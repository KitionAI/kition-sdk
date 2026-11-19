//! What the route tests share: the gateway app as `kition gateway` serves it (the transport guard
//! in front of the routes), requests sent with or without its token, server-sent events read
//! from a response, and the mock kit standing in for a real one.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use http::{HeaderMap, Request, StatusCode};
use http_body_util::BodyExt;
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};
use tower::ServiceExt;

pub const TOKEN: &str = "routes-test-token-0123456789abcdef0123456789abcdef0123456789abcd";
pub const HOST: &str = "127.0.0.1:34115";

/// The gateway app over `kits`, as `kition gateway` serves it.
pub fn app(kits: &KitManager) -> Router {
    let gate = kition_kits_http::gateway::gate(TOKEN).unwrap();
    let identity = json!({ "protocol": kition_kits_http::gateway::PROTOCOL, "pid": 1, "workspace": "test" });
    kition_kits_http::gateway::app(kits.clone(), gate, identity, kition_kits_http::gateway::Activity::default())
}

/// The API path of `path` (`/kits` is `/api/v1/kits`).
pub fn api(path: &str) -> String {
    format!("{}{path}", kition_kits_http::gateway::API_PREFIX)
}

pub struct Answer {
    pub status: StatusCode,
    pub json: Value,
    pub bytes: Vec<u8>,
    pub headers: HeaderMap,
}

impl Answer {
    pub fn data(&self) -> &Value {
        &self.json["data"]
    }

    pub fn reason(&self) -> &Value {
        &self.json["data"]["reason"]
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

/// Sends `request` as it is.
pub async fn send_as_is(app: &Router, request: Request<Body>) -> Answer {
    let response = app.clone().oneshot(request).await.unwrap_or_else(|err| match err {});
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Answer { status, json, bytes, headers }
}

/// Sends `request` with the token and a loopback `Host`.
pub async fn send(app: &Router, mut request: Request<Body>) -> Answer {
    request.headers_mut().insert(kition_http_guard::TOKEN_HEADER, http::HeaderValue::from_static(TOKEN));
    request.headers_mut().entry(http::header::HOST).or_insert(http::HeaderValue::from_static(HOST));
    send_as_is(app, request).await
}

/// A JSON request to `uri` with the token.
pub async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> Answer {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap();
    send(app, request).await
}

/// `PUT` of `bytes` to `uri` with the token.
pub async fn put(app: &Router, uri: &str, bytes: &'static str) -> Answer {
    let request = Request::builder().method("PUT").uri(uri).header("content-type", "application/octet-stream").body(Body::from(bytes)).unwrap();
    send(app, request).await
}

/// Reads server-sent events from a response body, one JSON message per `data:` line.
pub struct Events {
    pub body: Body,
    pub buffer: String,
}

impl Events {
    pub async fn next(&mut self) -> Value {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let frame: String = self.buffer.drain(..end + 2).collect();
                let data: String = frame.lines().filter_map(|line| line.strip_prefix("data:")).map(str::trim).collect();
                if data.is_empty() {
                    continue;
                }
                return serde_json::from_str(&data).unwrap_or_else(|err| panic!("{err}: {data}"));
            }
            let frame = tokio::time::timeout(std::time::Duration::from_secs(30), self.body.frame())
                .await
                .unwrap_or_else(|_| panic!("no event in time"))
                .unwrap_or_else(|| panic!("the stream ended"))
                .unwrap();
            if let Ok(bytes) = frame.into_data() {
                self.buffer.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    }
}

/// Opens the bridge stream with `request` (the token's or a signed URL's) and reads its
/// `bridge.ready`: the events and the session id.
pub async fn open_bridge(app: &Router, request: Request<Body>) -> (Events, u64) {
    let response = app.clone().oneshot(request).await.unwrap_or_else(|err| match err {});
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut events = Events { body: response.into_body(), buffer: String::new() };
    let ready = events.next().await;
    assert_eq!(ready["method"], "bridge.ready");
    let session = ready["params"]["session"].as_u64().unwrap();
    (events, session)
}

/// The bridge stream with the token.
pub async fn bridge(app: &Router) -> (Events, u64) {
    let request = Request::builder().uri(api("/kits/bridge")).header(kition_http_guard::TOKEN_HEADER, TOKEN).header("host", HOST).body(Body::empty()).unwrap();
    open_bridge(app, request).await
}

/// An editor window's post to the bridge.
pub async fn post_bridge(app: &Router, session: u64, message: Value) -> StatusCode {
    call(app, "POST", &format!("{}?session={session}", api("/kits/bridge")), Some(message)).await.status
}

/// A built workspace binary, found from the test executable's folder.
pub fn workspace_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::current_exe().ok().and_then(|exe| {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        exe.parent()?.ancestors().map(|dir| dir.join(&name)).find(|path| path.is_file())
    });
    assert!(path.is_some() || std::env::var_os("CI").is_none(), "build {name} first (cargo build -p {name})");
    path
}

pub fn mock_binary() -> Option<PathBuf> {
    workspace_binary("kition-kit-mock")
}

/// The Example kit (kition-kits' `tests/support/example.json`), served by the mock kit standing
/// in for it: a launcher in `dir` that starts the mock as `kit.example`. `None` without the mock.
#[cfg(unix)]
pub fn example_kit(dir: &Path) -> Option<(&'static KitDefinition, PathBuf)> {
    use std::os::unix::fs::PermissionsExt;
    let mock = mock_binary()?;
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../kition-kits/tests/support/example.json")).unwrap())
            .unwrap();
    let version = manifest["version"].as_str().unwrap_or_default().to_owned();
    let launcher = dir.join("kition-example");
    std::fs::write(
        &launcher,
        format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={version} exec '{}' \"$@\"\n", mock.display()),
    )
    .unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
    Some((KitDefinition::from_manifest(&manifest).unwrap(), launcher))
}

pub fn write(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, bytes).unwrap();
}
