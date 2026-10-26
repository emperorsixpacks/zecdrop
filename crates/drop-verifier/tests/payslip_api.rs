//! `POST /v1/payslip` (REQ-VER-006), driven in process with an in-memory chain that holds real
//! librustzcash transactions built with TEST-ONLY keys (the fixtures under `drop-verify`).
//!
//! The payslips are issued the way the owner of the campaign's outgoing viewing key issues
//! them, with `orchard` directly (a development-only dependency of this crate), so the code under
//! test never sees a key: it gets a transaction from the chain and a payslip in a POST body.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use drop_core::{Network, Txid};
use drop_verifier::api::{build_router, Sources, VerifierState};
use drop_verifier::config::Settings;
use drop_verifier::log::{CaptureSink, Logger};
use drop_verify::{ChainSource, FetchedTx, Payslip, SourceError};
use http_body_util::BodyExt;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use serde_json::{json, Value};
use tower::ServiceExt;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

const TIP: u32 = 5_000_000;
const ORIGIN: &str = "https://site.example";

struct Fixture {
    txid: Txid,
    raw: Vec<u8>,
    funding_txid: Txid,
    funding_raw: Vec<u8>,
}

fn fixture(name: &str) -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../drop-verify/tests/fixtures")
        .join(format!("{name}.json"));
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let text = |value: &Value| value.as_str().unwrap().to_owned();
    Fixture {
        txid: text(&v["txid"]).parse().unwrap(),
        raw: hex::decode(text(&v["raw_hex"])).unwrap(),
        funding_txid: text(&v["funding"]["txid"]).parse().unwrap(),
        funding_raw: hex::decode(text(&v["funding"]["raw_hex"])).unwrap(),
    }
}

/// The campaign's outgoing viewing key in the drop-verify fixtures (a throwaway).
fn campaign_ovk() -> orchard::keys::OutgoingViewingKey {
    FullViewingKey::from(&SpendingKey::from_bytes([0x33; 32]).unwrap()).to_ovk(Scope::External)
}

/// The payslip of payout `i` (the fixture's recipients are throwaway keys 0x40 + i).
fn payslip_of(f: &Fixture, i: usize) -> Payslip {
    let receiver = FullViewingKey::from(&SpendingKey::from_bytes([0x40 + i as u8; 32]).unwrap())
        .address_at(0u32, Scope::External)
        .to_raw_address_bytes();
    let tx = Transaction::read(&f.raw[..], BranchId::Nu6_3).unwrap();
    tx.ironwood_bundle()
        .unwrap()
        .recover_outputs_with_ovks(&[campaign_ovk()])
        .into_iter()
        .map(|(action, _, note, _, _)| {
            Payslip::from_note(Network::Testnet, f.txid, action as u32, &note).unwrap()
        })
        .find(|p| p.receiver == receiver)
        .expect("the key recovers every payout")
}

#[derive(Default)]
struct Chain {
    txs: HashMap<Txid, FetchedTx>,
    calls: Arc<AtomicUsize>,
    down: bool,
}

impl Chain {
    fn holding(f: &Fixture, confirmations: u32) -> Chain {
        let mut chain = Chain::default();
        chain.txs.insert(
            f.funding_txid,
            FetchedTx {
                raw: f.funding_raw.clone(),
                mined_height: Some(1),
            },
        );
        chain.txs.insert(
            f.txid,
            FetchedTx {
                raw: f.raw.clone(),
                mined_height: Some(TIP - confirmations + 1),
            },
        );
        chain
    }
}

impl ChainSource for Chain {
    async fn transaction(&self, txid: &Txid) -> Result<Option<FetchedTx>, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.down {
            return Err(SourceError::Unavailable);
        }
        Ok(self.txs.get(txid).cloned())
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        if self.down {
            return Err(SourceError::Unavailable);
        }
        Ok(TIP)
    }
}

struct App {
    router: Router,
    logs: CaptureSink,
    calls: Arc<AtomicUsize>,
}

fn app_with(chain: Chain, settings: Settings, mainnet: bool) -> App {
    let (logger, logs) = Logger::capture();
    let calls = Arc::clone(&chain.calls);
    let sources = if mainnet {
        Sources {
            testnet: None,
            mainnet: Some(chain),
        }
    } else {
        Sources {
            testnet: Some(chain),
            mainnet: None,
        }
    };
    let router = build_router(Arc::new(VerifierState {
        sources,
        settings,
        logger,
    }));
    App {
        router,
        logs,
        calls,
    }
}

fn app(chain: Chain) -> App {
    app_with(chain, Settings::default(), false)
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("{e}: {}", self.text()))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

async fn send(app: &App, method: Method, headers: &[(&str, &str)], body: impl Into<Body>) -> Reply {
    let mut request = Request::builder().method(method).uri("/v1/payslip");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .router
        .clone()
        .oneshot(request.body(body.into()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    Reply {
        status: parts.status,
        headers: parts.headers,
        body: body.collect().await.unwrap().to_bytes().to_vec(),
    }
}

async fn post(app: &App, payslip: &Value) -> Reply {
    send(
        app,
        Method::POST,
        &[("content-type", "application/json")],
        payslip.to_string(),
    )
    .await
}

/// Every string that would give a payslip away: its receiver, its `rseed`, its amount, and the JSON.
fn secrets(p: &Payslip) -> Vec<String> {
    let json = serde_json::to_value(p).unwrap();
    vec![
        json["receiver"].as_str().unwrap().to_owned(),
        json["rseed"].as_str().unwrap().to_owned(),
        json["value"].as_str().unwrap().to_owned(),
        json.to_string(),
    ]
}

fn assert_none_of(what: &str, text: &str, secrets: &[String]) {
    for secret in secrets {
        assert!(
            !text.contains(secret.as_str()),
            "{what} leaked {secret}: {text}"
        );
    }
}

// covers: REQ-VER-006, REQ-PAY-001
#[tokio::test]
async fn a_posted_payslip_is_checked_against_the_chain_and_the_limits_come_with_the_answer() {
    let f = fixture("ironwood_batch_3");
    let slip = payslip_of(&f, 1);
    let body = serde_json::to_value(&slip).unwrap();

    // Final: verified, with the depth, and what a verified payslip does not prove.
    let ok = app(Chain::holding(&f, 6));
    let reply = post(&ok, &body).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let answer = reply.json();
    assert_eq!(answer["verdict"], "verified");
    assert_eq!(answer["confirmations"], 6);
    assert_eq!(answer["required_depth"], 3);
    assert_eq!(answer["ironwood_actions"], 3);
    assert_eq!(answer["network"], "testnet");
    assert_eq!(answer["txid"], f.txid.to_string());
    assert_eq!(answer["action"], slip.action);
    assert!(answer["reason"].is_null());
    assert_eq!(answer["not_proven"].as_array().unwrap().len(), 5);
    assert!(answer["not_proven"][0]
        .as_str()
        .unwrap()
        .contains("bearer document"));
    assert_eq!(reply.headers["cache-control"], "no-store");

    // Too young: it verifies, but it is pending.
    let young = app(Chain::holding(&f, 1));
    let answer = post(&young, &body).await.json();
    assert_eq!(answer["verdict"], "pending");
    assert_eq!(answer["confirmations"], 1);

    // Not on this chain at all.
    let empty = app(Chain::default());
    let answer = post(&empty, &body).await.json();
    assert_eq!(answer["verdict"], "not_found");
    assert!(answer["confirmations"].is_null());

    // A payslip that does not match the output: a verdict, not an error, and no detail.
    let mut changed = body.clone();
    changed["value"] = json!("999");
    let reply = post(&ok, &changed).await;
    assert_eq!(reply.status, StatusCode::OK);
    let answer = reply.json();
    assert_eq!(
        (answer["verdict"].as_str(), answer["reason"].as_str()),
        (Some("invalid"), Some("does_not_match"))
    );
    let mut elsewhere = body.clone();
    elsewhere["action"] = json!(9);
    assert_eq!(
        post(&ok, &elsewhere).await.json()["reason"],
        "no_such_action"
    );
}

// covers: REQ-VER-006
#[tokio::test]
async fn nothing_of_a_payslip_is_logged_or_echoed() {
    let f = fixture("ironwood_batch_3");
    let slip = payslip_of(&f, 2);
    let body = serde_json::to_value(&slip).unwrap();
    let hidden = secrets(&slip);

    let app = app(Chain::holding(&f, 6));
    let mut texts = vec![post(&app, &body).await.text()];
    let mut changed = body.clone();
    changed["rseed"] = json!("00".repeat(32));
    texts.push(post(&app, &changed).await.text());
    // Refusals of every kind.
    texts.push(
        send(&app, Method::POST, &[], "not json at all")
            .await
            .text(),
    );
    let mut unknown = body.clone();
    unknown["extra"] = json!(1);
    texts.push(post(&app, &unknown).await.text());
    texts.push(send(&app, Method::POST, &[], vec![b'x'; 5000]).await.text());
    texts.push(send(&app, Method::GET, &[], Body::empty()).await.text());
    let mut key = body.clone();
    key["note"] = json!("uviewtest1sentinelufvk0000000000000000000000000000000000000");
    texts.push(post(&app, &key).await.text());

    for text in &texts {
        assert_none_of("an answer", text, &hidden);
    }
    // The logs name the route, the status, the network and the verdict, and nothing else.
    let logs = app.logs.lines().join("\n");
    assert_none_of("the logs", &logs, &hidden);
    assert!(logs.contains("POST /v1/payslip -> 200"), "{logs}");
    assert!(
        logs.contains("payslip network=testnet verdict=verified"),
        "{logs}"
    );
    assert!(!logs.contains(&slip.txid.to_string()), "{logs}");
}

// covers: REQ-VER-006, REQ-VER-002
#[tokio::test]
async fn only_post_with_a_small_body_that_is_a_payslip_and_no_key_is_answered() {
    let f = fixture("ironwood_batch_3");
    let slip = payslip_of(&f, 0);
    let body = serde_json::to_value(&slip).unwrap();
    let app = app(Chain::holding(&f, 6));

    // Not a GET (a payslip must never travel in a URL), and not any other method.
    for method in [Method::GET, Method::PUT, Method::DELETE] {
        let reply = send(&app, method, &[], Body::empty()).await;
        assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED);
    }
    let with_query = Request::builder()
        .uri(format!(
            "/v1/payslip?payslip={}",
            hex::encode(body.to_string())
        ))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.router
            .clone()
            .oneshot(with_query)
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        app.calls.load(Ordering::SeqCst),
        0,
        "no chain call for any of them"
    );

    // Over 1 KiB.
    let reply = send(&app, Method::POST, &[], vec![b' '; 2000]).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.json()["error"]["code"], "payload_too_large");

    // Not JSON, not a payslip, unknown fields, a missing field.
    for text in ["", "null", "[]", "{}", "{\"version\":1}"] {
        let reply = send(&app, Method::POST, &[], text.to_owned()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{text:?}");
        assert_eq!(reply.json()["error"]["code"], "invalid_payslip");
    }
    let mut unknown = body.clone();
    unknown["extra"] = json!("x");
    assert_eq!(post(&app, &unknown).await.status, StatusCode::BAD_REQUEST);

    // Anything shaped like a viewing key is refused first, wherever it hides (REQ-VER-002).
    let mut key = body.clone();
    key["note"] = json!("uivk1sentinel");
    let reply = post(&app, &key).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["error"]["code"], "viewing_key_refused");
    assert_eq!(app.calls.load(Ordering::SeqCst), 0, "still no chain call");

    // The refusal for a network that is not configured comes before any chain call.
    let main_only = app_with(Chain::holding(&f, 6), Settings::default(), true);
    let reply = post(&main_only, &body).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["error"]["code"], "network_not_configured");
    assert_eq!(main_only.calls.load(Ordering::SeqCst), 0);
}

// covers: REQ-VER-006
#[tokio::test]
async fn an_outage_is_an_outage_and_never_a_verdict() {
    let f = fixture("ironwood_batch_3");
    let body = serde_json::to_value(payslip_of(&f, 1)).unwrap();
    let mut chain = Chain::holding(&f, 6);
    chain.down = true;
    let reply = post(&app(chain), &body).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.json()["error"]["code"], "chain_unavailable");
}

async fn post_from(app: &App, origin: &str, body: &str) -> Reply {
    send(
        app,
        Method::POST,
        &[("content-type", "application/json"), ("origin", origin)],
        body.to_owned(),
    )
    .await
}

// covers: REQ-VER-006
#[tokio::test]
async fn cross_origin_posts_are_allowed_only_from_the_configured_origin() {
    let f = fixture("ironwood_batch_3");
    let body = serde_json::to_value(payslip_of(&f, 1)).unwrap().to_string();
    let configured = app_with(
        Chain::holding(&f, 6),
        Settings {
            cors_origins: vec![ORIGIN.to_owned()],
            ..Settings::default()
        },
        false,
    );

    // The browser's preflight for a JSON POST.
    let preflight = send(
        &configured,
        Method::OPTIONS,
        &[
            ("origin", ORIGIN),
            ("access-control-request-method", "POST"),
            ("access-control-request-headers", "content-type"),
        ],
        Body::empty(),
    )
    .await;
    assert!(preflight.status.is_success(), "{}", preflight.text());
    assert_eq!(preflight.headers["access-control-allow-origin"], ORIGIN);
    let methods = preflight.headers["access-control-allow-methods"]
        .to_str()
        .unwrap();
    assert!(
        methods.contains("POST") && !methods.contains("GET"),
        "{methods}"
    );
    assert!(preflight.headers["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .to_lowercase()
        .contains("content-type"));

    // The POST itself: readable by the named origin, not by another, and not at all when off.
    let named = post_from(&configured, ORIGIN, &body).await;
    assert_eq!(named.status, StatusCode::OK);
    assert_eq!(named.headers["access-control-allow-origin"], ORIGIN);
    let other = post_from(&configured, "https://evil.example", &body).await;
    assert!(other.headers.get("access-control-allow-origin").is_none());
    let off = app(Chain::holding(&f, 6));
    assert!(post_from(&off, ORIGIN, &body)
        .await
        .headers
        .get("access-control-allow-origin")
        .is_none());
}
