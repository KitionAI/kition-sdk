//! The Kit AI bridge over HTTP, as an editor window uses it: `GET /api/v1/kits/bridge` streams
//! the server's JSON-RPC requests as server-sent events, and `POST /api/v1/kits/bridge?session=`
//! answers them. The server finds the window with a file open and runs the agent's call there.
//! (Ported from Kition's `kition-kits-http` tests, behind the gateway's guard.)

mod support;

use http::StatusCode;
use kition_kits::KitManager;
use serde_json::json;
use support::{app, bridge, post_bridge};

#[tokio::test]
async fn the_agent_reaches_the_window_with_the_file_open() {
    let kits = KitManager::new(None, Vec::new());
    let app = app(&kits);
    let (mut events, session) = bridge(&app).await;

    // The window: lists its open drawing, then runs the agent's call.
    let window = {
        let app = app.clone();
        tokio::spawn(async move {
            let listing = events.next().await;
            assert_eq!(listing["method"], "kit/documents");
            let documents = json!({ "documents": [{ "path": "art/Logo.kvector", "kit": "kit.vector", "dirty": false, "revision": 4 }] });
            assert_eq!(post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": listing["id"], "result": documents })).await, StatusCode::OK);
            let call = events.next().await;
            assert_eq!(call["method"], "kit/call");
            assert_eq!(call["params"]["tool"], "run");
            let result = json!({ "completed": [{ "command": "shape.ellipse", "changed": true, "result": null }], "saved": true });
            assert_eq!(post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": call["id"], "result": result })).await, StatusCode::OK);
            let changed = json!({ "jsonrpc": "2.0", "method": "kit.changed", "params": { "path": "art/Logo.kvector", "revision": 5, "by": "agent" } });
            assert_eq!(post_bridge(&app, session, changed).await, StatusCode::OK);
            events
        })
    };

    let live = kits.bridge().find("art/Logo.kvector").await.unwrap_or_else(|| panic!("the window has it open"));
    assert_eq!((live.kit.as_str(), live.revision, live.session), ("kit.vector", 4, session));
    let ran = kits.bridge().call(&live, "run", json!({ "steps": [{ "command": "shape.ellipse" }], "save": true })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(ran["completed"][0]["changed"], true);
    let events = window.await.unwrap();
    assert_eq!(kits.bridge().last_change("art/Logo.kvector"), Some((5, "agent".to_owned())));

    // An answer to no request, or from no session, is refused.
    assert_eq!(post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": 999, "result": {} })).await, StatusCode::NOT_FOUND);
    assert_eq!(post_bridge(&app, session ^ 1, json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).await, StatusCode::NOT_FOUND);

    // When the window's stream goes away, the agent falls back to the headless kit.
    drop(events);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(!kits.bridge().connected());
    assert!(kits.bridge().find("art/Logo.kvector").await.is_none());
}
