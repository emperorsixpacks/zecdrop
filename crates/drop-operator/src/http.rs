//! Shared HTTP plumbing: the JSON error type and a request-body extractor whose
//! failures never echo the body.
//!
//! The stock `Json` extractor puts serde's message in the response, and serde
//! messages quote the offending value. For a request that carries a recipient
//! list, that would be a leak (REQ-PRIV-002), so [`ApiJson`] reports only the
//! error category and its line and column.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

/// An error returned to API clients as `{"error": {"code", "message", ...}}`.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    details: Option<Value>,
}

impl ApiError {
    /// An error with an HTTP status, a stable machine code and a human message.
    /// The message must not contain recipient data.
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    /// Adds extra JSON fields next to `code` and `message`.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// 401: the bearer token is missing or wrong.
    pub fn unauthorized() -> Self {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "a valid bearer token is required",
        )
    }

    /// 404.
    pub fn not_found(what: &'static str) -> Self {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("{what} not found"),
        )
    }

    /// 400.
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, code, message)
    }

    /// 409.
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::CONFLICT, code, message)
    }

    /// 422.
    pub fn unprocessable(code: &'static str, message: impl Into<String>) -> Self {
        ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
    }

    /// 500: the store's data failed its integrity check, so nothing was acted on.
    pub fn store_corrupt() -> Self {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_corrupt",
            "the store failed its integrity check: its data was damaged or changed outside the \
             operator, so nothing was done; restore the store from a backup",
        )
    }

    /// 500 with a fixed message; the cause goes to the operator log, not the client.
    pub fn internal() -> Self {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "something went wrong inside the operator; see its log",
        )
    }

    /// The HTTP status.
    pub fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let (Some(Value::Object(extra)), Some(object)) = (self.details, error.as_object_mut()) {
            object.extend(extra);
        }
        let mut response = (self.status, axum::Json(json!({ "error": error }))).into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                header::HeaderValue::from_static("Bearer"),
            );
        }
        response
    }
}

/// A JSON request body that reports failures without quoting the input.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let is_json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.trim()
                    .to_ascii_lowercase()
                    .starts_with("application/json")
            });
        if !is_json {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "send the body as application/json",
            ));
        }
        let body = Bytes::from_request(request, state)
            .await
            .map_err(|rejection| {
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "body_too_large",
                        "the request body is too large",
                    )
                } else {
                    ApiError::bad_request("unreadable_body", "the request body could not be read")
                }
            })?;
        serde_json::from_slice(&body).map(ApiJson).map_err(|error| {
            let category = match error.classify() {
                serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
                    "is not valid JSON"
                }
                _ => "has missing, extra or mistyped fields",
            };
            ApiError::bad_request(
                "invalid_body",
                format!(
                    "the request body {category} (line {}, column {})",
                    error.line(),
                    error.column()
                ),
            )
        })
    }
}
