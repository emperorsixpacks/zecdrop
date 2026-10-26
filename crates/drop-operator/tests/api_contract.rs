//! Golden contract for the operator API in real-chain mode.
//!
//! The mock chain can show the web app only one side of every real-mode field (a funding
//! address that is `null`, no progress, a wallet that always matches). This test drives the
//! real router over the real Zcash backend (an in-memory node, TEST-ONLY keys), writes each
//! response to `fixtures/contract/operator/golden/`, and fails when a response no longer
//! matches the stored file. Nothing here is a real address or key: values that would be are
//! replaced by obvious placeholders before they are compared or written.
//!
//! Regenerate, after an intended change, with:
//!
//! ```text
//! UPDATE_GOLDEN=1 cargo test -p drop-operator --test api_contract
//! ```

mod common;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use axum::http::{Method, StatusCode};
use common::zcash::*;
use common::*;
use drop_core::{CampaignId, FailureKind, Zatoshi};
use drop_operator::accounts::{AccountAllocator, AccountError};
use drop_operator::chain::{ChainError, UtxoSighting};
use drop_operator::real::{ZcashBackend, ZcashConnector};
use drop_operator::state::Options;
use drop_zcash::{CampaignKeys, ZcashAddressCodec};
use serde_json::{json, Map, Value};

const DEPTH: u32 = 3;

/// 450_000_000 declared + (3 outputs + 1 transparent) * 5000.
const REQUIRED: u64 = 450_020_000;

const FAKE_ID: &str = "c-000000000001";
const FAKE_COMMITMENT: &str = "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0";
const FAKE_ADDRESS: &str = "tFAKEfundingAddressNotARealAddress0000";
const FAKE_UFVK: &str = "uviewFAKEplaceholderNotAKeyNotAKeyNotAKeyNotAKey";

fn fake_outpoint() -> String {
    format!("{}:0", "cd".repeat(32))
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures")
        .join("contract")
        .join("operator")
        .join("golden")
}

/// Replaces every value that is random, time-dependent or derived from a key with a fixed,
/// obviously fake one, so reruns are byte-identical and no real key or address is written.
fn normalise(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                match (key.as_str(), &*inner) {
                    ("id" | "campaign_id", Value::String(_)) => *inner = json!(FAKE_ID),
                    ("created_at", Value::Number(_)) => *inner = json!(1_700_000_000u64),
                    ("manifest_commitment", Value::String(_)) => *inner = json!(FAKE_COMMITMENT),
                    ("funding_address" | "campaign_funding_address", Value::String(_)) => {
                        *inner = json!(FAKE_ADDRESS)
                    }
                    ("outpoint" | "funding_input", Value::String(_)) => {
                        *inner = json!(fake_outpoint())
                    }
                    ("ufvk", Value::String(_)) => *inner = json!(FAKE_UFVK),
                    ("txid", Value::String(_)) => *inner = json!("a0".repeat(32)),
                    _ => normalise(inner),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalise),
        _ => {}
    }
}

struct Golden {
    dir: PathBuf,
    update: bool,
    entries: Vec<Value>,
    names: BTreeSet<String>,
    /// Strings that must not appear in any file.
    forbidden: Vec<String>,
}

impl Golden {
    fn new() -> Golden {
        Golden {
            dir: golden_dir(),
            update: std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1"),
            entries: Vec::new(),
            names: BTreeSet::new(),
            forbidden: vec![
                hex::encode(TEST_SEED),
                String::from_utf8_lossy(&TEST_SEED).into_owned(),
                ufvk_of(0),
                CampaignKeys::derive(&TEST_SEED, NETWORK, 0)
                    .unwrap()
                    .funding_address(),
                CampaignKeys::derive(
                    &TEST_SEED,
                    zcash_protocol::consensus::Network::MainNetwork,
                    0,
                )
                .unwrap()
                .funding_address(),
                recipient_ua(0),
                recipient_ua(1),
                recipient_ua(2),
            ],
        }
    }

    /// Records one response: checks its status, normalises its body and compares it with
    /// (or, when updating, writes) the file `file`.
    fn record(
        &mut self,
        file: &str,
        method: &str,
        path: &str,
        status: u16,
        reply: &Reply,
        note: &str,
    ) {
        assert_eq!(reply.status.as_u16(), status, "{file}: {}", reply.text());
        let mut body = reply.json();
        normalise(&mut body);
        let mut text = serde_json::to_string_pretty(&body).unwrap();
        text.push('\n');
        for needle in &self.forbidden {
            assert!(
                !text.contains(needle.as_str()),
                "{file} contains a real value: {needle}"
            );
        }
        self.compare(file, &text);
        self.entries.push(json!({
            "file": file,
            "method": method,
            "path": path,
            "status": status,
            "note": note,
        }));
    }

    fn compare(&mut self, file: &str, fresh: &str) {
        assert!(self.names.insert(file.to_owned()), "{file} recorded twice");
        let path = self.dir.join(file);
        if self.update {
            std::fs::create_dir_all(&self.dir).unwrap();
            std::fs::write(&path, fresh).unwrap();
            return;
        }
        let stored = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "cannot read {}: {e}\nGenerate it with: UPDATE_GOLDEN=1 cargo test -p drop-operator --test api_contract",
                path.display()
            )
        });
        assert!(
            stored == fresh,
            "{} is out of date with what the operator now answers.\n\
             If the change is intended, regenerate with:\n  \
             UPDATE_GOLDEN=1 cargo test -p drop-operator --test api_contract\n\
             and update the web contract test.\n\n--- stored ---\n{stored}\n--- fresh ---\n{fresh}",
            path.display()
        );
    }

    /// Writes or checks the index, and fails on files that no scenario produces any more.
    fn finish(mut self) {
        let mut index = Map::new();
        index.insert(
            "generated_by".into(),
            json!("crates/drop-operator/tests/api_contract.rs"),
        );
        index.insert(
            "files".into(),
            Value::Array(std::mem::take(&mut self.entries)),
        );
        let mut text = serde_json::to_string_pretty(&Value::Object(index)).unwrap();
        text.push('\n');
        self.compare("index.json", &text);
        if self.update {
            return;
        }
        let present: BTreeSet<String> = std::fs::read_dir(&self.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".json"))
            .collect();
        let stale: Vec<_> = present.difference(&self.names).collect();
        assert!(
            stale.is_empty(),
            "golden files no scenario produces any more (delete them, or regenerate): {stale:?}"
        );
    }
}

fn ufvk_of(account: u32) -> String {
    CampaignKeys::derive(&TEST_SEED, NETWORK, account)
        .unwrap()
        .ufvk_encoded()
        .unwrap()
}

fn rows() -> Vec<Row> {
    vec![
        Row {
            address: recipient_ua(0),
            zat: 150_000_000,
            memo: Some("hello zero".into()),
        },
        Row {
            address: recipient_ua(1),
            zat: 75_000_000,
            memo: None,
        },
        Row {
            address: recipient_ua(2),
            zat: 225_000_000,
            memo: Some("thanks two".into()),
        },
    ]
}

fn create_body(rows: &[Row], max_outputs: usize) -> Value {
    let mut csv = String::from("address,amount,memo\n");
    for r in rows {
        csv.push_str(&format!(
            "{},{},{}\n",
            r.address,
            Zatoshi::new(r.zat).unwrap().format_zec(),
            r.memo.clone().unwrap_or_default()
        ));
    }
    json!({ "name": "Real drop", "csv": csv, "max_outputs_per_batch": max_outputs, "fee_policy": "zip317_text" })
}

async fn create(h: &Harness) -> (CampaignId, Reply) {
    let reply = h.post("/api/campaigns", create_body(&rows(), 5)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap();
    (id, reply)
}

fn campaign_path(id: &CampaignId, tail: &str) -> String {
    format!("/api/campaigns/{id}{tail}")
}

const CONFIRM: (&str, &str) = ("X-Zecdrop-Confirm-Disclosure", "I-UNDERSTAND");

/// A node that cannot be reached.
struct DownConnector;

impl ZcashConnector for DownConnector {
    type Backend = FakeZcashChain;

    fn connect(&self, _keys: &CampaignKeys) -> Result<FakeZcashChain, ChainError> {
        Err(down())
    }

    fn sightings(&self, _address: &str) -> Result<Vec<UtxoSighting>, ChainError> {
        Err(down())
    }
}

/// An account registry that cannot be written.
struct BrokenRegistry;

impl AccountAllocator for BrokenRegistry {
    fn reserve(&self, _fingerprint: &str, _in_store: Option<u32>) -> Result<u32, AccountError> {
        Err(AccountError::Io)
    }
}

fn down() -> ChainError {
    ChainError {
        message: "node unreachable".into(),
        kind: FailureKind::Transient,
    }
}

// covers: REQ-FUND-002, REQ-AUD-001, REQ-SEC-001, REQ-OPS-002
#[tokio::test]
async fn the_real_mode_api_shapes_are_pinned() {
    let mut g = Golden::new();
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);

    let health = h.get("/api/health").await;
    g.record(
        "health-real.json",
        "GET",
        "/api/health",
        200,
        &health,
        "a real chain: mock is false",
    );

    // A real-chain campaign: its own funding address, nothing seen on the chain yet.
    let (id, created) = create(&h).await;
    g.record(
        "create-real.json",
        "POST",
        "/api/campaigns",
        201,
        &created,
        "created on a real chain: a funding address of its own, wallet_matches true",
    );
    let address = created.json()["funding_address"]
        .as_str()
        .unwrap()
        .to_owned();
    g.forbidden.push(address.clone());
    let got = h.get(&campaign_path(&id, "")).await;
    g.record(
        "campaign-real-awaiting-deposit.json",
        "GET",
        "/api/campaigns/{id}",
        200,
        &got,
        "nothing seen at the funding address: funding and funding_progress are null",
    );

    // A deep deposit that is too small: progress only.
    put_deposit(&node, &address, REQUIRED - 1, Some(990), 1);
    let check = h.post_empty(&campaign_path(&id, "/check-funding")).await;
    g.record(
        "campaign-real-deposit-too-small.json",
        "POST",
        "/api/campaigns/{id}/check-funding",
        200,
        &check,
        "a deposit is seen but does not cover the plan: funding_progress.sufficient is false",
    );

    // Big enough, one block short of the required depth: still waiting.
    put_deposit(&node, &address, REQUIRED, Some(999), 2);
    let check = h.post_empty(&campaign_path(&id, "/check-funding")).await;
    g.record(
        "campaign-real-deposit-shallow.json",
        "POST",
        "/api/campaigns/{id}/check-funding",
        200,
        &check,
        "a sufficient deposit that is not deep enough yet: sufficient true, confirmations below required_depth",
    );

    // One more block: funded, and the progress note goes away.
    node.lock().tip = 1_001;
    let check = h.post_empty(&campaign_path(&id, "/check-funding")).await;
    g.record(
        "campaign-real-funded.json",
        "POST",
        "/api/campaigns/{id}/check-funding",
        200,
        &check,
        "the deposit is on the chain at the required depth: funding is set, funding_progress is null",
    );

    // The public receipt of a funded real campaign names the address its batches spend from.
    let receipt = h.get(&campaign_path(&id, "/receipt")).await;
    assert_eq!(receipt.json()["funding_address"], address.as_str());
    g.record(
        "receipt-real.json",
        "GET",
        "/api/campaigns/{id}/receipt",
        200,
        &receipt,
        "the public receipt on a real chain: funding_address is the campaign's transparent address, the one every batch spends from; null on the mock chain",
    );

    // The auditor's key: refused without the acknowledgement, with the warning either way.
    let refused = h.get(&campaign_path(&id, "/audit-ufvk-export")).await;
    g.record(
        "error-confirmation-required.json",
        "GET",
        "/api/campaigns/{id}/audit-ufvk-export",
        400,
        &refused,
        "the key is never released without X-Zecdrop-Confirm-Disclosure: I-UNDERSTAND; the warning is in the error",
    );
    let export = h
        .call_with(
            Method::GET,
            &campaign_path(&id, "/audit-ufvk-export"),
            Auth::Token,
            None,
            &[CONFIRM],
        )
        .await;
    g.record(
        "audit-ufvk-export.json",
        "GET",
        "/api/campaigns/{id}/audit-ufvk-export",
        200,
        &export,
        "the campaign viewing key (a placeholder here) with the warning the UI must show; irreversible",
    );

    // A real-chain operator cannot be told a deposit exists.
    let declared = h
        .post(
            &campaign_path(&id, "/fund-observed"),
            json!({ "outpoint": fake_outpoint(), "amount": REQUIRED.to_string() }),
        )
        .await;
    g.record(
        "error-dev-only.json",
        "POST",
        "/api/campaigns/{id}/fund-observed",
        403,
        &declared,
        "fund-observed exists on the mock chain only",
    );

    // A campaign that needs several batches cannot run on a real chain yet.
    let mut many = rows();
    many.push(Row {
        address: recipient_ua(3),
        zat: 10_000_000,
        memo: None,
    });
    let split = h.post("/api/campaigns", create_body(&many, 3)).await;
    g.record(
        "error-needs-funding-split.json",
        "POST",
        "/api/campaigns",
        422,
        &split,
        "more than one batch on a real chain: the funding-split transaction is not implemented",
    );

    // The same store opened by an operator holding another wallet seed.
    let other = h.restart_as(
        [0x99; 32],
        Options {
            required_depth: DEPTH,
            ..Builder::default().options
        },
    );
    let got = other.get(&campaign_path(&id, "")).await;
    g.record(
        "campaign-real-wrong-wallet.json",
        "GET",
        "/api/campaigns/{id}",
        200,
        &got,
        "the wallet in use did not make this campaign: wallet_matches is false and there is no funding address",
    );
    let start = other.post_empty(&campaign_path(&id, "/start")).await;
    g.record(
        "error-wrong-wallet-seed.json",
        "POST",
        "/api/campaigns/{id}/start",
        409,
        &start,
        "a campaign is never run with a seed that did not derive its account",
    );

    // A node that cannot be reached.
    let unreachable = Builder {
        seed: TEST_SEED,
        backend: Some(Arc::new(ZcashBackend::new(DownConnector))),
        codec: Some(Arc::new(ZcashAddressCodec::new(NETWORK))),
        ..Builder::default()
    }
    .build();
    let (id, _) = create(&unreachable).await;
    let check = unreachable
        .post_empty(&campaign_path(&id, "/check-funding"))
        .await;
    g.record(
        "error-chain-unavailable.json",
        "POST",
        "/api/campaigns/{id}/check-funding",
        503,
        &check,
        "the chain data source could not be reached; try again shortly",
    );

    // A batch no transaction could hold.
    let too_big = unreachable
        .post("/api/campaigns", create_body(&rows(), 331))
        .await;
    g.record(
        "error-batch-size-too-large.json",
        "POST",
        "/api/campaigns",
        422,
        &too_big,
        "max_outputs_per_batch above what one transaction can pay (330 Ironwood actions, ZIP-218)",
    );

    // An account registry that cannot record the next account number.
    let broken = Builder {
        seed: TEST_SEED,
        backend: Some(Arc::new(ZcashBackend::new(FakeConnector(
            SharedNode::default(),
        )))),
        codec: Some(Arc::new(ZcashAddressCodec::new(NETWORK))),
        accounts: Some(Arc::new(BrokenRegistry)),
        ..Builder::default()
    }
    .build();
    let refused = broken.post("/api/campaigns", create_body(&rows(), 5)).await;
    g.record(
        "error-account-registry.json",
        "POST",
        "/api/campaigns",
        500,
        &refused,
        "the account registry could not be written: no campaign is created rather than risk reusing an account",
    );

    // A request that names the server in a way only a rebinding page would.
    let rebinding = unreachable
        .call_with(
            Method::GET,
            "/api/health",
            Auth::None,
            None,
            &[("host", "evil.example")],
        )
        .await;
    g.record(
        "error-host-not-allowed.json",
        "GET",
        "/api/health",
        421,
        &rebinding,
        "the Host header is not a loopback name with the server's own port (DNS rebinding); applies to every route",
    );

    // A batch that failed after its transaction was built: the view still names the transaction,
    // which may be in flight or already mined.
    let (failed_id, _) = create(&unreachable).await;
    {
        use drop_core::{BatchStatus, Ledger, Txid};
        let mut ledger = unreachable.state.store().ledger();
        let txid = Txid::from_bytes([0xcc; 32]);
        ledger.record(&failed_id, 0, BatchStatus::Planned).unwrap();
        ledger
            .record(
                &failed_id,
                0,
                BatchStatus::Built {
                    txid,
                    raw_tx: vec![1, 2, 3],
                },
            )
            .unwrap();
        ledger
            .record(
                &failed_id,
                0,
                BatchStatus::Failed {
                    reason: "the node rejected the transaction".into(),
                    txid: None,
                },
            )
            .unwrap();
    }
    let failed = unreachable.get(&campaign_path(&failed_id, "")).await;
    g.record(
        "campaign-real-batch-failed.json",
        "GET",
        "/api/campaigns/{id}",
        200,
        &failed,
        "a batch failed after its transaction was built: state failed, with its reason and the txid of that transaction (null if the failure came before anything was built)",
    );

    // A store that was edited outside the operator.
    let (tampered_id, _) = create(&unreachable).await;
    rusqlite::Connection::open(&unreachable.db)
        .unwrap()
        .execute(
            "UPDATE campaigns SET account = account + 1 WHERE id = ?1",
            [tampered_id.as_str()],
        )
        .unwrap();
    let corrupt = unreachable.get(&campaign_path(&tampered_id, "")).await;
    g.record(
        "error-store-corrupt.json",
        "GET",
        "/api/campaigns/{id}",
        500,
        &corrupt,
        "a stored row failed its integrity check (edited outside the operator); nothing was acted on, no key is ever exported from it",
    );

    // Things only the mock chain answers.
    let mock = Harness::new();
    let (mock_id, _) = mock.create().await;
    let check = mock
        .post_empty(&campaign_path(&mock_id, "/check-funding"))
        .await;
    g.record(
        "error-not-applicable.json",
        "POST",
        "/api/campaigns/{id}/check-funding",
        409,
        &check,
        "the mock chain has no funding addresses to look at",
    );
    let export = mock
        .call_with(
            Method::GET,
            &campaign_path(&mock_id, "/audit-ufvk-export"),
            Auth::Token,
            None,
            &[CONFIRM],
        )
        .await;
    g.record(
        "error-not-available.json",
        "GET",
        "/api/campaigns/{id}/audit-ufvk-export",
        409,
        &export,
        "the mock chain has no real viewing keys",
    );

    near_scenarios(&mut g).await;

    g.finish();
}

// ---------------------------------------------------------------------------
// NEAR Intents funding (REQ-FUND-001)
// ---------------------------------------------------------------------------
//
// The service is a stand-in answering from drop-near's recorded fixtures. The token list and the
// dry quote have the shape the REAL service answered on 2026-10-07 (captured); the live quote and
// the statuses have the shape of its DOCUMENTATION (never captured: NEAR is mainnet-only and no
// non-dry quote was ever requested). The index notes say which is which.

const NEAR_REFUND: &str = "refund-account.near";
const NEAR_CONFIRM: (&str, &str) = ("x-zecdrop-confirm-near", "I-UNDERSTAND");

async fn mainnet_campaign(h: &Harness) -> CampaignId {
    let csv = format!(
        "address,amount,memo\n{},1.5,\n{},0.75,\n",
        recipient_ua_on(zcash_protocol::consensus::Network::MainNetwork, 0),
        recipient_ua_on(zcash_protocol::consensus::Network::MainNetwork, 1)
    );
    let reply = h
        .post(
            "/api/campaigns",
            json!({ "name": "Near drop", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap()
}

fn near_path(id: &CampaignId, tail: &str) -> String {
    format!("/api/campaigns/{id}/funding/near/{tail}")
}

async fn near_dry(h: &Harness, id: &CampaignId, origin: &str, refund: &str) -> Reply {
    h.post(
        &near_path(id, "dry-quote"),
        json!({ "origin_asset_id": origin, "refund_to": refund }),
    )
    .await
}

async fn near_live(h: &Harness, id: &CampaignId, headers: &[(&str, &str)]) -> Reply {
    h.call_with(
        Method::POST,
        &near_path(id, "live-quote"),
        Auth::Token,
        None,
        headers,
    )
    .await
}

async fn near_scenarios(g: &mut Golden) {
    use common::near::{Script, STATUSES, USDC};
    let preview_body = json!({ "origin_asset_id": USDC, "amount_zat": 545_000 });

    // ---- the testnet operator: tokens, a price preview, and why a campaign cannot use it ----
    let testnet = Harness::new();
    let tokens = testnet.get("/api/near/tokens").await;
    g.record("near-tokens.json", "GET", "/api/near/tokens", 200, &tokens,
        "CAPTURED SHAPE: the usable origin assets (no ZEC), sorted; the list is the real service's of 2026-10-07 (an excerpt), cached for 60 s");
    let preview = testnet
        .post("/api/near/preview", preview_body.clone())
        .await;
    g.record("near-preview.json", "POST", "/api/near/preview", 200, &preview,
        "CAPTURED SHAPE: a dry quote for 545,000 zat of native ZEC from USDC on NEAR, exactly the request the real service answered on 2026-10-07; works on testnet and mainnet operators; creates nothing");
    let (testnet_id, _) = testnet.create().await;
    let not_applicable = near_dry(&testnet, &testnet_id, USDC, NEAR_REFUND).await;
    g.record("error-near-not-applicable.json", "POST", "/api/campaigns/{id}/funding/near/dry-quote", 409, &not_applicable,
        "a testnet campaign cannot be funded through NEAR Intents (mainnet ZEC only); the same answer for live-quote and status");
    let bad_origin = testnet
        .post(
            "/api/near/preview",
            json!({ "origin_asset_id": "nep141:not-listed.near", "amount_zat": 1000 }),
        )
        .await;
    g.record(
        "error-near-unknown-origin-asset.json",
        "POST",
        "/api/near/preview",
        422,
        &bad_origin,
        "the origin asset is not in the service's token list",
    );
    let zec_origin = testnet
        .post(
            "/api/near/preview",
            json!({ "origin_asset_id": "nep141:zec.omft.near", "amount_zat": 1000 }),
        )
        .await;
    g.record(
        "error-near-zec-origin-not-allowed.json",
        "POST",
        "/api/near/preview",
        422,
        &zec_origin,
        "ZEC (native or bridged) is what the campaign receives, never what pays",
    );
    let bad_amount = testnet
        .post(
            "/api/near/preview",
            json!({ "origin_asset_id": USDC, "amount_zat": 0 }),
        )
        .await;
    g.record(
        "error-near-amount-out-of-range.json",
        "POST",
        "/api/near/preview",
        422,
        &bad_amount,
        "amount_zat must be a whole number of zatoshi above zero and within the total supply",
    );

    // ---- the service misbehaving, seen through the preview ----
    for (file, status, note, edit) in [
        (
            "error-near-unavailable.json",
            503,
            "the service could not be reached",
            Box::new(|s: &mut Script| s.transport_error = Some("down".into()))
                as Box<dyn Fn(&mut Script)>,
        ),
        (
            "error-near-rejected.json",
            502,
            "the service refused the request; only the HTTP status is repeated, never its words",
            Box::new(|s: &mut Script| s.fail_with = Some((400, "no".into()))),
        ),
        (
            "error-near-unauthorized.json",
            502,
            "the service rejected the credentials (NEAR_INTENTS_JWT)",
            Box::new(|s: &mut Script| s.fail_with = Some((401, "no".into()))),
        ),
        (
            "error-near-quote-mismatch.json",
            502,
            "the service quoted a different output than asked for",
            Box::new(|s: &mut Script| s.dry_amount_out = Some("1".into())),
        ),
        (
            "error-near-bad-response.json",
            502,
            "the service answered with something unusable (here: a deposit address on a dry quote)",
            Box::new(|s: &mut Script| s.dry_with_address = true),
        ),
    ] {
        testnet.clock.advance(61); // a stale token cache, so the failing call is the one asked
        testnet.near.script(|s| *s = Script::default());
        testnet.near.script(edit);
        let reply = testnet
            .post("/api/near/preview", preview_body.clone())
            .await;
        g.record(file, "POST", "/api/near/preview", status, &reply, note);
    }

    // ---- a mainnet campaign on a mainnet operator that allows it ----
    let mainnet = mainnet_harness(&SharedNode::default(), 3, true);
    let id = mainnet_campaign(&mainnet).await;
    let bad_refund = near_dry(&mainnet, &id, USDC, "not a plain address!").await;
    g.record(
        "error-near-invalid-refund-address.json",
        "POST",
        "/api/campaigns/{id}/funding/near/dry-quote",
        422,
        &bad_refund,
        "the refund address must be plain text on the origin chain",
    );
    let no_dry = near_live(&mainnet, &id, &[NEAR_CONFIRM]).await;
    g.record(
        "error-near-no-dry-quote.json",
        "POST",
        "/api/campaigns/{id}/funding/near/live-quote",
        409,
        &no_dry,
        "a deposit address is only asked for after a dry quote for this campaign",
    );
    let no_quote = mainnet.get(&near_path(&id, "status")).await;
    g.record(
        "error-near-no-live-quote.json",
        "GET",
        "/api/campaigns/{id}/funding/near/status",
        409,
        &no_quote,
        "no deposit address was ever asked for this campaign",
    );

    let dry = near_dry(&mainnet, &id, USDC, NEAR_REFUND).await;
    g.record("near-dry-quote.json", "POST", "/api/campaigns/{id}/funding/near/dry-quote", 200, &dry,
        "SHAPE OF THE CAPTURED DRY QUOTE with this campaign's own amount and recipient substituted; mainnet campaigns only; creates nothing; good for 10 minutes");
    let unconfirmed = near_live(&mainnet, &id, &[]).await;
    g.record("error-near-confirmation-required.json", "POST", "/api/campaigns/{id}/funding/near/live-quote", 400, &unconfirmed,
        "the live quote needs the header X-Zecdrop-Confirm-Near: I-UNDERSTAND; the warning to show is in the error");
    let live = near_live(&mainnet, &id, &[NEAR_CONFIRM]).await;
    g.record("near-live-quote.json", "POST", "/api/campaigns/{id}/funding/near/live-quote", 200, &live,
        "FROM THE DOCUMENTATION, NEVER CAPTURED: the deposit address, amount and deadline, plain instructions, and campaign_funded: false (it never says funded)");
    let again = near_live(&mainnet, &id, &[NEAR_CONFIRM]).await;
    g.record(
        "error-near-live-quote-exists.json",
        "POST",
        "/api/campaigns/{id}/funding/near/live-quote",
        409,
        &again,
        "the campaign already has a deposit address that is still valid",
    );
    for stem in STATUSES {
        mainnet.near.script(|s| s.status = stem);
        let reply = mainnet.get(&near_path(&id, "status")).await;
        g.record(&format!("near-status-{stem}.json"), "GET", "/api/campaigns/{id}/funding/near/status", 200, &reply,
            "FROM THE DOCUMENTATION, NEVER CAPTURED: a status as a closed word plus the next step; campaign_funded comes from the operator's own record, never from the service");
    }

    // ---- more refusals, each on a campaign of its own ----
    let expired_id = mainnet_campaign(&mainnet).await;
    near_dry(&mainnet, &expired_id, USDC, NEAR_REFUND).await;
    mainnet.clock.advance(601);
    let expired = near_live(&mainnet, &expired_id, &[NEAR_CONFIRM]).await;
    g.record(
        "error-near-dry-quote-expired.json",
        "POST",
        "/api/campaigns/{id}/funding/near/live-quote",
        409,
        &expired,
        "the dry quote is older than ten minutes",
    );
    let stale_id = mainnet_campaign(&mainnet).await;
    near_dry(&mainnet, &stale_id, USDC, NEAR_REFUND).await;
    let mut pending = mainnet.state.near().take_dry(&stale_id).unwrap();
    pending.funding_required = Zatoshi::new(pending.funding_required.as_u64() + 1).unwrap();
    mainnet.state.near().keep_dry(stale_id.clone(), pending);
    let stale = near_live(&mainnet, &stale_id, &[NEAR_CONFIRM]).await;
    g.record(
        "error-near-dry-quote-stale.json",
        "POST",
        "/api/campaigns/{id}/funding/near/live-quote",
        409,
        &stale,
        "what the campaign needs changed since the dry quote",
    );
    let funded_id = mainnet_campaign(&mainnet).await;
    mainnet
        .state
        .store()
        .record_funding(
            &funded_id,
            drop_operator::store::FundingObserved {
                outpoint: drop_core::OutPoint {
                    txid: "ab".repeat(32).parse().unwrap(),
                    vout: 0,
                },
                amount: Zatoshi::new(1_000_000_000).unwrap(),
            },
        )
        .unwrap();
    let funded = near_dry(&mainnet, &funded_id, USDC, NEAR_REFUND).await;
    g.record(
        "error-near-already-funded.json",
        "POST",
        "/api/campaigns/{id}/funding/near/dry-quote",
        409,
        &funded,
        "the campaign already has its deposit",
    );

    // ---- a mainnet operator not started with --allow-mainnet ----
    let cautious = mainnet_harness(&SharedNode::default(), 3, false);
    let cautious_id = mainnet_campaign(&cautious).await;
    near_dry(&cautious, &cautious_id, USDC, NEAR_REFUND).await;
    let refused = near_live(&cautious, &cautious_id, &[NEAR_CONFIRM]).await;
    g.record(
        "error-near-mainnet-not-enabled.json",
        "POST",
        "/api/campaigns/{id}/funding/near/live-quote",
        403,
        &refused,
        "a real swap is mainnet money: the operator must be started with --allow-mainnet",
    );
}
