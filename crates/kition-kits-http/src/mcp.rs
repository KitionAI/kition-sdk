//! `POST /mcp/kits`: the kit tools as an MCP server over Streamable HTTP (`kition_kits::mcp`).
//!
//! It is stateless, as MCP clients that reach it work best with it: a request is answered `200`
//! with one JSON-RPC answer as `application/json`; a notification or a response is accepted with
//! `202` and no body; a batch or a body that is no JSON gets `400`; `GET` and `DELETE` get `405`
//! (no server-initiated stream and no session to end), and no `Mcp-Session-Id` is ever issued, so
//! a server restarted on the same address and token is the same server to its clients.
//!
//! Callers are told apart without sessions. A client that names its connection in every message
//! with `Kition-Mcp-Connection: <id>` (16 to 128 letters, digits, `-` or `_`, drawn at random:
//! `kition mcp` relaying to a gateway sends one) has its own requests in flight, so its request
//! ids and its `notifications/cancelled` meet no other connection's, and its own agent, named on
//! its `initialize` from `clientInfo.name` with a suffix taken from the id. A message without it
//! is a connection of its own: its request id collides with nobody's, it cannot be cancelled by a
//! later message (closing the HTTP request cancels it), and it acts as the server process's agent.
//!
//! `Kition-Mcp-Options` carries the call options the client's own server would have had, as JSON:
//! `{"draft": true}` (`--drafts`), `{"guard": "premise"|"epoch"|"off"}` (`--guard`),
//! `{"requireBasis": true}` (`--require-basis`); without it, the defaults.
//!
//! Server-to-client notifications (`notifications/progress`, `notifications/tools/list_changed`)
//! have no stream to go on and are dropped.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode, header};
use kition_http_guard::gate::RequireToken;
use kition_http_guard::{ApiError, JsonBody};
use kition_kits::mcp::Session;
use kition_kits::tools::{CallOptions, Guard};
use serde_json::Value;

use crate::KitsState;

/// The header that names a client's connection.
pub const CONNECTION_HEADER: &str = "kition-mcp-connection";
/// The header that carries a client's call options.
pub const OPTIONS_HEADER: &str = "kition-mcp-options";
/// The most connections remembered; the one used longest ago goes first.
const MOST_CONNECTIONS: usize = 512;

/// The connections that named themselves.
#[derive(Default)]
pub struct Connections {
    sessions: Mutex<HashMap<String, (Arc<Session>, Instant)>>,
}

impl Connections {
    /// The session of connection `id`, made when it is first seen.
    fn session(&self, id: &str) -> Arc<Session> {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((session, used)) = sessions.get_mut(id) {
            *used = Instant::now();
            return Arc::clone(session);
        }
        if sessions.len() >= MOST_CONNECTIONS
            && let Some(oldest) = sessions.iter().min_by_key(|(_, (_, used))| *used).map(|(id, _)| id.clone())
        {
            sessions.remove(&oldest);
        }
        let session = Arc::new(Session::for_connection(id));
        sessions.insert(id.to_owned(), (Arc::clone(&session), Instant::now()));
        session
    }

    /// How many connections are remembered.
    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn bad(message: &str) -> ApiError {
    ApiError::bad_request(message)
}

/// A connection id as [`CONNECTION_HEADER`] may carry it.
fn connection_id(headers: &HeaderMap) -> Result<Option<&str>, ApiError> {
    let Some(value) = headers.get(CONNECTION_HEADER) else { return Ok(None) };
    let id = value.to_str().map_err(|_| bad("Kition-Mcp-Connection is 16 to 128 letters, digits, - or _"))?;
    let fits = (16..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !fits {
        return Err(bad("Kition-Mcp-Connection is 16 to 128 letters, digits, - or _"));
    }
    Ok(Some(id))
}

/// The call options [`OPTIONS_HEADER`] carries.
fn call_options(headers: &HeaderMap) -> Result<CallOptions, ApiError> {
    let Some(value) = headers.get(OPTIONS_HEADER) else { return Ok(CallOptions::default()) };
    let refused = || bad("Kition-Mcp-Options is a JSON object with draft, guard (premise, epoch or off) and requireBasis");
    let options: Value = value.to_str().ok().and_then(|text| serde_json::from_str(text).ok()).filter(Value::is_object).ok_or_else(refused)?;
    let flag = |name: &str| match options.get(name) {
        None => Ok(false),
        Some(Value::Bool(on)) => Ok(*on),
        Some(_) => Err(refused()),
    };
    let guard = match options.get("guard") {
        None => Guard::default(),
        Some(Value::String(mode)) => Guard::parse(mode).ok_or_else(refused)?,
        Some(_) => return Err(refused()),
    };
    if options.as_object().is_some_and(|object| object.keys().any(|key| !matches!(key.as_str(), "draft" | "guard" | "requireBasis"))) {
        return Err(refused());
    }
    Ok(CallOptions { draft: flag("draft")?, guard, require_basis: flag("requireBasis")? })
}

/// `POST /mcp/kits`.
pub async fn handle(State(state): State<KitsState>, _caller: RequireToken, headers: HeaderMap, JsonBody(message): JsonBody<Value>) -> Response {
    let options = match call_options(&headers) {
        Ok(options) => options,
        Err(refused) => return refused.into_response(),
    };
    let session = match connection_id(&headers) {
        Ok(Some(id)) => state.mcp.session(id),
        Ok(None) => Arc::new(Session::single_message()),
        Err(refused) => return refused.into_response(),
    };
    match kition_kits::mcp::handle_in(&state.kits, &session, &message, options).await {
        Some(answer) => ([(header::CONTENT_TYPE, "application/json")], answer.to_string()).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            if let Ok(value) = http::HeaderValue::from_str(value) {
                map.insert(*name, value);
            }
        }
        map
    }

    #[test]
    fn reads_connection_ids_and_options() {
        assert_eq!(connection_id(&headers(&[])).ok(), Some(None));
        assert_eq!(connection_id(&headers(&[(CONNECTION_HEADER, "abcdefABCDEF0123-_")])).ok(), Some(Some("abcdefABCDEF0123-_")));
        for refused in ["short", "has space in it 0123", "slash/in/it/0123456", &"x".repeat(129)] {
            assert!(connection_id(&headers(&[(CONNECTION_HEADER, refused)])).is_err(), "{refused}");
        }
        assert_eq!(call_options(&headers(&[])).ok(), Some(CallOptions::default()));
        let options = call_options(&headers(&[(OPTIONS_HEADER, r#"{"draft":true,"guard":"epoch","requireBasis":true}"#)])).ok();
        assert_eq!(options, Some(CallOptions { draft: true, guard: Guard::Epoch, require_basis: true }));
        for refused in ["[]", "{\"guard\":\"loose\"}", "{\"draft\":1}", "{\"other\":true}", "not json"] {
            assert!(call_options(&headers(&[(OPTIONS_HEADER, refused)])).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_connection_keeps_its_session_and_the_oldest_goes_first() {
        let connections = Connections::default();
        let first = connections.session("connection-aaaaaaaaaaaa");
        assert!(Arc::ptr_eq(&first, &connections.session("connection-aaaaaaaaaaaa")));
        for index in 0..MOST_CONNECTIONS {
            connections.session(&format!("connection-{index:012}"));
        }
        assert_eq!(connections.len(), MOST_CONNECTIONS);
        assert!(!Arc::ptr_eq(&first, &connections.session("connection-aaaaaaaaaaaa")), "the oldest was forgotten");
    }
}
