//! The `/api/v1/kits/drafts` routes over a headless draft (KHP A27) of a mock kit file: the
//! person lists it, compares it, has a merge refused while the file changed since the draft
//! forked, merges it anyway, and discards another; and paths outside the workspace are refused.
//! The draft is made as `kition mcp --drafts` makes a `file` draft: a copy of the file and the
//! edited copy beside it. (Ported from Kition's `kition-kits-http` tests.)

mod support;

use std::path::{Path, PathBuf};

use http::StatusCode;
use kition_kits::{KitAgent, KitDefinition, KitManager, drafts};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::{api, app, call, mock_binary, write};

static MOCK: KitDefinition = KitDefinition {
    id: "kit.mock",
    name: "Mock kit",
    extensions: &["mocktext"],
    views: &[],
    creates: &[("mocktext", "mock.text")],
    base_name: "Untitled Mock kit",
    exports: &[],
    executable: None,
    protocol: Some("kition-kit/1"),
    version: "0.0.0",
    manifest: "{}",
    outline: None,
    agent: KitAgent {
        prefix: "mock",
        drafts: true,
        object_model: true,
        noun: "mock document",
        formats: ".mocktext",
        reports: "its text",
        covers: "text edits",
        queries: "`append`",
        command: "text.append",
        use_for: None,
        render: None,
        parts: None,
        export: None,
    },
};

const FILE: &str = "art/note.mocktext";

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A `file` draft of `path` in `workspace`, as `kition mcp --drafts` keeps one: the file as it
/// was, the agent's edited copy, and `draft.json`.
fn make_draft(workspace: &Path, path: &str, base: &[u8], draft: &[u8]) {
    let dir = drafts::folder(workspace, path);
    write(&dir.join("base.mocktext"), base);
    write(&dir.join("draft.mocktext"), draft);
    let meta = json!({
        "version": 1,
        "path": path,
        "kit": "kit.mock",
        "mode": "file",
        "state": "ready",
        "baseSha256": sha256(base),
        "created": 1_760_000_000_000_u64,
        "updated": 1_760_000_000_000_u64,
    });
    write(&dir.join("draft.json"), meta.to_string().as_bytes());
}

fn kits(workspace: &Path, binary: PathBuf) -> KitManager {
    KitManager::new(Some(workspace.to_path_buf()), vec![(&MOCK, Some(binary))])
}

#[tokio::test]
async fn the_person_reviews_merges_and_discards_headless_drafts() {
    let Some(binary) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let workspace = &std::fs::canonicalize(dir.path()).unwrap();
    write(&workspace.join(FILE), b"hello");
    make_draft(workspace, FILE, b"hello", b"hello world");
    let kits = kits(workspace, binary);
    let app = app(&kits);

    let listed = call(&app, "GET", &api("/kits/drafts"), None).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.json);
    assert_eq!(listed.data()["drafts"][0]["path"], FILE);
    assert_eq!(listed.data()["drafts"][0]["stale"], false);

    let compared = call(&app, "GET", &api(&format!("/kits/drafts/compare?path={FILE}")), None).await;
    assert_eq!(compared.status, StatusCode::OK, "{}", compared.json);
    assert_eq!(compared.data()["mode"], "file");
    assert_eq!(compared.data()["diff"], Value::Null);
    assert!(compared.data()["summary"]["draft"].is_string(), "{}", compared.json);

    // The person edits the file meanwhile: merging would drop that edit, so it is refused.
    write(&workspace.join(FILE), b"hello again");
    let refused = call(&app, "POST", &api("/kits/drafts/merge"), Some(json!({ "path": FILE }))).await;
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.json);
    assert_eq!(refused.reason(), "stale", "{}", refused.json);
    let listed = call(&app, "GET", &api("/kits/drafts"), None).await;
    assert_eq!(listed.data()["drafts"][0]["stale"], true);

    let merged = call(&app, "POST", &api("/kits/drafts/merge"), Some(json!({ "path": FILE, "overwrite": true }))).await;
    assert_eq!(merged.status, StatusCode::OK, "{}", merged.json);
    assert_eq!(std::fs::read(workspace.join(FILE)).unwrap_or_default(), b"hello world");
    assert!(!drafts::folder(workspace, FILE).exists());

    make_draft(workspace, FILE, b"hello world", b"bye");
    let discarded = call(&app, "POST", &api("/kits/drafts/discard"), Some(json!({ "path": FILE }))).await;
    assert_eq!(discarded.status, StatusCode::OK, "{}", discarded.json);
    assert_eq!(std::fs::read(workspace.join(FILE)).unwrap_or_default(), b"hello world", "discarding leaves the file as it is");
    let missing = call(&app, "POST", &api("/kits/drafts/discard"), Some(json!({ "path": FILE }))).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND, "{}", missing.json);
    assert_eq!(missing.reason(), "not-found");
    let listed = call(&app, "GET", &api("/kits/drafts"), None).await;
    assert_eq!(listed.data()["drafts"], json!([]));
    kits.shutdown().await;
}

/// sdk.gateway.security/workspace-paths: a draft route names a workspace path: `..`, an absolute
/// path, a hidden segment and a link out of the workspace are refused before anything is read.
#[tokio::test]
async fn draft_routes_refuse_paths_outside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = std::fs::canonicalize(dir.path()).unwrap().join("workspace");
    let outside = std::fs::canonicalize(dir.path()).unwrap().join("outside");
    write(&outside.join("secret.mocktext"), b"secret");
    write(&workspace.join(FILE), b"hello");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, workspace.join("away")).unwrap();
    let kits = KitManager::new(Some(workspace.clone()), vec![(&MOCK, None)]);
    let app = app(&kits);
    let absolute = outside.join("secret.mocktext").display().to_string();
    for path in ["../outside/secret.mocktext", "art/../../outside/secret.mocktext", absolute.as_str(), ".kition/drafts/x.mocktext", "art/.hidden.mocktext"] {
        let encoded: String = path
            .bytes()
            .map(|byte| if byte.is_ascii_alphanumeric() || b"-_.".contains(&byte) { char::from(byte).to_string() } else { format!("%{byte:02X}") })
            .collect();
        let compared = call(&app, "GET", &api(&format!("/kits/drafts/compare?path={encoded}")), None).await;
        assert_eq!(compared.status, StatusCode::FORBIDDEN, "{path}: {}", compared.json);
        for route in ["/kits/drafts/merge", "/kits/drafts/discard"] {
            let answer = call(&app, "POST", &api(route), Some(json!({ "path": path, "overwrite": true }))).await;
            assert_eq!(answer.status, StatusCode::FORBIDDEN, "{route} {path}: {}", answer.json);
        }
    }
    // Through a link out of the workspace: no draft there is the person's to merge.
    #[cfg(unix)]
    for route in ["/kits/drafts/merge", "/kits/drafts/discard"] {
        let answer = call(&app, "POST", &api(route), Some(json!({ "path": "away/secret.mocktext", "overwrite": true }))).await;
        assert!(answer.status.is_client_error(), "{route}: {}", answer.json);
    }
    assert_eq!(std::fs::read(outside.join("secret.mocktext")).unwrap(), b"secret");
}
