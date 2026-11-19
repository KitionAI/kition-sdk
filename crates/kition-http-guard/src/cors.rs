//! Request origin checks. The server only answers requests addressed to a loopback host, which
//! defeats DNS rebinding. Same-origin requests and requests without an `Origin` pass; the exact
//! origins a [`CorsPolicy`] names are allowed with credentials (never a wildcard); every other
//! cross-origin request gets `403`, other pages on this machine (`http://localhost:<any port>`)
//! and opaque origins (`null`: sandboxed frames, `file:` pages) among them, so no other page can
//! read an answer or send the API token. Preflights from an allowed origin end with `204` before
//! any other middleware runs, the API token gate included.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};

/// Kition's desktop renderer: `tauri://localhost` on macOS and Linux, and `tauri.localhost` on
/// Windows ([`CorsPolicy::with_desktop_shell`]).
pub const DESKTOP_SHELL_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const ALLOW_METHODS: &str = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
// `Range` lets kit workers read workspace media in ranges (lent files). `Kition-Token` is the
// per-launch API token (`crate::gate`).
const ALLOW_HEADERS: &str = "Authorization,Content-Type,X-Request-Id,X-Locale,Range,Kition-Token";
// Kit editors follow a file by its `ETag`, and lent reads check `Content-Range`. A read through
// a file grant names the whole size in `Kition-File-Size`.
const EXPOSE_HEADERS: &str = "ETag,Content-Range,Accept-Ranges,Kition-File-Size";

/// The cross-origin callers allowed, each named exactly.
#[derive(Clone, Default)]
pub struct CorsPolicy {
    allowed: Arc<[String]>,
}

impl CorsPolicy {
    /// Allows exactly `origins` (a trailing `/` is ignored); empty entries are dropped.
    pub fn new(origins: impl IntoIterator<Item = String>) -> Self {
        Self { allowed: origins.into_iter().map(|origin| origin.trim().trim_end_matches('/').to_owned()).filter(|origin| !origin.is_empty()).collect() }
    }

    /// Allows Kition's desktop renderer as well ([`DESKTOP_SHELL_ORIGINS`]).
    #[must_use]
    pub fn with_desktop_shell(self) -> Self {
        Self::new(self.allowed.iter().cloned().chain(DESKTOP_SHELL_ORIGINS.iter().map(|origin| (*origin).to_owned())))
    }

    fn allows(&self, origin: &str) -> bool {
        // An opaque origin is never anyone's to allow.
        origin != "null" && self.allowed.iter().any(|allowed| allowed == origin)
    }
}

/// Whether a `Host` header names this machine.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let name =
        if let Some(rest) = host.strip_prefix('[') { rest.split(']').next().unwrap_or_default() } else { host.rsplit_once(':').map_or(host, |(name, _)| name) };
    matches!(name.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
}

/// The fence as middleware: the `Host` check, then the `Origin` check.
pub async fn cors(State(policy): State<CorsPolicy>, request: Request, next: Next) -> Response {
    let host_allowed = request.headers().get(header::HOST).map(|value| value.to_str().ok().is_some_and(is_loopback_host)).unwrap_or(true);
    if !host_allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(origin) = request.headers().get(header::ORIGIN).map(|value| value.to_str().unwrap_or("null").to_owned()) else {
        return next.run(request).await;
    };
    let host = request.headers().get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or_default();
    if !host.is_empty() && (origin == format!("http://{host}") || origin == format!("https://{host}")) {
        return next.run(request).await;
    }
    if !policy.allows(&origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(origin_value) = HeaderValue::from_str(&origin) else {
        return StatusCode::FORBIDDEN.into_response();
    };

    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
        headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static(ALLOW_METHODS));
        headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static(ALLOW_HEADERS));
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
        headers.append(header::VARY, HeaderValue::from_static("Access-Control-Request-Method"));
        headers.append(header::VARY, HeaderValue::from_static("Access-Control-Request-Headers"));
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin_value);
        return response;
    }

    let mut response = next.run(request).await;
    apply_normal(response.headers_mut(), origin_value);
    response
}

fn apply_normal(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static(EXPOSE_HEADERS));
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;

    fn app(policy: CorsPolicy) -> Router {
        Router::new().route("/x", get(|| async { "ok" })).layer(axum::middleware::from_fn_with_state(policy, cors))
    }

    fn development() -> CorsPolicy {
        CorsPolicy::new(["http://localhost:5173".to_owned(), "http://127.0.0.1:9000/".to_owned()])
    }

    async fn send(policy: CorsPolicy, request: http::request::Builder) -> Response {
        app(policy).oneshot(request.body(Body::empty()).unwrap_or_default()).await.unwrap_or_else(|err| match err {})
    }

    fn header_text<'a>(response: &'a Response, name: &str) -> Vec<&'a str> {
        response.headers().get_all(name).iter().filter_map(|v| v.to_str().ok()).collect()
    }

    #[tokio::test]
    async fn preflight_from_an_allowed_origin() {
        let response = send(development(), Request::options("/x").header("Origin", "http://localhost:5173").header("Host", "127.0.0.1:18101")).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(header_text(&response, "access-control-allow-origin"), ["http://localhost:5173"]);
        assert_eq!(header_text(&response, "access-control-allow-methods"), [ALLOW_METHODS]);
        assert_eq!(header_text(&response, "vary").len(), 3);
    }

    #[tokio::test]
    async fn an_allowed_origin_gets_its_own_name_back_never_a_wildcard() {
        let response = send(development(), Request::get("/x").header("Origin", "http://127.0.0.1:9000")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header_text(&response, "access-control-allow-origin"), ["http://127.0.0.1:9000"]);
        assert_eq!(header_text(&response, "access-control-allow-credentials"), ["true"]);
        assert_eq!(header_text(&response, "vary"), ["Origin"]);
        assert_eq!(header_text(&response, "access-control-expose-headers"), [EXPOSE_HEADERS]);
        assert!(ALLOW_HEADERS.split(',').any(|name| name == "Range"));
        assert!(ALLOW_HEADERS.split(',').any(|name| name == "Kition-Token"));
        // A policy cannot be talked into a wildcard.
        let wildcard = CorsPolicy::new(["*".to_owned()]);
        let response = send(wildcard, Request::get("/x").header("Origin", "https://example.com")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn other_pages_and_opaque_origins_are_forbidden() {
        // A page in the person's browser served from another local port, the web, or a sandboxed
        // frame can neither read an answer nor pass a preflight to send the API token.
        for policy in [CorsPolicy::default(), development(), CorsPolicy::new(["null".to_owned()])] {
            for origin in ["http://localhost:3001", "http://127.0.0.1:18102", "http://localhost:34115", "https://example.com", "null", "file://"] {
                for request in [
                    Request::get("/x").header("Origin", origin),
                    Request::options("/x")
                        .header("Origin", origin)
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers", "kition-token"),
                ] {
                    let response = send(policy.clone(), request.header("Host", "127.0.0.1:18101")).await;
                    assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
                    assert!(header_text(&response, "access-control-allow-origin").is_empty(), "{origin}");
                }
            }
        }
    }

    #[tokio::test]
    async fn the_desktop_shell_is_allowed_only_when_asked_for() {
        for origin in DESKTOP_SHELL_ORIGINS {
            let response = send(CorsPolicy::default().with_desktop_shell(), Request::get("/x").header("Origin", origin)).await;
            assert_eq!(response.status(), StatusCode::OK, "{origin}");
            assert_eq!(header_text(&response, "access-control-allow-origin"), [origin]);
            assert_eq!(send(CorsPolicy::default(), Request::get("/x").header("Origin", origin)).await.status(), StatusCode::FORBIDDEN);
        }
        let lookalike = send(CorsPolicy::default().with_desktop_shell(), Request::get("/x").header("Origin", "tauri://evil.example")).await;
        assert_eq!(lookalike.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn non_loopback_hosts_are_forbidden() {
        for host in ["evil.example:18101", "192.168.1.5:18101", "localhost.evil.example", "127.0.0.1.evil.example", "[::2]:1", "0.0.0.0:1"] {
            let response = send(CorsPolicy::default(), Request::get("/x").header("Host", host)).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host}");
        }
        for host in ["127.0.0.1:18101", "localhost:3000", "[::1]:18101", "LOCALHOST"] {
            let response = send(CorsPolicy::default(), Request::get("/x").header("Host", host)).await;
            assert_eq!(response.status(), StatusCode::OK, "{host}");
        }
    }

    #[tokio::test]
    async fn same_origin_and_no_origin_pass_through() {
        let same = send(CorsPolicy::default(), Request::get("/x").header("Origin", "http://127.0.0.1:1").header("Host", "127.0.0.1:1")).await;
        assert_eq!(same.status(), StatusCode::OK);
        assert!(header_text(&same, "access-control-allow-origin").is_empty());
        let none = send(CorsPolicy::default(), Request::get("/x")).await;
        assert_eq!(none.status(), StatusCode::OK);
        // An empty Origin is no origin a page sends: refused like `null`.
        let empty = send(CorsPolicy::default(), Request::get("/x").header("Origin", "")).await;
        assert_eq!(empty.status(), StatusCode::FORBIDDEN);
    }
}
