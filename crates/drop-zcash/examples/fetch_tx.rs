//! Fetches one transaction through drop-chain and prints its public shape and raw bytes, for
//! capturing test fixtures and checking where a deposit's funds came from.
//!
//! Prints public chain data only; it needs no key.
//!
//! Run: `cargo run -p drop-zcash --example fetch_tx -- <txid> [testnet|mainnet] [endpoint]`

use drop_chain::{ChainConfig, LightwalletdSource};
use drop_core::{Network, Txid};
use drop_verify::{ChainSource, ParsedTx};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: fetch_tx <txid> [testnet|mainnet] [endpoint]";
    let txid: Txid = args
        .first()
        .ok_or(usage)?
        .parse()
        .map_err(|_| "txid must be 64 hex chars")?;
    let (network, default_endpoint) = match args.get(1).map(String::as_str) {
        None | Some("testnet") => (Network::Testnet, "https://testnet.zec.rocks:443"),
        Some("mainnet") => (Network::Mainnet, "https://zec.rocks:443"),
        Some(_) => return Err(usage.into()),
    };
    let endpoint = args.get(2).map_or(default_endpoint, String::as_str);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let fetched = runtime.block_on(async {
        let config = ChainConfig::new(endpoint, network);
        let (source, _) = LightwalletdSource::connect(&config)
            .await
            .map_err(|e| e.to_string())?;
        source
            .transaction(&txid)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "the server does not know this transaction".to_owned())
    })?;

    // The same checks the verifier and the operator make: every byte read, and the bytes are the
    // transaction asked for; and the same rule for what a deposit spent (REQ-VER-007).
    let parsed = ParsedTx::parse_any_version(&fetched.raw)
        .map_err(|_| "the server's bytes are not one whole transaction")?;
    if parsed.txid() != txid {
        return Err("the server answered with another transaction".into());
    }
    let tx = Transaction::read(fetched.raw.as_slice(), BranchId::Nu6_3)
        .map_err(|e| format!("not a transaction: {e}"))?;
    let (inputs, outputs) = tx.transparent_bundle().map_or((0, Vec::new()), |b| {
        (
            b.vin.len(),
            b.vout.iter().map(|o| u64::from(o.value())).collect(),
        )
    });
    let sapling = tx.sapling_bundle().map_or((0, 0), |b| {
        (b.shielded_spends().len(), b.shielded_outputs().len())
    });
    let orchard = tx
        .orchard_bundle()
        .map(|b| (b.actions().len(), i64::from(*b.value_balance())));
    let ironwood = tx
        .ironwood_bundle()
        .map(|b| (b.actions().len(), i64::from(*b.value_balance())));

    println!("txid                 {txid}");
    println!("version              {:?}", tx.version());
    println!("mined at             {:?}", fetched.mined_height);
    println!("transparent inputs   {inputs}");
    println!("transparent outputs  {outputs:?} (zatoshi)");
    println!(
        "sapling              {} spends, {} outputs, balance {}",
        sapling.0,
        sapling.1,
        i64::from(tx.sapling_value_balance())
    );
    println!("orchard              {orchard:?} (actions, balance)");
    println!("ironwood             {ironwood:?} (actions, balance)");
    println!(
        "as a deposit         {:?} (what it spent)",
        parsed.deposit_source()
    );
    println!("raw                  {}", hex::encode(&fetched.raw));
    Ok(())
}
