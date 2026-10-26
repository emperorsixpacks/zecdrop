//! The hosted verifier's HTTP surface, driven in process with an in-memory chain.
//! The chain holds real librustzcash transactions built with TEST-ONLY keys (the
//! fixtures under `drop-verify`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use drop_core::{CampaignPhase, Network, Pool, PublicReceipt, Txid};
use drop_verifier::api::{build_router, Sources, VerifierState};
use drop_verifier::config::Settings;
use drop_verifier::log::{CaptureSink, Logger};
use drop_verify::{ChainSource, FetchedTx, SourceError};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const TIP: u32 = 5_000_000;
const COMMITMENT: &str = "aade9fd18f7c48dc3b04ead6a7ee2211640d0fa5948dfd14b5a356463c841491";
/// A UFVK-shaped string (the shape matters, not validity).
const UFVK: &str = "uviewtest1sentinelufvk0000000000000000000000000000000000000000000";

struct Fixture {
    txid: Txid,
    raw: Vec<u8>,
    funding_txid: Txid,
    funding_raw: Vec<u8>,
    payout_total: u64,
    fee: u64,
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
        payout_total: text(&v["payout_total"]).parse().unwrap(),
        fee: text(&v["fee"]).parse().unwrap(),
    }
}

#[derive(Default)]
struct Chain {
    txs: HashMap<Txid, FetchedTx>,
    calls: Arc<AtomicUsize>,
    down: bool,
    inconsistent: bool,
    delay: Option<Duration>,
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
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        if self.down {
            return Err(SourceError::Unavailable);
        }
        if self.inconsistent {
            return Err(SourceError::Inconsistent);
        }
        Ok(self.txs.get(txid).cloned())
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
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

async fn get(app: &App, uri: &str) -> Reply {
    get_with(app, uri, &[]).await
}

async fn get_with(app: &App, uri: &str, headers: &[(&str, &str)]) -> Reply {
    let mut request = Request::builder().uri(uri);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    Reply {
        status: parts.status,
        headers: parts.headers,
        body: body.collect().await.unwrap().to_bytes().to_vec(),
    }
}

fn receipt_uri(txids: &[Txid], declared: u64) -> String {
    let txs: String = txids.iter().map(|t| format!("&tx={t}")).collect();
    format!("/v1/receipt?network=testnet{txs}&commitment={COMMITMENT}&declared_total={declared}")
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

// covers: REQ-VER-001
#[tokio::test]
async fn a_good_batch_returns_a_settled_public_receipt() {
    let f = fixture("ironwood_batch_3");
    let app = app(Chain::holding(&f, 6));
    let reply = get(&app, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());

    let receipt: PublicReceipt = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!(receipt.phase, CampaignPhase::Settled);
    assert!(receipt.findings.is_empty());
    assert_eq!(receipt.network, Network::Testnet);
    assert_eq!(receipt.manifest_commitment.to_string(), COMMITMENT);
    assert_eq!(receipt.batches[0].txid, Some(f.txid));
    assert_eq!(receipt.batches[0].fee.map(|x| x.as_u64()), Some(f.fee));
    assert_eq!(receipt.batches[0].pool, Some(Pool::Ironwood));
    assert!(reply.headers["content-type"]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
}

// covers: REQ-VER-001
#[tokio::test]
async fn problems_come_back_as_findings_in_a_successful_response() {
    let f = fixture("orchard_batch_old_height");
    let app = app(Chain::holding(&f, 6));
    let reply = get(&app, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(reply.status, StatusCode::OK);
    let json = reply.json();
    assert_eq!(
        json["findings"][0],
        serde_json::json!({ "code": "unexpected_pool", "batch_index": 0 })
    );
    assert_eq!(json["phase"]["phase"], "failed");
    assert_eq!(json["batches"][0]["pool"], "orchard");

    // A transaction the chain does not know is a finding too, not an HTTP error.
    let empty = app_with(Chain::default(), Settings::default(), false);
    let reply = get(&empty, &receipt_uri(&[f.txid], 1)).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["findings"][0]["code"], "tx_not_found");
}

// covers: REQ-VER-003
#[tokio::test]
async fn the_configured_depth_decides_pending_versus_settled() {
    let f = fixture("ironwood_batch_3");
    let shallow = app(Chain::holding(&f, 2));
    let json = get(&shallow, &receipt_uri(&[f.txid], f.payout_total))
        .await
        .json();
    assert_eq!(json["findings"][0]["code"], "batch_pending");
    assert_eq!(
        json["phase"],
        serde_json::json!({ "phase": "sending", "done": 0, "total": 1 })
    );

    let lenient = app_with(
        Chain::holding(&f, 2),
        Settings {
            required_depth: 2,
            ..Settings::default()
        },
        false,
    );
    let json = get(&lenient, &receipt_uri(&[f.txid], f.payout_total))
        .await
        .json();
    assert_eq!(json["phase"]["phase"], "settled");
}

#[tokio::test]
async fn health_and_unknown_routes() {
    let app = app(Chain::default());
    let health = get(&app, "/v1/health").await;
    assert_eq!(health.status, StatusCode::OK);
    assert_eq!(health.json(), serde_json::json!({ "ok": true }));

    let missing = get(&app, "/v1/nothing-here?token=abc").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert!(
        !missing.text().contains("nothing-here"),
        "the path is not echoed"
    );
}

// ---------------------------------------------------------------------------
// Strict input (REQ-VER-002)
// ---------------------------------------------------------------------------

// covers: REQ-VER-002
#[tokio::test]
async fn unknown_missing_duplicate_and_invalid_parameters_are_400_without_echo() {
    let f = fixture("ironwood_batch_3");
    let app = app(Chain::holding(&f, 6));
    let good = receipt_uri(&[f.txid], f.payout_total);
    let cases = [
        (format!("{good}&sneaky-param-name=1"), "unknown_parameter"),
        ("/v1/receipt".to_owned(), "missing_parameter"),
        (format!("{good}&network=mainnet"), "duplicate_parameter"),
        (good.replace("testnet", "regtest"), "invalid_parameter"),
        (good.replace(COMMITMENT, "zz"), "invalid_parameter"),
        (
            good.replace(&f.txid.to_string(), "not-a-txid-marker"),
            "invalid_parameter",
        ),
        (
            format!("/v1/receipt?network=testnet&commitment={COMMITMENT}&declared_total=1"),
            "missing_parameter",
        ),
    ];
    for (uri, code) in cases {
        let reply = get(&app, &uri).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(reply.json()["error"]["code"], code, "{uri}");
        for echoed in ["sneaky-param-name", "not-a-txid-marker"] {
            assert!(
                !reply.text().contains(echoed),
                "{echoed} echoed in {}",
                reply.text()
            );
        }
    }
}

// covers: REQ-VER-002
#[tokio::test]
async fn viewing_key_shaped_input_is_refused_never_looked_up_and_never_logged() {
    let f = fixture("ironwood_batch_3");
    let app = app(Chain::holding(&f, 6));
    let good = receipt_uri(&[f.txid], f.payout_total);
    let encoded: String = UFVK.bytes().map(|b| format!("%{b:02x}")).collect();
    let uris = [
        format!("{good}&ufvk={UFVK}"),
        format!("{good}&{UFVK}=1"),
        format!("{good}&campaign={UFVK}"),
        format!("/v1/receipt?network=testnet&tx={UFVK}&commitment={COMMITMENT}&declared_total=1"),
        format!("{good}&k={encoded}"),
        format!("{good}&k=uivk1abcdef"),
        format!("{good}&k=UFVK1ABCDEF"),
        format!("/v1/receipt?{UFVK}"),
    ];
    for uri in uris {
        let reply = get(&app, &uri).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(
            reply.json()["error"]["code"],
            "viewing_key_refused",
            "{uri}"
        );
        assert!(
            !reply.text().contains("sentinelufvk"),
            "echoed: {}",
            reply.text()
        );
    }
    assert_eq!(
        app.calls.load(Ordering::SeqCst),
        0,
        "a refused request never reaches the chain"
    );

    // An unmatched route carrying a key in the path is a plain 404 and is not logged either.
    let reply = get(&app, &format!("/v1/{UFVK}")).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert!(!reply.text().contains("sentinelufvk"));

    let logs = app.logs.lines().join("\n");
    assert!(!logs.contains("sentinelufvk"), "{logs}");
    assert!(!logs.contains(UFVK), "{logs}");
    assert!(!logs.contains(&encoded), "{logs}");
    assert!(logs.contains("viewing-key-shaped input refused"), "{logs}");
}

// covers: REQ-VER-002
#[tokio::test]
async fn the_number_of_transactions_per_request_is_bounded() {
    let f = fixture("ironwood_batch_3");
    let app = app_with(
        Chain::holding(&f, 6),
        Settings {
            max_txids: 2,
            ..Settings::default()
        },
        false,
    );
    let txids: Vec<Txid> = (1..=3u8).map(|i| Txid::from_bytes([i; 32])).collect();
    let reply = get(&app, &receipt_uri(&txids, 1)).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["error"]["code"], "too_many_transactions");
    assert_eq!(app.calls.load(Ordering::SeqCst), 0);
    let ok = get(&app, &receipt_uri(&txids[..2], 1)).await;
    assert_eq!(ok.status, StatusCode::OK);
}

// covers: REQ-VER-002
#[tokio::test]
async fn an_unconfigured_network_is_refused() {
    let f = fixture("ironwood_batch_3");
    let app = app(Chain::holding(&f, 6));
    let uri = receipt_uri(&[f.txid], 1).replace("testnet", "mainnet");
    let reply = get(&app, &uri).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.json()["error"]["code"], "network_not_configured");
    let main_only = app_with(Chain::holding(&f, 6), Settings::default(), true);
    assert_eq!(get(&main_only, &uri).await.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// Operational limits
// ---------------------------------------------------------------------------

// covers: REQ-VER-001
#[tokio::test]
async fn chain_outages_are_503_and_502_not_findings() {
    let f = fixture("ironwood_batch_3");
    let down = app(Chain {
        down: true,
        ..Chain::holding(&f, 6)
    });
    let reply = get(&down, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.json()["error"]["code"], "chain_unavailable");

    let odd = app(Chain {
        inconsistent: true,
        ..Chain::holding(&f, 6)
    });
    let reply = get(&odd, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json()["error"]["code"], "chain_inconsistent");
}

// covers: REQ-VER-002
#[tokio::test]
async fn a_slow_chain_times_out_instead_of_hanging() {
    let f = fixture("ironwood_batch_3");
    let app = app_with(
        Chain {
            delay: Some(Duration::from_secs(5)),
            ..Chain::holding(&f, 6)
        },
        Settings {
            request_timeout: Duration::from_millis(100),
            ..Settings::default()
        },
        false,
    );
    let started = std::time::Instant::now();
    let reply = get(&app, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(reply.status, StatusCode::GATEWAY_TIMEOUT);
    assert!(started.elapsed() < Duration::from_secs(2));
}

// covers: REQ-VER-002
#[tokio::test]
async fn cors_is_off_unless_configured_and_then_limited_to_the_named_origins() {
    let f = fixture("ironwood_batch_3");
    let uri = receipt_uri(&[f.txid], f.payout_total);
    let origin = "https://receipts.example.org";

    let closed = app(Chain::holding(&f, 6));
    let reply = get_with(&closed, &uri, &[("origin", origin)]).await;
    assert!(reply.headers.get("access-control-allow-origin").is_none());

    let listed = app_with(
        Chain::holding(&f, 6),
        Settings {
            cors_origins: vec![origin.to_owned()],
            ..Settings::default()
        },
        false,
    );
    let reply = get_with(&listed, &uri, &[("origin", origin)]).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.headers["access-control-allow-origin"], origin);
    let other = get_with(&listed, &uri, &[("origin", "https://evil.example")]).await;
    assert!(other.headers.get("access-control-allow-origin").is_none());

    let any = app_with(
        Chain::holding(&f, 6),
        Settings {
            cors_origins: vec!["*".to_owned()],
            ..Settings::default()
        },
        false,
    );
    let reply = get_with(&any, &uri, &[("origin", "https://anything.example")]).await;
    assert_eq!(reply.headers["access-control-allow-origin"], "*");
    assert!(reply
        .headers
        .get("access-control-allow-credentials")
        .is_none());
}

// covers: REQ-VER-002
#[tokio::test]
async fn logs_hold_route_templates_and_counts_only() {
    let f = fixture("ironwood_batch_3");
    let app = app(Chain::holding(&f, 6));
    let uri = receipt_uri(&[f.txid], f.payout_total);
    get(&app, &uri).await;
    get(&app, &format!("{uri}&campaign=spring-drop")).await;
    get(&app, "/v1/health").await;
    get(&app, &format!("{uri}&unknown=1")).await;

    let logs = app.logs.lines().join("\n");
    assert!(logs.contains("GET /v1/receipt -> 200"), "{logs}");
    assert!(
        logs.contains("receipt network=testnet txids=1 findings=0"),
        "{logs}"
    );
    for leaked in [
        f.txid.to_string().as_str(),
        COMMITMENT,
        "declared_total",
        "spring-drop",
        "unknown=1",
        "commitment",
    ] {
        assert!(!logs.contains(leaked), "{leaked} in {logs}");
    }
}

#[tokio::test]
async fn responses_carry_hardening_headers_and_are_never_cached() {
    let app = app(Chain::default());
    for uri in ["/v1/health", "/v1/receipt", "/nope"] {
        let reply = get(&app, uri).await;
        assert_eq!(reply.headers["x-content-type-options"], "nosniff", "{uri}");
        assert_eq!(reply.headers["referrer-policy"], "no-referrer", "{uri}");
        assert_eq!(reply.headers["cache-control"], "no-store", "{uri}");
    }
}

// covers: REQ-VER-002
#[tokio::test]
async fn the_service_keeps_no_state_between_requests() {
    let f = fixture("ironwood_batch_3");
    let app = app(Chain::holding(&f, 6));
    let uri = receipt_uri(&[f.txid], f.payout_total);
    let first = get(&app, &uri).await.json();
    let second = get(&app, &uri).await.json();
    assert_eq!(first, second);
    // A different declared total on the same transaction gives a different answer:
    // nothing from the first request was remembered.
    let other = get(&app, &receipt_uri(&[f.txid], f.payout_total + 1))
        .await
        .json();
    assert_eq!(other["findings"][0]["code"], "declared_total_mismatch");
    assert_eq!(get(&app, &uri).await.json(), first);
}

// ---------------------------------------------------------------------------
// Bounded work per request
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chain_lookups_per_request_are_bounded() {
    let f = fixture("ironwood_batch_3");
    // This batch needs two lookups: the batch transaction and its funding transaction.
    let tight = app_with(
        Chain::holding(&f, 6),
        Settings {
            max_lookups: 1,
            ..Settings::default()
        },
        false,
    );
    let reply = get(&tight, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.text()
    );
    assert_eq!(reply.json()["error"]["code"], "too_many_lookups");
    assert!(
        tight.calls.load(Ordering::SeqCst) <= 3,
        "stopped at the budget"
    );

    let enough = app_with(
        Chain::holding(&f, 6),
        Settings {
            max_lookups: 2,
            ..Settings::default()
        },
        false,
    );
    let reply = get(&enough, &receipt_uri(&[f.txid], f.payout_total)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
}
