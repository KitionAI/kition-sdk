//! The app `kition gateway` serves on loopback for one workspace: the routes of this crate under
//! [`API_PREFIX`], the workspace as kits read it under `/kit-files/`, the gateway's identity, and
//! the health probe, all behind the transport guard (`kition_http_guard::guard`):
//!
//! | Route | Who |
//! | --- | --- |
//! | `GET /health` | anyone on this machine (answers `"healthy"`, nothing else) |
//! | `GET /api/v1/gateway` | the token: the gateway's identity ([`app`]'s `identity`) |
//! | `/api/v1/kits…`, `POST /api/v1/mcp/kits` | the token ([`crate::router`]) |
//! | `GET /api/v1/kits/bridge` | the token, or a signed URL |
//! | `GET`/`HEAD /kit-files/<path>` | the token, or a signed URL ([`crate::kit_files`]) |
//!
//! Every request first passes the loopback `Host` fence and the `Origin` check (no cross-origin
//! caller is allowed), then the token gate; anything refused gets `403` or `401` before routing.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use http::Method;
use kition_http_guard::cors::CorsPolicy;
use kition_http_guard::gate::{ApiGate, EmptyToken, RequireToken};
use kition_http_guard::ok;
use kition_kits::KitManager;
use serde_json::Value;

use crate::KitsState;

/// Where the API routes are, as in Kition's runtime.
pub const API_PREFIX: &str = "/api/v1";
/// The gateway's protocol: its routes, its ready line and its lockfile (`kition gateway`).
pub const PROTOCOL: &str = "kition-gateway/1";

/// The gate for `token`: `GET /health` open, and signed URLs for `/kit-files/` and the bridge
/// stream.
pub fn gate(token: &str) -> Result<ApiGate, EmptyToken> {
    Ok(ApiGate::new(token)?.open(Method::GET, "/health").signable("/kit-files/").signable(&format!("{API_PREFIX}/kits/bridge")))
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
/// `GET /api/v1/gateway` answers; `activity` hears every request but the health probe.
pub fn app(kits: KitManager, gate: ApiGate, identity: Value, activity: Activity) -> Router {
    let api = crate::router(KitsState::new(kits.clone())).route("/gateway", get(move |_: RequireToken| async move { ok(identity) }));
    let mut app = Router::new().route("/health", get(|| async { ok("healthy") })).nest(API_PREFIX, api);
    if let Some(dir) = kits.workspace_dir() {
        app = app.nest_service("/kit-files", crate::kit_files::router(dir));
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
