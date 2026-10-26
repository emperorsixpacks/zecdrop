//! A stand-in for the 1Click service, answering from `drop-near`'s recorded fixtures.
//!
//! `tokens` and the dry quote are shaped from what the real service answered on 2026-10-07
//! (captured); the live quote and the statuses are shaped from its documentation. Nothing here
//! talks to a network: [`FakeNear`] is an in-process `HttpClient`, and [`serve`] puts the same
//! replies behind a socket on the loopback interface, for tests of the real binary.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use drop_near::{HttpClient, HttpResponse};
use serde_json::{json, Value};

pub const TOKENS: &str = include_str!("../../../drop-near/testdata/tokens-excerpt.json");
pub const DRY_CAPTURED: &str =
    include_str!("../../../drop-near/testdata/quote-dry-response.captured.json");
pub const LIVE_DOCS: &str =
    include_str!("../../../drop-near/testdata/quote-live-response.from-docs.json");

/// The USDC-on-NEAR asset id in the captured token list.
pub const USDC: &str = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/// The docs example's deposit address (a placeholder: no such account is meant to exist).
pub const DOCS_DEPOSIT_ADDRESS: &str = "docs-example-deposit-address.near";

/// One recorded request.
#[derive(Clone, Debug)]
pub struct Call {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl Call {
    pub fn is_live_quote(&self) -> bool {
        self.method == "POST"
            && self.url.ends_with("/v0/quote")
            && self
                .body
                .as_deref()
                .and_then(|b| serde_json::from_str::<Value>(b).ok())
                .is_some_and(|v| v["dry"] == json!(false))
    }
}

/// How the fake answers.
#[derive(Clone, Debug)]
pub struct Script {
    /// The status fixture to answer `GET /v0/status` with, by its file stem after `status-`
    /// (e.g. `success`, `pending-deposit`).
    pub status: &'static str,
    /// Answer `GET /v0/status` with exactly this body instead of a fixture.
    pub status_body: Option<String>,
    /// Answer `GET /v0/tokens` with exactly this body instead of the fixture.
    pub tokens_body: Option<String>,
    /// Answer every request with this HTTP status and body instead.
    pub fail_with: Option<(u16, String)>,
    /// Fail every request at the transport level.
    pub transport_error: Option<String>,
    /// The dry quote's `amountOut` is this instead of the requested amount.
    pub dry_amount_out: Option<String>,
    /// The live quote's deposit address (`None` leaves the docs example's).
    pub deposit_address: Option<String>,
    /// The live quote's `amountIn` (`None` leaves the fixture's).
    pub live_amount_in: Option<String>,
    /// The live quote carries this deposit memo.
    pub live_memo: Option<String>,
    /// The live quote has no deposit address at all.
    pub live_without_address: bool,
    /// The live quote's `amountOut` is this instead of the requested amount.
    pub live_amount_out: Option<String>,
    /// The dry quote already carries a deposit address.
    pub dry_with_address: bool,
}

impl Default for Script {
    fn default() -> Self {
        Script {
            status: "pending-deposit",
            status_body: None,
            tokens_body: None,
            fail_with: None,
            transport_error: None,
            dry_amount_out: None,
            deposit_address: None,
            live_amount_in: None,
            live_memo: None,
            live_without_address: false,
            live_amount_out: None,
            dry_with_address: false,
        }
    }
}

fn status_fixture(stem: &str) -> &'static str {
    match stem {
        "pending-deposit" => {
            include_str!("../../../drop-near/testdata/status-pending-deposit.from-docs.json")
        }
        "known-deposit-tx" => {
            include_str!("../../../drop-near/testdata/status-known-deposit-tx.from-docs.json")
        }
        "processing" => {
            include_str!("../../../drop-near/testdata/status-processing.from-docs.json")
        }
        "success" => include_str!("../../../drop-near/testdata/status-success.from-docs.json"),
        "incomplete-deposit" => {
            include_str!("../../../drop-near/testdata/status-incomplete-deposit.from-docs.json")
        }
        "refunded" => include_str!("../../../drop-near/testdata/status-refunded.from-docs.json"),
        "failed" => include_str!("../../../drop-near/testdata/status-failed.from-docs.json"),
        "mystery-state" => {
            include_str!("../../../drop-near/testdata/status-mystery-state.from-docs.json")
        }
        other => panic!("no status fixture {other}"),
    }
}

/// Every documented status, and the one that is not.
pub const STATUSES: [&str; 8] = [
    "pending-deposit",
    "known-deposit-tx",
    "processing",
    "success",
    "incomplete-deposit",
    "refunded",
    "failed",
    "mystery-state",
];

fn ok(status: u16, body: String) -> Result<HttpResponse, String> {
    Ok(HttpResponse { status, body })
}

/// The service's answer to a request. `authorization` is the `Authorization` header it got.
pub fn reply(
    script: &Script,
    method: &str,
    url: &str,
    authorization: Option<&str>,
    body: Option<&str>,
) -> Result<HttpResponse, String> {
    if let Some(error) = &script.transport_error {
        return Err(error.clone());
    }
    if let Some((status, message)) = &script.fail_with {
        // A server that echoes the credentials it was given, to see them scrubbed.
        let echoed = authorization.unwrap_or("none");
        return ok(
            *status,
            json!({ "message": format!("{message} (you sent: {echoed})") }).to_string(),
        );
    }
    let path = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = path.find('/').map_or("", |i| &path[i..]);
    let route = path.split('?').next().unwrap_or("");
    match (method, route) {
        ("GET", "/v0/tokens") => ok(
            200,
            script
                .tokens_body
                .clone()
                .unwrap_or_else(|| TOKENS.to_owned()),
        ),
        ("GET", "/v0/status") => ok(
            200,
            script
                .status_body
                .clone()
                .unwrap_or_else(|| status_fixture(script.status).to_owned()),
        ),
        ("POST", "/v0/quote") => {
            let request: Value =
                serde_json::from_str(body.unwrap_or("{}")).map_err(|e| e.to_string())?;
            ok(201, quote_for(script, &request).to_string())
        }
        _ => ok(404, json!({ "message": "not found" }).to_string()),
    }
}

/// A quote response (dry or live) that echoes `request` the way the real service does.
fn quote_for(script: &Script, request: &Value) -> Value {
    let dry = request["dry"] == json!(true);
    let mut quote: Value = serde_json::from_str(if dry { DRY_CAPTURED } else { LIVE_DOCS })
        .expect("the fixtures are JSON");
    quote.as_object_mut().unwrap().remove("_source");
    for field in [
        "swapType",
        "originAsset",
        "destinationAsset",
        "amount",
        "refundTo",
        "recipient",
        "deadline",
        "dry",
        "slippageTolerance",
    ] {
        quote["quoteRequest"][field] = request[field].clone();
    }
    let wanted = request["amount"].as_str().unwrap_or("0").to_owned();
    let out = if dry {
        script.dry_amount_out.clone()
    } else {
        script.live_amount_out.clone()
    }
    .unwrap_or(wanted);
    quote["quote"]["amountOut"] = json!(out);
    quote["quote"]["minAmountOut"] = json!(out);
    if !dry {
        // As the real service does, the quote's deadline is the one asked for.
        quote["quote"]["deadline"] = request["deadline"].clone();
        quote["quote"]["timeWhenInactive"] = request["deadline"].clone();
    }
    if dry {
        if script.dry_with_address {
            quote["quote"]["depositAddress"] = json!(DOCS_DEPOSIT_ADDRESS);
        }
    } else if script.live_without_address {
        quote["quote"]
            .as_object_mut()
            .unwrap()
            .remove("depositAddress");
    } else if let Some(address) = &script.deposit_address {
        quote["quote"]["depositAddress"] = json!(address);
    }
    if !dry {
        if let Some(amount_in) = &script.live_amount_in {
            quote["quote"]["amountIn"] = json!(amount_in);
        }
        if let Some(memo) = &script.live_memo {
            quote["quote"]["depositMemo"] = json!(memo);
        }
    }
    quote
}

/// An in-process `HttpClient` over [`reply`], recording every call.
#[derive(Clone, Default)]
pub struct FakeNear {
    script: Arc<Mutex<Script>>,
    calls: Arc<Mutex<Vec<Call>>>,
    authorization: Arc<Mutex<Option<String>>>,
}

impl FakeNear {
    pub fn new() -> FakeNear {
        FakeNear::default()
    }

    pub fn script(&self, edit: impl FnOnce(&mut Script)) {
        edit(&mut self.script.lock().unwrap());
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    /// How many non-dry quotes were asked for.
    pub fn live_quotes(&self) -> usize {
        self.calls().iter().filter(|c| c.is_live_quote()).count()
    }

    pub fn count(&self, method: &str, route: &str) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.method == method && c.url.contains(route))
            .count()
    }

    fn record(
        &self,
        method: &'static str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Option<String> {
        let authorization = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| (*v).to_owned());
        self.calls.lock().unwrap().push(Call {
            method,
            url: url.to_owned(),
            headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            body: body.map(str::to_owned),
        });
        *self.authorization.lock().unwrap() = authorization.clone();
        authorization
    }
}

impl HttpClient for FakeNear {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
        let authorization = self.record("GET", url, headers, None);
        reply(
            &self.script.lock().unwrap(),
            "GET",
            url,
            authorization.as_deref(),
            None,
        )
    }

    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<HttpResponse, String> {
        let authorization = self.record("POST", url, headers, Some(body));
        reply(
            &self.script.lock().unwrap(),
            "POST",
            url,
            authorization.as_deref(),
            Some(body),
        )
    }
}

/// What [`serve`] saw: method, path, authorization header, body.
pub type Seen = Arc<Mutex<Vec<(String, String, Option<String>, String)>>>;

/// A change to a [`Script`], boxed so a table of cases can hold several.
pub type Edit = Box<dyn Fn(&mut Script)>;

/// [`reply`] behind a socket on 127.0.0.1, for tests of the real binary. Returns the base URL
/// and the requests it saw (method, path, authorization header, body). The thread ends with the
/// process.
pub fn serve(script: Script) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            let mut parts = line.split_whitespace();
            let (method, path) = (
                parts.next().unwrap_or("").to_owned(),
                parts.next().unwrap_or("").to_owned(),
            );
            let (mut length, mut authorization) = (0usize, None);
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                    break;
                }
                let lower = header.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                if lower.starts_with("authorization:") {
                    authorization = Some(header["authorization:".len()..].trim().to_owned());
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            let body = String::from_utf8_lossy(&body).into_owned();
            log.lock().unwrap().push((
                method.clone(),
                path.clone(),
                authorization.clone(),
                body.clone(),
            ));
            let answer = reply(
                &script,
                &method,
                &path,
                authorization.as_deref(),
                Some(&body),
            )
            .unwrap_or(HttpResponse {
                status: 502,
                body: String::new(),
            });
            let _ = write!(
                stream,
                "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                answer.status,
                answer.body.len(),
                answer.body
            );
        }
    });
    (base, seen)
}
