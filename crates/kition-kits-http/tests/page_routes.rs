//! The routes the gateway's editor page uses beyond the kits' API (sdk.gateway.page,
//! sdk.gateway.editor-packages):
//!
//! - `/page/`: the page and its review view, its script and style, `no-cache` with an `ETag`,
//!   the HTML with its content security policy; nothing else is served there;
//! - direct opening: the address `open_url` makes is a signed URL of `/page/` whose fragment holds
//!   a signed bootstrap, traded once for a page session, which reaches the kits' API but not the
//!   gateway's identity or the agents' MCP endpoint; a bootstrap is good once, through its
//!   signature only, until it expires;
//! - `POST /api/v1/gateway/sign`: signed URLs of editor packages and kit files for a page session;
//! - `/kits-ui/`: an editor store's packages, `/api/v1/kits/editors` and its install route;
//! - `PUT /api/v1/kits/files?expected=`: a save over another version than the editor read is
//!   refused as `file_conflict`; a save answers the file's new version, the `ETag` `/kit-files/`
//!   answers;
//! - `/api/v1/kits/replicas`: the replica an editor keeps beside its document;
//! - `/api/v1/kits/view-state`: the person's view state of a document, in the gateway's data folder
//!   outside the workspace (sdk.ui.view-state).

mod support;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use kition_kits::{KitAgent, KitDefinition, KitManager};
use kition_kits_http::editors::{EditorEntry, EditorPackage, EditorStore, Progress};
use serde_json::json;
use support::{HOST, TOKEN, api, call, send, send_as_is, write};

static MOCK: KitDefinition = KitDefinition {
    id: "kit.mock",
    name: "Mock kit",
    extensions: &["mocktext"],
    views: &["mockview"],
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

/// A store with one package, `mock@1.2.3`, in a folder; it records install requests.
struct Store {
    root: PathBuf,
    installs: Mutex<Vec<String>>,
}

impl EditorStore for Store {
    fn listing(&self, kits: &[&str]) -> Vec<EditorEntry> {
        kits.iter()
            .map(|id| EditorEntry {
                id: (*id).to_owned(),
                version: Some("1.2.3".into()),
                installed: *id == "kit.mock",
                local: false,
                available: Some(true),
                downloading: (*id != "kit.mock").then_some(Progress { done: 1, total: 2 }),
                failed: None,
            })
            .collect()
    }

    fn package(&self, kit: &str, version: &str) -> Option<EditorPackage> {
        (kit == "mock" && version == "1.2.3").then(|| EditorPackage { root: self.root.clone(), manifest: None, local: false })
    }

    fn install(&self, kit: &str) -> Result<bool, String> {
        if kit == "none" {
            return Err("the kit index lists no editor package".into());
        }
        self.installs.lock().unwrap().push(kit.to_owned());
        Ok(true)
    }
}

struct Fixture {
    app: Router,
    root: PathBuf,
    data: PathBuf,
    store: Arc<Store>,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let root = base.join("workspace");
    write(&root.join("art/note.mocktext"), b"hello");
    let package = base.join("package");
    write(&package.join("index.html"), b"<!doctype html><title>mock editor</title>");
    write(&package.join("engine/kit_bg.wasm"), b"\0asm");
    write(&base.join("secret.js"), b"secret");
    #[cfg(unix)]
    std::os::unix::fs::symlink(base.join("secret.js"), package.join("link.js")).unwrap();
    let store = Arc::new(Store { root: package, installs: Mutex::default() });
    let kits = KitManager::new(Some(root.clone()), vec![(&MOCK, None)]);
    let gate = kition_kits_http::gateway::gate(TOKEN).unwrap();
    let identity = json!({ "protocol": kition_kits_http::gateway::PROTOCOL });
    let data = base.join("data");
    let app = kition_kits_http::gateway::app(kits, gate, identity, kition_kits_http::gateway::Activity::default(), Some(store.clone()), Some(data.clone()));
    Fixture { app, root, data, store, _dir: dir }
}

async fn get(app: &Router, uri: &str, headers: &[(&str, &str)]) -> support::Answer {
    let mut built = Request::builder().method("GET").uri(uri).header("host", HOST);
    for (name, value) in headers {
        built = built.header(*name, *value);
    }
    send_as_is(app, built.body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn the_page_and_its_review_view_are_served_with_their_policy() {
    let f = fixture();
    for view in ["/page/", "/page/review?path=art/note.mocktext", "/page/index.html"] {
        let page = get(&f.app, view, &[("kition-token", TOKEN)]).await;
        assert_eq!(page.status, StatusCode::OK, "{view}");
        assert_eq!(page.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(page.header("content-security-policy"), Some(kition_kits_http::page::CSP));
        assert_eq!((page.header("cache-control"), page.header("x-content-type-options")), (Some("no-cache"), Some("nosniff")));
        assert_eq!(page.header("referrer-policy"), Some("no-referrer"));
        let etag = page.header("etag").unwrap().to_owned();
        assert_eq!(get(&f.app, view, &[("kition-token", TOKEN), ("if-none-match", &etag)]).await.status, StatusCode::NOT_MODIFIED);
    }
    assert!(kition_kits_http::page::CSP.contains("frame-ancestors 'self'") && kition_kits_http::page::CSP.contains("connect-src 'self'"));
    assert_eq!(get(&f.app, "/page/page.js", &[("kition-token", TOKEN)]).await.header("content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(get(&f.app, "/page/page.css", &[("kition-token", TOKEN)]).await.header("content-type"), Some("text/css; charset=utf-8"));
    for missing in ["/page/../Cargo.toml", "/page/src/main.ts", "/page/review/x", "/page/%2e%2e/Cargo.toml"] {
        assert_eq!(get(&f.app, missing, &[("kition-token", TOKEN)]).await.status, StatusCode::NOT_FOUND, "{missing}");
    }
}

/// The path and fragment of an address `open_url` made.
fn parts(address: &str) -> (String, String) {
    let rest = address.strip_prefix(&format!("http://{HOST}")).unwrap();
    let (path, fragment) = rest.split_once('#').unwrap();
    let bootstrap = fragment.strip_prefix("bootstrap=").unwrap();
    (path.to_owned(), kition_http_guard::files::percent_decoded(bootstrap))
}

#[tokio::test]
async fn a_direct_open_trades_its_bootstrap_once_for_a_page_session() {
    let f = fixture();
    let address = kition_kits_http::gateway::open_url(TOKEN, &format!("http://{HOST}/"), Some("art/my note.mocktext"), false).unwrap();
    assert!(!address.contains(TOKEN), "the token is not in the address");
    let (page, bootstrap) = parts(&address);
    assert!(page.starts_with("/_signed/") && page.contains("/page/?path=art/my%20note.mocktext"), "{page}");
    let review = kition_kits_http::gateway::open_url(TOKEN, &format!("http://{HOST}"), Some("a.mocktext"), true).unwrap();
    assert!(review.contains("/page/review?path=a.mocktext#bootstrap="), "{review}");

    // The signed page and its files load without a header.
    let loaded = get(&f.app, &page, &[]).await;
    assert_eq!(loaded.status, StatusCode::OK);
    let scope = &page[..page.find("/page/").unwrap() + "/page/".len()];
    assert_eq!(get(&f.app, &format!("{scope}page.js"), &[]).await.status, StatusCode::OK);
    assert_eq!(get(&f.app, &format!("{scope}review"), &[]).await.status, StatusCode::OK);
    // The page's signature is for the page only.
    assert_eq!(get(&f.app, &scope.replace("/page/", "/kit-files/art/note.mocktext"), &[]).await.status, StatusCode::UNAUTHORIZED);

    // The bootstrap: once, through its signature.
    let traded = get(&f.app, &bootstrap, &[]).await;
    assert_eq!(traded.status, StatusCode::OK, "{}", traded.json);
    assert_eq!(traded.header("cache-control"), Some("no-store"));
    let session = traded.data()["session"].as_str().unwrap().to_owned();
    assert_eq!(session.len(), 64);
    assert_ne!(session, TOKEN);
    let again = get(&f.app, &bootstrap, &[]).await;
    assert_eq!((again.status, again.reason().clone()), (StatusCode::UNAUTHORIZED, json!("bootstrap_spent")));
    let nonce = bootstrap.rsplit('/').next().unwrap();
    assert_eq!(
        get(&f.app, &api(&format!("/gateway/page-session/{nonce}")), &[("kition-token", TOKEN)]).await.status,
        StatusCode::UNAUTHORIZED,
        "the token holder needs no bootstrap"
    );
    let other = kition_kits_http::gateway::open_url("another-token", &format!("http://{HOST}"), None, false).unwrap();
    assert_eq!(get(&f.app, &parts(&other).1, &[]).await.status, StatusCode::UNAUTHORIZED, "signed with another token");

    // The session reaches the kits' API, the files and the bridge; not the identity or MCP.
    let with = [("kition-token", session.as_str())];
    assert_eq!(get(&f.app, &api("/kits"), &with).await.status, StatusCode::OK);
    assert_eq!(get(&f.app, "/kit-files/art/note.mocktext", &with).await.status, StatusCode::OK);
    assert_eq!(get(&f.app, "/page/", &with).await.status, StatusCode::OK);
    assert_eq!(get(&f.app, &api("/gateway"), &with).await.status, StatusCode::UNAUTHORIZED);
    let mcp = Request::builder()
        .method("POST")
        .uri(api("/mcp/kits"))
        .header("host", HOST)
        .header("kition-token", session.as_str())
        .header("content-type", "application/json")
        .body(Body::from(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string()))
        .unwrap();
    assert_eq!(send_as_is(&f.app, mcp).await.status, StatusCode::UNAUTHORIZED);

    // It signs editor packages and kit files for its frames, nothing else.
    let sign = |path: &str| {
        let app = f.app.clone();
        let session = session.clone();
        let body = json!({ "path": path }).to_string();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri(api("/gateway/sign"))
                .header("host", HOST)
                .header("kition-token", session)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            send_as_is(&app, request).await
        }
    };
    let signed = sign("/kits-ui/mock@1.2.3/").await;
    assert_eq!(signed.status, StatusCode::OK);
    let folder = signed.data()["path"].as_str().unwrap().to_owned();
    assert_eq!(sign("/kits-ui/mock@1.2.3/").await.data()["path"], json!(folder), "the same within its window, for the browser's cache");
    assert_eq!(get(&f.app, &format!("{folder}engine/kit_bg.wasm"), &[]).await.status, StatusCode::OK);
    let lent = sign("/kit-files/art/").await.data()["path"].as_str().unwrap().to_owned();
    assert_eq!(get(&f.app, &format!("{lent}note.mocktext"), &[]).await.status, StatusCode::OK);
    for refused in ["/api/v1/kits", "/page/", "/kits-ui/../api/v1/kits", "/kit-files/%2e%2e/x", "kits-ui/mock@1.2.3/", "/kits-ui/a?x=1"] {
        assert_eq!(sign(refused).await.status, StatusCode::BAD_REQUEST, "{refused}");
    }
}

#[tokio::test]
async fn editor_packages_are_served_from_the_store_and_listed_and_installed_for_pages() {
    let f = fixture();
    let page = get(&f.app, "/kits-ui/mock@1.2.3/", &[("kition-token", TOKEN)]).await;
    assert_eq!((page.status, page.header("content-type")), (StatusCode::OK, Some("text/html; charset=utf-8")));
    assert_eq!(page.header("cache-control"), Some("public, max-age=31536000, immutable"));
    let wasm = get(&f.app, "/kits-ui/mock@1.2.3/engine/kit_bg.wasm", &[("kition-token", TOKEN), ("range", "bytes=1-2")]).await;
    assert_eq!((wasm.status, wasm.header("content-type"), wasm.bytes.as_slice()), (StatusCode::PARTIAL_CONTENT, Some("application/wasm"), &b"as"[..]));
    for missing in ["/kits-ui/mock@1.2.3/link.js", "/kits-ui/mock@1.2.4/index.html", "/kits-ui/mock@1.2.3/%2e%2e/secret.js", "/kits-ui/other@1.2.3/index.html"]
    {
        let answer = get(&f.app, missing, &[("kition-token", TOKEN)]).await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{missing}");
        assert!(!String::from_utf8_lossy(&answer.bytes).contains("secret"));
    }
    let post =
        Request::builder().method("POST").uri("/kits-ui/mock@1.2.3/index.html").header("host", HOST).header("kition-token", TOKEN).body(Body::empty()).unwrap();
    assert_eq!(send_as_is(&f.app, post).await.status, StatusCode::METHOD_NOT_ALLOWED);

    let listed = call(&f.app, "GET", &api("/kits/editors"), None).await;
    assert_eq!(listed.data()["editors"]["kit.mock"]["base"], "kits-ui/mock@1.2.3/", "{}", listed.json);
    assert_eq!(listed.data()["editors"]["kit.mock"]["installed"], true);
    let started = call(&f.app, "POST", &api("/kits/editors/install"), Some(json!({ "kit": "kit.mock" }))).await;
    assert_eq!((started.status, started.data()["started"].clone()), (StatusCode::ACCEPTED, json!(true)));
    assert_eq!(f.store.installs.lock().unwrap().as_slice(), ["mock"]);
    assert_eq!(call(&f.app, "POST", &api("/kits/editors/install"), Some(json!({ "kit": "nothing" }))).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_kits_list_what_each_edits_and_what_it_only_views() {
    let f = fixture();
    let listed = call(&f.app, "GET", &api("/kits"), None).await;
    let kit = &listed.data()["kits"][0];
    assert_eq!(
        (kit["id"].clone(), kit["extensions"].clone(), kit["views"].clone()),
        (json!("kit.mock"), json!(["mocktext"]), json!(["mockview"])),
        "{}",
        listed.json
    );
}

#[tokio::test]
async fn a_save_over_another_version_is_refused_and_a_save_answers_the_new_one() {
    let f = fixture();
    let stamp = |app: Router| async move {
        let request = Request::builder().method("HEAD").uri("/kit-files/art/note.mocktext").body(Body::empty()).unwrap();
        send(&app, request).await.header("etag").unwrap().to_owned()
    };
    let read = stamp(f.app.clone()).await;
    let put = |expected: &str| {
        let uri = api(&format!("/kits/files?path=art/note.mocktext&document=art/note.mocktext&expected={}", expected.replace('"', "%22")));
        let app = f.app.clone();
        async move { send(&app, Request::builder().method("PUT").uri(uri).body(Body::from("mine")).unwrap()).await }
    };
    // Something else wrote the file after the editor read it.
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(f.root.join("art/note.mocktext"), b"the agent's").unwrap();
    let refused = put(&read).await;
    assert_eq!((refused.status, refused.reason().clone()), (StatusCode::CONFLICT, json!("file_conflict")));
    assert_eq!(std::fs::read(f.root.join("art/note.mocktext")).unwrap(), b"the agent's", "nothing overwritten");
    let now = stamp(f.app.clone()).await;
    let saved = put(&now).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.json);
    assert_eq!(std::fs::read(f.root.join("art/note.mocktext")).unwrap(), b"mine");
    assert_eq!(saved.data()["version"], json!(stamp(f.app.clone()).await), "the save answers the version it made");
}

#[tokio::test]
async fn an_editor_keeps_its_replica_beside_its_document() {
    let f = fixture();
    let mut body = 3u64.to_le_bytes().to_vec();
    body.extend_from_slice(b"snpblobs");
    let put = |uri: String, body: Vec<u8>| {
        let app = f.app.clone();
        async move { send(&app, Request::builder().method("PUT").uri(uri).header("kition-file-stamp", "\"5-1\"").body(Body::from(body)).unwrap()).await }
    };
    assert_eq!(
        call(&f.app, "GET", &api("/kits/replicas?path=art/note.mocktext&kit=kit.mock"), None).await.status,
        StatusCode::NO_CONTENT,
        "none kept: no failure"
    );
    assert_eq!(put(api("/kits/replicas?path=art/note.mocktext&kit=kit.mock"), body.clone()).await.status, StatusCode::OK);
    let read = call(&f.app, "GET", &api("/kits/replicas?path=art/note.mocktext&kit=kit.mock"), None).await;
    assert_eq!((read.status, read.bytes.as_slice(), read.header("kition-file-stamp")), (StatusCode::OK, body.as_slice(), Some("\"5-1\"")));
    assert!(f.root.join(".kition/replicas").is_dir(), "in the workspace's hidden store");
    assert_eq!(
        call(&f.app, "GET", &api("/kits/replicas?path=art/note.mocktext&kit=kit.other"), None).await.status,
        StatusCode::NO_CONTENT,
        "another kit's is not this one's"
    );
    assert_eq!(put(api("/kits/replicas?path=art/note.mocktext&kit=kit.other"), body.clone()).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(api("/kits/replicas?path=art/note.mocktext&kit=kit.mock"), 99u64.to_le_bytes().to_vec()).await.status, StatusCode::BAD_REQUEST);
    for outside in ["../x.mocktext", ".kition/replicas/x.mocktext", "/etc/passwd"] {
        assert_eq!(put(api(&format!("/kits/replicas?path={outside}&kit=kit.mock")), body.clone()).await.status, StatusCode::FORBIDDEN, "{outside}");
    }
}

/// A view state body: the JSON's length (8 bytes, little-endian), the JSON, the bytes.
fn view_state(json: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut body = (json.len() as u64).to_le_bytes().to_vec();
    body.extend_from_slice(json);
    body.extend_from_slice(bytes);
    body
}

/// Every file under `dir`, with its bytes.
fn files_under(dir: &std::path::Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(files_under(&path));
        } else {
            out.push((path.clone(), std::fs::read(&path).unwrap()));
        }
    }
    out
}

#[tokio::test]
async fn an_editor_keeps_the_view_state_outside_the_workspace() {
    let f = fixture();
    let uri = api("/kits/view-state?path=art/note.mocktext&kit=kit.mock");
    let send_body = |method: &'static str, uri: String, body: Vec<u8>| {
        let app = f.app.clone();
        async move { send(&app, Request::builder().method(method).uri(uri).body(Body::from(body)).unwrap()).await }
    };
    assert_eq!(call(&f.app, "GET", &uri, None).await.status, StatusCode::NO_CONTENT, "none kept: no failure");

    // A round trip: JSON and bytes come back as written; the last write wins.
    let first = view_state(br#"{"v":1,"zoom":2}"#, b"\x01\x02\x03");
    assert_eq!(send_body("PUT", uri.clone(), first).await.status, StatusCode::OK);
    let second = view_state(br#"{"v":1,"zoom":3,"marker":"VIEWSTATE-MARKER"}"#, b"VIEWBYTES-MARKER");
    assert_eq!(send_body("PUT", uri.clone(), second.clone()).await.status, StatusCode::OK);
    let read = call(&f.app, "GET", &uri, None).await;
    assert_eq!((read.status, read.bytes.as_slice()), (StatusCode::OK, second.as_slice()));

    // Kept in the gateway's data folder, never in the workspace (nor its replica store).
    assert!(f.data.join("view-state").is_dir(), "in the gateway's data folder");
    for (path, bytes) in files_under(&f.root) {
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("VIEWSTATE-MARKER") && !text.contains("VIEWBYTES-MARKER"), "view state in the workspace: {}", path.display());
    }
    assert_eq!(std::fs::read(f.root.join("art/note.mocktext")).unwrap(), b"hello", "the document is untouched");

    // Another kit's is not this one's, and a kit that does not edit the file keeps none.
    assert_eq!(call(&f.app, "GET", &api("/kits/view-state?path=art/note.mocktext&kit=kit.other"), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(send_body("PUT", api("/kits/view-state?path=art/note.mocktext&kit=kit.other"), view_state(b"{}", b"")).await.status, StatusCode::BAD_REQUEST);

    // Malformed bodies: a length past the end, JSON that is not an object.
    assert_eq!(send_body("PUT", uri.clone(), 99u64.to_le_bytes().to_vec()).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(send_body("PUT", uri.clone(), view_state(b"[1,2]", b"")).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(send_body("PUT", uri.clone(), view_state(b"{nope", b"")).await.status, StatusCode::BAD_REQUEST);

    // The limits: 256 KB of JSON, 16 MB of bytes; over either is refused as too-large, and nothing changes.
    let padding = "x".repeat(kition_kits_http::VIEW_STATE_JSON_LIMIT);
    let big = send_body("PUT", uri.clone(), view_state(format!(r#"{{"p":"{padding}"}}"#).as_bytes(), b"")).await;
    assert_eq!((big.status, big.reason()), (StatusCode::PAYLOAD_TOO_LARGE, &json!("too-large")), "{}", big.json);
    let at_limit = format!(r#"{{"p":"{}"}}"#, "x".repeat(kition_kits_http::VIEW_STATE_JSON_LIMIT - 8));
    assert_eq!(at_limit.len(), kition_kits_http::VIEW_STATE_JSON_LIMIT);
    assert_eq!(send_body("PUT", uri.clone(), view_state(at_limit.as_bytes(), b"")).await.status, StatusCode::OK, "at the limit is kept");
    let heavy = send_body("PUT", uri.clone(), view_state(b"{}", &vec![7u8; kition_kits_http::VIEW_STATE_BYTES_LIMIT + 1])).await;
    assert_eq!((heavy.status, heavy.reason()), (StatusCode::PAYLOAD_TOO_LARGE, &json!("too-large")), "{}", heavy.json);
    assert_eq!(
        send_body("PUT", uri.clone(), view_state(b"{}", &vec![7u8; kition_kits_http::VIEW_STATE_BYTES_LIMIT])).await.status,
        StatusCode::OK,
        "at the limit is kept"
    );
    assert_eq!(send_body("PUT", uri.clone(), second.clone()).await.status, StatusCode::OK);

    // Paths are confined like every other route's.
    for outside in ["../x.mocktext", ".kition/replicas/x.mocktext", "/etc/passwd"] {
        let uri = api(&format!("/kits/view-state?path={outside}&kit=kit.mock"));
        assert_eq!(send_body("PUT", uri.clone(), view_state(b"{}", b"")).await.status, StatusCode::FORBIDDEN, "{outside}");
        assert_eq!(call(&f.app, "GET", &uri, None).await.status, StatusCode::FORBIDDEN, "{outside}");
        assert_eq!(call(&f.app, "DELETE", &uri, None).await.status, StatusCode::FORBIDDEN, "{outside}");
    }

    // A damaged entry reads as none.
    let kept: Vec<PathBuf> = files_under(&f.data.join("view-state")).into_iter().map(|(path, _)| path).collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    let original = std::fs::read(&kept[0]).unwrap();
    std::fs::write(&kept[0], &original[..original.len() / 2]).unwrap();
    assert_eq!(call(&f.app, "GET", &uri, None).await.status, StatusCode::NO_CONTENT, "a truncated entry");
    std::fs::write(&kept[0], b"garbage").unwrap();
    assert_eq!(call(&f.app, "GET", &uri, None).await.status, StatusCode::NO_CONTENT, "a garbled entry");

    // Delete: forgets it; deleting none is no failure.
    assert_eq!(send_body("PUT", uri.clone(), second).await.status, StatusCode::OK);
    assert_eq!(call(&f.app, "DELETE", &uri, None).await.status, StatusCode::OK);
    assert_eq!(call(&f.app, "GET", &uri, None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(call(&f.app, "DELETE", &uri, None).await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_gateway_without_a_data_folder_keeps_no_view_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    write(&root.join("art/note.mocktext"), b"hello");
    let kits = KitManager::new(Some(root.clone()), vec![(&MOCK, None)]);
    let app = support::app(&kits);
    let answer = call(&app, "GET", &api("/kits/view-state?path=art/note.mocktext&kit=kit.mock"), None).await;
    assert_eq!((answer.status, answer.reason()), (StatusCode::NOT_FOUND, &json!("unsupported")));
}
