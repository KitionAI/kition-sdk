//! The transport guard of Kition's loopback HTTP servers (`kition gateway`, and Kition's own
//! runtime, which syncs this crate): what every answer and every refusal looks like, and the
//! checks every request passes before it reaches a route.
//!
//! - [`envelope`]: the JSON envelope `{"code", "message", "data"}` every route answers, its
//!   errors ([`ApiError`]), and the JSON body extractor ([`JsonBody`]).
//! - [`cors`]: the loopback `Host` fence (DNS rebinding) and the `Origin` policy: same-origin
//!   requests, requests without an `Origin`, and the exact origins a [`cors::CorsPolicy`] names
//!   pass; every other origin, `null` among them, gets `403` before routing.
//! - [`gate`]: the per-launch API token in the `Kition-Token` header, compared in constant time,
//!   and signed GET URLs for reads that cannot carry a header; anything else gets `401` before
//!   routing, apart from a short list of open routes.
//! - [`files`]: the headers a served workspace file carries (`nosniff`, a sandboxing CSP).
//!
//! [`guard`] puts the fence and the gate in front of a router, in that order.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod cors;
pub mod envelope;
pub mod files;
pub mod gate;

use axum::Router;

pub use envelope::{ApiError, ApiResult, Envelope, JsonBody, ok};
pub use gate::{Access, ApiGate, RequireToken, TOKEN_HEADER};

/// `routes` behind the transport checks: the loopback `Host` and origin checks ([`cors`]), then
/// the API token gate ([`gate`]), both in front of routing, so a refused request reaches no route
/// and an unknown path is refused like a known one.
pub fn guard(routes: Router, gate: gate::ApiGate, policy: cors::CorsPolicy) -> Router {
    Router::new()
        .fallback_service(routes)
        .layer(axum::middleware::from_fn_with_state(gate, gate::require))
        .layer(axum::middleware::from_fn_with_state(policy, cors::cors))
}

/// The answer for unknown routes behind the gate.
pub async fn not_found() -> axum::response::Response {
    use axum::response::IntoResponse;
    (http::StatusCode::NOT_FOUND, [(http::header::CONTENT_TYPE, "text/plain")], "404 page not found").into_response()
}
