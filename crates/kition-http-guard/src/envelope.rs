//! The JSON envelope every route answers: `{"code": 200, "message": "success", "data": ...}`,
//! and on failure `{"code": <business code>, "message": <text>, "data": ...}` with an HTTP
//! status. The shape and the codes are Kition runtime's (`kition-core`), so a client of one
//! talks to the other unchanged.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

impl Envelope {
    pub fn success(data: impl Into<Value>) -> Self {
        Self { code: 200, message: "success".to_owned(), data: data.into() }
    }

    pub fn failure(code: i64, message: impl Into<String>, data: impl Into<Value>) -> Self {
        Self { code, message: message.into(), data: data.into() }
    }
}

/// `200 {"code":200,"message":"success","data":...}`.
pub fn ok<T: Serialize>(data: T) -> Response {
    match serde_json::to_value(data) {
        Ok(value) => Json(Envelope::success(value)).into_response(),
        Err(_) => ApiError::internal().into_response(),
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// A failure: an HTTP status, a business code, a message, and `data` (`null` unless set). The
/// details are boxed so `Result<T, ApiError>` stays small.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError(Box<Details>);

#[derive(Debug, Clone, PartialEq)]
pub struct Details {
    pub status: u16,
    pub code: i64,
    pub message: String,
    pub data: Value,
}

impl std::ops::Deref for ApiError {
    type Target = Details;

    fn deref(&self) -> &Details {
        &self.0
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

/// Kition runtime's English message for a request it cannot decode (`common.bad_request`).
pub const BAD_REQUEST_MESSAGE: &str = "Invalid request parameters";
/// Its message for an unexpected failure (`common.internal_error`); the detail is never shown.
pub const INTERNAL_ERROR_MESSAGE: &str = "Internal server error";
/// Its message for a caller that is not let in (`auth.unauthorized`).
pub const UNAUTHORIZED_MESSAGE: &str = "Unauthorized, please sign in again";

impl ApiError {
    pub fn new(status: u16, code: i64, message: impl Into<String>) -> Self {
        Self(Box::new(Details { status, code, message: message.into(), data: Value::Null }))
    }

    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.0.data = data;
        self
    }

    /// `400` with code `400`.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, 400, message)
    }

    /// `401` with code `401`: the caller is not let in.
    pub fn unauthorized() -> Self {
        Self::new(401, 401, UNAUTHORIZED_MESSAGE)
    }

    /// `500` with code `500`, saying nothing about what failed.
    pub fn internal() -> Self {
        Self::new(500, 500, INTERNAL_ERROR_MESSAGE)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = http::StatusCode::from_u16(self.status).unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
        let Details { code, message, data, .. } = *self.0;
        (status, Json(Envelope::failure(code, message, data))).into_response()
    }
}

/// A JSON object request body. Any decoding failure is `400` with code `400`, whatever the
/// content type says. A top-level array is refused (serde would otherwise accept it for
/// structs), and `null` decodes as an empty object.
pub struct JsonBody<T>(pub T);

/// Decodes a JSON object body with [`JsonBody`] semantics.
pub fn decode_object<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    let bad = || ApiError::bad_request(BAD_REQUEST_MESSAGE);
    let trimmed = bytes.trim_ascii();
    if trimmed.starts_with(b"[") {
        return Err(bad());
    }
    let source: &[u8] = if trimmed == b"null" { b"{}" } else { bytes };
    serde_json::from_slice(source).map_err(|_| bad())
}

impl<T, S> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(request, state).await.map_err(|_| ApiError::bad_request(BAD_REQUEST_MESSAGE))?;
        decode_object(&bytes).map(JsonBody)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Default, Deserialize, PartialEq)]
    struct Body {
        #[serde(default)]
        name: Option<String>,
    }

    #[test]
    fn success_matches_the_runtime_shape() {
        let json = serde_json::to_value(Envelope::success("healthy")).unwrap_or_default();
        assert_eq!(json, serde_json::json!({"code": 200, "message": "success", "data": "healthy"}));
    }

    #[test]
    fn decodes_objects_like_the_runtime() {
        assert_eq!(decode_object::<Body>(b"{\"name\":\"a\"}").ok(), Some(Body { name: Some("a".into()) }));
        assert_eq!(decode_object::<Body>(b" null ").ok(), Some(Body::default()));
        assert!(decode_object::<Body>(b"[]").is_err());
        assert!(decode_object::<Body>(b"").is_err());
        assert!(decode_object::<Body>(b"\"x\"").is_err());
        let refused = decode_object::<Body>(b"[]").unwrap_err();
        assert_eq!((refused.status, refused.code, refused.message.as_str()), (400, 400, BAD_REQUEST_MESSAGE));
    }
}
