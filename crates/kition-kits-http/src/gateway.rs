//! The app `kition gateway` serves on loopback for one workspace: the routes of this crate under
//! [`API_PREFIX`], the workspace as kits read it under `/kit-files/`, the kits' editor packages
//! under `/kits-ui/`, the editor page under `/page/`, the gateway's identity, and the health probe,
//! all behind the transport guard (`kition_http_guard::guard`):
//!
//! | Route | Who |
//! | --- | --- |
//! | `GET /health` | anyone on this machine (answers `"healthy"`, nothing else) |
//! | `GET /api/v1/gateway` | the launch token: the gateway's identity ([`app`]'s `identity`) |
//! | `POST /api/v1/mcp/kits` | the launch token ([`crate::mcp`]) |
//! | `/api/v1/kits…` | the token or a page session ([`crate::router`]) |
//! | `GET /api/v1/kits/bridge` | the token, a page session, or a signed URL |
//! | `POST /api/v1/gateway/sign` | the token or a page session: a signed URL for `/kits-ui/` or `/kit-files/` |
//! | `GET /api/v1/gateway/page-session/<nonce>` | a signed URL only, once: opens a page session |
//! | `GET`/`HEAD /kit-files/<path>` | the token, a page session, or a signed URL ([`crate::kit_files`]) |
//! | `GET`/`HEAD /kits-ui/<kit>@<version>/<file>` | the same ([`crate::editors`]) |
//! | `GET`/`HEAD /page/…` | the same ([`crate::page`]) |
//!
//! Every request first passes the loopback `Host` fence and the `Origin` check (no cross-origin
//! caller is allowed), then the token gate; anything refused gets `403` or `401` before routing.
//!
//! How a browser gets in. Behind a same-origin reverse proxy (the primary deployment) the proxy
//! adds `Kition-Token` to every request, the page's sub-resources and the kit frame's included,
//! and the browser holds nothing. Opened directly (`kition gateway --open`, [`open_url`]), the
//! address is a signed URL of `/page/` (good for [`PAGE_SESSION`]) whose fragment carries a signed
//! bootstrap good for [`BOOTSTRAP`] and once: the page trades it for a page session
//! (`/api/v1/gateway/page-session/`), keeps that in the tab's memory (`sessionStorage`), drops the
//! fragment from the address bar, sends the session in `Kition-Token`, and loads the kit's frame
//! from a signed URL of its package's folder (`/api/v1/gateway/sign`), under which every relative
//! sub-resource (scripts, workers, wasm, fonts) is signed too. Fragments are never sent to a
//! server, so neither the token nor the session is in any request line or log; the address left
//! in the history opens nothing once its bootstrap is spent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{get, post};
use http::{Method, header};
use kition_http_guard::cors::CorsPolicy;
use kition_http_guard::gate::{Access, ApiGate, EmptyToken, RequireLaunchToken, RequireToken};
use kition_http_guard::{ApiError, ApiResult, JsonBody, ok};
use kition_kits::KitManager;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::KitsState;
use crate::editors::EditorStore;

/// Where the API routes are, as in Kition's runtime.
pub const API_PREFIX: &str = "/api/v1";
/// The gateway's protocol: its routes, its ready line and its lockfile (`kition gateway`).
pub const PROTOCOL: &str = "kition-gateway/1";

/// Where a page trades its signed bootstrap for a page session.
pub const PAGE_SESSION_ROUTE: &str = "/gateway/page-session/";
/// How long a page session (and the signed URL of the page it was opened with) is good for.
pub const PAGE_SESSION: Duration = Duration::from_secs(12 * 3600);
/// How long a bootstrap is good for: once, and only this long.
pub const BOOTSTRAP: Duration = Duration::from_secs(120);
/// The prefixes `POST /api/v1/gateway/sign` signs.
pub const SIGNED_FOR_PAGES: [&str; 2] = ["/kits-ui/", "/kit-files/"];

/// The gate for `token`: `GET /health` open, and signed URLs for `/kit-files/`, the bridge
/// stream, the editor packages, the editor page and its bootstrap.
pub fn gate(token: &str) -> Result<ApiGate, EmptyToken> {
    Ok(ApiGate::new(token)?
        .open(Method::GET, "/health")
        .signable("/kit-files/")
        .signable(&format!("{API_PREFIX}/kits/bridge"))
        .signable("/kits-ui/")
        .signable("/page/")
        .signable(&format!("{API_PREFIX}{PAGE_SESSION_ROUTE}")))
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs())
}

/// The direct-open address of the editor page of the gateway at `url` with `token`: `/page/`
/// (or `/page/review` with `review`) for the workspace file `file`, signed for [`PAGE_SESSION`],
/// with a bootstrap for one page session good for [`BOOTSTRAP`] in its fragment.
pub fn open_url(token: &str, url: &str, file: Option<&str>, review: bool) -> Result<String, EmptyToken> {
    let gate = ApiGate::new(token)?;
    let now = now_seconds();
    let page = gate.signed_path("/page/", "/page/".len(), now + PAGE_SESSION.as_secs());
    let page = format!("{page}{}", if review { "review" } else { "" });
    let nonce = kition_http_guard::gate::new_token();
    let bootstrap = format!("{API_PREFIX}{PAGE_SESSION_ROUTE}{nonce}");
    let bootstrap = gate.signed_path(&bootstrap, bootstrap.len(), now + BOOTSTRAP.as_secs());
    let query = file.map(|file| format!("?path={}", encode_component(file))).unwrap_or_default();
    Ok(format!("{}{page}{query}#bootstrap={}", url.trim_end_matches('/'), encode_component(&bootstrap)))
}

/// `text` percent-encoded as a URL query or fragment component.
fn encode_component(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// The bootstraps already traded for a page session, until they would have expired anyway.
#[derive(Clone, Default)]
struct Spent(Arc<Mutex<HashMap<String, u64>>>);

impl Spent {
    /// Whether `nonce` is fresh; it is spent from now on.
    fn spend(&self, nonce: &str) -> bool {
        let now = now_seconds();
        let mut spent = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        spent.retain(|_, until| *until >= now);
        spent.insert(nonce.to_owned(), now + BOOTSTRAP.as_secs() + 60).is_none()
    }
}

#[derive(Clone)]
struct PageState {
    gate: ApiGate,
    spent: Spent,
}

/// `GET /api/v1/gateway/page-session/<nonce>`, reached only through a signed URL (a bootstrap):
/// opens a page session for [`PAGE_SESSION`], once per bootstrap.
async fn page_session(State(state): State<PageState>, Path(nonce): Path<String>, request: Request) -> ApiResult<Response> {
    if request.extensions().get::<Access>() != Some(&Access::Signed) {
        return Err(ApiError::unauthorized());
    }
    let plain = nonce.len() == 64 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !plain || !state.spent.spend(&nonce) {
        return Err(ApiError::new(401, 40110, "this address was used already: ask for a new one (kition gateway --open)")
            .with_data(json!({ "reason": "bootstrap_spent" })));
    }
    let (session, expires) = state.gate.open_session(PAGE_SESSION);
    let mut response = ok(json!({ "session": session, "expires": expires }));
    response.headers_mut().insert(header::CACHE_CONTROL, http::HeaderValue::from_static("no-store"));
    Ok(response)
}

#[derive(Deserialize)]
struct SignBody {
    /// A path from the gateway's root, percent-encoded as it will be sent: a file, or a folder
    /// ending in `/` whose files the URL then reaches.
    path: String,
}

/// `POST /api/v1/gateway/sign {path}`: a signed URL path for `path` under `/kits-ui/` or
/// `/kit-files/`, for a frame or a worker that cannot send the page's header. It is good for six
/// to twelve hours, the same for every request in a six-hour window, so the browser's cache
/// keeps a package across page loads.
async fn sign(State(state): State<PageState>, _caller: RequireToken, JsonBody(body): JsonBody<SignBody>) -> ApiResult<Response> {
    let decoded = kition_http_guard::files::percent_decoded(&body.path);
    let plain = !decoded.contains('\\') && !decoded.contains('\0') && decoded.split('/').skip(1).all(|segment| segment != "." && segment != "..");
    if !plain || !SIGNED_FOR_PAGES.iter().any(|prefix| body.path.starts_with(prefix)) || body.path.contains(['?', '#']) {
        return Err(ApiError::new(400, 40005, format!("only a path under {} is signed here", SIGNED_FOR_PAGES.join(" or "))));
    }
    const WINDOW: u64 = 6 * 3600;
    let expires = (now_seconds() / WINDOW + 2) * WINDOW;
    Ok(ok(json!({ "path": state.gate.signed_path(&body.path, body.path.len(), expires), "expires": expires })))
}

/// When the gateway last answered a request other than the health probe.
#[derive(Clone, Debug)]
pub struct Activity(Arc<AtomicU64>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
}

impl Default for Activity {
    fn default() -> Self {
        Self(Arc::new(AtomicU64::new(now_ms())))
    }
}

impl Activity {
    pub fn touch(&self) {
        self.0.store(now_ms(), Ordering::Relaxed);
    }

    /// How long since the last request.
    pub fn idle_for(&self) -> Duration {
        Duration::from_millis(now_ms().saturating_sub(self.0.load(Ordering::Relaxed)))
    }
}

/// The gateway app over `kits` (whose workspace it serves) behind `gate`; `identity` is what
/// `GET /api/v1/gateway` answers; `activity` hears every request but the health probe; `editors`
/// is the host's store of editor packages (none: the page shows that no editor can be loaded).
pub fn app(kits: KitManager, gate: ApiGate, identity: Value, activity: Activity, editors: Option<Arc<dyn EditorStore>>) -> Router {
    let mut state = KitsState::new(kits.clone());
    if let Some(store) = &editors {
        state = state.with_editors(store.clone());
    }
    let pages = PageState { gate: gate.clone(), spent: Spent::default() };
    let gateway = Router::new().route(&format!("{PAGE_SESSION_ROUTE}{{nonce}}"), get(page_session)).route("/gateway/sign", post(sign)).with_state(pages);
    let api = crate::router(state).route("/gateway", get(move |_: RequireLaunchToken| async move { ok(identity) })).merge(gateway);
    let mut app = Router::new().route("/health", get(|| async { ok("healthy") })).nest(API_PREFIX, api).nest_service("/page", crate::page::router());
    if let Some(dir) = kits.workspace_dir() {
        app = app.nest_service("/kit-files", crate::kit_files::router(dir));
    }
    if let Some(store) = editors {
        app = app.nest_service(crate::editors::PREFIX, crate::editors::router(store));
    }
    let app = app.fallback(kition_http_guard::not_found).layer(axum::middleware::from_fn(move |request: Request, next: Next| {
        let activity = activity.clone();
        async move {
            if request.uri().path() != "/health" {
                activity.touch();
            }
            let response: Response = next.run(request).await;
            response
        }
    }));
    kition_http_guard::guard(app, gate, CorsPolicy::default())
}
