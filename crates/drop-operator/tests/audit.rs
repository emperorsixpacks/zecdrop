//! The local audit and the viewing-key export, over genuine Orchard batch transactions built
//! with TEST-ONLY keys. The chain is an in-memory `ChainSource`; nothing touches a network.
//!
//! The proofs are expensive, so the three transactions are built once and shared.

mod common;

use std::io::Cursor;
use std::sync::OnceLock;

use axum::http::{Method, StatusCode};
use clap::{CommandFactory, Parser};
use common::zcash::*;
use common::*;
use drop_core::{
    BatchStatus, CampaignId, Finding, Ledger, ManifestCommitment, Network, Txid, Zatoshi,
};
use drop_operator::audit::{audit_campaign, AuditError, AuditInput, AuditReport};
use drop_operator::commands::{
    campaign_ufvk, run_audit, run_export_ufvk, CommandError, DISCLOSURE_WARNING,
};
use drop_operator::config::{AuditArgs, Cli, Command, ExportArgs};
use drop_operator::secret::SecretSeed;
use drop_verify::FetchedTx;
use drop_zcash::inspect::recover_with_ufvk;
use drop_zcash::CampaignKeys;
use serde_json::{json, Value};

const DEPTH: u32 = 3;

// ---------------------------------------------------------------------------
// Material: three genuine batch transactions, built once
// ---------------------------------------------------------------------------

/// One campaign's chain material: the deposit and the batch that spent it.
struct Prepared {
    account: u32,
    rows: Vec<Row>,
    funding: (Txid, Vec<u8>),
    batch: (Txid, Vec<u8>),
}

struct Fixture {
    /// Three recipients, campaign account 0.
    a: Prepared,
    /// Three other recipients, campaign account 1.
    b: Prepared,
    /// One recipient, account 0.
    solo: Prepared,
}

fn prepare(account: u32, rows: Vec<Row>, salt: u8) -> Prepared {
    let total: u64 = rows.iter().map(|r| r.zat).sum();
    let value = total + 20_000_000;
    let keys = CampaignKeys::derive(&TEST_SEED, NETWORK, account).unwrap();
    let funding = funding_tx(&keys.funding_address(), value, salt);
    let batch = batch_tx(account, &rows, (&funding.0, value));
    Prepared {
        account,
        rows,
        funding,
        batch,
    }
}

fn row(i: u32, zat: u64, memo: Option<&str>) -> Row {
    Row {
        address: recipient_ua(i),
        zat,
        memo: memo.map(str::to_owned),
    }
}

fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| Fixture {
        a: prepare(
            0,
            vec![
                row(0, 150_000_000, Some("hello zero")),
                row(1, 75_000_000, None),
                row(2, 225_000_000, Some("thanks two")),
            ],
            11,
        ),
        b: prepare(
            1,
            vec![
                row(10, 100_000_000, Some("b one")),
                row(11, 200_000_000, None),
                row(12, 50_000_000, Some("b three")),
            ],
            12,
        ),
        solo: prepare(0, vec![row(20, 40_000_000, Some("solo memo"))], 13),
    })
}

/// A campaign of two batches of two recipients each, both under account 0.
fn multi() -> &'static [Prepared; 2] {
    static MULTI: OnceLock<[Prepared; 2]> = OnceLock::new();
    MULTI.get_or_init(|| {
        [
            prepare(
                0,
                vec![
                    row(30, 60_000_000, Some("m zero")),
                    row(31, 70_000_000, None),
                ],
                14,
            ),
            prepare(
                0,
                vec![
                    row(32, 80_000_000, None),
                    row(33, 90_000_000, Some("m three")),
                ],
                15,
            ),
        ]
    })
}

fn mined_height() -> u32 {
    u32::from(ironwood_height()) + 1
}

/// A chain holding these campaigns' deposits and batches, `confirmations` deep.
fn chain(campaigns: &[&Prepared], confirmations: u32) -> StaticChain {
    let mut chain = StaticChain {
        tip: mined_height() + confirmations - 1,
        ..StaticChain::default()
    };
    for p in campaigns {
        chain.txs.insert(
            p.funding.0,
            FetchedTx {
                raw: p.funding.1.clone(),
                mined_height: Some(1),
            },
        );
        chain.txs.insert(
            p.batch.0,
            FetchedTx {
                raw: p.batch.1.clone(),
                mined_height: Some(mined_height()),
            },
        );
    }
    chain
}

fn ufvk_of(account: u32) -> String {
    CampaignKeys::derive(&TEST_SEED, NETWORK, account)
        .unwrap()
        .ufvk_encoded()
        .unwrap()
}

// ---------------------------------------------------------------------------
// Campaigns in a store
// ---------------------------------------------------------------------------

fn body(rows: &[Row]) -> Value {
    let mut csv = String::from("address,amount,memo\n");
    for r in rows {
        csv.push_str(&format!(
            "{},{},{}\n",
            r.address,
            Zatoshi::new(r.zat).unwrap().format_zec(),
            r.memo.clone().unwrap_or_default()
        ));
    }
    json!({ "name": "Audit drop", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" })
}

fn harness() -> Harness {
    real_harness(&SharedNode::default(), DEPTH)
}

/// Creates a campaign through the API, so it has its own account, manifest and commitment.
async fn create(h: &Harness, rows: &[Row]) -> (CampaignId, u32) {
    let reply = h.post("/api/campaigns", body(rows)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap();
    let account = h.state.store().load_campaign(&id).unwrap().unwrap().account;
    (id, account)
}

/// Records the batch as built, sent and confirmed, as the engine would have.
fn settle(h: &Harness, id: &CampaignId, p: &Prepared) {
    settle_batch(h, id, 0, p);
}

fn settle_batch(h: &Harness, id: &CampaignId, index: u32, p: &Prepared) {
    let mut ledger = h.state.store().ledger();
    let txid = p.batch.0;
    ledger.record(id, index, BatchStatus::Planned).unwrap();
    ledger
        .record(
            id,
            index,
            BatchStatus::Built {
                txid,
                raw_tx: p.batch.1.clone(),
            },
        )
        .unwrap();
    ledger
        .record(id, index, BatchStatus::Broadcast { txid })
        .unwrap();
    ledger
        .record(id, index, BatchStatus::Confirmed { txid, depth: 6 })
        .unwrap();
}

/// A store holding one campaign whose stored payout list is `listed`, with `paid`'s batch
/// recorded as its (only) confirmed transaction.
async fn case(listed: &[Row], paid: &Prepared) -> (Harness, CampaignId) {
    let h = harness();
    let (id, account) = create(&h, listed).await;
    assert_eq!(account, paid.account, "the first campaign gets account 0");
    settle(&h, &id, paid);
    (h, id)
}

async fn audit_with(
    h: &Harness,
    id: &CampaignId,
    chain: &StaticChain,
    ufvk: &str,
    receipt: Option<ManifestCommitment>,
    batches: u32,
) -> AuditReport {
    let store = h.state.store();
    let record = store.load_campaign(id).unwrap().unwrap();
    let statuses = store.ledger().statuses(&record.id, batches).unwrap();
    audit_campaign(
        chain,
        AuditInput {
            record: &record,
            statuses: &statuses,
            ufvk,
            receipt_commitment: receipt.unwrap_or(record.commitment),
            required_depth: DEPTH,
        },
    )
    .await
    .unwrap()
}

async fn audit(h: &Harness, id: &CampaignId, chain: &StaticChain, ufvk: &str) -> AuditReport {
    audit_with(h, id, chain, ufvk, None, 1).await
}

/// The rendered line that mentions `what`; the verdict is at its end.
fn line_with<'a>(text: &'a str, what: &str) -> &'a str {
    text.lines()
        .find(|l| l.contains(what))
        .unwrap_or_else(|| panic!("no line with {what:?} in:\n{text}"))
}

const NET_A: u64 = 450_000_000;

// ---------------------------------------------------------------------------
// REQ-AUD-001: counts and sums, with differences reported
// ---------------------------------------------------------------------------

// covers: REQ-AUD-001, REQ-AUD-003
#[tokio::test]
async fn a_campaign_paid_as_listed_reconciles() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let report = audit(&h, &id, &chain(&[&f.a], 10), &ufvk_of(0)).await;

    assert!(report.reconciled, "{}", report.render());
    let text = report.render();
    // The sums carry the network's coin: TAZ on testnet, ZEC on mainnet.
    let sum_line = line_with(&text, "recovered total");
    assert!(
        sum_line.contains("TAZ") && !sum_line.contains("ZEC"),
        "{sum_line}"
    );
    let on_mainnet = drop_operator::audit::AuditReport {
        network: Network::Mainnet,
        ..report.clone()
    };
    let sum_line = on_mainnet.render();
    let sum_line = line_with(&sum_line, "recovered total");
    assert!(
        sum_line.contains("ZEC") && !sum_line.contains("TAZ"),
        "{sum_line}"
    );
    assert!(
        line_with(&text, "outputs recovered").ends_with("matches"),
        "{text}"
    );
    assert!(
        line_with(&text, "recovered total").ends_with("matches"),
        "{text}"
    );
    assert!(
        line_with(&text, "recomputed").ends_with("matches"),
        "{text}"
    );
    assert!(text.contains("RESULT: reconciled"), "{text}");
    assert_eq!(report.batches.len(), 1);
    let batch = &report.batches[0];
    let net = Zatoshi::new(NET_A).unwrap();
    assert!(batch.found);
    assert_eq!(batch.txid, Some(f.a.batch.0));
    assert_eq!(batch.confirmations, 10);
    assert_eq!(batch.planned_recipients, 3);
    assert_eq!(batch.public_actions, Some(3));
    assert_eq!(batch.recovered_outputs, 3);
    assert_eq!(batch.count_matches, Some(true));
    assert_eq!(batch.public_net_into_pool, Some(net));
    assert_eq!(batch.recovered_sum, Some(net));
    assert_eq!(batch.sum_matches, Some(true));
    assert!(batch.findings.is_empty(), "{:?}", batch.findings);

    let commitment = &report.commitment;
    let stored = h
        .state
        .store()
        .load_campaign(&id)
        .unwrap()
        .unwrap()
        .commitment;
    assert_eq!(commitment.receipt, stored);
    assert_eq!(commitment.recomputed, Some(stored));
    assert!(commitment.matches);
    assert_eq!((commitment.rows_matched, commitment.rows_total), (3, 3));
    assert_eq!(commitment.unmatched_outputs, 0);
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_single_recipient_batch_has_no_comparable_count() {
    // One output is padded to two actions, so the counts differ by design (the requirement
    // compares counts only for batches of two or more) and the sum is what is checked.
    let f = fixture();
    let (h, id) = case(&f.solo.rows, &f.solo).await;
    let report = audit(&h, &id, &chain(&[&f.solo], 10), &ufvk_of(0)).await;
    let batch = &report.batches[0];
    assert_eq!(batch.planned_recipients, 1);
    assert_eq!(batch.recovered_outputs, 1);
    assert_eq!(batch.public_actions, Some(2));
    assert_eq!(batch.count_matches, None);
    assert_eq!(batch.sum_matches, Some(true));
    assert!(report.reconciled, "{}", report.render());
    assert!(report.render().contains("not comparable"));
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_key_that_opens_nothing_is_reported_as_a_difference_in_count_and_sum() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    // Another campaign account's key is valid for the network but opens none of these outputs.
    let report = audit(&h, &id, &chain(&[&f.a], 10), &ufvk_of(5)).await;

    assert!(!report.reconciled);
    let batch = &report.batches[0];
    assert!(batch.found);
    assert_eq!(batch.recovered_outputs, 0);
    assert_eq!(batch.public_actions, Some(3));
    assert_eq!(batch.count_matches, Some(false));
    assert_eq!(batch.recovered_sum, Some(Zatoshi::ZERO));
    assert_eq!(
        batch.public_net_into_pool,
        Some(Zatoshi::new(NET_A).unwrap())
    );
    assert_eq!(batch.sum_matches, Some(false));
    let commitment = &report.commitment;
    assert_eq!((commitment.rows_matched, commitment.rows_total), (0, 3));
    assert!(!commitment.matches);
    assert_eq!(commitment.recomputed, None);

    let text = report.render();
    assert!(text.contains("NOT reconciled"), "{text}");
    // Each verdict is on its own line, so a difference in one cannot be masked by the others.
    let count = line_with(&text, "outputs recovered");
    assert!(
        count.contains("0 of 3 public actions") && count.ends_with("DIFFERS"),
        "{count}"
    );
    let sum = line_with(&text, "recovered total");
    assert!(sum.ends_with("DIFFERS"), "{sum}");
    assert!(line_with(&text, "recomputed").ends_with("DIFFERS"));
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_batch_the_chain_does_not_know_is_reported_not_found() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let report = audit(&h, &id, &StaticChain::default(), &ufvk_of(0)).await;

    assert!(!report.reconciled);
    let batch = &report.batches[0];
    assert!(!batch.found);
    assert_eq!(batch.txid, Some(f.a.batch.0));
    assert_eq!(batch.recovered_outputs, 0);
    assert_eq!(batch.count_matches, None);
    assert_eq!(batch.sum_matches, None);
    assert!(batch
        .findings
        .iter()
        .any(|f| matches!(f, Finding::TxNotFound { .. })));
    assert_eq!(report.commitment.rows_matched, 0);
    let text = report.render();
    assert!(text.contains("NOT FOUND on the chain"), "{text}");
    assert!(
        text.contains("note: "),
        "the findings are shown too: {text}"
    );
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_batch_the_chain_returns_as_garbage_is_not_found_either() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let mut garbled = chain(&[&f.a], 10);
    garbled.txs.get_mut(&f.a.batch.0).unwrap().raw = vec![0x05, 0x00, 0x00, 0x80, 0xff];
    let report = audit(&h, &id, &garbled, &ufvk_of(0)).await;

    assert!(!report.reconciled);
    let batch = &report.batches[0];
    assert!(!batch.found);
    assert_eq!(batch.recovered_outputs, 0);
    assert!(batch
        .findings
        .iter()
        .any(|f| matches!(f, Finding::TxUnparseable { .. })));
    let text = report.render();
    assert!(
        text.contains("not a transaction this tool can read"),
        "{text}"
    );
    assert!(!text.contains("NOT FOUND on the chain"), "{text}");
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_deposit_the_chain_cannot_show_keeps_the_batch_from_reconciling() {
    // The value that entered the pool is in the shielded bundle, but without the deposit
    // transaction the chain cannot show where the transparent inputs came from, so the public
    // balance cannot be checked: the verifier says so, and so does the audit.
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let mut no_deposit = chain(&[&f.a], 10);
    no_deposit.txs.remove(&f.a.funding.0);
    let report = audit(&h, &id, &no_deposit, &ufvk_of(0)).await;

    let batch = &report.batches[0];
    assert!(batch.found);
    assert_eq!(
        batch.recovered_outputs, 3,
        "the key still opens the outputs"
    );
    assert_eq!(batch.sum_matches, Some(true));
    assert!(!batch.findings.is_empty(), "the verifier's finding is kept");
    assert!(!report.reconciled, "{}", report.render());
    assert!(report.render().contains("note: "));
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_batch_not_built_yet_leaves_nothing_to_reconcile() {
    let f = fixture();
    let h = harness();
    let (id, _) = create(&h, &f.a.rows).await;
    let report = audit(&h, &id, &chain(&[&f.a], 10), &ufvk_of(0)).await;

    assert!(!report.reconciled);
    assert_eq!(report.batches[0].txid, None);
    assert!(!report.batches[0].found);
    assert!(report.render().contains("not built yet"));
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_batch_that_is_not_final_yet_is_not_reconciled() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    // Two confirmations against a required depth of three: everything else matches.
    let report = audit(&h, &id, &chain(&[&f.a], DEPTH - 1), &ufvk_of(0)).await;
    let batch = &report.batches[0];
    assert!(batch.found);
    assert_eq!(batch.count_matches, Some(true));
    assert_eq!(batch.sum_matches, Some(true));
    assert!(report.commitment.matches);
    assert!(batch
        .findings
        .iter()
        .any(|f| matches!(f, Finding::BatchPending { .. })));
    assert!(!report.reconciled, "{}", report.render());
    // At exactly the required depth it is final.
    let report = audit(&h, &id, &chain(&[&f.a], DEPTH), &ufvk_of(0)).await;
    assert!(report.reconciled, "{}", report.render());
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_key_for_the_wrong_network_is_refused_without_echoing_it() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let mainnet = CampaignKeys::derive(
        &TEST_SEED,
        zcash_protocol::consensus::Network::MainNetwork,
        0,
    )
    .unwrap()
    .ufvk_encoded()
    .unwrap();
    let store = h.state.store();
    let record = store.load_campaign(&id).unwrap().unwrap();
    let statuses = store.ledger().statuses(&record.id, 1).unwrap();
    let error = audit_campaign(
        &chain(&[&f.a], 10),
        AuditInput {
            record: &record,
            statuses: &statuses,
            ufvk: &mainnet,
            receipt_commitment: record.commitment,
            required_depth: DEPTH,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error, AuditError::UfvkNetwork);
    let shown = format!("{error} {error:?}");
    assert!(
        !shown.contains(&mainnet) && !shown.contains("uview"),
        "{shown}"
    );
}

// A campaign of several batches. Real mode runs one batch per campaign until the funding
// split exists, but the audit does not depend on that, so the store here is the mock one,
// which plans any number of batches.
async fn multi_case(listed_first: usize) -> (Harness, CampaignId, Vec<Row>) {
    let m = multi();
    let mut rows: Vec<Row> = m[0].rows.iter().chain(&m[1].rows).cloned().collect();
    if listed_first == 1 {
        // The payout list names the second group first.
        rows = m[1].rows.iter().chain(&m[0].rows).cloned().collect();
    }
    let h = Harness::new();
    let mut request = body(&rows);
    request["max_outputs_per_batch"] = json!(2);
    let reply = h.post("/api/campaigns", request).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap();
    settle_batch(&h, &id, 0, &m[0]);
    settle_batch(&h, &id, 1, &m[1]);
    (h, id, rows)
}

// covers: REQ-AUD-001, REQ-AUD-003
#[tokio::test]
async fn a_campaign_of_several_batches_is_audited_batch_by_batch() {
    let m = multi();
    let (h, id, _) = multi_case(0).await;
    let report = audit_with(&h, &id, &chain(&[&m[0], &m[1]], 10), &ufvk_of(0), None, 2).await;

    assert!(report.reconciled, "{}", report.render());
    assert_eq!(report.batches.len(), 2);
    for (batch, (txid, net)) in report
        .batches
        .iter()
        .zip([(m[0].batch.0, 130_000_000), (m[1].batch.0, 170_000_000)])
    {
        let net = Zatoshi::new(net).unwrap();
        assert_eq!(batch.txid, Some(txid));
        assert_eq!(batch.recovered_outputs, 2);
        assert_eq!(batch.public_actions, Some(2));
        assert_eq!(batch.count_matches, Some(true));
        assert_eq!(batch.recovered_sum, Some(net));
        assert_eq!(batch.public_net_into_pool, Some(net));
    }
    assert_eq!(report.batches[1].index, 1);
    assert_eq!(
        (report.commitment.rows_matched, report.commitment.rows_total),
        (4, 4)
    );
    assert!(report.commitment.matches);
}

// covers: REQ-AUD-001, REQ-AUD-003
#[tokio::test]
async fn one_missing_batch_of_several_is_not_hidden_by_the_others() {
    let m = multi();
    let (h, id, _) = multi_case(0).await;
    let report = audit_with(&h, &id, &chain(&[&m[0]], 10), &ufvk_of(0), None, 2).await;

    assert!(!report.reconciled);
    assert!(report.batches[0].found);
    assert_eq!(report.batches[0].sum_matches, Some(true));
    assert!(!report.batches[1].found);
    assert_eq!(report.batches[1].txid, Some(m[1].batch.0));
    assert_eq!(
        (report.commitment.rows_matched, report.commitment.rows_total),
        (2, 4)
    );
    assert!(!report.commitment.matches);
    assert!(report.render().contains("Batch 1"));
}

// covers: REQ-AUD-003
#[tokio::test]
async fn a_payout_made_in_another_batch_than_planned_is_a_difference() {
    // The chain paid the right people the right amounts, but the plan put them in the other
    // batch: matching is per batch, so this is reported rather than matched globally.
    let m = multi();
    let (h, id, _) = multi_case(1).await;
    let report = audit_with(&h, &id, &chain(&[&m[0], &m[1]], 10), &ufvk_of(0), None, 2).await;

    assert!(!report.reconciled);
    assert_eq!(report.batches[0].recovered_outputs, 2);
    // The chain agrees with itself; it is the plan it disagrees with.
    assert_eq!(report.batches[0].sum_matches, Some(true));
    assert!(report.batches[0]
        .findings
        .iter()
        .any(|f| matches!(f, Finding::DeclaredTotalMismatch)));
    assert_eq!(
        (report.commitment.rows_matched, report.commitment.rows_total),
        (0, 4)
    );
    assert_eq!(report.commitment.unmatched_outputs, 4);
}

// ---------------------------------------------------------------------------
// REQ-AUD-003: the committed payout list against what the chain shows
// ---------------------------------------------------------------------------

// covers: REQ-AUD-003
#[tokio::test]
async fn a_changed_payout_list_row_is_reported_and_the_commitment_differs() {
    let f = fixture();
    type Change = Box<dyn Fn(&mut Row)>;
    let changes: [(&str, Change); 3] = [
        ("amount", Box::new(|r| r.zat += 1_000)),
        (
            "memo",
            Box::new(|r| r.memo = Some("a different memo".into())),
        ),
        ("recipient", Box::new(|r| r.address = recipient_ua(77))),
    ];
    for (what, change) in changes {
        // The store lists row 1 differently from what was actually paid.
        let mut listed = f.a.rows.clone();
        change(&mut listed[1]);
        let (h, id) = case(&listed, &f.a).await;
        let report = audit(&h, &id, &chain(&[&f.a], 10), &ufvk_of(0)).await;

        assert!(!report.reconciled, "{what}: {}", report.render());
        let commitment = &report.commitment;
        assert_eq!(
            (commitment.rows_matched, commitment.rows_total),
            (2, 3),
            "{what}"
        );
        assert_eq!(commitment.unmatched_outputs, 1, "{what}");
        assert!(!commitment.matches, "{what}");
        assert_ne!(commitment.recomputed, Some(commitment.receipt), "{what}");
        // The chain itself is fine in count and sum: the difference is in the list.
        assert_eq!(report.batches[0].count_matches, Some(true), "{what}");
        assert_eq!(report.batches[0].recovered_outputs, 3, "{what}");
        assert!(report.render().contains("1 recovered outputs match no row"));
    }
}

// covers: REQ-AUD-003
#[tokio::test]
async fn a_receipt_commitment_that_is_not_the_stored_one_is_reported() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let stored = h
        .state
        .store()
        .load_campaign(&id)
        .unwrap()
        .unwrap()
        .commitment;
    let mut other = *stored.as_bytes();
    other[0] ^= 1;
    let other = ManifestCommitment::from_bytes(other);

    let report = audit_with(&h, &id, &chain(&[&f.a], 10), &ufvk_of(0), Some(other), 1).await;
    assert!(!report.reconciled);
    let commitment = &report.commitment;
    assert_eq!(commitment.receipt, other);
    // Every row is confirmed by the chain and the recomputation is the stored commitment:
    // the only difference is the commitment the auditor was given.
    assert_eq!(commitment.recomputed, Some(stored));
    assert_eq!((commitment.rows_matched, commitment.rows_total), (3, 3));
    assert!(!commitment.matches);
    assert_eq!(report.batches[0].sum_matches, Some(true));
    assert!(report.render().contains("DIFFERS"));
}

// covers: REQ-AUD-003
#[tokio::test]
async fn the_commitment_is_recomputed_from_the_chain_not_taken_from_the_store() {
    // With nothing confirmed there is nothing to recompute, however good the stored value.
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let report = audit(&h, &id, &StaticChain::default(), &ufvk_of(0)).await;
    assert_eq!(report.commitment.recomputed, None);
    assert!(!report.commitment.matches);
}

// ---------------------------------------------------------------------------
// REQ-AUD-002: one campaign's key opens that campaign only
// ---------------------------------------------------------------------------

// covers: REQ-AUD-002
#[tokio::test]
async fn the_key_of_one_campaign_recovers_nothing_from_another() {
    let f = fixture();
    let (a, b) = (ufvk_of(0), ufvk_of(1));
    assert_ne!(a, b);

    let open = |raw: &[u8], ufvk: &str| recover_with_ufvk(raw, NETWORK, ufvk).unwrap();
    assert_eq!(open(&f.a.batch.1, &a).len(), 3, "A's key opens A's batch");
    assert_eq!(open(&f.b.batch.1, &b).len(), 3, "B's key opens B's batch");
    assert!(
        open(&f.b.batch.1, &a).is_empty(),
        "A's key opens nothing of B's"
    );
    assert!(
        open(&f.a.batch.1, &b).is_empty(),
        "B's key opens nothing of A's"
    );

    // The same account number from another wallet seed is another key as well.
    let stranger = CampaignKeys::derive(&[0x42; 32], NETWORK, 0)
        .unwrap()
        .ufvk_encoded()
        .unwrap();
    assert!(open(&f.a.batch.1, &stranger).is_empty());
}

// covers: REQ-AUD-002
#[tokio::test]
async fn auditing_one_campaign_with_the_other_campaigns_key_finds_nothing() {
    let f = fixture();
    let h = harness();
    let (id_a, account_a) = create(&h, &f.a.rows).await;
    let (id_b, account_b) = create(&h, &f.b.rows).await;
    assert_eq!((account_a, account_b), (0, 1), "one account per campaign");
    settle(&h, &id_a, &f.a);
    settle(&h, &id_b, &f.b);
    let both = chain(&[&f.a, &f.b], 10);

    // Each reconciles under its own key ...
    assert!(audit(&h, &id_a, &both, &ufvk_of(0)).await.reconciled);
    assert!(audit(&h, &id_b, &both, &ufvk_of(1)).await.reconciled);

    // ... and under the other's recovers nothing, however it is asked.
    for (id, wrong) in [(&id_a, ufvk_of(1)), (&id_b, ufvk_of(0))] {
        let report = audit(&h, id, &both, &wrong).await;
        assert!(!report.reconciled);
        assert_eq!(report.batches[0].recovered_outputs, 0);
        assert_eq!(report.commitment.rows_matched, 0);
        assert_eq!(report.commitment.recomputed, None);
    }
}

// ---------------------------------------------------------------------------
// What the audit shows, and what it never shows
// ---------------------------------------------------------------------------

/// Everything that must never reach a report, a log line or a response body.
fn forbidden(f: &Fixture, ufvk: &str) -> Vec<String> {
    let mut needles = vec![
        ufvk.to_owned(),
        ufvk[..40].to_owned(),
        hex::encode(TEST_SEED),
        String::from_utf8_lossy(&TEST_SEED).into_owned(),
    ];
    for r in &f.a.rows {
        needles.push(r.address.clone());
        needles.push(r.zat.to_string());
        needles.push(Zatoshi::new(r.zat).unwrap().format_zec());
        needles.extend(r.memo.clone());
    }
    needles
}

async fn run(
    h: &Harness,
    id: &CampaignId,
    chain: &StaticChain,
    stdin: &str,
    json: bool,
) -> (Result<bool, CommandError>, String) {
    let args = AuditArgs {
        campaign: id.to_string(),
        ufvk_stdin: true,
        ufvk_file: None,
        receipt_commitment: None,
        json,
    };
    let mut out = Vec::new();
    let result = run_audit(
        h.state.store(),
        &args,
        chain,
        DEPTH,
        &mut Cursor::new(stdin.as_bytes().to_vec()),
        &mut out,
    )
    .await;
    (result, String::from_utf8(out).unwrap())
}

// covers: REQ-AUD-001, REQ-PRIV-002
#[tokio::test]
async fn the_report_holds_no_key_address_memo_or_per_recipient_amount() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let ufvk = ufvk_of(0);
    let needles = forbidden(f, &ufvk);
    let both = chain(&[&f.a], 10);

    // Read from stdin, with the ordinary trailing newline.
    let (result, text) = run(&h, &id, &both, &format!("{ufvk}\n"), false).await;
    assert!(result.unwrap(), "{text}");
    assert!(text.contains("RESULT: reconciled"), "{text}");
    assert!(text.contains(&f.a.batch.0.to_string()));
    assert_clean("audit text", &text, &needles);

    let (result, text) = run(&h, &id, &both, &ufvk, true).await;
    assert!(result.unwrap());
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["reconciled"], true);
    assert_eq!(parsed["batches"][0]["recovered_outputs"], 3);
    assert_clean("audit json", &text, &needles);

    // The same for a failing audit, whose report is the longer one.
    let (result, text) = run(&h, &id, &both, &ufvk_of(5), false).await;
    assert!(!result.unwrap());
    assert_clean("failing audit text", &text, &needles);

    // The store never learned the key: neither the file nor its journal contains it.
    for name in ["", "-wal", "-journal"] {
        let path = format!("{}{name}", h.db.display());
        if let Ok(bytes) = std::fs::read(&path) {
            let hay = String::from_utf8_lossy(&bytes);
            assert!(!hay.contains(&ufvk), "{path} holds the key");
            assert!(!hay.contains(&ufvk[..40]), "{path} holds part of the key");
        }
    }
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_bad_key_is_refused_and_the_error_says_nothing_about_it() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let both = chain(&[&f.a], 10);

    let shaped_but_wrong = format!("uview1{}", "q".repeat(120));
    let cases = [
        ("", CommandErrorKind::Audit(AuditError::UfvkShape)),
        (
            "not a viewing key",
            CommandErrorKind::Audit(AuditError::UfvkShape),
        ),
        (
            "uview1 leaked secret words",
            CommandErrorKind::Audit(AuditError::UfvkShape),
        ),
        // Right shape, but it does not decode: refused when it is first used.
        (
            &shaped_but_wrong,
            CommandErrorKind::Audit(AuditError::UfvkNetwork),
        ),
    ];
    for (input, expected) in cases {
        let (result, out) = run(&h, &id, &both, input, false).await;
        let error = result.unwrap_err();
        assert!(expected.matches(&error), "{input:?} gave {error}");
        let shown = format!("{error} {error:?}");
        for part in ["leaked", "secret", "words", "qqqq", "not a viewing key"] {
            assert!(!shown.contains(part), "the error repeats {part:?}: {shown}");
        }
        assert!(out.is_empty(), "no report is written: {out}");
    }
}

enum CommandErrorKind {
    Audit(AuditError),
}

impl CommandErrorKind {
    fn matches(&self, error: &CommandError) -> bool {
        match (self, error) {
            (CommandErrorKind::Audit(want), CommandError::Audit(got)) => want == got,
            _ => false,
        }
    }
}

// covers: REQ-AUD-001
#[tokio::test]
async fn an_unknown_campaign_or_a_bad_commitment_is_refused_before_anything_is_read() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let both = chain(&[&f.a], 10);
    let ufvk = ufvk_of(0);

    let mut args = AuditArgs {
        campaign: "no-such-campaign".into(),
        ufvk_stdin: true,
        ufvk_file: None,
        receipt_commitment: None,
        json: false,
    };
    let mut out = Vec::new();
    let result = run_audit(
        h.state.store(),
        &args,
        &both,
        DEPTH,
        &mut Cursor::new(ufvk.as_bytes().to_vec()),
        &mut out,
    )
    .await;
    assert!(matches!(result, Err(CommandError::NoSuchCampaign)));

    args.campaign = id.to_string();
    args.receipt_commitment = Some("abc".into());
    let result = run_audit(
        h.state.store(),
        &args,
        &both,
        DEPTH,
        &mut Cursor::new(ufvk.as_bytes().to_vec()),
        &mut out,
    )
    .await;
    assert!(matches!(result, Err(CommandError::BadCommitment)));
    assert!(out.is_empty());
}

// covers: REQ-AUD-001
#[tokio::test]
async fn the_key_can_come_from_a_file_instead_of_stdin() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let path = h.dir.path().join("campaign.ufvk");
    std::fs::write(&path, format!("{}\n", ufvk_of(0))).unwrap();
    let args = AuditArgs {
        campaign: id.to_string(),
        ufvk_stdin: false,
        ufvk_file: Some(path),
        receipt_commitment: None,
        json: false,
    };
    let mut out = Vec::new();
    // Nothing is read from stdin when a file is named.
    let reconciled = run_audit(
        h.state.store(),
        &args,
        &chain(&[&f.a], 10),
        DEPTH,
        &mut Cursor::new(Vec::new()),
        &mut out,
    )
    .await
    .unwrap();
    assert!(reconciled);
}

// covers: REQ-AUD-001
#[test]
fn the_command_line_has_no_place_to_type_a_key() {
    let key = ufvk_of(0);
    let campaign = ["--campaign", "c1"];

    // A key as an option value, or as a stray argument, is not accepted.
    for extra in [
        vec!["--ufvk", key.as_str()],
        vec!["--viewing-key", key.as_str()],
        vec!["--ufvk-stdin", key.as_str()],
        vec![key.as_str()],
    ] {
        let mut argv = vec!["drop-operator", "audit"];
        argv.extend(campaign);
        argv.extend(extra.clone());
        assert!(
            Cli::try_parse_from(&argv).is_err(),
            "{extra:?} was accepted"
        );
        let mut argv = vec!["drop-operator", "export-ufvk"];
        argv.extend(campaign);
        argv.extend(extra.clone());
        assert!(
            Cli::try_parse_from(&argv).is_err(),
            "{extra:?} was accepted"
        );
    }

    // Exactly one source is needed, and the two named ones are flags and a path.
    let audit = |extra: &[&str]| {
        let mut argv = vec!["drop-operator", "audit", "--campaign", "c1"];
        argv.extend(extra);
        Cli::try_parse_from(argv)
    };
    assert!(audit(&[]).is_err());
    assert!(audit(&["--ufvk-stdin", "--ufvk-file", "k"]).is_err());
    let cli = audit(&["--ufvk-stdin"]).unwrap();
    assert!(matches!(
        cli.command,
        Some(Command::Audit(AuditArgs {
            ufvk_stdin: true,
            ufvk_file: None,
            ..
        }))
    ));
    assert!(audit(&["--ufvk-file", "key.txt"]).is_ok());

    // Nothing that is called a key takes a value, other than the path to a file.
    let command = Cli::command();
    let mut seen = Vec::new();
    for sub in command.get_subcommands() {
        for arg in sub.get_arguments() {
            let name = arg.get_id().as_str();
            if name.contains("ufvk") || name.contains("key") {
                seen.push(format!("{} {name}", sub.get_name()));
                let takes_value = arg.get_action().takes_values();
                assert_eq!(takes_value, name == "ufvk_file", "{name}");
            }
        }
    }
    // The two commands that read a key (audit, audit-tx) take it from stdin or a file only;
    // `audit-tx --account` takes a number, which is not a key.
    seen.sort();
    assert_eq!(
        seen,
        [
            "audit ufvk_file",
            "audit ufvk_stdin",
            "audit-tx ufvk_file",
            "audit-tx ufvk_stdin"
        ]
    );
}

// ---------------------------------------------------------------------------
// The export: a CLI command and an API route, both behind the disclosure warning
// ---------------------------------------------------------------------------

fn export_args(id: &CampaignId, understood: bool) -> ExportArgs {
    ExportArgs {
        campaign: id.to_string(),
        i_understand_this_is_irreversible: understood,
    }
}

// covers: REQ-AUD-001
#[tokio::test]
async fn the_export_command_needs_the_acknowledgement_and_keeps_the_key_off_stderr() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let seed = SecretSeed::from_bytes(TEST_SEED);

    // Without the acknowledgement nothing is printed and the error is the warning itself.
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let error = run_export_ufvk(
        h.state.store(),
        &seed,
        &export_args(&id, false),
        &mut out,
        &mut err,
    )
    .unwrap_err();
    assert!(matches!(error, CommandError::NotConfirmed));
    assert_eq!(error.to_string(), DISCLOSURE_WARNING);
    assert!(out.is_empty() && err.is_empty());

    // With it: the warning on stderr, the key and only the key on stdout.
    run_export_ufvk(
        h.state.store(),
        &seed,
        &export_args(&id, true),
        &mut out,
        &mut err,
    )
    .unwrap();
    let (out, err) = (
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    );
    let ufvk = ufvk_of(0);
    assert_eq!(out, format!("{ufvk}\n"));
    assert!(
        err.contains(DISCLOSURE_WARNING) && err.starts_with("WARNING"),
        "{err}"
    );
    assert!(!err.contains(&ufvk), "the key is not on stderr");
    assert!(!out.contains("WARNING"));

    // The exported key is the one that audits this campaign: export, then audit from its output.
    let (result, text) = run(&h, &id, &chain(&[&f.a], 10), &out, false).await;
    assert!(result.unwrap(), "{text}");
}

// covers: REQ-AUD-002, REQ-SEC-001
#[tokio::test]
async fn the_export_command_refuses_a_wallet_that_did_not_make_the_campaign() {
    let f = fixture();
    let (h, id) = case(&f.a.rows, &f.a).await;
    let other = SecretSeed::from_bytes([0x99; 32]);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let error = run_export_ufvk(
        h.state.store(),
        &other,
        &export_args(&id, true),
        &mut out,
        &mut err,
    )
    .unwrap_err();
    assert!(matches!(error, CommandError::WrongWallet));
    assert!(out.is_empty() && err.is_empty(), "no key, no warning");

    let ghost = CampaignId::new("no-such-campaign").unwrap();
    let seed = SecretSeed::from_bytes(TEST_SEED);
    let error = run_export_ufvk(
        h.state.store(),
        &seed,
        &export_args(&ghost, true),
        &mut out,
        &mut err,
    )
    .unwrap_err();
    assert!(matches!(error, CommandError::NoSuchCampaign));
    assert!(out.is_empty());
}

// covers: REQ-AUD-002
#[tokio::test]
async fn each_campaign_exports_its_own_key() {
    let f = fixture();
    let h = harness();
    let (a, _) = create(&h, &f.a.rows).await;
    let (b, _) = create(&h, &f.b.rows).await;
    let seed = SecretSeed::from_bytes(TEST_SEED);
    let export = |id: &CampaignId| {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        run_export_ufvk(
            h.state.store(),
            &seed,
            &export_args(id, true),
            &mut out,
            &mut err,
        )
        .unwrap();
        String::from_utf8(out).unwrap().trim().to_owned()
    };
    let (key_a, key_b) = (export(&a), export(&b));
    assert_eq!(key_a, ufvk_of(0));
    assert_eq!(key_b, ufvk_of(1));
    assert_ne!(key_a, key_b);
    assert_eq!(
        campaign_ufvk(&seed, Network::Testnet, 1).unwrap().as_str(),
        key_b
    );
}

const CONFIRM: (&str, &str) = ("X-Zecdrop-Confirm-Disclosure", "I-UNDERSTAND");

fn export_path(id: &CampaignId) -> String {
    format!("/api/campaigns/{id}/audit-ufvk-export")
}

async fn confirmed_export(h: &Harness, id: &CampaignId) -> Reply {
    h.call_with(Method::GET, &export_path(id), Auth::Token, None, &[CONFIRM])
        .await
}

// covers: REQ-AUD-001
#[tokio::test]
async fn the_export_route_refuses_without_the_acknowledgement_header() {
    let f = fixture();
    let h = harness();
    let (id, _) = create(&h, &f.a.rows).await;
    let ufvk = ufvk_of(0);

    let plain = h.get(&export_path(&id)).await;
    assert_eq!(plain.status, StatusCode::BAD_REQUEST);
    let error = plain.json()["error"].clone();
    assert_eq!(error["code"], "confirmation_required");
    // The refusal carries the warning for the UI to show, and no key.
    assert_eq!(error["warning"], DISCLOSURE_WARNING);
    assert!(!plain.text().contains(&ufvk) && !plain.text().contains("uview"));

    // A header that is not exactly the acknowledgement does not do either.
    for value in ["", "i-understand", "yes", "I-UNDERSTAND "] {
        let reply = h
            .call_with(
                Method::GET,
                &export_path(&id),
                Auth::Token,
                None,
                &[(CONFIRM.0, value)],
            )
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{value:?}");
        assert!(!reply.text().contains("uview"));
    }
    assert!(!h.logs.lines().join("\n").contains(&ufvk));
}

// covers: REQ-AUD-001, REQ-AUD-002
#[tokio::test]
async fn the_export_route_returns_the_campaign_key_with_the_warning() {
    let f = fixture();
    let h = harness();
    let (a, _) = create(&h, &f.a.rows).await;
    let (b, _) = create(&h, &f.b.rows).await;

    let reply_a = confirmed_export(&h, &a).await;
    assert_eq!(reply_a.status, StatusCode::OK, "{}", reply_a.text());
    let view = reply_a.json();
    assert_eq!(view["ufvk"], ufvk_of(0));
    assert_eq!(view["campaign_id"], a.to_string());
    assert_eq!(view["network"], "testnet");
    let warning = view["warning"].as_str().unwrap();
    assert_eq!(warning, DISCLOSURE_WARNING);
    assert!(warning.contains("cannot be undone"));
    assert_eq!(
        reply_a.headers[axum::http::header::CACHE_CONTROL],
        "no-store"
    );

    let reply_b = confirmed_export(&h, &b).await;
    assert_eq!(reply_b.json()["ufvk"], ufvk_of(1));

    // The key is in the response only: not in the log, not in the store.
    let logs = h.logs.lines().join("\n");
    for key in [ufvk_of(0), ufvk_of(1)] {
        assert!(!logs.contains(&key[..40]), "the log holds a key");
        let bytes = std::fs::read(&h.db).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(&key[..40]));
    }
    assert!(!logs.contains(&hex::encode(TEST_SEED)));
}

// covers: REQ-AUD-001, REQ-OPS-002
#[tokio::test]
async fn the_export_route_needs_the_token_and_a_real_campaign() {
    let f = fixture();
    let h = harness();
    let (id, _) = create(&h, &f.a.rows).await;
    for auth in [Auth::None, Auth::Wrong] {
        let reply = h
            .call_with(Method::GET, &export_path(&id), auth, None, &[CONFIRM])
            .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{auth:?}");
        assert!(!reply.text().contains("uview"));
    }
    let ghost = CampaignId::new("no-such-campaign").unwrap();
    let reply = h
        .call_with(
            Method::GET,
            &export_path(&ghost),
            Auth::Token,
            None,
            &[CONFIRM],
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

// covers: REQ-AUD-001
#[tokio::test]
async fn the_mock_chain_has_no_viewing_keys_to_export() {
    let h = Harness::new();
    let (id, _) = h.create().await;
    let reply = h
        .call_with(
            Method::GET,
            &export_path(&id),
            Auth::Token,
            None,
            &[CONFIRM],
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "not_available");
    assert!(!reply.text().contains("uview"));
}

// covers: REQ-AUD-002, REQ-SEC-001
#[tokio::test]
async fn the_export_route_refuses_a_wallet_that_did_not_make_the_campaign() {
    let f = fixture();
    let h = harness();
    let (id, _) = create(&h, &f.a.rows).await;

    // The same store and chain, opened by an operator holding another seed.
    let Harness {
        dir,
        db,
        chain,
        backend,
        codec,
        web_dir,
        state,
        router,
        ..
    } = h;
    drop((state, router));
    let store = std::sync::Arc::new(drop_operator::store::Store::open(&db, PASSPHRASE).unwrap());
    let other = Harness::from_parts(
        dir,
        db,
        store,
        chain,
        Builder {
            seed: [0x99; 32],
            web_dir,
            backend: Some(backend),
            codec: Some(codec),
            ..Builder::default()
        },
    );
    let reply = other
        .call_with(
            Method::GET,
            &export_path(&id),
            Auth::Token,
            None,
            &[CONFIRM],
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.text());
    assert_eq!(reply.json()["error"]["code"], "wrong_wallet_seed");
    assert!(!reply.text().contains("uview"));
}
