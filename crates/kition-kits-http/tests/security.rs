//! The gateway's transport and workspace guarantees (sdk.gateway.security, decision R11 of the
//! DeepSeek Harness plugin plan: these pass before any release).
//!
//! - transport: a request not addressed to a loopback host (DNS rebinding) or from a foreign or
//!   opaque (`null`) origin gets `403` before routing, whatever it carries; every route but
//!   `GET /health` needs the token in `Kition-Token` (not a cookie, a query parameter or a bearer
//!   credential), `/mcp/kits` included; no answer allows any origin, let alone `*`.
//! - workspace-paths: the file routes refuse `..`, absolute paths, hidden segments and links out of
//!   the workspace or into its hidden store, and write nothing there (grants and drafts: their
//!   own tests).
//! - kit-files: `/kit-files/` serves workspace files with `nosniff` and, for the types a browser
//!   runs script in, `Content-Security-Policy: sandbox`; it serves no hidden file, no folder, and
//!   nothing a link leads to outside the workspace or into a hidden folder; ranges and stamps.
//! - signed-urls: a signed GET URL reads its scope until it expires, and is no good for another
//!   path, another method, or a route that takes none.

mod support;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use kition_http_guard::TOKEN_HEADER;
use kition_kits::{KitAgent, KitDefinition, KitManager};
use serde_json::json;
use support::{HOST, TOKEN, api, open_bridge, send, send_as_is, write};

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

struct Fixture {
    app: Router,
    root: std::path::PathBuf,
    outside: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (root, outside) = (base.join("workspace"), base.join("outside"));
    write(&root.join("art/note.mocktext"), b"hello");
    write(&root.join("art/photo.png"), b"0123456789");
    write(&root.join("art/page.html"), b"<script>alert(1)</script>");
    write(&root.join("art/logo.svg"), b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    write(&root.join("art/.secret.png"), b"hidden");
    write(&root.join(".kition/state.json"), b"store");
    write(&outside.join("private.png"), b"outside");
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(outside.join("private.png"), root.join("art/escape.png")).unwrap();
        symlink(&outside, root.join("away")).unwrap();
        symlink(root.join(".kition/state.json"), root.join("art/store.json")).unwrap();
        symlink(root.join("art/photo.png"), root.join("art/alias.png")).unwrap();
    }
    let kits = KitManager::new(Some(root.clone()), vec![(&MOCK, None)]);
    Fixture { app: support::app(&kits), root, outside, _dir: dir }
}

fn request(method: &str, uri: &str) -> http::request::Builder {
    Request::builder().method(method).uri(uri).header("content-type", "application/json")
}

/// Every route the gateway serves, with a body each takes.
fn routes() -> Vec<(&'static str, String, String)> {
    let body = |value: serde_json::Value| value.to_string();
    vec![
        ("GET", api("/gateway"), String::new()),
        ("GET", api("/kits"), String::new()),
        ("PUT", api("/kits/files?path=art/new.mockout"), "x".to_owned()),
        ("POST", api("/kits/grants/sessions"), body(json!({ "kit": "kit.mock" }))),
        ("POST", api("/kits/grants/choices"), body(json!({ "session": "fs_x" }))),
        ("POST", api("/kits/grants"), body(json!({ "session": "fs_x", "choice": "ch_x", "rights": ["read"], "flow": "pick" }))),
        ("POST", api("/kits/grants/create"), body(json!({ "session": "fs_x", "suggestedName": "a.png" }))),
        ("POST", api("/kits/grants/release"), body(json!({ "session": "fs_x", "handles": [] }))),
        ("GET", api("/kits/grants/sessions/fs_x"), String::new()),
        ("DELETE", api("/kits/grants/sessions/fs_x"), String::new()),
        ("GET", api("/kits/grants/fh_x?session=fs_x"), String::new()),
        ("GET", api("/kits/grants/fh_x/list?session=fs_x"), String::new()),
        ("GET", api("/kits/grants/fh_x/content?session=fs_x"), String::new()),
        ("PUT", api("/kits/grants/fh_x/content?session=fs_x&offset=0"), "x".to_owned()),
        ("GET", api("/kits/drafts"), String::new()),
        ("GET", api("/kits/drafts/compare?path=art/note.mocktext"), String::new()),
        ("POST", api("/kits/drafts/merge"), body(json!({ "path": "art/note.mocktext" }))),
        ("POST", api("/kits/drafts/discard"), body(json!({ "path": "art/note.mocktext" }))),
        ("GET", api("/kits/bridge"), String::new()),
        ("POST", api("/kits/bridge?session=1"), body(json!({ "jsonrpc": "2.0", "id": 1, "result": {} }))),
        ("POST", api("/mcp/kits"), body(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))),
        ("GET", api("/kits/editors"), String::new()),
        ("POST", api("/kits/editors/install"), body(json!({ "kit": "kit.mock" }))),
        ("GET", api("/kits/replicas?path=art/note.mocktext&kit=kit.mock"), String::new()),
        ("PUT", api("/kits/replicas?path=art/note.mocktext&kit=kit.mock"), "x".repeat(8)),
        ("GET", api("/kits/view-state?path=art/note.mocktext&kit=kit.mock"), String::new()),
        ("PUT", api("/kits/view-state?path=art/note.mocktext&kit=kit.mock"), "x".repeat(8)),
        ("DELETE", api("/kits/view-state?path=art/note.mocktext&kit=kit.mock"), String::new()),
        ("POST", api("/gateway/sign"), body(json!({ "path": "/kits-ui/mock@0.0.0/" }))),
        ("GET", api(&format!("/gateway/page-session/{}", "a".repeat(64))), String::new()),
        ("GET", "/kits-ui/mock@0.0.0/index.html".to_owned(), String::new()),
        ("HEAD", "/kits-ui/mock@0.0.0/index.html".to_owned(), String::new()),
        ("GET", "/page/".to_owned(), String::new()),
        ("GET", "/page/review?path=art/note.mocktext".to_owned(), String::new()),
        ("GET", "/page/page.js".to_owned(), String::new()),
        ("GET", "/kit-files/art/photo.png".to_owned(), String::new()),
        ("HEAD", "/kit-files/art/photo.png".to_owned(), String::new()),
        ("GET", "/no/such/route".to_owned(), String::new()),
    ]
}

#[tokio::test]
async fn every_route_but_health_needs_the_token() {
    let f = fixture();
    let health = send_as_is(&f.app, request("GET", "/health").header("host", HOST).body(Body::empty()).unwrap()).await;
    assert_eq!((health.status, &health.json["data"]), (StatusCode::OK, &json!("healthy")));
    for (method, uri, body) in routes() {
        let carriers: [(&str, String); 6] = [
            ("none", String::new()),
            (TOKEN_HEADER, "wrong".to_owned()),
            (TOKEN_HEADER, format!("{TOKEN} ")),
            ("authorization", format!("Bearer {TOKEN}")),
            ("cookie", format!("kition-token={TOKEN}; Kition-Token={TOKEN}")),
            ("x-kition-token", TOKEN.to_owned()),
        ];
        for (header, value) in carriers {
            let mut built = request(method, &uri).header("host", HOST);
            if header != "none" {
                built = built.header(header, value.as_str());
            }
            let answer = send_as_is(&f.app, built.body(Body::from(body.clone())).unwrap()).await;
            assert_eq!(answer.status, StatusCode::UNAUTHORIZED, "{method} {uri} with {header}");
            if method != "HEAD" {
                assert_eq!(answer.reason(), "api_token", "{method} {uri}");
            }
        }
        let query = if uri.contains('?') { format!("{uri}&token={TOKEN}&kition-token={TOKEN}") } else { format!("{uri}?token={TOKEN}&kition-token={TOKEN}") };
        let answer = send_as_is(&f.app, request(method, &query).header("host", HOST).body(Body::from(body.clone())).unwrap()).await;
        assert_eq!(answer.status, StatusCode::UNAUTHORIZED, "{method} {query}");
    }
    // With the token each is routed (whatever it then answers), and nothing was written before.
    assert!(!f.root.join("art/new.mockout").exists());
    let listed = send(&f.app, request("GET", &api("/kits")).body(Body::empty()).unwrap()).await;
    assert_eq!(listed.status, StatusCode::OK);
    let identity = send(&f.app, request("GET", &api("/gateway")).body(Body::empty()).unwrap()).await;
    assert_eq!(identity.data()["protocol"], kition_kits_http::gateway::PROTOCOL);
}

#[tokio::test]
async fn a_foreign_host_or_origin_is_refused_before_routing() {
    let f = fixture();
    for (method, uri, body) in routes().into_iter().chain([("GET", "/health".to_owned(), String::new())]) {
        for host in ["evil.example", "evil.example:34115", "localhost.evil.example:34115", "127.0.0.1.nip.io:34115", "192.168.1.20:34115", "[::2]:34115"] {
            let answer =
                send_as_is(&f.app, request(method, &uri).header("host", host).header(TOKEN_HEADER, TOKEN).body(Body::from(body.clone())).unwrap()).await;
            assert_eq!(answer.status, StatusCode::FORBIDDEN, "{method} {uri} for {host}");
            assert!(answer.bytes.is_empty(), "{method} {uri} for {host}: nothing is said");
        }
        for origin in ["https://evil.example", "http://localhost:3000", "http://127.0.0.1:1", "null", "file://", ""] {
            for preflight in [false, true] {
                let built = if preflight {
                    request("OPTIONS", &uri).header("access-control-request-method", method).header("access-control-request-headers", "kition-token")
                } else {
                    request(method, &uri).header(TOKEN_HEADER, TOKEN)
                };
                let answer = send_as_is(&f.app, built.header("host", HOST).header("origin", origin).body(Body::from(body.clone())).unwrap()).await;
                assert_eq!(answer.status, StatusCode::FORBIDDEN, "{method} {uri} from {origin:?} (preflight {preflight})");
                assert!(answer.header("access-control-allow-origin").is_none(), "{method} {uri} from {origin:?}");
            }
        }
    }
    // A write from a foreign origin, token and all, changed nothing.
    assert!(!f.root.join("art/new.mockout").exists());
    // The same origin as the Host passes, and no answer ever allows another origin.
    let same = send_as_is(
        &f.app,
        request("GET", &api("/kits")).header("host", HOST).header("origin", format!("http://{HOST}")).header(TOKEN_HEADER, TOKEN).body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(same.status, StatusCode::OK);
    assert!(same.header("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn file_routes_stay_inside_the_workspace() {
    let f = fixture();
    let put = |uri: String| {
        let app = f.app.clone();
        async move { send(&app, request("PUT", &uri).header("content-type", "application/octet-stream").body(Body::from("saved")).unwrap()).await.status }
    };
    assert_eq!(put(api("/kits/files?path=art/note.mocktext&document=art/note.mocktext")).await, StatusCode::OK);
    assert_eq!(std::fs::read_to_string(f.root.join("art/note.mocktext")).unwrap(), "saved");
    let absolute = f.outside.join("x.mockout").display().to_string();
    let inside_absolute = f.root.join("art/abs.mockout").display().to_string();
    for (path, status) in [
        ("art/note.txt", StatusCode::BAD_REQUEST),
        ("../x.mockout", StatusCode::FORBIDDEN),
        ("art/../../x.mockout", StatusCode::FORBIDDEN),
        ("%2e%2e%2fx.mockout", StatusCode::FORBIDDEN),
        ("art%2f..%2f..%2fx.mockout", StatusCode::FORBIDDEN),
        (absolute.as_str(), StatusCode::FORBIDDEN),
        // An absolute path inside the workspace is refused too: a route names workspace paths.
        (inside_absolute.as_str(), StatusCode::FORBIDDEN),
        (".kition/docs/x.mockout", StatusCode::FORBIDDEN),
        ("attachments/.hidden/x.mockout", StatusCode::FORBIDDEN),
        ("art\\x.mockout", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(put(api(&format!("/kits/files?path={path}"))).await, status, "{path}");
    }
    #[cfg(unix)]
    {
        // A link out of the workspace, for a new file or a save over a document behind it.
        assert_eq!(put(api("/kits/files?path=away/new/x.mockout")).await, StatusCode::FORBIDDEN);
        write(&f.outside.join("victim.mocktext"), b"outside");
        std::os::unix::fs::symlink(f.outside.join("victim.mocktext"), f.root.join("art/link.mocktext")).unwrap();
        assert_eq!(put(api("/kits/files?path=art/link.mocktext&document=art/link.mocktext")).await, StatusCode::FORBIDDEN);
        assert_eq!(std::fs::read_to_string(f.outside.join("victim.mocktext")).unwrap(), "outside");
        // regressions/issue-hidden-link-write: a link inside the workspace into its hidden store
        // was written through, as if the store were the person's file.
        write(&f.root.join(".kition/notes.mocktext"), b"store");
        std::os::unix::fs::symlink(f.root.join(".kition/notes.mocktext"), f.root.join("art/store.mocktext")).unwrap();
        assert_eq!(put(api("/kits/files?path=art/store.mocktext&document=art/store.mocktext")).await, StatusCode::FORBIDDEN);
        assert_eq!(std::fs::read_to_string(f.root.join(".kition/notes.mocktext")).unwrap(), "store");
        std::os::unix::fs::symlink(f.root.join(".kition"), f.root.join("store")).unwrap();
        assert_eq!(put(api("/kits/files?path=store/new.mockout")).await, StatusCode::FORBIDDEN);
        assert!(!f.root.join(".kition/new.mockout").exists());
    }
    assert!(!f.outside.join("x.mockout").exists() && !f.outside.join("new").exists());
    assert!(!f.root.join("art/abs.mockout").exists());
}

async fn get(app: &Router, uri: &str, headers: &[(&str, &str)]) -> support::Answer {
    let mut built = request("GET", uri);
    for (name, value) in headers {
        built = built.header(*name, *value);
    }
    send(app, built.body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn kit_files_serve_visible_workspace_files_only_and_harden_them() {
    let f = fixture();
    let photo = get(&f.app, "/kit-files/art/photo.png", &[]).await;
    assert_eq!(photo.status, StatusCode::OK);
    assert_eq!(photo.bytes, b"0123456789");
    assert_eq!(photo.header("content-type"), Some("image/png"));
    assert_eq!(photo.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(photo.header("accept-ranges"), Some("bytes"));
    assert!(photo.header("content-security-policy").is_none(), "an image keeps its viewer");
    let modified = photo.header("last-modified").unwrap().to_owned();
    for (file, mime) in [("art/page.html", "text/html"), ("art/logo.svg", "image/svg+xml")] {
        let scriptable = get(&f.app, &format!("/kit-files/{file}"), &[]).await;
        assert_eq!(scriptable.status, StatusCode::OK, "{file}");
        assert!(scriptable.header("content-type").is_some_and(|value| value.starts_with(mime)), "{file}");
        assert_eq!(scriptable.header("content-security-policy"), Some("sandbox"), "{file}");
        assert_eq!(scriptable.header("x-content-type-options"), Some("nosniff"), "{file}");
    }
    // Ranges, stamps and conditional reads, as kit engines and the editor's host/stamp use them.
    let range = get(&f.app, "/kit-files/art/photo.png", &[("range", "bytes=2-5")]).await;
    assert_eq!((range.status, range.bytes.as_slice(), range.header("content-range")), (StatusCode::PARTIAL_CONTENT, &b"2345"[..], Some("bytes 2-5/10")));
    let beyond = get(&f.app, "/kit-files/art/photo.png", &[("range", "bytes=20-")]).await;
    assert_eq!((beyond.status, beyond.header("content-range")), (StatusCode::RANGE_NOT_SATISFIABLE, Some("bytes */10")));
    let stamp = send(&f.app, request("HEAD", "/kit-files/art/photo.png").body(Body::empty()).unwrap()).await;
    assert_eq!((stamp.status, stamp.bytes.len(), stamp.header("content-length")), (StatusCode::OK, 0, Some("10")));
    let unchanged = get(&f.app, "/kit-files/art/photo.png", &[("if-modified-since", &modified)]).await;
    assert_eq!(unchanged.status, StatusCode::NOT_MODIFIED);
    #[cfg(unix)]
    assert_eq!(get(&f.app, "/kit-files/art/alias.png", &[]).await.bytes, b"0123456789", "a link inside the workspace is followed");
    // Never a hidden file, a folder, or what a link leads to outside or into the store; refused
    // like a missing file. Writes are not served at all.
    let mut refused = vec![
        "/kit-files/art/.secret.png",
        "/kit-files/.kition/state.json",
        "/kit-files/%2ekition/state.json",
        "/kit-files/art/%2E%2E/%2E%2E/outside/private.png",
        "/kit-files/art",
        "/kit-files/",
        "/kit-files/art/missing.png",
    ];
    if cfg!(unix) {
        refused.extend(["/kit-files/art/escape.png", "/kit-files/away/private.png", "/kit-files/art/store.json"]);
    }
    for uri in refused {
        let answer = get(&f.app, uri, &[]).await;
        assert_eq!(answer.status, StatusCode::NOT_FOUND, "{uri}");
        assert!(!answer.bytes.windows(7).any(|window| window == b"outside" || window == b"hidden\0"), "{uri}");
    }
    let written = send(&f.app, request("PUT", "/kit-files/art/photo.png").body(Body::from("x")).unwrap()).await;
    assert_eq!(written.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(std::fs::read(f.root.join("art/photo.png")).unwrap(), b"0123456789");
}

#[tokio::test]
async fn signed_urls_read_their_scope_until_they_expire() {
    let f = fixture();
    let gate = kition_kits_http::gateway::gate(TOKEN).unwrap();
    let later = 4_102_444_800;
    let unsigned = |uri: &str| request("GET", uri).header("host", HOST).body(Body::empty()).unwrap();
    let file = "/kit-files/art/photo.png";
    let read = send_as_is(&f.app, unsigned(&gate.signed_path(file, file.len(), later))).await;
    assert_eq!((read.status, read.bytes.as_slice()), (StatusCode::OK, &b"0123456789"[..]));
    assert_eq!(read.header("x-content-type-options"), Some("nosniff"));
    // A lent root: anything under it.
    let root = "/kit-files/art/";
    let lent = gate.signed_path(root, root.len(), later);
    assert_eq!(send_as_is(&f.app, unsigned(&format!("{lent}page.html"))).await.status, StatusCode::OK);
    // Not for another file, not after it expires, not for a route that takes no signed URL, not
    // for a write.
    for uri in [
        gate.signed_path(file, file.len(), later).replace("photo.png", "page.html"),
        gate.signed_path(file, file.len(), 1),
        gate.signed_path(&api("/kits"), api("/kits").len(), later),
        gate.signed_path(&api("/mcp/kits"), api("/mcp/kits").len(), later),
        kition_kits_http::gateway::gate("another-token").unwrap().signed_path(file, file.len(), later),
    ] {
        assert_eq!(send_as_is(&f.app, unsigned(&uri)).await.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let post = send_as_is(&f.app, request("PUT", &gate.signed_path(file, file.len(), later)).header("host", HOST).body(Body::from("x")).unwrap()).await;
    assert_eq!(post.status, StatusCode::UNAUTHORIZED);
    // Hidden files stay hidden behind a signed lent root.
    assert_eq!(send_as_is(&f.app, unsigned(&format!("{lent}.secret.png"))).await.status, StatusCode::NOT_FOUND);
    // The bridge stream takes one (an EventSource cannot send the header); its answers do not.
    let bridge = api("/kits/bridge");
    let (_events, session) = open_bridge(&f.app, unsigned(&gate.signed_path(&bridge, bridge.len(), later))).await;
    let answer = format!("{bridge}?session={session}");
    let signed_post =
        send_as_is(&f.app, request("POST", &gate.signed_path(&answer, answer.len(), later)).header("host", HOST).body(Body::from("{}")).unwrap()).await;
    assert_eq!(signed_post.status, StatusCode::UNAUTHORIZED);
}
