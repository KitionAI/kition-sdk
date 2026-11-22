//! `PUT /api/v1/kits/files`, as in-page kit editors save through it: a save replaces only the
//! document its editor opened, and a write without one makes a new file and never replaces one,
//! of any kit. (Ported from Kition's `kition-kits-http` tests.)

mod support;

use axum::body::Body;
use http::{Request, StatusCode};
use kition_kits::{KitAgent, KitDefinition, KitManager};
use support::{api, send, write};

static MOCK: KitDefinition = KitDefinition {
    id: "kit.mock",
    name: "Mock kit",
    extensions: &["mocktext"],
    views: &[],
    creates: &[("mocktext", "mock.text")],
    base_name: "Untitled Mock kit",
    exports: &["mockout"],
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

/// A second kit, so that one kit's editor can try to write another kit's file.
static OTHER: KitDefinition = KitDefinition {
    id: "kit.other",
    name: "Other kit",
    extensions: &["mockpic"],
    views: &[],
    creates: &[],
    base_name: "Untitled Other kit",
    exports: &[],
    executable: None,
    protocol: Some("kition-kit/1"),
    version: "0.0.0",
    manifest: "{}",
    outline: None,
    agent: KitAgent {
        prefix: "other",
        drafts: true,
        object_model: true,
        noun: "other document",
        formats: ".mockpic",
        reports: "its picture",
        covers: "nothing",
        queries: "nothing",
        command: "picture.noop",
        use_for: None,
        render: None,
        parts: None,
        export: None,
    },
};

/// An in-page save replaces only the document its editor opened, and a write without one makes a
/// new file and never replaces one, of any kit. (Ported from Kition's `kition-kits-http` tests.)
#[tokio::test]
async fn an_in_page_save_writes_only_the_document_it_names() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["art/note.mocktext", "art/other.mocktext", "art/cover.mockpic"] {
        write(&dir.path().join(name), b"original");
    }
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(&MOCK, None), (&OTHER, None)]);
    let app = support::app(&kits);
    let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap_or_default();
    let put = |uri: &str, body: &'static str| {
        let (app, uri) = (app.clone(), api(uri));
        async move {
            send(&app, Request::builder().method("PUT").uri(&uri).header("content-type", "application/octet-stream").body(Body::from(body)).unwrap())
                .await
                .status
        }
    };
    // A save names the document its editor opened; any other target is refused, whatever its kit.
    for uri in [
        "/kits/files?path=art/other.mocktext&document=art/note.mocktext",
        "/kits/files?path=art/cover.mockpic&document=art/note.mocktext",
        "/kits/files?path=art/cover.mockpic&document=art/cover.mocktext",
        "/kits/files?path=art/note.mockout&document=art/note.mockout",
        "/kits/files?path=art/note.txt&document=art/note.txt",
    ] {
        assert_eq!(put(uri, "taken").await, StatusCode::BAD_REQUEST, "{uri}");
    }
    // Without a document, a write makes a new file and never replaces one, of any kit.
    for uri in ["/kits/files?path=art/other.mocktext", "/kits/files?path=art/cover.mockpic", "/kits/files?path=art/note.mocktext"] {
        assert_eq!(put(uri, "taken").await, StatusCode::BAD_REQUEST, "{uri}");
    }
    for name in ["art/note.mocktext", "art/other.mocktext", "art/cover.mockpic"] {
        assert_eq!(read(name), "original", "{name}");
    }
    assert_eq!(put("/kits/files?path=art/note.mocktext&document=art/note.mocktext", "saved").await, StatusCode::OK);
    assert_eq!(read("art/note.mocktext"), "saved");
    assert_eq!(put("/kits/files?path=art/new.mocktext", "made").await, StatusCode::OK);
    assert_eq!(read("art/new.mocktext"), "made");
    assert_eq!(put("/kits/files?path=art/new.mocktext", "again").await, StatusCode::BAD_REQUEST);
    assert_eq!(read("art/new.mocktext"), "made");
    // A new file may start its own folders; a save never does.
    assert_eq!(put("/kits/files?path=attachments/art/x.mockout", "made").await, StatusCode::OK);
    assert!(dir.path().join("attachments/art/x.mockout").is_file());
    assert_eq!(put("/kits/files?path=missing/x.mocktext&document=missing/x.mocktext", "x").await, StatusCode::BAD_REQUEST);
    assert!(!dir.path().join("missing").exists());
}
