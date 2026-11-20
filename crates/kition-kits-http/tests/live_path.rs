//! The live path of the gateway (sdk.gateway.security/live-path): an editor window attached to
//! the gateway's bridge (`GET /api/v1/kits/bridge`) lists a workspace file as open, and an MCP
//! `kit_run` on it arriving over `POST /api/v1/mcp/kits` is delivered to that editor as
//! `kit/call` and not run headless; with no editor attached, the same call runs in the headless
//! kit and changes the file. The headless kit is the mock kit standing in for Kition Example.
//! (The same call relayed by a `kition mcp` stdio process: kition-cli's `tests/gateway.rs`.)
#![cfg(unix)]

mod support;

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use kition_kits::KitManager;
use serde_json::{Value, json};
use support::{api, app, bridge, example_kit, post_bridge, send, write};

const FILE: &str = "notes/Plan.example";

async fn mcp(app: &Router, message: Value) -> Value {
    let request = Request::builder()
        .method("POST")
        .uri(api("/mcp/kits"))
        .header("content-type", "application/json")
        .header("kition-mcp-connection", "live-path-test-connection")
        .body(Body::from(message.to_string()))
        .unwrap();
    let answer = send(app, request).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json);
    answer.json
}

fn run(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "kit_run", "arguments": {
        "path": FILE, "steps": [{ "command": "text.append", "params": { "text": " B" } }]
    } } })
}

#[tokio::test]
async fn a_tool_call_reaches_the_open_editor_and_runs_headless_without_one() {
    let dir = tempfile::tempdir().unwrap();
    let Some((kit, launcher)) = example_kit(dir.path()) else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let workspace = dir.path().join("workspace");
    write(&workspace.join(FILE), b"plan");
    kition_kits::tools::set_unified(true);
    let kits = KitManager::new(Some(workspace.clone()), vec![(kit, Some(launcher))]).with_headless_drafts();
    let app = app(&kits);
    let init = mcp(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "live-test", "version": "1" } } })).await;
    assert_eq!(init["result"]["serverInfo"]["name"], "kition-kits");
    let tools = mcp(&app, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    assert!(tools["result"]["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["name"] == "kit_run")), "{tools}");

    // (a) An editor window has the file open: the call goes to it.
    let (mut events, session) = bridge(&app).await;
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let window = {
        let app = app.clone();
        tokio::spawn(async move {
            let mut calls = Vec::new();
            loop {
                let message = tokio::select! {
                    message = events.next() => message,
                    _ = &mut stopped => break,
                };
                let id = message["id"].clone();
                let result = match message["method"].as_str() {
                    Some("kit/documents") => json!({ "documents": [{ "path": FILE, "kit": "kit.example", "dirty": false, "revision": 3 }] }),
                    Some("kit/call") => {
                        calls.push(message["params"].clone());
                        json!({ "completed": [{ "command": "text.append", "changed": true, "result": null }], "saved": true, "document": { "summary": "edited in the editor" } })
                    }
                    Some("kit/preview") => json!({ "png": "iVBORw0KGgo=" }),
                    _ => continue,
                };
                assert_eq!(post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": id, "result": result })).await, StatusCode::OK);
            }
            (calls, events)
        })
    };
    let live = tokio::time::timeout(Duration::from_secs(30), mcp(&app, run(3))).await.unwrap();
    let _ = stop.send(());
    let (calls, events) = window.await.unwrap();
    assert_eq!(calls.len(), 1, "the editor got the call: {calls:?}");
    assert_eq!((calls[0]["tool"].as_str(), calls[0]["path"].as_str(), calls[0]["kit"].as_str()), (Some("run"), Some(FILE), Some("kit.example")));
    assert_eq!(calls[0]["arguments"]["steps"][0]["command"], "text.append");
    assert_eq!(live["result"]["isError"], false, "{live}");
    assert_eq!(live["result"]["structuredContent"]["live"], true, "{live}");
    assert_eq!(std::fs::read_to_string(workspace.join(FILE)).unwrap(), "plan", "nothing ran headless");

    // (b) The editor window goes away: the same call runs in the headless kit.
    drop(events);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!kits.bridge().connected());
    let headless = mcp(&app, run(4)).await;
    assert_eq!(headless["result"]["isError"], false, "{headless}");
    assert_ne!(headless["result"]["structuredContent"]["live"], true, "{headless}");
    assert_eq!(std::fs::read_to_string(workspace.join(FILE)).unwrap(), "plan B");
    kits.shutdown().await;
}
