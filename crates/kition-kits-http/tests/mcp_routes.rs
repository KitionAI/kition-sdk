//! `POST /api/v1/mcp/kits`: the kit tools as an MCP server over Streamable HTTP, as DeepSeek
//! Harness's MCP client, `kition mcp` relaying to a gateway, and other MCP clients reach it.
//!
//! - The wire, as a stateless endpoint (spike S1 against DeepSeek Harness 0.2.2-rc.5): requests
//!   answered `200` JSON, notifications `202` with no body, `GET` and `DELETE` `405` with
//!   `Allow: POST` (after the token gate), batches and bad JSON `400`, no `Mcp-Session-Id`, and
//!   `server/discover` unknown (`-32601`), so a client falls back to `initialize`.
//! - Connections (regressions/issue-mcp-http-connections): every HTTP client shared one MCP
//!   session, whose requests in flight were keyed by JSON-RPC id alone, so a second client's
//!   call with an id the first had in flight was refused (`-32600 request id is already in
//!   flight`), and one client's `notifications/cancelled` could cancel another's request. Now a
//!   client that names its connection (`Kition-Mcp-Connection`) has its own, and one that does
//!   not is a connection of its own per message.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};
use support::{Answer, TOKEN, api, app, bridge, post_bridge, send, send_as_is};

fn mcp_request(message: &str, connection: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(api("/mcp/kits"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18");
    if let Some(connection) = connection {
        request = request.header("kition-mcp-connection", connection);
    }
    request.body(Body::from(message.to_owned())).unwrap()
}

async fn post(app: &Router, message: Value) -> Answer {
    send(app, mcp_request(&message.to_string(), None)).await
}

async fn post_on(app: &Router, connection: &str, message: Value) -> Answer {
    send(app, mcp_request(&message.to_string(), Some(connection))).await
}

#[tokio::test]
async fn speaks_mcp_over_http() {
    let kits = KitManager::new(None, Vec::new());
    let app = app(&kits);
    // A newer client first asks for the newer protocol's discovery, which this server does not
    // know, then falls back to `initialize` with the newest version it has.
    let discover = post(&app, json!({ "jsonrpc": "2.0", "id": 0, "method": "server/discover" })).await;
    assert_eq!((discover.status, &discover.json["error"]["code"]), (StatusCode::OK, &json!(-32601)));
    let init = post(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } })).await;
    assert_eq!(init.status, StatusCode::OK);
    assert_eq!(init.header("content-type"), Some("application/json"));
    assert_eq!(init.json["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init.json["result"]["capabilities"]["tools"]["listChanged"], false);
    assert!(init.header("mcp-session-id").is_none(), "a stateless endpoint issues no session");
    let initialized = post(&app, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!((initialized.status, initialized.bytes.len()), (StatusCode::ACCEPTED, 0));
    assert_eq!(post(&app, json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })).await.json["result"], json!({}));
    assert_eq!(post(&app, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).await.json["result"]["tools"], json!([]), "no kit is installed");
}

#[tokio::test]
async fn the_endpoint_is_post_only_and_takes_one_message() {
    let kits = KitManager::new(None, Vec::new());
    let app = app(&kits);
    for method in ["GET", "DELETE"] {
        let request = || Request::builder().method(method).uri(api("/mcp/kits")).header("accept", "text/event-stream").body(Body::empty()).unwrap();
        // The token gate comes first: nothing is said about the route without it.
        assert_eq!(send_as_is(&app, request()).await.status, StatusCode::UNAUTHORIZED, "{method}");
        let refused = send(&app, request()).await;
        assert_eq!(refused.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
        assert!(refused.header("allow").is_some_and(|allow| allow.contains("POST")), "{method}: {:?}", refused.headers);
    }
    let batch = send(&app, mcp_request(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#, None)).await;
    assert_eq!(batch.status, StatusCode::BAD_REQUEST);
    let broken = send(&app, mcp_request("{not json", None)).await;
    assert_eq!(broken.status, StatusCode::BAD_REQUEST);
    // A response from the client (to a request the server never sends here) is accepted.
    let response = post(&app, json!({ "jsonrpc": "2.0", "id": 9, "result": {} })).await;
    assert_eq!((response.status, response.bytes.len()), (StatusCode::ACCEPTED, 0));
    // A malformed connection id or call options are refused, not ignored.
    let bad_connection = send(&app, mcp_request(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, Some("short"))).await;
    assert_eq!(bad_connection.status, StatusCode::BAD_REQUEST);
    let mut bad_options = mcp_request(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, None);
    bad_options.headers_mut().insert("kition-mcp-options", http::HeaderValue::from_static(r#"{"guard":"loose"}"#));
    assert_eq!(send(&app, bad_options).await.status, StatusCode::BAD_REQUEST);
    // Without the token, no message reaches the kits.
    let anonymous = send_as_is(&app, mcp_request(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, None)).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    let _ = TOKEN;
}

/// A kit with no headless executable whose files open in a scripted editor that holds each
/// `kit/call` until the test lets it answer.
fn slow_kit() -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": "kit.lvslow", "name": "Kition lvslow", "version": "0.0.0",
        "formats": [{ "id": "lvslow", "extensions": ["lvslow"], "role": "edit" }],
        "agent": { "prefix": "lvslow", "tools": "document" }
    });
    KitDefinition::from_manifest(&manifest).unwrap()
}

/// The `kit/call`s the editor holds: each call's path, and a sender that lets it answer.
type Held = Arc<Mutex<Vec<(String, tokio::sync::oneshot::Sender<()>)>>>;

async fn slow_editor(app: &Router) -> Held {
    let (mut events, session) = bridge(app).await;
    let held: Held = Arc::default();
    let (app, calls) = (app.clone(), Arc::clone(&held));
    tokio::spawn(async move {
        loop {
            let message = events.next().await;
            let id = message["id"].clone();
            match message["method"].as_str() {
                Some("kit/documents") => {
                    let documents = json!({ "documents": [
                        { "path": "a.lvslow", "kit": "kit.lvslow", "dirty": false, "revision": 1 },
                        { "path": "b.lvslow", "kit": "kit.lvslow", "dirty": false, "revision": 1 },
                    ] });
                    post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": id, "result": documents })).await;
                }
                Some("kit/preview") => {
                    post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": id, "result": { "png": "iVBORw0KGgo=" } })).await;
                }
                Some("kit/call") => {
                    let (release, released) = tokio::sync::oneshot::channel();
                    calls.lock().unwrap().push((message["params"]["path"].as_str().unwrap_or_default().to_owned(), release));
                    let app = app.clone();
                    tokio::spawn(async move {
                        let _ = released.await;
                        let result = json!({ "path": message["params"]["path"], "summary": "held and answered", "document": { "summary": "held" } });
                        post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
                    });
                }
                _ => {}
            }
        }
    });
    held
}

async fn wait_for_calls(held: &Held, count: usize) {
    for _ in 0..500 {
        if held.lock().unwrap().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the editor did not get {count} calls");
}

fn release_all(held: &Held) {
    for (_, release) in held.lock().unwrap().drain(..) {
        let _ = release.send(());
    }
}

fn inspect(id: u64, path: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "lvslow_inspect", "arguments": { "path": path } } })
}

/// regressions/issue-mcp-http-connections: two connections with overlapping calls of the same
/// request id both run, and a cancellation from one leaves the other's call alone.
#[tokio::test]
async fn connections_have_their_own_requests_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["a.lvslow", "b.lvslow"] {
        std::fs::write(dir.path().join(name), "x").unwrap();
    }
    // The kit counts as installed (it offers tools) with any file as its executable: no call
    // reaches it, since both files are open in the editor.
    let placeholder = dir.path().join("kition-lvslow");
    std::fs::write(&placeholder, "never started").unwrap();
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(slow_kit(), Some(placeholder))]);
    let app = app(&kits);
    let held = slow_editor(&app).await;
    let (first, second) = ("connection-a-0123456789", "connection-b-0123456789");

    // Overlapping calls with the same id on two connections: both run, neither is refused.
    let a = tokio::spawn({
        let app = app.clone();
        async move { post_on(&app, first, inspect(1, "a.lvslow")).await }
    });
    let b = tokio::spawn({
        let app = app.clone();
        async move { post_on(&app, second, inspect(1, "b.lvslow")).await }
    });
    wait_for_calls(&held, 2).await;
    // The first connection cancels its request 1; the second's request 1 runs on.
    let cancelled = post_on(&app, first, json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } })).await;
    assert_eq!(cancelled.status, StatusCode::ACCEPTED);
    let a = tokio::time::timeout(Duration::from_secs(10), a).await.unwrap().unwrap();
    assert_eq!(a.json["error"]["code"], -32800, "{}", a.json);
    release_all(&held);
    let b = tokio::time::timeout(Duration::from_secs(10), b).await.unwrap().unwrap();
    assert!(b.json.get("result").is_some(), "the other connection's call was not cancelled: {}", b.json);
    assert_eq!(b.json["id"], 1);

    // Clients that name no connection: each message is a connection of its own, so the same id
    // in flight twice runs twice, and a cancellation without a connection reaches nobody's call.
    let c = tokio::spawn({
        let app = app.clone();
        async move { post(&app, inspect(7, "a.lvslow")).await }
    });
    let d = tokio::spawn({
        let app = app.clone();
        async move { post(&app, inspect(7, "b.lvslow")).await }
    });
    wait_for_calls(&held, 2).await;
    let stray = post(&app, json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7 } })).await;
    assert_eq!(stray.status, StatusCode::ACCEPTED);
    release_all(&held);
    for answer in [c, d] {
        let answer = tokio::time::timeout(Duration::from_secs(10), answer).await.unwrap().unwrap();
        assert!(answer.json.get("result").is_some(), "{}", answer.json);
    }

    // One connection still refuses its own id twice in flight.
    let e = tokio::spawn({
        let app = app.clone();
        async move { post_on(&app, first, inspect(3, "a.lvslow")).await }
    });
    wait_for_calls(&held, 1).await;
    let again = post_on(&app, first, inspect(3, "b.lvslow")).await;
    assert_eq!(again.json["error"]["code"], -32600, "{}", again.json);
    release_all(&held);
    let e = tokio::time::timeout(Duration::from_secs(10), e).await.unwrap().unwrap();
    assert!(e.json.get("result").is_some(), "{}", e.json);
}
