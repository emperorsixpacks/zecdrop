//! Writes `examples/demo-recipients.testnet.csv` (repo root): 8 TESTNET demo recipients derived
//! from the dev seed (accounts 9000..9007), with varied amounts summing to 0.005 TAZ.
//!
//! The CSV holds public Unified Addresses only: no seed, keys or viewing keys. Regenerating is
//! deterministic for a given dev seed.
//!
//! Run: `cargo run -p drop-zcash --example demo_recipients`

mod support;

use std::path::PathBuf;

use drop_core::Zatoshi;
use drop_zcash::{zcash_network, CampaignKeys};
use support::{demo_account, demo_memo, load_dev_seed, DEMO_AMOUNTS};

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let seed = load_dev_seed()?;
    let network = zcash_network(drop_core::Network::Testnet);

    let mut csv = String::from("address,amount,memo\n");
    let mut total = 0u64;
    for (i, amount) in DEMO_AMOUNTS.iter().enumerate() {
        let n = i as u32 + 1;
        let keys = CampaignKeys::derive(seed.as_bytes(), network, demo_account(n))
            .map_err(|e| e.to_string())?;
        total += Zatoshi::parse_zec(amount)
            .map_err(|e| e.to_string())?
            .as_u64();
        csv.push_str(&format!(
            "{},{amount},{}\n",
            keys.unified_address(),
            demo_memo(n)
        ));
    }
    drop(seed);
    if total != 500_000 {
        return Err(format!("demo amounts sum to {total} zat, expected 500000"));
    }

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/demo-recipients.testnet.csv");
    std::fs::write(&path, csv).map_err(|e| format!("{}: {e}", path.display()))?;
    let path = path.canonicalize().unwrap_or(path);
    println!(
        "wrote {} recipients ({} TAZ in total) to {}",
        DEMO_AMOUNTS.len(),
        Zatoshi::new(total).map_err(|e| e.to_string())?,
        path.display()
    );
    Ok(())
}
