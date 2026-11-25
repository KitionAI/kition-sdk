//! `kition-kit-host`'s `HeadlessKit` launching the reference grid kit: initialize, requests, the
//! workspace's files served to the kit by handle, a crash, and shutdown.

use std::time::Duration;

use kition_kit_host::{ClientError, HeadlessKit, LaunchOptions};
use serde_json::json;

const LIMIT: Duration = Duration::from_secs(10);

fn workspace(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("kition-kit-host-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::canonicalize(root).unwrap()
}

#[tokio::test]
async fn launches_initializes_and_serves_requests() {
    let root = workspace("serve");
    let mut options = LaunchOptions::new(env!("CARGO_BIN_EXE_kit-grid"));
    options.workspace = Some(root.clone());
    let kit = HeadlessKit::launch(options).await.unwrap();
    assert_eq!(kit.kit_id(), "example.grid");
    assert!(kit.serves("view.describe"));
    assert!(!kit.serves("model.open"));
    kit.request("kit.ping", json!({}), LIMIT).await.unwrap();
    let opened = kit.create("plan.grid", "grid", LIMIT).await.unwrap();
    assert_eq!(opened["name"], "plan.grid");
    let described = kit.request("view.describe", json!({ "documentId": opened["documentId"] }), LIMIT).await.unwrap();
    assert!(described["summary"].is_string());
    // The kit writes the file through the host's files.*, and reopens it by its handle.
    let saved = kit.request("file.save", json!({ "documentId": opened["documentId"] }), LIMIT).await.unwrap();
    assert!(saved["version"].is_string(), "{saved}");
    assert!(root.join("plan.grid").is_file());
    let again = kit.open("plan.grid", false, LIMIT).await.unwrap();
    assert_eq!(again["documentId"], opened["documentId"], "the same file is the same document");
    let outside = kit.open("../plan.grid", false, LIMIT).await.unwrap_err();
    assert_eq!(outside.reason(), Some("file_not_allowed"));
    let refused = kit.request("file.activate", json!({ "documentId": "nope" }), LIMIT).await.unwrap_err();
    assert_eq!(refused.reason(), Some("document_not_found"));
    kit.shutdown(LIMIT).await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_killed_kit_fails_its_requests_and_a_wrong_binary_does_not_launch() {
    let mut kit = HeadlessKit::launch(LaunchOptions::new(env!("CARGO_BIN_EXE_kit-grid"))).await.unwrap();
    assert!(kit.pid().is_some());
    kit.kill().await;
    assert!(kit.has_exited());
    let error = kit.request("kit.ping", json!({}), LIMIT).await.unwrap_err();
    assert!(error.is_fatal(), "{error}");
    let missing = HeadlessKit::launch(LaunchOptions::new("/nonexistent/kit-none")).await.err();
    assert!(matches!(missing, Some(ClientError::Launch(_))));
    // A memory limit wraps the launch in the shell; the kit still starts.
    let mut limited = LaunchOptions::new(env!("CARGO_BIN_EXE_kit-grid"));
    limited.memory_limit_bytes = Some(4 * 1024 * 1024 * 1024);
    let kit = HeadlessKit::launch(limited).await.unwrap();
    kit.request("kit.ping", json!({}), LIMIT).await.unwrap();
    kit.shutdown(LIMIT).await;
}
