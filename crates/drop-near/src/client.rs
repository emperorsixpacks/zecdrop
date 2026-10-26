//! The 1Click HTTP API behind a small [`HttpClient`] trait, so tests run on recorded fixtures.
//!
//! The JWT is optional: on 2026-10-07 a **dry** quote succeeded without one (HTTP 201; see
//! `testdata/README.md`). The docs list authentication as required and say a JWT lowers fees.
//! It is read from [`JWT_ENV_VAR`] only, and never printed, logged or put in an error.

use std::fmt;
use std::time::Duration;

use crate::error::NearError;
use crate::quote::{
    parse_quote_response, DepositInstructions, DryQuoteRequest, LiveQuoteRequest, QuoteResponse,
};
use crate::status::{parse_status_response, StatusResponse};
use crate::tokens::{parse_tokens, Token};

pub const DEFAULT_BASE_URL: &str = "https://1click.chaindefuser.com";

/// The only place the JWT is read from.
pub const JWT_ENV_VAR: &str = "NEAR_INTENTS_JWT";

/// An HTTP response: status code and body text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// The two HTTP calls 1Click needs. Implementations must not treat 4xx/5xx as transport errors:
/// return them as responses so the API's error message can be reported.
pub trait HttpClient {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String>;
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<HttpResponse, String>;
}

/// A bearer token. `Debug` and `Display` never show it.
#[derive(Clone)]
pub struct Jwt(String);

impl Jwt {
    /// Reads [`JWT_ENV_VAR`]; `None` if unset or empty.
    pub fn from_env() -> Option<Jwt> {
        std::env::var(JWT_ENV_VAR)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(Jwt)
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.0)
    }
}

impl fmt::Debug for Jwt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Jwt(<redacted>)")
    }
}

/// A 1Click API client.
pub struct OneClick<C: HttpClient> {
    http: C,
    base_url: String,
    jwt: Option<Jwt>,
}

impl<C: HttpClient> fmt::Debug for OneClick<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OneClick")
            .field("base_url", &self.base_url)
            .field("jwt", &self.jwt.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

impl<C: HttpClient> OneClick<C> {
    pub fn new(http: C, jwt: Option<Jwt>) -> Self {
        OneClick {
            http,
            base_url: DEFAULT_BASE_URL.to_owned(),
            jwt,
        }
    }

    pub fn with_base_url(mut self, base_url: &str) -> Self {
        self.base_url = base_url.trim_end_matches('/').to_owned();
        self
    }

    fn headers(&self) -> Vec<(&'static str, String)> {
        let mut h = vec![("Accept", "application/json".to_owned())];
        if let Some(jwt) = &self.jwt {
            h.push(("Authorization", jwt.bearer()));
        }
        h
    }

    fn check(&self, resp: HttpResponse) -> Result<String, NearError> {
        match resp.status {
            200..=299 => Ok(resp.body),
            401 => Err(NearError::Unauthorized),
            status => {
                let message = serde_json::from_str::<serde_json::Value>(&resp.body)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_owned))
                    .unwrap_or_else(|| "no message".to_owned());
                Err(NearError::Rejected {
                    status,
                    message: self.scrub(message),
                })
            }
        }
    }

    /// Belt and braces: never let the JWT reach an error message, even if a server echoes it.
    fn scrub(&self, text: String) -> String {
        match &self.jwt {
            Some(jwt) if !jwt.0.is_empty() => text.replace(&jwt.0, "<redacted>"),
            _ => text,
        }
    }

    fn get(&self, path: &str) -> Result<String, NearError> {
        let headers = self.headers();
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let resp = self
            .http
            .get(&format!("{}{path}", self.base_url), &headers)
            .map_err(|e| NearError::Transport(self.scrub(e)))?;
        self.check(resp)
    }

    fn post(&self, path: &str, body: &str) -> Result<String, NearError> {
        let headers = self.headers();
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let resp = self
            .http
            .post_json(&format!("{}{path}", self.base_url), &headers, body)
            .map_err(|e| NearError::Transport(self.scrub(e)))?;
        self.check(resp)
    }

    /// `GET /v0/tokens` (no auth needed).
    pub fn tokens(&self) -> Result<Vec<Token>, NearError> {
        parse_tokens(&self.get("/v0/tokens")?)
    }

    /// `POST /v0/quote` with `dry: true`. Nothing is created or moved.
    pub fn quote_dry(&self, request: &DryQuoteRequest) -> Result<QuoteResponse, NearError> {
        let resp = parse_quote_response(&self.post("/v0/quote", &request.to_json())?)?;
        if resp.quote.deposit_address.is_some() {
            return Err(NearError::DryQuoteHasDepositAddress);
        }
        Ok(resp)
    }

    /// `POST /v0/quote` with `dry: false`: creates a deposit address the funder can pay. Only
    /// reachable through [`DryQuoteRequest::confirm`]. No test or tool in this repository calls it.
    pub fn quote_live(&self, request: &LiveQuoteRequest) -> Result<DepositInstructions, NearError> {
        let resp = parse_quote_response(&self.post("/v0/quote", &request.to_json())?)?;
        request.deposit_instructions(&resp)
    }

    /// `GET /v0/status?depositAddress=…[&depositMemo=…]`.
    pub fn status(
        &self,
        deposit_address: &str,
        deposit_memo: Option<&str>,
    ) -> Result<StatusResponse, NearError> {
        let mut path = format!(
            "/v0/status?depositAddress={}",
            encode_query(deposit_address)
        );
        if let Some(memo) = deposit_memo {
            path.push_str(&format!("&depositMemo={}", encode_query(memo)));
        }
        parse_status_response(&self.get(&path)?)
    }
}

/// Percent-encodes everything but RFC 3986 unreserved characters.
fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The real HTTP client (blocking, rustls with webpki roots).
pub struct UreqClient {
    agent: ureq::Agent,
}

impl Default for UreqClient {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build();
        UreqClient {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl HttpClient for UreqClient {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
        let mut req = self.agent.get(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let mut resp = req.call().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok(HttpResponse { status, body })
    }

    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<HttpResponse, String> {
        let mut req = self
            .agent
            .post(url)
            .header("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let mut resp = req.send(body).map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::quote::tests::captured_request;
    use crate::tokens::tests::TOKENS;

    /// One request the fake received.
    struct Call {
        url: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    }

    /// Replays fixtures and records every call. Never touches the network.
    #[derive(Default)]
    struct Recorded {
        responses: RefCell<Vec<HttpResponse>>,
        calls: RefCell<Vec<Call>>,
    }

    impl Recorded {
        fn replying(responses: Vec<HttpResponse>) -> Self {
            Recorded {
                responses: RefCell::new(responses),
                ..Default::default()
            }
        }
        fn next(&self) -> HttpResponse {
            self.responses.borrow_mut().remove(0)
        }
        fn record(&self, url: &str, headers: &[(&str, &str)], body: Option<&str>) {
            let headers = headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            self.calls.borrow_mut().push(Call {
                url: url.to_owned(),
                headers,
                body: body.map(str::to_owned),
            });
        }
    }

    impl HttpClient for &Recorded {
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
            self.record(url, headers, None);
            Ok(self.next())
        }
        fn post_json(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            body: &str,
        ) -> Result<HttpResponse, String> {
            self.record(url, headers, Some(body));
            Ok(self.next())
        }
    }

    fn ok(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            body: body.to_owned(),
        }
    }

    const DRY: &str = include_str!("../testdata/quote-dry-response.captured.json");
    const SECRET: &str = "eyJTEST-ONLY-not-a-real-jwt";

    // covers: REQ-FUND-001
    #[test]
    fn tokens_then_a_dry_quote_without_a_jwt() {
        let http = Recorded::replying(vec![ok(200, TOKENS), ok(201, DRY)]);
        let api = OneClick::new(&http, None);
        let zec = api
            .tokens()
            .unwrap()
            .into_iter()
            .find(|t| t.blockchain == "zec")
            .unwrap();
        assert_eq!(zec.asset_id, "nep141:zec.omft.near");
        let dry = api.quote_dry(&captured_request()).unwrap();
        assert_eq!(dry.quote.amount_out, "545000");

        let calls = http.calls.borrow();
        assert_eq!(calls[0].url, "https://1click.chaindefuser.com/v0/tokens");
        assert_eq!(calls[1].url, "https://1click.chaindefuser.com/v0/quote");
        let body: serde_json::Value =
            serde_json::from_str(calls[1].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["dry"], true, "only dry quotes are ever sent in tests");
        assert!(calls
            .iter()
            .all(|c| c.headers.iter().all(|(k, _)| k != "Authorization")));
    }

    // covers: REQ-FUND-001
    #[test]
    fn the_jwt_is_sent_as_a_bearer_header_but_never_shown() {
        let http = Recorded::replying(vec![ok(
            400,
            &format!(r#"{{"message":"bad token {SECRET}"}}"#),
        )]);
        let api = OneClick::new(&http, Some(Jwt(SECRET.to_owned())));
        let err = api.quote_dry(&captured_request()).unwrap_err();
        assert!(matches!(err, NearError::Rejected { status: 400, .. }));
        assert!(!err.to_string().contains(SECRET), "{err}");
        assert!(!format!("{api:?}").contains(SECRET));
        let calls = http.calls.borrow();
        assert!(calls[0]
            .headers
            .contains(&("Authorization".to_owned(), format!("Bearer {SECRET}"))));
    }

    #[test]
    fn unauthorized_and_status_query_encoding() {
        let http = Recorded::replying(vec![
            ok(401, "Unauthorized"),
            ok(
                200,
                include_str!("../testdata/status-processing.from-docs.json"),
            ),
        ]);
        let api = OneClick::new(&http, None);
        assert_eq!(api.tokens().unwrap_err(), NearError::Unauthorized);
        let status = api.status("abc.near", Some("memo 1&2")).unwrap();
        assert_eq!(status.status, crate::SwapStatus::Processing);
        assert_eq!(
            http.calls.borrow()[1].url,
            "https://1click.chaindefuser.com/v0/status?depositAddress=abc.near&depositMemo=memo%201%262"
        );
    }

    /// Only `GET /v0/tokens`: no quote of any kind, no deposit. Run with `--ignored`.
    #[test]
    #[ignore = "network: GET https://1click.chaindefuser.com/v0/tokens"]
    fn live_token_list_lists_native_zec() {
        let api = OneClick::new(UreqClient::default(), None);
        let tokens = api.tokens().unwrap();
        let zec = crate::find_zec(&tokens).unwrap();
        assert_eq!(zec.asset_id, "nep141:zec.omft.near");
    }
}
