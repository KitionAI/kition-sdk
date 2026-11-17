//! The JSON-RPC 2.0 envelope every `kition-sync/1` message uses, and its parsing. Method name
//! constants and the typed params/results for each method are [`crate::messages`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// A request id: an integer or a string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

/// The stable reason a failure carries in `error.data.code`; distinct from the JSON-RPC
/// `code`/`message`, which are for logs and people.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Invalid,
    Unavailable,
    /// The connection or its principal sends faster than the server allows (protocol 1.5);
    /// `error.data.retryAfterMs`, when present, is how long to wait before trying again.
    RateLimited,
    /// The room is at the server's limit of people co-editing at once (Kition Server's free
    /// limit); `error.data.limit` is that number. The person can still open, edit, and save the
    /// document alone.
    CollabLimit,
}

/// A JSON-RPC error object. `data.code` is one of [`ErrorCode`] for every error this protocol
/// itself defines; peers MAY send other JSON-RPC errors (`-32601` unknown method and the like)
/// with no `data`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message} ({code})")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// The code every [`ErrorCode`] error uses; JSON-RPC reserves `-32000` to `-32099` for the
    /// application, and the stable reason lives in `data.code` instead of this number.
    pub const APPLICATION_ERROR: i64 = -32000;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn invalid_params(detail: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(Self::INTERNAL_ERROR, detail)
    }

    /// One of this protocol's own error codes (`error.data.code`, the table in the Kition platform's `docs/platform/reference/sync-protocol.md`).
    pub fn code(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code: Self::APPLICATION_ERROR, message: message.into(), data: Some(json!({ "code": code })) }
    }

    /// `collab-limit`: the room already has `limit` people co-editing.
    pub fn collab_limit(limit: u64, message: impl Into<String>) -> Self {
        Self { code: Self::APPLICATION_ERROR, message: message.into(), data: Some(json!({ "code": ErrorCode::CollabLimit, "limit": limit })) }
    }

    /// The limit a `collab-limit` error names.
    pub fn collab_limit_of(&self) -> Option<u64> {
        if self.reason() != Some(ErrorCode::CollabLimit) {
            return None;
        }
        self.data.as_ref()?.get("limit")?.as_u64()
    }

    /// This error's [`ErrorCode`], when it carries one.
    pub fn reason(&self) -> Option<ErrorCode> {
        serde_json::from_value(self.data.as_ref()?.get("code")?.clone()).ok()
    }
}

/// A decoded message, independent of its binary frames (see [`crate::framing`]).
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request { id: RequestId, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: RequestId, outcome: Result<Value, RpcError> },
}

/// Parses one already-decoded JSON value into a [`Message`], or the JSON-RPC error response to
/// send back when it is malformed. Never panics: every shape a peer can send is either a valid
/// message or an `Err` reply.
pub fn parse(value: Value) -> Result<Message, Value> {
    let Value::Object(mut object) = value else {
        return Err(error_response(None, &RpcError::new(RpcError::INVALID_REQUEST, "a message must be a json object")));
    };
    let id = match object.remove("id") {
        None => None,
        Some(id) => match serde_json::from_value::<RequestId>(id) {
            Ok(id) => Some(id),
            Err(_) => return Err(error_response(None, &RpcError::new(RpcError::INVALID_REQUEST, "id must be an integer or a string"))),
        },
    };
    let invalid = |id: Option<&RequestId>, detail: &str| error_response(id, &RpcError::new(RpcError::INVALID_REQUEST, detail));
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(invalid(id.as_ref(), "jsonrpc must be \"2.0\""));
    }
    if let Some(method) = object.remove("method") {
        let Value::String(method) = method else {
            return Err(invalid(id.as_ref(), "method must be a string"));
        };
        let params = object.remove("params").unwrap_or_else(|| Value::Object(Map::new()));
        if !params.is_object() {
            return Err(invalid(id.as_ref(), "params must be an object"));
        }
        return Ok(match id {
            Some(id) => Message::Request { id, method, params },
            None => Message::Notification { method, params },
        });
    }
    let Some(id) = id else {
        return Err(invalid(None, "a message needs a method, or a result or error with an id"));
    };
    if let Some(result) = object.remove("result") {
        return Ok(Message::Response { id, outcome: Ok(result) });
    }
    if let Some(error) = object.remove("error") {
        return match serde_json::from_value::<RpcError>(error) {
            Ok(error) => Ok(Message::Response { id, outcome: Err(error) }),
            Err(_) => Err(invalid(Some(&id), "error must be a json-rpc error object")),
        };
    }
    Err(invalid(Some(&id), "a message needs a method, a result, or an error"))
}

/// Parses one incoming JSON text frame.
pub fn parse_text(text: &str) -> Result<Message, Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => parse(value),
        Err(_) => Err(error_response(None, &RpcError::new(RpcError::PARSE_ERROR, "parse error"))),
    }
}

pub fn request(id: RequestId, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub fn result_response(id: &RequestId, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_response(id: Option<&RequestId>, error: &RpcError) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

/// Deserializes request or notification parameters, mapping failures to `-32602`.
pub fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|error| RpcError::invalid_params(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests_notifications_and_responses() {
        assert_eq!(
            parse(json!({ "jsonrpc": "2.0", "id": 1, "method": "sync/hello", "params": {} })).unwrap(),
            Message::Request { id: RequestId::Number(1), method: "sync/hello".into(), params: json!({}) }
        );
        assert_eq!(
            parse(json!({ "jsonrpc": "2.0", "method": "room/leave", "params": { "docId": "d1" } })).unwrap(),
            Message::Notification { method: "room/leave".into(), params: json!({ "docId": "d1" }) }
        );
        assert_eq!(
            parse(json!({ "jsonrpc": "2.0", "id": "c1", "result": { "seq": 3 } })).unwrap(),
            Message::Response { id: RequestId::String("c1".into()), outcome: Ok(json!({ "seq": 3 })) }
        );
        let failure = parse(json!({ "jsonrpc": "2.0", "id": "c1", "error": { "code": -32000, "message": "nope", "data": { "code": "forbidden" } } })).unwrap();
        let Message::Response { outcome: Err(error), .. } = failure else {
            panic!("expected a response error");
        };
        assert_eq!(error.reason(), Some(ErrorCode::Forbidden));
    }

    #[test]
    fn rejects_malformed_messages_without_panicking() {
        let code = |value: Value| parse(value).err().map(|reply| reply["error"]["code"].clone());
        assert_eq!(code(json!([])), Some(json!(-32600)));
        assert_eq!(code(json!({ "id": 3, "method": "room/leave" })), Some(json!(-32600)));
        assert_eq!(code(json!({ "jsonrpc": "2.0", "id": 4, "method": "room/leave", "params": [1] })), Some(json!(-32600)));
        assert_eq!(code(json!({ "jsonrpc": "2.0", "id": 5 })), Some(json!(-32600)));
        assert_eq!(code(json!({ "jsonrpc": "1.0", "id": 6, "method": "room/leave" })), Some(json!(-32600)));
        assert!(parse_text("not json").is_err());
    }

    #[test]
    fn error_code_round_trips_as_kebab_case() {
        let error = RpcError::code(ErrorCode::NotFound, "no such document");
        assert_eq!(serde_json::to_value(&error).unwrap()["data"]["code"], "not-found");
        assert_eq!(error.reason(), Some(ErrorCode::NotFound));
        let limited = RpcError::code(ErrorCode::RateLimited, "slow down");
        assert_eq!(serde_json::to_value(&limited).unwrap()["data"]["code"], "rate-limited");
        assert_eq!(limited.reason(), Some(ErrorCode::RateLimited));
        let full = RpcError::collab_limit(5, "co-editing is limited to 5 people on this server");
        assert_eq!(serde_json::to_value(&full).unwrap()["data"], json!({ "code": "collab-limit", "limit": 5 }));
        assert_eq!(full.reason(), Some(ErrorCode::CollabLimit));
        assert_eq!(full.collab_limit_of(), Some(5));
        assert_eq!(limited.collab_limit_of(), None);
    }
}
