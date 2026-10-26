//! The 8-recipient demo batch mined on testnet (`fixtures/testnet-ironwood-batch-8/`, operator
//! campaign `c-d8d4d52029a4`) opens for every demo recipient and for the campaign's auditor.
//!
//! The keys come from the TESTNET dev seed (`~/.zecdrop-dev/testnet.seed`, outside the repo;
//! viewing keys are never committed), so CI cannot run this. It is ignored by default, and passes
//! without checking anything when the seed file is absent. Run it on the dev machine with:
//!
//! ```text
//! cargo test -p drop-zcash --test demo_batch_recovery -- --ignored --nocapture
//! ```
//!
//! Never prints the seed, a key, an amount or a memo.

#[path = "../examples/support/mod.rs"]
mod support;

use std::collections::BTreeSet;
use std::path::PathBuf;

use drop_core::{import_csv_str, ImportOptions, Network};
use drop_zcash::{inspect, zcash_network, CampaignKeys, ZcashAddressCodec};
use orchard::keys::Scope;
use support::{demo_account, load_dev_seed};

const TX_HEX: &str = include_str!(
    "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/tx.hex"
);
/// What the operator was given for this campaign.
const CSV: &str = include_str!("../../../examples/demo-recipients.testnet.csv");
/// Public: `net_into_ironwood_zat` of the fixture's `expected.json`.
const NET_INTO_IRONWOOD: u64 = 500_000;
/// The campaign is account 0 of the dev seed (its funding address is the one the batch spends).
const CAMPAIGN_ACCOUNT: u32 = 0;
const CAMPAIGN_FUNDING_ADDRESS: &str = "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD";

fn dev_seed_present() -> bool {
    std::env::var_os("HOME").is_some_and(|home| {
        PathBuf::from(home)
            .join(".zecdrop-dev")
            .join("testnet.seed")
            .exists()
    })
}

// No `covers:` marker: CI never runs this, so it must not count as spec coverage.
#[test]
#[ignore = "needs the TESTNET dev seed (~/.zecdrop-dev/testnet.seed); run with --ignored"]
fn every_demo_recipient_and_the_auditor_open_the_real_8_recipient_batch() {
    if !dev_seed_present() {
        eprintln!("skipped: no dev seed at ~/.zecdrop-dev/testnet.seed");
        return;
    }
    let seed = load_dev_seed().expect("dev seed readable (errors carry no seed material)");
    let network = zcash_network(Network::Testnet);
    let raw = hex::decode(TX_HEX.trim()).unwrap();
    let codec = ZcashAddressCodec::new(network);
    let rows = import_csv_str(CSV, &codec, &ImportOptions::default())
        .into_result()
        .expect("the demo CSV imports");
    assert_eq!(rows.len(), 8);

    // Each recipient's incoming viewing key opens exactly one output: their row's amount and memo.
    let mut opened = Vec::new();
    for (n, row) in (1u32..).zip(&rows) {
        let keys = CampaignKeys::derive(seed.as_bytes(), network, demo_account(n)).unwrap();
        let ivk = keys
            .ufvk()
            .orchard()
            .expect("an Orchard key")
            .to_ivk(Scope::External);
        let mine = inspect::decrypt_with_ivk(&raw, &ivk).unwrap();
        assert!(
            mine.len() == 1,
            "recipient {n} opens {} outputs, not 1",
            mine.len()
        );
        assert!(
            mine[0].value == row.amount().as_u64(),
            "recipient {n}: amount differs from the CSV"
        );
        assert!(
            mine[0].memo.as_deref() == row.memo(),
            "recipient {n}: memo differs from the CSV"
        );
        opened.push((mine[0].action_index, mine[0].value, mine[0].memo.clone()));
    }
    let indices: BTreeSet<usize> = opened.iter().map(|(i, _, _)| *i).collect();
    assert_eq!(
        indices.len(),
        8,
        "eight distinct outputs, one per recipient"
    );

    // The campaign UFVK (via its OVK) recovers all eight, and they add up to the public total.
    let campaign = CampaignKeys::derive(seed.as_bytes(), network, CAMPAIGN_ACCOUNT).unwrap();
    drop(seed);
    assert_eq!(campaign.funding_address(), CAMPAIGN_FUNDING_ADDRESS);
    let ufvk = campaign.ufvk_encoded().unwrap();
    let audit = inspect::recover_with_ufvk(&raw, network, &ufvk).unwrap();
    assert_eq!(audit.len(), 8, "the auditor recovers every output");
    assert_eq!(
        audit.iter().map(|o| o.value).sum::<u64>(),
        NET_INTO_IRONWOOD,
        "recovered sum equals the public net into Ironwood"
    );
    for (index, value, memo) in &opened {
        let seen = audit.iter().find(|o| o.action_index == *index);
        assert!(
            seen.is_some_and(|o| o.value == *value && o.memo == *memo),
            "the auditor sees action {index} as its recipient does"
        );
    }
    eprintln!("checked: 8 recipients x 1 output each, auditor 8/8, sum = public net");
}
