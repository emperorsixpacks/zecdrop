//! The 8-recipient batch mined on public testnet (`fixtures/testnet-ironwood-batch-8/`) and the
//! eight payslips issued for it with the demo campaign's key (`crates/drop-zcash/examples/
//! issue_demo_payslips.rs`; the key is a throwaway testnet dev key that is not in the repository).
//!
//! This needs no key and no network: it is the check anyone can run. It is the positive proof on real
//! chain data that `src/payslip.rs`'s unit tests cannot give (they hold no payslip for it).
//!
//! The same 8 recipients were paid again by a batch funded through a shielded deposit address
//! (`fixtures/testnet-ironwood-batch-8-inbox/`), whose payslips the operator's own `payslips` command
//! wrote: how a payout was funded changes nothing for its payslips.

use drop_core::Zatoshi;
use drop_verify::{verify_payslip, Payslip, PayslipError};

const TX_HEX: &str = include_str!(
    "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/tx.hex"
);

/// The eight payslips, in the order of the demo CSV's rows.
const PAYSLIPS: [&str; 8] = [
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-1.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-2.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-3.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-4.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-5.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-6.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-7.json"),
    include_str!("../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/payslips/payslip-8.json"),
];

/// The demo CSV's amounts in zatoshi (0.0006 TAZ and so on), row by row.
const AMOUNTS: [u64; 8] = [
    60_000, 40_000, 90_000, 50_000, 70_000, 30_000, 100_000, 60_000,
];

fn raw() -> Vec<u8> {
    hex::decode(TX_HEX.trim()).unwrap()
}

fn payslips() -> Vec<Payslip> {
    PAYSLIPS
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect()
}

// covers: REQ-PAY-001
#[test]
fn every_demo_payslip_opens_its_own_output_of_the_real_mined_batch_with_no_key() {
    let raw = raw();
    let slips = payslips();
    let mut actions = Vec::new();
    for (i, slip) in slips.iter().enumerate() {
        assert_eq!(
            slip.value,
            Zatoshi::new(AMOUNTS[i]).unwrap(),
            "row {}",
            i + 1
        );
        let proof = verify_payslip(&raw, slip).unwrap_or_else(|e| panic!("row {}: {e}", i + 1));
        assert_eq!(proof.ironwood_actions, 8);
        actions.push(proof.action);
    }
    // Eight different outputs, in no relation to the order of the payout list.
    actions.sort_unstable();
    assert_eq!(actions, (0..8).collect::<Vec<u32>>());
    // They add up to what the transaction publishes entering the pool: 0.005 TAZ.
    let sum: u64 = slips.iter().map(|s| s.value.as_u64()).sum();
    assert_eq!(sum, 500_000);
}

// covers: REQ-PAY-001
#[test]
fn a_demo_payslip_opens_no_other_output_and_no_changed_one() {
    let raw = raw();
    let slips = payslips();
    for (i, slip) in slips.iter().enumerate() {
        // Pointed at any other action it fails, even for the same transaction.
        for other in (0..8).filter(|a| *a != slip.action) {
            let mut moved = slip.clone();
            moved.action = other;
            assert_eq!(
                verify_payslip(&raw, &moved).unwrap_err(),
                PayslipError::CommitmentMismatch,
                "row {} moved to action {other}",
                i + 1
            );
        }
        // One zatoshi more or less, or another recipient's seed, fails.
        let mut richer = slip.clone();
        richer.value = Zatoshi::new(slip.value.as_u64() + 1).unwrap();
        assert!(verify_payslip(&raw, &richer).is_err());
        let mut borrowed = slip.clone();
        borrowed.rseed = slips[(i + 1) % 8].rseed;
        assert!(verify_payslip(&raw, &borrowed).is_err());
    }
}

/// The batch funded through the shielded deposit address, and the folder of its payslips.
const INBOX_BATCH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/testnet-ironwood-batch-8-inbox/af8adf80e3a58378d4ed4852cfbbb035be5dbd4bde65dab732fa3bf95cd64a12"
);

// covers: REQ-PAY-001
#[test]
fn the_payslips_of_the_batch_funded_through_a_shielded_deposit_address_open_their_outputs_with_no_key(
) {
    let dir = std::path::Path::new(INBOX_BATCH);
    let raw = hex::decode(std::fs::read_to_string(dir.join("tx.hex")).unwrap().trim()).unwrap();
    let mut actions = Vec::new();
    for (i, amount) in AMOUNTS.iter().enumerate() {
        let name = format!("payslip-{:03}.json", i + 1);
        let text = std::fs::read_to_string(dir.join("payslips").join(&name)).unwrap();
        let slip: Payslip = serde_json::from_str(&text).unwrap();
        assert_eq!(slip.value, Zatoshi::new(*amount).unwrap(), "{name}");
        let proof = verify_payslip(&raw, &slip).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(proof.ironwood_actions, 8);
        actions.push(proof.action);
        // Against the other real batch, which paid the same recipients the same amounts, it fails.
        assert!(verify_payslip(&self::raw(), &slip).is_err(), "{name}");
    }
    actions.sort_unstable();
    assert_eq!(actions, (0..8).collect::<Vec<u32>>());
}
