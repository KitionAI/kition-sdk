//! The kit side's reading of incoming messages and its replies, on `kition-kit-process-protocol`'s
//! envelopes.

use serde_json::{Map, Value};

use crate::protocol::{Message, Notification, RequestId, Response, RpcError};

/// A message the server acts on.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// A response from a client: the host's answer to one of the kit's requests (section 5.1).
    Response(Response),
    /// A malformed response: it gets no answer.
    Ignored,
}

/// Parses one frame, or returns the error response to send back. A kit's methods take named
/// parameters: absent `params` read as `{}`, and an array is an invalid request.
pub fn parse(frame: &str) -> Result<Incoming, Value> {
    let message = match Message::parse(frame) {
        Ok(message) => message,
        // A malformed response from a client still gets no answer.
        Err(_) if frame_is_response(frame) => return Ok(Incoming::Ignored),
        Err(response) => return Err(response.to_value()),
    };
    let named = |id: Option<&RequestId>, params: Option<Value>| match params.unwrap_or_else(|| Value::Object(Map::new())) {
        params @ Value::Object(_) => Ok(params),
        _ => Err(error_response(id, &RpcError::invalid_request("params must be an object"))),
    };
    Ok(match message {
        Message::Request(request) => {
            let params = named(Some(&request.id), request.params)?;
            Incoming::Request { id: request.id, method: request.method, params }
        }
        Message::Notification(notification) => Incoming::Notification { params: named(None, notification.params)?, method: notification.method },
        Message::Response(response) => Incoming::Response(response),
    })
}

fn frame_is_response(frame: &str) -> bool {
    serde_json::from_str::<Value>(frame).is_ok_and(|value| value.get("method").is_none() && (value.get("result").is_some() || value.get("error").is_some()))
}

pub fn result_response(id: &RequestId, result: Value) -> Value {
    Response { id: Some(id.clone()), outcome: Ok(result) }.to_value()
}

pub fn error_response(id: Option<&RequestId>, error: &RpcError) -> Value {
    Response { id: id.cloned(), outcome: Err(error.clone()) }.to_value()
}

pub fn notification(method: &str, params: Value) -> Value {
    Notification::new(method, Some(params)).to_value()
}

/// Deserializes request parameters, mapping failures to `-32602`.
pub fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|error| RpcError::invalid_params(error.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_requests_notifications_and_responses() {
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":1,"method":"kit.ping"}"#),
            Ok(Incoming::Request { id: RequestId::Number(1), method: "kit.ping".into(), params: json!({}) })
        );
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","method":"kit.initialized","params":{}}"#),
            Ok(Incoming::Notification { method: "kit.initialized".into(), params: json!({}) })
        );
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":"a","result":{}}"#),
            Ok(Incoming::Response(Response { id: Some(RequestId::String("a".into())), outcome: Ok(json!({})) }))
        );
        assert_eq!(parse(r#"{"jsonrpc":"2.0","id":"a","error":"nonsense"}"#), Ok(Incoming::Ignored));
    }

    #[test]
    fn malformed_messages_get_the_standard_codes() {
        let code = |frame: &str| parse(frame).err().map(|reply| (reply["id"].clone(), reply["error"]["code"].clone()));
        assert_eq!(code("{"), Some((Value::Null, json!(-32700))));
        assert_eq!(code("[]"), Some((Value::Null, json!(-32600))));
        assert_eq!(code(r#"{"id":3,"method":"kit.ping"}"#), Some((json!(3), json!(-32600))));
        assert_eq!(code(r#"{"jsonrpc":"2.0","id":4,"method":"kit.ping","params":[1]}"#), Some((json!(4), json!(-32600))));
    }

    #[test]
    fn replies_are_jsonrpc_envelopes() {
        let id = RequestId::Number(7);
        assert_eq!(result_response(&id, json!({ "ok": true })), json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": true } }));
        let error = crate::protocol::RpcError::kit_detail(crate::protocol::ErrorReason::FileNotGranted, "not this connection's handle");
        assert_eq!(
            error_response(None, &error),
            json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32014, "message": "file not granted", "data": { "reason": "file_not_granted", "detail": "not this connection's handle" } } })
        );
        assert_eq!(notification("kit.log", json!({})), json!({ "jsonrpc": "2.0", "method": "kit.log", "params": {} }));
    }
}
