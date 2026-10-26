//! Golden contract for the public receipt JSON.
//!
//! The web app parses `fixtures/contract/public-receipt.json`, and this test pins
//! that file to what `PublicReceipt` serializes to today. Change a receipt field
//! and this test fails until the fixture is regenerated, which in turn breaks the
//! web test until it is updated: neither side can drift alone.
//!
//! Regenerate with:
//!
//! ```text
//! UPDATE_GOLDEN=1 cargo test -p drop-core --test receipt_contract
//! ```

use std::fs;
use std::path::PathBuf;

use drop_core::{
    plan_batches, BatchReceipt, BatchStatus, CampaignId, CampaignPhase, ChainReceiptInputs,
    FeePolicy, Finding, FundingRef, FundingSource, FundingState, ManifestCommitment, Network,
    OutPoint, Pool, PublicReceipt, ReceiptInputs, Recipient, Txid, Zatoshi,
};

/// An obviously fake transparent address, as the fixtures show it.
const FUNDING_ADDRESS: &str = "tFAKEfundingAddressNotARealAddress0000";

/// A second one, for batches that spend from somewhere else.
const OTHER_ADDRESS: &str = "tFAKEotherAddressNotARealAddress000000";

/// Where a fixture lives: `<workspace root>/fixtures/contract/<name>`.
fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures")
        .join("contract")
        .join(name)
}

/// Compares `receipt`'s pretty JSON with the stored fixture `name`, or rewrites the
/// fixture when `UPDATE_GOLDEN=1`. Also checks the fixture parses back to `receipt`.
fn check_golden(name: &str, receipt: &PublicReceipt) {
    let mut fresh = serde_json::to_string_pretty(receipt).unwrap();
    fresh.push('\n');

    let path = golden_path(name);
    if std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1") {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &fresh).unwrap();
        return;
    }

    let stored = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\nGenerate it with: UPDATE_GOLDEN=1 cargo test -p drop-core --test receipt_contract",
            path.display()
        )
    });
    assert!(
        stored == fresh,
        "{} is out of date with the serialized PublicReceipt.\n\
         If the change is intended, regenerate with:\n  \
         UPDATE_GOLDEN=1 cargo test -p drop-core --test receipt_contract\n\
         and update the web contract test.\n\n--- stored ---\n{stored}\n--- fresh ---\n{fresh}",
        path.display()
    );
    let parsed: PublicReceipt = serde_json::from_str(&stored).unwrap();
    assert_eq!(
        &parsed, receipt,
        "{name} does not parse back to the same receipt"
    );
}

/// A representative receipt built from clearly fake data: batch 0 is built and
/// confirmed past the required depth, batch 1 is not built yet (`txid: null`).
fn representative_receipt() -> PublicReceipt {
    let campaign = CampaignId::new("golden-fixture").unwrap();

    let amounts = [
        150_000_000u64,
        25_000_000,
        310_000_000,
        7_500_000,
        42_000_000,
    ];
    let rows: Vec<Recipient> = amounts
        .iter()
        .enumerate()
        .map(|(i, amount)| {
            Recipient::new(
                format!("u1fixtureaddress{i:016}"),
                Zatoshi::new(*amount).unwrap(),
                None,
            )
            .unwrap()
        })
        .collect();
    // Five rows with a maximum of three: batches of three and two.
    let batches = plan_batches(&rows, 3).unwrap();
    assert_eq!(batches.len(), 2);

    let fundings: Vec<FundingRef> = batches
        .iter()
        .map(|batch| FundingRef {
            outpoint: OutPoint {
                txid: Txid::from_bytes([0xcc; 32]),
                vout: batch.index(),
            },
            value: Zatoshi::new(batch.total().as_u64() + 1_000_000).unwrap(),
        })
        .collect();
    let statuses = vec![
        BatchStatus::Confirmed {
            txid: Txid::from_bytes([0xaa; 32]),
            depth: 5,
        },
        BatchStatus::Planned,
    ];

    PublicReceipt::assemble(ReceiptInputs {
        campaign_id: &campaign,
        network: Network::Testnet,
        manifest_commitment: ManifestCommitment::from_bytes([0xee; 32]),
        fee_policy: &FeePolicy::zip317_text(),
        pool: Pool::Ironwood,
        batches: &batches,
        fundings: &fundings,
        statuses: &statuses,
        funding_state: FundingState::Funded,
        required_depth: 3,
        funding_address: Some(FUNDING_ADDRESS),
        funding_source: Some(FundingSource::Shielded),
    })
    .unwrap()
}

// covers: REQ-PRIV-001, REQ-VER-007
#[test]
fn public_receipt_json_matches_the_golden_fixture() {
    let receipt = representative_receipt();
    check_golden("public-receipt.json", &receipt);
    // The shapes the web side must handle: one built and confirmed batch, one with a null txid.
    assert_eq!(receipt.funding_address.as_deref(), Some(FUNDING_ADDRESS));
    assert_eq!(receipt.funding_source, Some(FundingSource::Shielded));
    assert!(receipt.batches[0].txid.is_some());
    assert!(receipt.batches[1].txid.is_none());
    assert!(receipt.findings.is_empty());
}

/// A batch the verifier established in full.
fn verified(index: u32, net: u64, confirmations: u32) -> BatchReceipt {
    BatchReceipt {
        index,
        txid: Some(Txid::from_bytes([0xa0 + index as u8; 32])),
        funding_input: Some(OutPoint {
            txid: Txid::from_bytes([0xcc; 32]),
            vout: index,
        }),
        net_into_pool: Some(Zatoshi::new(net).unwrap()),
        fee: Some(Zatoshi::new(20_000).unwrap()),
        shielded_actions: Some(3),
        pool: Some(Pool::Ironwood),
        confirmations,
    }
}

/// A batch whose facts could not be established (only the requested txid is known).
fn unknown(index: u32) -> BatchReceipt {
    BatchReceipt {
        txid: Some(Txid::from_bytes([0xa0 + index as u8; 32])),
        funding_input: None,
        net_into_pool: None,
        fee: None,
        shielded_actions: None,
        pool: None,
        confirmations: 0,
        index,
    }
}

fn chain_receipt(
    campaign: Option<&CampaignId>,
    declared: u64,
    batches: Vec<BatchReceipt>,
    findings: Vec<Finding>,
    funding: &[Option<&str>],
    source: Option<FundingSource>,
) -> PublicReceipt {
    let funding: Vec<Option<String>> = funding.iter().map(|a| a.map(str::to_owned)).collect();
    PublicReceipt::from_chain_facts_with_funding(
        ChainReceiptInputs {
            campaign_id: campaign,
            network: Network::Testnet,
            manifest_commitment: ManifestCommitment::from_bytes([0xee; 32]),
            declared_total: Zatoshi::new(declared).unwrap(),
            required_depth: 3,
            batches,
            findings,
            funding_source: source,
        },
        &funding,
    )
    .unwrap()
}

// covers: REQ-PRIV-001, REQ-VER-001, REQ-VER-003, REQ-VER-004
#[test]
fn verifier_receipt_with_every_batch_level_finding_matches_the_golden_fixture() {
    let campaign = CampaignId::new("golden-fixture").unwrap();
    let mut prevout_unresolved = verified(4, 1_000_000, 6);
    prevout_unresolved.fee = None;
    let mut negative_fee = verified(5, 1_000_000, 6);
    negative_fee.fee = None;
    let mut wrong_pool = verified(7, 1_000_000, 6);
    wrong_pool.pool = Some(Pool::Orchard);

    let receipt = chain_receipt(
        Some(&campaign),
        8_000_000,
        vec![
            verified(0, 1_000_000, 6),
            verified(1, 1_000_000, 1),
            unknown(2),
            unknown(3),
            prevout_unresolved,
            negative_fee,
            verified(6, 1_000_000, 6),
            wrong_pool,
        ],
        vec![
            Finding::TxNotFound { batch_index: 2 },
            Finding::TxUnparseable { batch_index: 3 },
            Finding::PrevoutUnresolved { batch_index: 4 },
            Finding::NegativeFee { batch_index: 5 },
            Finding::BalanceMismatch { batch_index: 6 },
            Finding::UnexpectedPool { batch_index: 7 },
        ],
        // Batch 6 spends from somewhere else; two are unknown, so no single address is stated.
        &[
            Some(FUNDING_ADDRESS),
            Some(FUNDING_ADDRESS),
            None,
            None,
            Some(FUNDING_ADDRESS),
            Some(FUNDING_ADDRESS),
            Some(OTHER_ADDRESS),
            Some(FUNDING_ADDRESS),
        ],
        // Two deposits could not be looked up, so where they came from is not established.
        None,
    );
    check_golden("public-receipt-findings.json", &receipt);
    assert_eq!(receipt.funding_address, None);
    assert_eq!(receipt.funding_source, None);
    assert!(receipt
        .findings
        .contains(&Finding::MixedFundingSources { batch_index: 6 }));

    // Every finding code except the campaign-level one appears, plus `batch_pending`.
    let codes: Vec<String> = receipt
        .findings
        .iter()
        .map(|f| {
            serde_json::to_value(f).unwrap()["code"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    for code in [
        "tx_not_found",
        "tx_unparseable",
        "prevout_unresolved",
        "negative_fee",
        "balance_mismatch",
        "unexpected_pool",
        "mixed_funding_sources",
        "batch_pending",
    ] {
        assert!(
            codes.iter().any(|c| c == code),
            "{code} missing from {codes:?}"
        );
    }
    assert_eq!(receipt.phase, CampaignPhase::Failed);
    assert_eq!(receipt.fee_total, None);
}

// covers: REQ-PRIV-001, REQ-VER-001, REQ-VER-004, REQ-VER-007
#[test]
fn verifier_receipt_with_a_declared_total_mismatch_matches_the_golden_fixture() {
    let receipt = chain_receipt(
        None,
        2_000_001,
        vec![verified(0, 1_000_000, 9), verified(1, 1_000_000, 9)],
        vec![],
        // Both batches spend from the same address: the receipt states it.
        &[Some(FUNDING_ADDRESS), Some(FUNDING_ADDRESS)],
        // A deposit that spent a transparent coin: a privacy fact, not one of the findings.
        Some(FundingSource::Transparent),
    );
    check_golden("public-receipt-declared-mismatch.json", &receipt);
    assert_eq!(receipt.funding_address.as_deref(), Some(FUNDING_ADDRESS));
    assert_eq!(receipt.funding_source, Some(FundingSource::Transparent));
    // The transparent deposit added no finding: the only one is the mismatch.
    assert_eq!(receipt.findings, vec![Finding::DeclaredTotalMismatch]);
    assert_eq!(receipt.phase, CampaignPhase::Failed);
    assert!(receipt.campaign_id.is_none());
    assert!(receipt.fee_total.is_some());
}
