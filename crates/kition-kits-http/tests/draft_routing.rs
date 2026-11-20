//! Decision R9 (regressions/issue-agent-draft-in-editor): an agent's draft is always a headless
//! draft on a server that keeps them (`kition gateway`, `kition mcp`), even when the file is open
//! in an editor attached to its bridge. A draft run on an open file used to go to the editor as
//! `kit/call` with `draft: true`, where the draft lived in the editor's page and died with its tab,
//! so the person's review (`/kits/drafts`) never saw it. Now the open editor gets no call, the
//! draft is kept beside the file (`.kition/drafts/`) for the person to review, the file is
//! unchanged, and every window on the bridge hears `kit/draftsChanged` with the file's path.
#![cfg(unix)]

mod support;

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use kition_kits::KitManager;
use serde_json::{Value, json};
use support::{api, app, bridge, call, example_kit, post_bridge, send, write};

const FILE: &str = "notes/Plan.example";

async fn mcp(app: &Router, message: Value) -> Value {
    let request = Request::builder()
        .method("POST")
        .uri(api("/mcp/kits"))
        .header("content-type", "application/json")
        .header("kition-mcp-connection", "draft-routing-test-connection")
        .body(Body::from(message.to_string()))
        .unwrap();
    let answer = send(app, request).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json);
    answer.json
}

fn tool(id: u64, name: &str, arguments: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } })
}

#[tokio::test]
async fn an_agent_draft_on_an_open_file_is_a_headless_draft() {
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
    mcp(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "draft-routing", "version": "1" } } })).await;

    // An editor window has the file open, and records every call it gets and every notification.
    let (mut events, session) = bridge(&app).await;
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let window = {
        let app = app.clone();
        tokio::spawn(async move {
            let (mut calls, mut notices) = (Vec::new(), Vec::new());
            loop {
                let message = tokio::select! {
                    message = events.next() => message,
                    _ = &mut stopped => break,
                };
                let Some(id) = message.get("id").cloned() else {
                    notices.push(message);
                    continue;
                };
                let result = match message["method"].as_str() {
                    Some("kit/documents") => json!({ "documents": [{ "path": FILE, "kit": "kit.example", "dirty": false, "revision": 3 }] }),
                    Some("kit/call") => {
                        calls.push(message["params"].clone());
                        json!({ "completed": [], "saved": false, "document": { "summary": "the editor's" } })
                    }
                    Some("kit/preview") => json!({ "png": "iVBORw0KGgo=" }),
                    _ => continue,
                };
                assert_eq!(post_bridge(&app, session, json!({ "jsonrpc": "2.0", "id": id, "result": result })).await, StatusCode::OK);
            }
            (calls, notices)
        })
    };

    let run = tool(2, "kit_run", json!({ "path": FILE, "draft": true, "steps": [{ "command": "text.append", "params": { "text": " drafted" } }] }));
    let answer = tokio::time::timeout(Duration::from_secs(60), mcp(&app, run)).await.unwrap();
    assert!(answer["result"]["isError"] != true, "{answer}");
    let ready = tokio::time::timeout(Duration::from_secs(60), mcp(&app, tool(3, "kit_draft_ready", json!({ "path": FILE })))).await.unwrap();
    assert!(ready["result"]["isError"] != true, "{ready}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = stop.send(());
    let (calls, notices) = window.await.unwrap();

    let drafted: Vec<&Value> =
        calls.iter().filter(|call| call["arguments"]["draft"] == true || call["tool"].as_str().is_some_and(|tool| tool.starts_with("draft_"))).collect();
    assert!(drafted.is_empty(), "the open editor got the agent's draft calls: {calls:?}");
    let listed = call(&app, "GET", &api("/kits/drafts"), None).await;
    let drafts = listed.data()["drafts"].as_array().cloned().unwrap_or_default();
    assert_eq!(drafts.len(), 1, "one headless draft for the person to review: {}", listed.json);
    assert_eq!((drafts[0]["path"].as_str(), drafts[0]["state"].as_str()), (Some(FILE), Some("ready")));
    assert_eq!(std::fs::read(workspace.join(FILE)).unwrap(), b"plan", "the file is unchanged until the person merges");
    assert!(
        notices.iter().any(|notice| notice["method"] == "kit/draftsChanged" && notice["params"]["path"] == FILE),
        "the window hears that the file's draft changed: {notices:?}"
    );
    kits.shutdown().await;
}
