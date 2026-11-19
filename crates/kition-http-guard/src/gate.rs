//! The per-launch API token.
//!
//! A loopback server that edits a person's files must not answer on ambient authority: not
//! another account on the machine, not a page in the person's browser, not a kit's editor frame.
//! Every request carries the token the server made for this launch in the `Kition-Token` header
//! (compared in constant time; never a cookie, never a query parameter), or is a signed URL
//! (`/_signed/…`) made with it for a read that cannot carry a header (`EventSource`, a kit
//! engine's lent reads). Anything else gets `401` before routing, so it has no side effect. A
//! short list of routes stays open (the health probe).
//!
//! A signed URL is `/_signed/<expires>.<length>.<signature>/<path>`: `<signature>` is the
//! lower-case hex HMAC-SHA-256, keyed with the token, of `<expires>\n<scope>`, where `<scope>` is
//! the first `<length>` bytes of `/<path>` as sent (percent-encoded). A URL for one file signs
//! the whole path; a lent root signs a folder and the kit appends the rest. It serves `GET` and
//! `HEAD` only, until `<expires>` (Unix seconds), and only under the prefixes the gate names as
//! signable. The request is routed as `/<path>`.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use http::{Method, StatusCode, Uri};
use sha2::{Digest, Sha256};

use crate::envelope::{ApiError, Envelope};

/// The request header that carries the token.
pub const TOKEN_HEADER: &str = "kition-token";
/// Where signed URLs start.
pub const SIGNED_ROOT: &str = "/_signed/";
/// `data.reason` of the `401` answer.
pub const REFUSAL_REASON: &str = "api_token";
/// The message of the `401` answer.
pub const REFUSAL_MESSAGE: &str = "This request needs Kition's API token.";

/// How a request passed the gate; the gate puts it in the request's extensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// It carried the token.
    Token,
    /// A signed URL for one read.
    Signed,
    /// A route on the open list.
    Open,
}

/// The gate: this launch's token, the open routes, and the paths a signed URL may name.
#[derive(Clone)]
pub struct ApiGate(Arc<Inner>);

#[derive(Clone)]
struct Inner {
    token: String,
    open: Vec<(Method, String)>,
    signable: Vec<String>,
}

/// A new token: 256 random bits, lower-case hex.
pub fn new_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

/// An empty token would let everyone in, so the gate refuses to be made with one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyToken;

impl std::fmt::Display for EmptyToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the API gate needs a token")
    }
}

impl std::error::Error for EmptyToken {}

impl ApiGate {
    /// The gate for `token`, with no open route and nothing signable yet.
    pub fn new(token: &str) -> Result<Self, EmptyToken> {
        if token.is_empty() {
            return Err(EmptyToken);
        }
        Ok(Self(Arc::new(Inner { token: token.to_owned(), open: Vec::new(), signable: Vec::new() })))
    }

    fn inner_mut(&mut self) -> &mut Inner {
        Arc::make_mut(&mut self.0)
    }

    /// Lets `method` on exactly `path` through without the token.
    #[must_use]
    pub fn open(mut self, method: Method, path: &str) -> Self {
        self.inner_mut().open.push((method, path.to_owned()));
        self
    }

    /// Lets a signed URL name paths under `prefix`.
    #[must_use]
    pub fn signable(mut self, prefix: &str) -> Self {
        self.inner_mut().signable.push(prefix.to_owned());
        self
    }

    /// The routes that need no token, as `(method, path)`.
    pub fn open_routes(&self) -> impl Iterator<Item = (&Method, &str)> {
        self.0.open.iter().map(|(method, path)| (method, path.as_str()))
    }

    /// The signature of `scope` until `expires`.
    pub fn signature(&self, scope: &str, expires: u64) -> String {
        hex::encode(hmac_sha256(self.0.token.as_bytes(), format!("{expires}\n{scope}").as_bytes()))
    }

    /// A signed URL path for `path` (percent-encoded, from `/`), whose first `scope_len` bytes are
    /// signed.
    pub fn signed_path(&self, path: &str, scope_len: usize, expires: u64) -> String {
        let scope = path.get(..scope_len).unwrap_or(path);
        format!("{SIGNED_ROOT}{expires}.{}.{}{path}", scope.len(), self.signature(scope, expires))
    }

    /// Whether `presented` is this launch's token, in time that does not depend on where they
    /// differ.
    pub fn token_matches(&self, presented: &[u8]) -> bool {
        constant_time_eq(presented, self.0.token.as_bytes())
    }

    fn is_open(&self, method: &Method, path: &str) -> bool {
        self.0.open.iter().any(|(open_method, open_path)| open_method == method && open_path == path)
    }

    /// The path a signed URL path names, when its signature holds now.
    fn verify_signed(&self, method: &Method, path: &str, now: u64) -> Option<String> {
        if method != Method::GET && method != Method::HEAD {
            return None;
        }
        let rest = path.strip_prefix(SIGNED_ROOT)?;
        let (stamp, target) = rest.split_at(rest.find('/')?);
        let mut parts = stamp.splitn(3, '.');
        let expires: u64 = parts.next()?.parse().ok()?;
        let length: usize = parts.next()?.parse().ok()?;
        let signature = hex::decode(parts.next()?).ok()?;
        if expires < now || length == 0 {
            return None;
        }
        let scope = target.get(..length)?;
        if !self.0.signable.iter().any(|prefix| scope.starts_with(prefix.as_str())) {
            return None;
        }
        let expected = hmac_sha256(self.0.token.as_bytes(), format!("{expires}\n{scope}").as_bytes());
        constant_time_eq(&signature, &expected).then(|| target.to_owned())
    }
}

/// The gate as middleware. Put it in front of routing ([`crate::guard`]): a signed URL is routed
/// by the path it names.
pub async fn require(State(gate): State<ApiGate>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if path.starts_with(SIGNED_ROOT) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
        let Some(target) = gate.verify_signed(request.method(), &path, now) else {
            return refused();
        };
        let rewritten = match request.uri().query() {
            Some(query) => format!("{target}?{query}"),
            None => target,
        };
        let Ok(uri) = rewritten.parse::<Uri>() else {
            return refused();
        };
        *request.uri_mut() = uri;
        request.extensions_mut().insert(Access::Signed);
        return next.run(request).await;
    }
    let access = if request.headers().get(TOKEN_HEADER).is_some_and(|value| gate.token_matches(value.as_bytes())) {
        Access::Token
    } else if gate.is_open(request.method(), &path) {
        Access::Open
    } else {
        return refused();
    };
    request.extensions_mut().insert(access);
    next.run(request).await
}

/// The `401` every refused request gets.
pub fn refused() -> Response {
    (StatusCode::UNAUTHORIZED, Json(Envelope::failure(401, REFUSAL_MESSAGE, serde_json::json!({ "reason": REFUSAL_REASON })))).into_response()
}

/// A route that only a caller with the token reaches: not a signed URL, not an open route, and
/// not a request that came through no gate at all (a router mounted without [`crate::guard`]
/// refuses every request that names this extractor).
#[derive(Debug, Clone, Copy)]
pub struct RequireToken;

impl<S: Send + Sync> FromRequestParts<S> for RequireToken {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        match parts.extensions.get::<Access>() {
            Some(Access::Token) => Ok(Self),
            _ => Err(ApiError::unauthorized()),
        }
    }
}

/// A route that a caller with the token or a signed URL reaches (a stream an `EventSource`
/// opens), never an open route or a request that came through no gate.
#[derive(Debug, Clone, Copy)]
pub struct RequireTokenOrSigned;

impl<S: Send + Sync> FromRequestParts<S> for RequireTokenOrSigned {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        match parts.extensions.get::<Access>() {
            Some(Access::Token | Access::Signed) => Ok(Self),
            _ => Err(ApiError::unauthorized()),
        }
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

/// HMAC-SHA-256 (RFC 2104).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::{get, post};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    const TOKEN: &str = "test-token";

    fn gate(token: &str) -> ApiGate {
        ApiGate::new(token).unwrap().open(Method::GET, "/health").signable("/workspace-files/").signable("/kit-files/").signable("/api/v1/kits/bridge")
    }

    fn app() -> (Router, ApiGate) {
        let gate = gate(TOKEN);
        let inner = Router::new()
            .route("/health", get(|| async { "healthy" }))
            .route("/api/v1/hooks", post(|| async { "made" }))
            .route("/api/v1/needs-token", get(|_: RequireToken| async { "token" }))
            .route("/workspace-files/{*path}", get(|request: Request| async move { format!("{} {:?}", request.uri(), request.extensions().get::<Access>()) }))
            .route("/api/v1/kits/bridge", get(|_: RequireTokenOrSigned| async { "stream" }));
        (crate::guard(inner, gate.clone(), crate::cors::CorsPolicy::default()), gate)
    }

    async fn send(app: &Router, request: http::request::Builder) -> (StatusCode, String) {
        let response = app.clone().oneshot(request.body(Body::empty()).unwrap_or_default()).await.unwrap_or_else(|err| match err {});
        let status = response.status();
        let bytes = response.into_body().collect().await.map(|body| body.to_bytes()).unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2.
        assert_eq!(hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: a key longer than the block.
        assert_eq!(
            hex::encode(hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn signed_paths_match_the_runtime_contracts_example() {
        // Kition's renderer checks the same example (its src/services/runtimeAuth.spec.ts).
        assert_eq!(
            gate(TOKEN).signed_path("/kit-files/", 11, 4_102_444_800),
            "/_signed/4102444800.11.38171d08275ed2553e0d9f40dfd420d46ee6117cb075fb48a5b4e0c8e7e75d3a/kit-files/"
        );
    }

    #[test]
    fn tokens_are_long_and_fresh_and_never_empty() {
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert_ne!(token, new_token());
        assert_eq!(ApiGate::new("").err(), Some(EmptyToken));
    }

    #[tokio::test]
    async fn requests_without_the_token_are_refused_before_routing() {
        let (app, _) = app();
        let (status, body) = send(&app, Request::post("/api/v1/hooks")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains(REFUSAL_REASON), "{body}");
        let envelope: Envelope = serde_json::from_str(&body).unwrap();
        assert_eq!((envelope.code, envelope.message.as_str()), (401, REFUSAL_MESSAGE));
        // An unknown path is refused too, not answered 404: nothing reveals the routes.
        assert_eq!(send(&app, Request::get("/no/such/route")).await.0, StatusCode::UNAUTHORIZED);
        for wrong in ["", "test-toke", "test-token2", "TEST-TOKEN", "test-token "] {
            let (status, _) = send(&app, Request::post("/api/v1/hooks").header(TOKEN_HEADER, wrong)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{wrong:?}");
        }
        // The token belongs in its own header: a bearer credential, a cookie or a query parameter
        // is not it.
        for request in [
            Request::post("/api/v1/hooks").header("Authorization", "Bearer test-token"),
            Request::post("/api/v1/hooks").header("Cookie", "kition-token=test-token; Kition-Token=test-token"),
            Request::post("/api/v1/hooks?token=test-token&kition-token=test-token"),
        ] {
            assert_eq!(send(&app, request).await.0, StatusCode::UNAUTHORIZED);
        }
        let (status, body) = send(&app, Request::post("/api/v1/hooks").header(TOKEN_HEADER, TOKEN)).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "made"));
        let (status, body) = send(&app, Request::post("/api/v1/hooks").header("Kition-Token", TOKEN)).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "made"), "header names are case-insensitive");
    }

    #[tokio::test]
    async fn only_the_open_list_needs_no_token() {
        let (app, gate) = app();
        assert_eq!(gate.open_routes().map(|(method, path)| format!("{method} {path}")).collect::<Vec<_>>(), ["GET /health"]);
        assert_eq!(send(&app, Request::get("/health")).await.0, StatusCode::OK);
        // The open list names a method too.
        assert_eq!(send(&app, Request::post("/health")).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_route_that_needs_the_token_refuses_a_signed_url_and_an_ungated_router() {
        let (app, gate) = app();
        let later = 4_102_444_800;
        let path = "/api/v1/needs-token";
        assert_eq!(send(&app, Request::get(path).header(TOKEN_HEADER, TOKEN)).await.0, StatusCode::OK);
        // Not signable, so refused by the gate; and the route itself refuses anything but the token.
        assert_eq!(send(&app, Request::get(gate.signed_path(path, path.len(), later))).await.0, StatusCode::UNAUTHORIZED);
        let ungated = Router::new().route(path, get(|_: RequireToken| async { "token" }));
        assert_eq!(send(&ungated, Request::get(path).header(TOKEN_HEADER, TOKEN)).await.0, StatusCode::UNAUTHORIZED);
        let ungated = Router::new().route(path, get(|_: RequireTokenOrSigned| async { "stream" }));
        assert_eq!(send(&ungated, Request::get(path)).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn signed_urls_read_one_scope_until_they_expire() {
        let (app, gate) = app();
        let later = 4_102_444_800;
        let file = "/workspace-files/art/cover%20one.png";
        let (status, body) = send(&app, Request::get(format!("{}?v=2", gate.signed_path(file, file.len(), later)))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, format!("{file}?v=2 Some(Signed)"));

        // A folder scope: anything below it.
        let root = "/workspace-files/art/";
        let signed_root = gate.signed_path(root, root.len(), later);
        assert_eq!(send(&app, Request::get(format!("{signed_root}deep/clip.mp4"))).await.0, StatusCode::OK);

        let refusals = [
            // Another file than the one signed: a URL cannot be replayed for another path.
            gate.signed_path(file, file.len(), later).replace("cover%20one", "cover%20two"),
            // Outside the signed folder (the browser resolves `..` before it sends).
            format!("{}/workspace-files/secret.txt", {
                let signed = gate.signed_path(root, root.len(), later);
                signed[..signed.len() - root.len()].to_owned()
            }),
            // Expired.
            gate.signed_path(file, file.len(), 1),
            // A later expiry than the one signed.
            gate.signed_path(file, file.len(), later).replacen(&later.to_string(), &(later + 1).to_string(), 1),
            // A route a signed URL never serves.
            gate.signed_path("/api/v1/hooks", 13, later),
            // Signed with another token.
            super::tests::gate("other").signed_path(file, file.len(), later),
            // Malformed.
            "/_signed/x/workspace-files/a.png".to_owned(),
            format!("/_signed/{later}.0.00/workspace-files/a.png"),
            format!("/_signed/{later}.999.00/workspace-files/a.png"),
        ];
        for path in refusals {
            assert_eq!(send(&app, Request::get(&path)).await.0, StatusCode::UNAUTHORIZED, "{path}");
        }
        // Reads only.
        assert_eq!(send(&app, Request::post(gate.signed_path(file, file.len(), later))).await.0, StatusCode::UNAUTHORIZED);
        let bridge = "/api/v1/kits/bridge";
        assert_eq!(send(&app, Request::get(gate.signed_path(bridge, bridge.len(), later))).await.0, StatusCode::OK);
    }
}
