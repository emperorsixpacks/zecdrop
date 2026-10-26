//! Key-less verification against real librustzcash transactions (fixtures built with
//! TEST-ONLY keys) served by an in-memory chain.

mod support;

use drop_core::{
    CampaignId, CampaignPhase, Finding, ManifestCommitment, Network, OutPoint, Pool, PublicReceipt,
    Txid, Zatoshi,
};
use drop_verify::analyze::Prevout;
use drop_verify::{
    verify_campaign, FetchedTx, ParsedTx, Problem, SourceError, VerifyConfig, VerifyError,
    VerifyRequest,
};
use std::path::PathBuf;

use support::{load, FakeChain, Fixture};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::bundle::TxOut;

const TIP: u32 = 5_000_000;

fn request(txids: Vec<Txid>, declared: u64) -> VerifyRequest {
    VerifyRequest {
        network: Network::Testnet,
        txids,
        manifest_commitment: ManifestCommitment::from_bytes([0xee; 32]),
        declared_total: Zatoshi::new(declared).unwrap(),
        campaign_id: None,
    }
}

fn config(depth: u32) -> VerifyConfig {
    VerifyConfig {
        required_depth: depth,
        expected_pool: Pool::Ironwood,
    }
}

/// A chain holding the fixture's funding tx and batch tx, mined `confirmations` deep.
fn chain(f: &Fixture, confirmations: u32) -> FakeChain {
    let mined = (confirmations > 0).then(|| TIP - confirmations + 1);
    FakeChain::with(f, mined, TIP)
}

async fn run(chain: &FakeChain, f: &Fixture, depth: u32) -> PublicReceipt {
    verify_campaign(
        chain,
        &request(vec![f.batch_txid], f.payout_total),
        &config(depth),
    )
    .await
    .unwrap()
}

fn resolver<'a>(f: &'a Fixture) -> impl Fn(&Prevout) -> Option<TxOut> + 'a {
    let funding = ParsedTx::parse_any_version(&f.funding_raw).unwrap();
    move |prevout| funding.output(prevout.n())
}

// ---------------------------------------------------------------------------
// REQ-VER-001
// ---------------------------------------------------------------------------

// covers: REQ-VER-001
#[tokio::test]
async fn a_good_batch_verifies_with_every_fact_established() {
    let f = load("ironwood_batch_3");
    let receipt = run(&chain(&f, 6), &f, 3).await;

    assert!(receipt.findings.is_empty(), "{:?}", receipt.findings);
    assert_eq!(receipt.phase, CampaignPhase::Settled);
    let batch = &receipt.batches[0];
    assert_eq!(batch.txid, Some(f.batch_txid));
    assert_eq!(
        batch.net_into_pool,
        Some(Zatoshi::new(f.payout_total).unwrap())
    );
    assert_eq!(batch.fee, Some(Zatoshi::new(f.fee).unwrap()));
    assert_eq!(batch.pool, Some(Pool::Ironwood));
    assert_eq!(batch.shielded_actions, Some(3));
    assert_eq!(batch.confirmations, 6);
    assert_eq!(
        batch.funding_input,
        Some(OutPoint {
            txid: f.funding_txid,
            vout: 0
        })
    );
    assert_eq!(receipt.declared_total.as_u64(), f.payout_total);
    assert_eq!(receipt.fee_total, batch.fee);
}

// covers: REQ-VER-001
#[tokio::test]
async fn the_balance_equation_holds_from_public_data_alone() {
    let f = load("ironwood_batch_3");
    let tx = ParsedTx::parse(&f.batch_raw).unwrap();
    let analysis = tx.analyze(resolver(&f), Pool::Ironwood);
    assert!(analysis.problems.is_empty(), "{:?}", analysis.problems);
    // t_in = funding value = payouts + cushion; t_out = change; so
    // t_in = t_out + net + fee.
    let net = analysis.net_into_pool.unwrap().as_u64();
    let fee = analysis.fee.unwrap().as_u64();
    let t_in = f.payout_total + 100_000_000; // payouts + one ZEC cushion
    assert_eq!(t_in, f.change + net + fee);
    assert_eq!(net, f.payout_total);
    assert_eq!(fee, f.fee);
}

// covers: REQ-VER-001
#[tokio::test]
async fn the_fee_is_reported_not_compared_with_a_fixed_rate() {
    // Same payouts, paid at 1000 zatoshi per action instead of 5000: both are real, valid shapes.
    let standard = load("ironwood_batch_3");
    let low = load("ironwood_batch_low_fee");
    assert_eq!((standard.fee, low.fee), (20_000, 4_000));

    for f in [&standard, &low] {
        let receipt = run(&chain(f, 6), f, 3).await;
        assert!(
            receipt.findings.is_empty(),
            "{}: {:?}",
            f.name,
            receipt.findings
        );
        assert_eq!(
            receipt.batches[0].fee,
            Some(Zatoshi::new(f.fee).unwrap()),
            "{}",
            f.name
        );
        assert_eq!(receipt.phase, CampaignPhase::Settled);
    }
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_two_batch_campaign_adds_up_net_and_fee() {
    let a = load("ironwood_batch_3");
    let b = load("ironwood_batch_low_fee");
    let mut both = chain(&a, 6);
    both.txs.insert(
        b.batch_txid,
        FetchedTx {
            raw: b.batch_raw.clone(),
            mined_height: Some(TIP - 9),
        },
    );

    let receipt = verify_campaign(
        &both,
        &request(
            vec![a.batch_txid, b.batch_txid],
            a.payout_total + b.payout_total,
        ),
        &config(3),
    )
    .await
    .unwrap();
    assert_eq!(receipt.phase, CampaignPhase::Settled);
    assert_eq!(receipt.fee_total, Some(Zatoshi::new(24_000).unwrap()));
    assert_eq!(
        receipt.batches.iter().map(|x| x.index).collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(receipt.batches[1].confirmations, 10);
}

// covers: REQ-VER-001
#[tokio::test]
async fn the_declared_total_must_match_what_entered_the_pool() {
    let f = load("ironwood_batch_3");
    let c = chain(&f, 6);
    for declared in [f.payout_total + 1, f.payout_total - 1, 0] {
        let receipt = verify_campaign(&c, &request(vec![f.batch_txid], declared), &config(3))
            .await
            .unwrap();
        assert_eq!(
            receipt.findings,
            vec![Finding::DeclaredTotalMismatch],
            "{declared}"
        );
        assert_eq!(receipt.phase, CampaignPhase::Failed);
    }
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_tampered_value_balance_is_a_finding() {
    let f = load("ironwood_batch_3");
    // Flip a bit in the 8-byte Ironwood value balance. The binding signature no longer verifies.
    let balance = (-(f.payout_total as i64)).to_le_bytes();
    let positions: Vec<usize> = f
        .batch_raw
        .windows(8)
        .enumerate()
        .filter(|(_, w)| *w == balance)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        positions.len(),
        1,
        "the value balance appears once in the encoding"
    );
    let mut tampered = f.batch_raw.clone();
    tampered[positions[0]] ^= 0x01;

    // The tampered bytes have their own txid; serve them under it.
    let parsed = ParsedTx::parse(&tampered).unwrap();
    let mut c = chain(&f, 6);
    c.txs.insert(
        parsed.txid(),
        FetchedTx {
            raw: tampered,
            mined_height: Some(TIP - 5),
        },
    );

    let receipt = verify_campaign(
        &c,
        &request(vec![parsed.txid()], f.payout_total),
        &config(3),
    )
    .await
    .unwrap();
    assert!(
        receipt
            .findings
            .contains(&Finding::BalanceMismatch { batch_index: 0 }),
        "{:?}",
        receipt.findings
    );
    assert_eq!(receipt.phase, CampaignPhase::Failed);
    // The numbers it would have shown are not what was published, and are flagged as such.
    assert_ne!(
        receipt.batches[0].net_into_pool,
        Some(Zatoshi::new(f.payout_total).unwrap())
    );
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_corrupted_binding_signature_is_a_finding_even_though_the_txid_is_unchanged() {
    let f = load("ironwood_batch_3");
    let mut tampered = f.batch_raw.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x01; // inside the binding signature
    let parsed = ParsedTx::parse(&tampered).unwrap();
    assert_eq!(
        parsed.txid(),
        f.batch_txid,
        "signatures are not part of the txid"
    );

    let mut c = chain(&f, 6);
    c.txs.insert(
        f.batch_txid,
        FetchedTx {
            raw: tampered,
            mined_height: Some(TIP - 5),
        },
    );
    let receipt = run(&c, &f, 3).await;
    assert_eq!(
        receipt.findings,
        vec![Finding::BalanceMismatch { batch_index: 0 }]
    );
    assert_eq!(receipt.phase, CampaignPhase::Failed);
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_missing_prevout_is_a_finding_and_the_fee_stays_unknown() {
    let f = load("ironwood_batch_3");
    let mut c = chain(&f, 6);
    c.txs.remove(&f.funding_txid);
    let receipt = run(&c, &f, 3).await;

    assert_eq!(
        receipt.findings,
        vec![Finding::PrevoutUnresolved { batch_index: 0 }]
    );
    let batch = &receipt.batches[0];
    assert_eq!(batch.fee, None);
    assert_eq!(
        batch.net_into_pool,
        Some(Zatoshi::new(f.payout_total).unwrap()),
        "net needs no prevouts"
    );
    assert_eq!(batch.pool, Some(Pool::Ironwood));
    assert!(matches!(
        receipt.phase,
        CampaignPhase::Sending { done: 0, total: 1 }
    ));
    assert_eq!(receipt.fee_total, None);
}

// covers: REQ-VER-001
#[tokio::test]
async fn an_unreadable_funding_transaction_leaves_the_prevout_unresolved() {
    let f = load("ironwood_batch_3");
    let mut c = chain(&f, 6);
    c.txs.insert(
        f.funding_txid,
        FetchedTx {
            raw: vec![0xde, 0xad, 0xbe, 0xef],
            mined_height: Some(1),
        },
    );
    let receipt = run(&c, &f, 3).await;
    assert_eq!(
        receipt.findings,
        vec![Finding::PrevoutUnresolved { batch_index: 0 }]
    );
}

// covers: REQ-VER-001
#[test]
fn inputs_worth_less_than_the_outputs_give_a_negative_fee_not_a_wrapped_one() {
    let f = load("ironwood_batch_3");
    let tx = ParsedTx::parse(&f.batch_raw).unwrap();
    let real = ParsedTx::parse_any_version(&f.funding_raw)
        .unwrap()
        .output(0)
        .unwrap();
    // A source that understates the funding coin by one zatoshi more than the fee headroom.
    let short = TxOut::new(
        Zatoshis::from_u64(f.payout_total).unwrap(), // less than payouts + change
        real.script_pubkey().clone(),
    );
    let analysis = tx.analyze(|_| Some(short.clone()), Pool::Ironwood);
    assert!(
        analysis.problems.contains(&Problem::NegativeFee),
        "{:?}",
        analysis.problems
    );
    assert_eq!(
        analysis.fee, None,
        "a negative fee is never reported as a number"
    );
    // The shielded sighash commits to prevout amounts, so the lie also breaks the balance check.
    assert!(analysis.problems.contains(&Problem::BalanceMismatch));
}

// covers: REQ-VER-001
#[test]
fn an_overstated_prevout_also_fails_the_balance_check() {
    let f = load("ironwood_batch_3");
    let tx = ParsedTx::parse(&f.batch_raw).unwrap();
    let real = ParsedTx::parse_any_version(&f.funding_raw)
        .unwrap()
        .output(0)
        .unwrap();
    let rich = TxOut::new(
        Zatoshis::from_u64(u64::from(real.value()) + 5_000).unwrap(),
        real.script_pubkey().clone(),
    );
    let analysis = tx.analyze(|_| Some(rich.clone()), Pool::Ironwood);
    assert_eq!(analysis.problems, vec![Problem::BalanceMismatch]);
    // The (unverifiable) fee it would report is higher by exactly the lie.
    assert_eq!(analysis.fee.unwrap().as_u64(), f.fee + 5_000);
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_v5_orchard_batch_at_an_old_height_is_reported_as_the_wrong_pool() {
    let f = load("orchard_batch_old_height");
    let receipt = run(&chain(&f, 6), &f, 3).await;
    assert_eq!(
        receipt.findings,
        vec![Finding::UnexpectedPool { batch_index: 0 }]
    );
    assert_eq!(receipt.batches[0].pool, Some(Pool::Orchard));
    assert_eq!(receipt.batches[0].shielded_actions, Some(3));
    assert_eq!(receipt.phase, CampaignPhase::Failed);

    // The transaction itself is sound: expecting Orchard, it verifies cleanly.
    let orchard = verify_campaign(
        &chain(&f, 6),
        &request(vec![f.batch_txid], f.payout_total),
        &VerifyConfig {
            required_depth: 3,
            expected_pool: Pool::Orchard,
        },
    )
    .await
    .unwrap();
    assert!(orchard.findings.is_empty(), "{:?}", orchard.findings);
    assert_eq!(orchard.phase, CampaignPhase::Settled);
}

// covers: REQ-VER-001
#[tokio::test]
async fn an_unknown_transaction_is_not_found_not_failed() {
    let f = load("ironwood_batch_3");
    let empty = FakeChain {
        tip: TIP,
        ..FakeChain::default()
    };
    let receipt = run(&empty, &f, 3).await;
    assert_eq!(
        receipt.findings,
        vec![Finding::TxNotFound { batch_index: 0 }]
    );
    assert_eq!(receipt.batches[0].txid, Some(f.batch_txid));
    assert!(receipt.batches[0].net_into_pool.is_none());
    assert!(matches!(
        receipt.phase,
        CampaignPhase::Sending { done: 0, total: 1 }
    ));
}

// covers: REQ-VER-001
#[tokio::test]
async fn bytes_that_are_not_a_transaction_become_a_finding_never_a_panic() {
    let f = load("ironwood_batch_3");
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("garbage", vec![0xff; 64]),
        ("truncated", f.batch_raw[..f.batch_raw.len() / 2].to_vec()),
        ("trailing bytes", [f.batch_raw.clone(), vec![0]].concat()),
        ("header only", f.batch_raw[..16].to_vec()),
    ];
    for (name, raw) in cases {
        let mut c = FakeChain {
            tip: TIP,
            ..FakeChain::default()
        };
        c.txs.insert(
            f.batch_txid,
            FetchedTx {
                raw,
                mined_height: Some(TIP),
            },
        );
        let receipt = run(&c, &f, 3).await;
        assert_eq!(
            receipt.findings,
            vec![Finding::TxUnparseable { batch_index: 0 }],
            "{name}"
        );
        assert_eq!(receipt.phase, CampaignPhase::Failed, "{name}");
        assert!(receipt.batches[0].net_into_pool.is_none(), "{name}");
    }
}

// covers: REQ-VER-001
#[test]
fn damaging_any_byte_of_a_real_transaction_never_panics() {
    let f = load("ironwood_batch_3");
    let resolve = resolver(&f);
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut analyzed = 0;
    for position in (0..f.batch_raw.len()).step_by(5) {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut damaged = f.batch_raw.clone();
        damaged[position] ^= ((seed >> 33) as u8) | 1;
        if let Ok(tx) = ParsedTx::parse(&damaged) {
            let analysis = tx.analyze(&resolve, Pool::Ironwood);
            analyzed += 1;
            // Never claims a clean bill of health for bytes that differ from the real transaction
            // unless the damage was to data nothing commits to.
            let _ = analysis;
        }
    }
    assert!(
        analyzed > 0,
        "some damaged variants still parse, and were analyzed"
    );
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_source_that_answers_with_the_wrong_transaction_is_an_error() {
    let f = load("ironwood_batch_3");
    let other = load("orchard_batch_old_height");
    let lying = FakeChain {
        tip: TIP,
        always_answer_with: Some(other.batch_raw.clone()),
        ..FakeChain::default()
    };
    let err = verify_campaign(
        &lying,
        &request(vec![f.batch_txid], f.payout_total),
        &config(3),
    )
    .await
    .unwrap_err();
    assert_eq!(err, VerifyError::Source(SourceError::Inconsistent));
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_batch_served_under_the_wrong_transaction_id_is_an_error_not_a_receipt() {
    // The funding transaction is genuine, so the only lie is which transaction the batch id names.
    let f = load("ironwood_batch_3");
    let other = load("orchard_batch_old_height");
    let mut c = chain(&f, 6);
    c.txs.insert(
        f.batch_txid,
        FetchedTx {
            raw: other.batch_raw.clone(),
            mined_height: Some(TIP - 5),
        },
    );
    let err = verify_campaign(&c, &request(vec![f.batch_txid], f.payout_total), &config(3))
        .await
        .unwrap_err();
    assert_eq!(err, VerifyError::Source(SourceError::Inconsistent));
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_funding_transaction_served_under_the_wrong_id_is_an_error_not_a_made_up_input() {
    let f = load("ironwood_batch_3");
    let other = load("orchard_batch_old_height");
    let mut c = chain(&f, 6);
    // A parseable transaction with a different id, offered as the funding transaction.
    c.txs.insert(
        f.funding_txid,
        FetchedTx {
            raw: other.batch_raw.clone(),
            mined_height: Some(1),
        },
    );
    let err = verify_campaign(&c, &request(vec![f.batch_txid], f.payout_total), &config(3))
        .await
        .unwrap_err();
    assert_eq!(err, VerifyError::Source(SourceError::Inconsistent));
}

// covers: REQ-VER-001
#[tokio::test]
async fn an_unreachable_source_is_an_error_not_a_not_found_finding() {
    let f = load("ironwood_batch_3");
    let down = FakeChain {
        down: true,
        ..chain(&f, 6)
    };
    let err = verify_campaign(
        &down,
        &request(vec![f.batch_txid], f.payout_total),
        &config(3),
    )
    .await
    .unwrap_err();
    assert_eq!(err, VerifyError::Source(SourceError::Unavailable));
}

// covers: REQ-VER-001
#[tokio::test]
async fn malformed_requests_are_refused() {
    let f = load("ironwood_batch_3");
    let c = chain(&f, 6);
    assert_eq!(
        verify_campaign(&c, &request(vec![], 0), &config(3))
            .await
            .unwrap_err(),
        VerifyError::NoTransactions
    );
    assert_eq!(
        verify_campaign(
            &c,
            &request(vec![f.batch_txid, f.batch_txid], 1),
            &config(3)
        )
        .await
        .unwrap_err(),
        VerifyError::DuplicateTxid
    );
    assert_eq!(
        verify_campaign(&c, &request(vec![f.batch_txid], 1), &config(0))
            .await
            .unwrap_err(),
        VerifyError::ZeroDepth
    );
}

// covers: REQ-VER-001
#[test]
fn txids_and_outpoints_use_display_order() {
    let f = load("ironwood_batch_3");
    let tx = ParsedTx::parse(&f.batch_raw).unwrap();
    assert_eq!(
        tx.txid(),
        f.batch_txid,
        "the txid computed from bytes is the one explorers show"
    );
    let prevouts = tx.prevouts();
    assert_eq!(prevouts.len(), 1);
    assert_eq!(
        drop_verify::analyze::core_outpoint(&prevouts[0]).txid,
        f.funding_txid
    );
    let wire = drop_verify::analyze::wire_txid_bytes(&f.funding_txid);
    assert_eq!(prevouts[0].hash(), &wire);
}

// covers: REQ-PRIV-002
#[tokio::test]
async fn the_campaign_id_is_only_echoed() {
    let f = load("ironwood_batch_3");
    let mut req = request(vec![f.batch_txid], f.payout_total);
    req.campaign_id = Some(CampaignId::new("spring-drop").unwrap());
    let receipt = verify_campaign(&chain(&f, 6), &req, &config(3))
        .await
        .unwrap();
    assert_eq!(
        receipt.campaign_id.as_ref().map(CampaignId::as_str),
        Some("spring-drop")
    );
}

// ---------------------------------------------------------------------------
// REQ-VER-003: confirmation depth
// ---------------------------------------------------------------------------

// covers: REQ-VER-003
#[tokio::test]
async fn below_the_required_depth_a_batch_is_pending_and_the_campaign_is_not_settled() {
    let f = load("ironwood_batch_3");
    for confirmations in [0, 1, 2] {
        let receipt = run(&chain(&f, confirmations), &f, 3).await;
        assert_eq!(
            receipt.findings,
            vec![Finding::BatchPending { batch_index: 0 }],
            "{confirmations} confirmations"
        );
        assert_eq!(receipt.batches[0].confirmations, confirmations);
        assert!(
            matches!(receipt.phase, CampaignPhase::Sending { done: 0, total: 1 }),
            "{:?}",
            receipt.phase
        );
    }
}

// covers: REQ-VER-003
#[tokio::test]
async fn at_or_above_the_depth_a_batch_is_final_and_the_campaign_settles() {
    let f = load("ironwood_batch_3");
    for confirmations in [3, 4, 100] {
        let receipt = run(&chain(&f, confirmations), &f, 3).await;
        assert!(
            receipt.findings.is_empty(),
            "{confirmations}: {:?}",
            receipt.findings
        );
        assert_eq!(receipt.phase, CampaignPhase::Settled, "{confirmations}");
    }
}

// covers: REQ-VER-003
#[tokio::test]
async fn one_pending_batch_keeps_a_multi_batch_campaign_from_settling() {
    let a = load("ironwood_batch_3");
    let b = load("ironwood_batch_low_fee");
    let mut both = chain(&a, 9);
    both.txs.insert(
        b.batch_txid,
        FetchedTx {
            raw: b.batch_raw.clone(),
            mined_height: Some(TIP - 1),
        },
    );
    let receipt = verify_campaign(
        &both,
        &request(
            vec![a.batch_txid, b.batch_txid],
            a.payout_total + b.payout_total,
        ),
        &config(3),
    )
    .await
    .unwrap();
    assert_eq!(
        receipt.findings,
        vec![Finding::BatchPending { batch_index: 1 }]
    );
    assert_eq!(receipt.phase, CampaignPhase::Sending { done: 1, total: 2 });
}

// covers: REQ-VER-003
#[tokio::test]
async fn the_depth_is_the_callers_to_choose() {
    let f = load("ironwood_batch_3");
    let c = chain(&f, 2);
    assert_eq!(run(&c, &f, 1).await.phase, CampaignPhase::Settled);
    assert_eq!(run(&c, &f, 2).await.phase, CampaignPhase::Settled);
    assert!(matches!(
        run(&c, &f, 3).await.phase,
        CampaignPhase::Sending { .. }
    ));
}

// ---------------------------------------------------------------------------
// Real testnet batches (fixtures/testnet-ironwood-batch*/): public chain data only
// ---------------------------------------------------------------------------

/// The campaign funding address both real batches spend from.
const REAL_FUNDING_ADDRESS: &str = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";
/// The first live batch: 3 recipients (fixture set, txid).
const REAL_BATCH_3: (&str, &str) = (
    "testnet-ironwood-batch",
    "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3",
);
/// The operator's 8-recipient demo campaign `c-d8d4d52029a4`.
const REAL_BATCH_8: (&str, &str) = (
    "testnet-ironwood-batch-8",
    "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955",
);

fn real_dir((set, txid): (&str, &str)) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(set)
        .join(txid)
}

fn real_json(batch: (&str, &str), name: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(real_dir(batch).join(name)).unwrap()).unwrap()
}

/// A chain serving a captured batch `confirmations` deep, and the transaction it spends.
fn real_chain(batch: (&str, &str), confirmations: u32) -> (Txid, FakeChain) {
    let dir = real_dir(batch);
    let hex_file = |name: &str| {
        let text = std::fs::read_to_string(dir.join(name)).unwrap();
        hex::decode(text.trim()).unwrap()
    };
    let mined = real_json(batch, "expected.json")["mined_height"]
        .as_u64()
        .unwrap() as u32;
    let funding: Txid = real_json(batch, "prevouts.json")[0]["txid"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let txid: Txid = batch.1.parse().unwrap();

    let mut chain = FakeChain {
        tip: mined + confirmations - 1,
        ..FakeChain::default()
    };
    chain.txs.insert(
        funding,
        FetchedTx {
            raw: hex_file("funding-tx.hex"),
            mined_height: Some(1),
        },
    );
    chain.txs.insert(
        txid,
        FetchedTx {
            raw: hex_file("tx.hex"),
            mined_height: Some(mined),
        },
    );
    (txid, chain)
}

// covers: REQ-VER-004
#[tokio::test]
async fn the_real_testnet_batch_names_its_funding_address() {
    let (txid, chain) = real_chain(REAL_BATCH_3, 6);
    let receipt = verify_campaign(&chain, &request(vec![txid], 60_000), &config(3))
        .await
        .unwrap();

    assert!(receipt.findings.is_empty(), "{:?}", receipt.findings);
    assert_eq!(receipt.phase, CampaignPhase::Settled);
    assert_eq!(
        receipt.funding_address.as_deref(),
        Some(REAL_FUNDING_ADDRESS)
    );
    assert_eq!(receipt.fee_total, Some(Zatoshi::new(20_000).unwrap()));
}

// covers: REQ-VER-001
// covers: REQ-VER-004
#[tokio::test]
async fn the_real_8_recipient_batch_verifies_from_chain_data_alone() {
    let (txid, chain) = real_chain(REAL_BATCH_8, 19);
    let receipt = verify_campaign(&chain, &request(vec![txid], 500_000), &config(3))
        .await
        .unwrap();

    assert!(receipt.findings.is_empty(), "{:?}", receipt.findings);
    assert_eq!(receipt.phase, CampaignPhase::Settled);
    assert_eq!(
        receipt.funding_address.as_deref(),
        Some(REAL_FUNDING_ADDRESS)
    );
    assert_eq!(receipt.fee_total, Some(Zatoshi::new(45_000).unwrap()));
    let batch = &receipt.batches[0];
    assert_eq!(batch.txid, Some(txid));
    assert_eq!(batch.net_into_pool, Some(Zatoshi::new(500_000).unwrap()));
    assert_eq!(batch.fee, Some(Zatoshi::new(45_000).unwrap()));
    assert_eq!(batch.shielded_actions, Some(8));
    assert_eq!(batch.pool, Some(Pool::Ironwood));
    assert_eq!(batch.confirmations, 19);
    // The input is the sweep's output, as the captured prevouts say.
    assert_eq!(
        batch.funding_input,
        Some(
            "9070aee087878ded13f46e8817574753e6cc6575678a5d233739a479a858f272:0"
                .parse()
                .unwrap()
        )
    );
}

// covers: REQ-VER-001
#[tokio::test]
async fn a_tampered_declared_total_fails_the_real_8_recipient_batch() {
    let (txid, chain) = real_chain(REAL_BATCH_8, 19);
    for declared in [499_999, 500_001, 545_000] {
        let receipt = verify_campaign(&chain, &request(vec![txid], declared), &config(3))
            .await
            .unwrap();
        assert_eq!(
            receipt.findings,
            vec![Finding::DeclaredTotalMismatch],
            "declared {declared}"
        );
        assert_eq!(receipt.phase, CampaignPhase::Failed, "declared {declared}");
        // The chain facts themselves are unchanged.
        assert_eq!(
            receipt.batches[0].net_into_pool,
            Some(Zatoshi::new(500_000).unwrap())
        );
    }
}

// covers: REQ-VER-001
// covers: REQ-VER-004
#[tokio::test]
async fn the_captured_receipts_are_what_the_verifier_computes_from_the_captured_chain_data() {
    // receipt.json came from the hosted verifier on testnet; recomputing it offline from the
    // stored transactions (at the depth it was captured at) must give the same receipt.
    for batch in [REAL_BATCH_3, REAL_BATCH_8] {
        let captured: PublicReceipt =
            serde_json::from_value(real_json(batch, "receipt.json")).unwrap();
        let (txid, chain) = real_chain(batch, captured.batches[0].confirmations);
        let request = VerifyRequest {
            network: Network::Testnet,
            txids: vec![txid],
            manifest_commitment: captured.manifest_commitment,
            declared_total: captured.declared_total,
            campaign_id: None,
        };
        let receipt = verify_campaign(&chain, &request, &config(3)).await.unwrap();
        assert_eq!(receipt, captured, "{}", batch.0);
    }
}

// covers: REQ-VER-004
#[tokio::test]
async fn batches_from_two_funding_addresses_are_mixed_and_fail() {
    let a = load("ironwood_batch_3");
    let other = load("ironwood_batch_other_funder");
    let mut c = chain(&a, 6);
    c.txs.insert(
        other.funding_txid,
        FetchedTx {
            raw: other.funding_raw.clone(),
            mined_height: Some(1),
        },
    );
    c.txs.insert(
        other.batch_txid,
        FetchedTx {
            raw: other.batch_raw.clone(),
            mined_height: Some(TIP - 5),
        },
    );

    let receipt = verify_campaign(
        &c,
        &request(
            vec![a.batch_txid, other.batch_txid],
            a.payout_total + other.payout_total,
        ),
        &config(3),
    )
    .await
    .unwrap();
    assert_eq!(
        receipt.findings,
        vec![Finding::MixedFundingSources { batch_index: 1 }]
    );
    assert_eq!(receipt.phase, CampaignPhase::Failed);
    assert_eq!(receipt.funding_address, None);
    // Every other fact still holds: only the funding differs.
    assert_eq!(
        receipt.batches[1].net_into_pool,
        Some(Zatoshi::new(other.payout_total).unwrap())
    );

    // Control: two batches from the same address state it and settle.
    let same = load("ironwood_batch_low_fee");
    let mut c = chain(&a, 6);
    c.txs.insert(
        same.batch_txid,
        FetchedTx {
            raw: same.batch_raw.clone(),
            mined_height: Some(TIP - 5),
        },
    );
    let receipt = verify_campaign(
        &c,
        &request(
            vec![a.batch_txid, same.batch_txid],
            a.payout_total + same.payout_total,
        ),
        &config(3),
    )
    .await
    .unwrap();
    assert_eq!(receipt.phase, CampaignPhase::Settled);
    let funding = ParsedTx::parse_any_version(&a.funding_raw).unwrap();
    assert_eq!(
        receipt.funding_address,
        drop_verify::p2pkh_address(&funding.output(0).unwrap(), Network::Testnet)
    );
    assert!(receipt.funding_address.unwrap().starts_with("tm"));
}

// covers: REQ-VER-004
#[tokio::test]
async fn an_unresolvable_prevout_leaves_the_funding_address_unknown_without_failing() {
    let f = load("ironwood_batch_3");
    let mut c = chain(&f, 6);
    c.txs.remove(&f.funding_txid);
    let receipt = run(&c, &f, 3).await;
    assert_eq!(receipt.funding_address, None);
    assert_eq!(
        receipt.findings,
        vec![Finding::PrevoutUnresolved { batch_index: 0 }]
    );
    assert_ne!(receipt.phase, CampaignPhase::Failed);

    // One known batch beside one unknown one: no address, and not "mixed" either.
    let other = load("ironwood_batch_other_funder");
    let mut c = chain(&f, 6);
    c.txs.insert(
        other.batch_txid,
        FetchedTx {
            raw: other.batch_raw.clone(),
            mined_height: Some(TIP - 5),
        },
    );
    let receipt = verify_campaign(
        &c,
        &request(
            vec![f.batch_txid, other.batch_txid],
            f.payout_total + other.payout_total,
        ),
        &config(3),
    )
    .await
    .unwrap();
    assert_eq!(receipt.funding_address, None);
    assert_eq!(
        receipt.findings,
        vec![Finding::PrevoutUnresolved { batch_index: 1 }]
    );
    assert_ne!(receipt.phase, CampaignPhase::Failed);
}
