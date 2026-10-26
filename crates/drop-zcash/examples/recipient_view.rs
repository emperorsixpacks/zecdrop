//! "The recipient sees their money" for the demo, on TESTNET, where released wallets cannot sync
//! (they predate NU7). Fetches a batch through drop-chain, decrypts it with demo recipient `n`'s
//! incoming viewing key, and shows what that recipient can and cannot see.
//!
//! Never prints the seed or any key.
//!
//! Run: `cargo run -p drop-zcash --example recipient_view -- <n: 1-8> <txid> [endpoint]`

mod support;

use std::collections::HashMap;

use drop_chain::{ChainConfig, LightwalletdSource};
use drop_core::{Network, Txid, Zatoshi};
use drop_verify::ChainSource;
use drop_zcash::{inspect, zcash_network, CampaignKeys};
use orchard::keys::Scope;
use support::{demo_account, load_dev_seed, DEMO_AMOUNTS};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;
use zcash_transparent::bundle::{OutPoint, TxOut};

const DEFAULT_ENDPOINT: &str = "https://testnet.zec.rocks:443";

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn zec(zat: u64) -> String {
    Zatoshi::new(zat)
        .map(|z| z.to_string())
        .unwrap_or_else(|_| format!("{zat} zat"))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: recipient_view <n: 1-8> <txid> [endpoint]";
    let n: u32 = args.first().and_then(|a| a.parse().ok()).ok_or(usage)?;
    if !(1..=DEMO_AMOUNTS.len() as u32).contains(&n) {
        return Err(usage.into());
    }
    let txid: Txid = args
        .get(1)
        .ok_or(usage)?
        .parse()
        .map_err(|_| "txid must be 64 hex chars")?;
    let endpoint = args.get(2).map_or(DEFAULT_ENDPOINT, String::as_str);

    // Recipient n's incoming viewing key; the seed is dropped right after.
    let ivk = {
        let seed = load_dev_seed()?;
        let keys = CampaignKeys::derive(
            seed.as_bytes(),
            zcash_network(Network::Testnet),
            demo_account(n),
        )
        .map_err(|e| e.to_string())?;
        keys.ufvk()
            .orchard()
            .ok_or("no Orchard key")?
            .to_ivk(Scope::External)
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let (raw, mined, prevouts) = runtime.block_on(async {
        let config = ChainConfig::new(endpoint, Network::Testnet);
        let (source, _) = LightwalletdSource::connect(&config)
            .await
            .map_err(|e| e.to_string())?;
        let fetched = source
            .transaction(&txid)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the server does not know this transaction")?;
        // Resolve the spent transparent coins, so the public total can be shown too.
        let tx = Transaction::read(fetched.raw.as_slice(), BranchId::Nu6_3)
            .map_err(|e| e.to_string())?;
        let mut prevouts: HashMap<OutPoint, TxOut> = HashMap::new();
        for txin in tx
            .transparent_bundle()
            .map(|b| b.vin.as_slice())
            .unwrap_or_default()
        {
            let mut display = *txin.prevout().hash();
            display.reverse();
            if let Ok(Some(prev)) = source.transaction(&Txid::from_bytes(display)).await {
                if let Ok(prev) = Transaction::read(prev.raw.as_slice(), BranchId::Nu6_3) {
                    if let Some(out) = prev
                        .transparent_bundle()
                        .and_then(|b| b.vout.get(txin.prevout().n() as usize))
                    {
                        prevouts.insert(txin.prevout().clone(), out.clone());
                    }
                }
            }
        }
        Ok::<_, String>((fetched.raw, fetched.mined_height, prevouts))
    })?;

    let mine = inspect::decrypt_with_ivk(&raw, &ivk).map_err(|e| e.to_string())?;
    let status = mined.map_or("in the mempool".to_string(), |h| {
        format!("mined at height {h}")
    });
    println!("Demo recipient {n} (testnet), transaction {txid} ({status})\n");

    println!("What you received (decrypted with your own incoming viewing key):");
    if mine.is_empty() {
        println!("  nothing: no output in this transaction is addressed to you");
    }
    for out in &mine {
        println!(
            "  {} TAZ  memo: {:?}",
            zec(out.value),
            out.memo.as_deref().unwrap_or("")
        );
    }

    let public = inspect::public_totals(&raw, |op| prevouts.get(op).cloned()).ok();
    println!("\nWhat anyone can see (no keys):");
    match &public {
        Some(p) => println!(
            "  {} TAZ entered the Ironwood pool in {} outputs; fee {} TAZ; change {} TAZ",
            zec(p.net_into_ironwood as u64),
            p.ironwood_actions,
            zec(p.fee as u64),
            zec(p.t_out_total)
        ),
        None => println!(
            "  (the funding transaction could not be fetched, so the public total is not shown)"
        ),
    }

    let actions = public
        .as_ref()
        .map_or_else(|| shielded_actions(&raw), |p| p.ironwood_actions);
    println!("\nWhat you cannot see:");
    println!(
        "  the other {} outputs: their amounts, recipients and memos are encrypted, and your key opens none of them",
        actions.saturating_sub(mine.len())
    );
    Ok(())
}

fn shielded_actions(raw: &[u8]) -> usize {
    Transaction::read(raw, BranchId::Nu6_3)
        .map(|tx| tx.ironwood_bundle().map_or(0, |b| b.actions().len()))
        .unwrap_or(0)
}
