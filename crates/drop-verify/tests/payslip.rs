//! Payslips, checked with no key, against real librustzcash transactions (fixtures built with
//! TEST-ONLY keys) served by an in-memory chain.
//!
//! The payslips are made here the way the owner of the campaign's outgoing viewing key makes
//! them, with the `orchard` crate directly: this crate cannot link `zcash_keys`, and the code under
//! test never sees a key, only a transaction and a payslip. The issuing side, over a freshly built
//! batch, is tested in `drop-zcash`.

mod support;

use drop_core::{Network, Txid, Zatoshi};
use drop_verify::payslip::{NOT_PROVEN, PAYSLIP_VERSION};
use drop_verify::{check_payslip, verify_payslip, CheckError, Payslip, PayslipError, SourceError};
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use support::{load, FakeChain, Fixture};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

const TIP: u32 = 5_000_000;

/// The campaign's outgoing viewing key in `support::builder` (a throwaway).
fn campaign_ovk() -> orchard::keys::OutgoingViewingKey {
    FullViewingKey::from(&SpendingKey::from_bytes([0x33; 32]).unwrap()).to_ovk(Scope::External)
}

/// Payout `i` of every fixture: its receiver and value (`support::builder`).
fn payout(i: usize) -> ([u8; 43], u64) {
    let fvk = FullViewingKey::from(&SpendingKey::from_bytes([0x40 + i as u8; 32]).unwrap());
    (
        fvk.address_at(0u32, Scope::External).to_raw_address_bytes(),
        1_000_000 * (i as u64 + 1) + i as u64,
    )
}

/// One payslip per output the campaign key recovers from the fixture's batch.
fn payslips(f: &Fixture) -> Vec<Payslip> {
    let tx = Transaction::read(&f.batch_raw[..], BranchId::Nu6_3).unwrap();
    let bundle = tx.ironwood_bundle().expect("an Ironwood batch");
    bundle
        .recover_outputs_with_ovks(&[campaign_ovk()])
        .into_iter()
        .map(|(action, _, note, _, _memo)| {
            Payslip::from_note(Network::Testnet, f.batch_txid, action as u32, &note).unwrap()
        })
        .collect()
}

/// The payslip for payout `i`.
fn slip(f: &Fixture, i: usize) -> Payslip {
    let (receiver, _) = payout(i);
    payslips(f)
        .into_iter()
        .find(|s| s.receiver == receiver)
        .expect("the key recovers every payout")
}

fn zat(value: u64) -> Zatoshi {
    Zatoshi::new(value).unwrap()
}

// covers: REQ-PAY-001
#[test]
fn every_payout_of_a_real_batch_has_a_payslip_the_verifier_accepts_with_no_key() {
    let f = load("ironwood_batch_3");
    let slips = payslips(&f);
    assert_eq!(slips.len(), 3);
    for i in 0..3 {
        let mine = slip(&f, i);
        assert_eq!(mine.value, zat(payout(i).1));
        assert_eq!((mine.version, mine.txid), (PAYSLIP_VERSION, f.batch_txid));
        let proof = verify_payslip(&f.batch_raw, &mine).unwrap();
        assert_eq!(
            (proof.txid, proof.action, proof.ironwood_actions),
            (f.batch_txid, mine.action, 3)
        );
    }
}

// covers: REQ-PAY-001
#[test]
fn a_changed_field_never_verifies() {
    let f = load("ironwood_batch_3");
    let good = slip(&f, 0);
    let rejected = |bad: &Payslip| verify_payslip(&f.batch_raw, bad).unwrap_err();

    let mut bad = good.clone();
    bad.value = zat(good.value.as_u64() + 1);
    assert_eq!(rejected(&bad), PayslipError::CommitmentMismatch);

    let mut bad = good.clone();
    bad.receiver = payout(1).0; // another recipient's real receiver
    assert_eq!(rejected(&bad), PayslipError::CommitmentMismatch);

    let mut bad = good.clone();
    bad.rseed[31] ^= 1;
    assert_eq!(rejected(&bad), PayslipError::CommitmentMismatch);

    for action in (0..3).filter(|a| *a != good.action) {
        let mut bad = good.clone();
        bad.action = action;
        assert_eq!(rejected(&bad), PayslipError::CommitmentMismatch);
    }
    let mut bad = good.clone();
    bad.action = 3;
    assert_eq!(rejected(&bad), PayslipError::ActionOutOfRange);

    let mut bad = good.clone();
    bad.txid = Txid::from_bytes([7; 32]);
    assert_eq!(rejected(&bad), PayslipError::TxidMismatch);
}

// covers: REQ-PAY-001
#[test]
fn a_payslip_names_a_transaction_and_not_only_an_output() {
    // Built from the same seed and payouts, so the shielded part of the three fixtures is
    // byte-for-byte the same; only the transparent side (and so the transaction id) differs.
    // Real batches never share an action: every output draws fresh randomness.
    let (a, b) = (load("ironwood_batch_3"), load("ironwood_batch_low_fee"));
    assert_ne!(a.batch_txid, b.batch_txid);
    let mine = slip(&a, 0);

    // As issued, the payslip is for A only.
    assert_eq!(
        verify_payslip(&b.batch_raw, &mine).unwrap_err(),
        PayslipError::TxidMismatch
    );
    // The commitment alone does not tell transactions apart: here the action is the same in
    // both, so a payslip that is rewritten to name B finds the same note there. The transaction
    // id is what ties a payslip to one transaction.
    let mut renamed = mine.clone();
    renamed.txid = b.batch_txid;
    assert!(verify_payslip(&b.batch_raw, &renamed).is_ok());
    // Which is why a service asks the chain for the transaction the payslip names, and checks
    // that what comes back has that id (`check_payslip`).
}

// covers: REQ-PAY-003
#[tokio::test]
async fn a_payslip_is_final_at_the_receipts_depth_and_pending_below_it() {
    let f = load("ironwood_batch_3");
    let mine = slip(&f, 1);
    let at = |confirmations: u32| {
        let mined = (confirmations > 0).then(|| TIP - confirmations + 1);
        FakeChain::with(&f, mined, TIP)
    };

    for (confirmations, is_final) in [(1, false), (2, false), (3, true), (50, true)] {
        let check = check_payslip(&at(confirmations), &mine, 3).await.unwrap();
        assert_eq!(check.confirmations, confirmations);
        assert_eq!(check.is_final, is_final, "{confirmations} confirmations");
        assert_eq!(check.proof.txid, f.batch_txid);
    }
    // In the mempool (or on a fork): valid, but nothing confirms it.
    let unmined = check_payslip(&at(0), &mine, 3).await.unwrap();
    assert_eq!((unmined.confirmations, unmined.is_final), (0, false));
}

// covers: REQ-PAY-003
#[tokio::test]
async fn an_outage_a_missing_transaction_and_a_lying_source_are_told_apart() {
    let f = load("ironwood_batch_3");
    let mine = slip(&f, 0);
    let chain = FakeChain::with(&f, Some(TIP), TIP);

    // Not final-able depth.
    assert_eq!(
        check_payslip(&chain, &mine, 0).await.unwrap_err(),
        CheckError::ZeroDepth
    );
    // An outage is not "your transaction does not exist".
    let down = FakeChain {
        down: true,
        ..chain.clone()
    };
    assert_eq!(
        check_payslip(&down, &mine, 3).await.unwrap_err(),
        CheckError::Source(SourceError::Unavailable)
    );
    // A transaction the source does not know.
    let mut stranger = mine.clone();
    stranger.txid = Txid::from_bytes([9; 32]);
    assert_eq!(
        check_payslip(&chain, &stranger, 3).await.unwrap_err(),
        CheckError::NotFound
    );
    // A source that answers with a different transaction than the one asked for.
    let liar = FakeChain {
        always_answer_with: Some(load("ironwood_batch_other_funder").batch_raw),
        ..chain.clone()
    };
    assert_eq!(
        check_payslip(&liar, &mine, 3).await.unwrap_err(),
        CheckError::Source(SourceError::Inconsistent)
    );
    // Bytes that are no transaction.
    let junk = FakeChain {
        always_answer_with: Some(vec![1, 2, 3]),
        ..chain.clone()
    };
    assert_eq!(
        check_payslip(&junk, &mine, 3).await.unwrap_err(),
        CheckError::Payslip(PayslipError::TxUnparseable)
    );
    // A version it does not read is refused before the chain is asked.
    let mut future = mine.clone();
    future.version = PAYSLIP_VERSION + 1;
    assert_eq!(
        check_payslip(&down, &future, 3).await.unwrap_err(),
        CheckError::Payslip(PayslipError::UnsupportedVersion)
    );
    // A payslip that does not match is an error, not a pending result.
    let mut wrong = mine.clone();
    wrong.value = zat(1);
    assert_eq!(
        check_payslip(&chain, &wrong, 3).await.unwrap_err(),
        CheckError::Payslip(PayslipError::CommitmentMismatch)
    );
}

// covers: REQ-PRIV-002, REQ-PAY-001
#[tokio::test]
async fn nothing_the_check_returns_or_prints_carries_the_payslips_contents() {
    let f = load("ironwood_batch_3");
    let chain = FakeChain::with(&f, Some(TIP), TIP);
    let all: Vec<Payslip> = (0..3).map(|i| slip(&f, i)).collect();

    let mut printed = Vec::new();
    for mine in &all {
        let check = check_payslip(&chain, mine, 3).await.unwrap();
        printed.push(format!("{check:?}"));
        printed.push(format!("{mine:?}"));
        let mut wrong = mine.clone();
        wrong.rseed[0] ^= 1;
        let error = check_payslip(&chain, &wrong, 3).await.unwrap_err();
        printed.push(format!("{error:?}"));
        printed.push(error.to_string());
    }
    for text in &printed {
        for other in &all {
            assert!(!text.contains(&hex::encode(other.receiver)), "{text}");
            assert!(!text.contains(&hex::encode(other.rseed)), "{text}");
            // Amounts, outside the transaction id's hex digits.
            let outside_hex: String = text
                .split(|c: char| !c.is_ascii_hexdigit())
                .filter(|run| run.len() < 32)
                .collect::<Vec<_>>()
                .join(" ");
            assert!(!outside_hex.contains(&other.value.to_string()), "{text}");
        }
    }
}

// covers: REQ-PAY-003
#[test]
fn the_limits_are_stated_with_the_answer() {
    let limits = NOT_PROVEN.join(" ");
    for topic in ["bearer", "memo", "final", "campaign", "other output"] {
        assert!(limits.contains(topic), "NOT_PROVEN must mention `{topic}`");
    }
}
