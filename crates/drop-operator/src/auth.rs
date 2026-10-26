//! The per-run bearer token (REQ-OPS-002).
//!
//! A fresh 32-byte random token is generated at every start and printed once. Every
//! `/api` request except the health check must present it in an
//! `Authorization: Bearer <token>` header. It is compared in constant time. A token
//! in the URL query string is never read, so it can never be accepted, logged or
//! leaked through a `Referer`.

use std::fmt;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::crypto::random_bytes;
use crate::error::CryptoError;
use crate::http::ApiError;

/// A per-run API token: 32 random bytes shown as 64 lowercase hex characters.
pub struct Token(Zeroizing<String>);

impl Token {
    /// Draws a fresh token from operating-system randomness.
    pub fn generate() -> Result<Self, CryptoError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        random_bytes(bytes.as_mut())?;
        Ok(Token(Zeroizing::new(hex::encode(bytes.as_ref()))))
    }

    /// Wraps a known token value. Intended for tests and fixed demo setups.
    pub fn from_hex(hex_token: &str) -> Self {
        Token(Zeroizing::new(hex_token.to_owned()))
    }

    /// The token text, for the one-time startup banner.
    pub fn reveal(&self) -> &str {
        &self.0
    }

    /// Whether `presented` equals the token, compared in constant time.
    pub fn matches(&self, presented: &str) -> bool {
        self.0.as_bytes().ct_eq(presented.as_bytes()).into()
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// The token from a single `Authorization: Bearer <token>` header, if present.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

/// Middleware: lets the request through only with the right bearer token.
pub async fn require_token(
    State(token): State<Arc<Token>>,
    request: Request,
    next: Next,
) -> Response {
    match bearer(request.headers()) {
        Some(presented) if token.matches(presented) => next.run(request).await,
        _ => ApiError::unauthorized().into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    // covers: REQ-OPS-002
    #[test]
    fn tokens_are_32_random_bytes_as_hex() {
        let a = Token::generate().unwrap();
        let b = Token::generate().unwrap();
        assert_eq!(a.reveal().len(), 64);
        assert!(a
            .reveal()
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a.reveal(), b.reveal(), "a fresh token every run");
    }

    // covers: REQ-OPS-002
    #[test]
    fn matching_is_exact() {
        let token = Token::from_hex(&"ab".repeat(32));
        assert!(token.matches(&"ab".repeat(32)));
        assert!(!token.matches(&"ac".repeat(32)));
        assert!(!token.matches(&"ab".repeat(31)));
        assert!(!token.matches(&"ab".repeat(33)));
        assert!(!token.matches(""));
        assert!(!token.matches(&"AB".repeat(32)));
    }

    // covers: REQ-OPS-002
    #[test]
    fn the_token_never_prints() {
        let token = Token::generate().unwrap();
        let text = format!("{token:?}");
        assert_eq!(text, "Token(<redacted>)");
        assert!(!text.contains(token.reveal()));
    }

    // covers: REQ-OPS-002
    #[test]
    fn only_a_single_bearer_header_counts() {
        let mut headers = HeaderMap::new();
        assert_eq!(bearer(&headers), None);
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer abc"),
        );
        assert_eq!(bearer(&headers), Some("abc"));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bearer abc"),
        );
        assert_eq!(bearer(&headers), Some("abc"));
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&headers), None);
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("abc"));
        assert_eq!(bearer(&headers), None);
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer abc"),
        );
        headers.append(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer abc"),
        );
        assert_eq!(
            bearer(&headers),
            None,
            "two Authorization headers are refused"
        );
    }
}
