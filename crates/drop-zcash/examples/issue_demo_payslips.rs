//! Issues the payslips of the 8-recipient demo batch mined on public testnet
//! (`fixtures/testnet-ironwood-batch-8/`), one per demo recipient, and checks each with the key-less
//! verifier. The campaign key comes from the TESTNET dev seed (`~/.zecdrop-dev/testnet.seed`,
//! outside the repo); it is read here, never printed, and zeroized.
//!
//! The payslips are public demo data: the demo recipients are throwaway accounts whose amounts and
//! memos are in `examples/demo-recipients.testnet.csv`, and a payslip holds nothing else.
//!
//! Run: `cargo run -p drop-zcash --example issue_demo_payslips -- <output directory>`
//! (the directory is created; files are `payslip-1.json` to `payslip-8.json`, numbered like the CSV rows).

mod support;

use std::path::PathBuf;

use drop_core::Network;
use drop_verify::payslip::verify_payslip;
use drop_zcash::payslip::issue_payslips;
use drop_zcash::{zcash_network, CampaignKeys};
use support::{demo_account, load_dev_seed};
use zcash_keys::address::Address;

const TX_HEX: &str = include_str!(
    "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/tx.hex"
);
/// The campaign is account 0 of the dev seed (its funding address is the one the batch spends).
const CAMPAIGN_ACCOUNT: u32 = 0;

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let out_dir: PathBuf = std::env::args()
        .nth(1)
        .ok_or("usage: issue_demo_payslips <output directory>")?
        .into();
    let network = zcash_network(Network::Testnet);
    let raw = hex::decode(TX_HEX.trim()).map_err(|_| "the fixture is not hex")?;

    // The campaign's viewing key and each demo recipient's receiver; the seed is dropped right after.
    let (ufvk, receivers) = {
        let seed = load_dev_seed()?;
        let campaign = CampaignKeys::derive(seed.as_bytes(), network, CAMPAIGN_ACCOUNT)
            .map_err(|e| e.to_string())?;
        let ufvk = campaign.ufvk_encoded().map_err(|e| e.to_string())?;
        let mut receivers = Vec::new();
        for n in 1..=8u32 {
            let keys = CampaignKeys::derive(seed.as_bytes(), network, demo_account(n))
                .map_err(|e| e.to_string())?;
            let receiver = match Address::decode(&network, &keys.unified_address()) {
                Some(Address::Unified(ua)) => ua
                    .orchard()
                    .map(|r| r.to_raw_address_bytes())
                    .ok_or("a demo recipient has no Orchard receiver")?,
                _ => return Err("a demo recipient address is not unified".into()),
            };
            receivers.push(receiver);
        }
        (ufvk, receivers)
    };

    let payslips = issue_payslips(&raw, network, &ufvk).map_err(|e| e.to_string())?;
    if payslips.len() != 8 {
        return Err(format!(
            "expected 8 payslips, the key opened {}",
            payslips.len()
        ));
    }
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    for (index, receiver) in receivers.iter().enumerate() {
        let payslip = payslips
            .iter()
            .find(|p| &p.receiver == receiver)
            .ok_or_else(|| format!("no payslip for demo recipient {}", index + 1))?;
        // Every one verifies with no key, against the transaction as mined.
        verify_payslip(&raw, payslip).map_err(|e| e.to_string())?;
        let mut text = serde_json::to_string_pretty(payslip).map_err(|e| e.to_string())?;
        text.push('\n');
        let path = out_dir.join(format!("payslip-{}.json", index + 1));
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
    }
    println!("wrote 8 payslips to {}", out_dir.display());
    Ok(())
}
