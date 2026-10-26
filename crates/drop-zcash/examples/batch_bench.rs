//! What one batch costs to build, for the sizes a payout might have: transaction size, the ZIP-317
//! fee, the time to prove and sign (the Halo2 proof dominates) and the time to verify the result.
//!
//! Offline: TEST ONLY keys and a made-up funding coin, nothing is sent. Prints a Markdown table.
//!
//! Run: `cargo run --release -p drop-zcash --example batch_bench -- [--repeat K] [N ...]` (default sizes:
//! 2 10 50 100 330; default K: 3 for sizes up to 100, 1 above). 330 is the most one transaction may carry
//! (ZIP-218), and takes minutes. Proving uses every core, so the times are only meaningful on a quiet machine:
//! the table shows the best of the K runs and the median.

use std::time::Instant;

use drop_core::FeePolicy;
use drop_zcash::builder::{build_batch_tx, fee_rule, FundingCoin, PayoutLine};
use drop_zcash::{encode_memo, inspect, zcash_network, CampaignKeys};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use zcash_keys::address::Address;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::Script;
use zcash_transparent::bundle::{OutPoint, TxOut};

/// TEST ONLY. Never fund anything derived from it.
const SEED: [u8; 32] = *b"TEST-ONLY zecdrop benchmark seed";

/// The Orchard receiver of a unified address (where an Ironwood payout goes).
fn receiver(network: Network, unified_address: &str) -> orchard::Address {
    match Address::decode(&network, unified_address) {
        Some(Address::Unified(ua)) => *ua.orchard().expect("an Orchard receiver"),
        _ => panic!("not a unified address"),
    }
}

/// The locking script of the campaign's funding address.
fn funding_script(network: Network, keys: &CampaignKeys) -> Script {
    match Address::decode(&network, &keys.funding_address()) {
        Some(Address::Transparent(t)) => Script::from(t.script()),
        _ => panic!("not a transparent address"),
    }
}

struct Row {
    payouts: usize,
    bytes: usize,
    fee: u64,
    build_secs: f64,
    verify_secs: f64,
}

fn measure(payouts: usize) -> Row {
    let network = zcash_network(drop_core::Network::Testnet);
    let keys = CampaignKeys::derive(&SEED, network, 0).expect("keys");
    let lines: Vec<PayoutLine> = (0..payouts)
        .map(|i| {
            let recipient = CampaignKeys::derive(&SEED, network, 1 + i as u32).expect("keys");
            PayoutLine {
                receiver: receiver(network, &recipient.unified_address()),
                value: Zatoshis::from_u64(10_000 + i as u64).expect("amount"),
                memo: encode_memo(Some("benchmark payout")).expect("memo"),
            }
        })
        .collect();
    let paid: u64 = lines.iter().map(|l| u64::from(l.value)).sum();
    // Enough to pay everyone and the fee, with a little change.
    let coin = FundingCoin {
        outpoint: OutPoint::new([0xbe; 32], 0),
        coin: TxOut::new(
            Zatoshis::from_u64(paid + 100 * (payouts as u64 + 2) * 1_000).expect("coin"),
            funding_script(network, &keys),
        ),
    };
    let height = network
        .activation_height(NetworkUpgrade::Nu7)
        .expect("testnet NU7 height")
        + 100;
    let started = Instant::now();
    let built = build_batch_tx(
        &keys,
        BlockHeight::from(u32::from(height)),
        orchard::Anchor::empty_tree(),
        std::slice::from_ref(&coin),
        &lines,
        &fee_rule(&FeePolicy::zip317_text()).expect("fee rule"),
        &mut ChaCha20Rng::seed_from_u64(payouts as u64),
    )
    .expect("build");
    let build_secs = started.elapsed().as_secs_f64();
    let resolve = |op: &OutPoint| (op == &coin.outpoint).then(|| coin.coin.clone());
    let started = Instant::now();
    inspect::verify_proofs_and_signatures(&built.raw, resolve).expect("verify");
    Row {
        payouts,
        bytes: built.raw.len(),
        fee: u64::from(built.fee),
        build_secs,
        verify_secs: started.elapsed().as_secs_f64(),
    }
}

fn median(sorted: &[f64]) -> f64 {
    sorted[sorted.len() / 2]
}

fn main() {
    let mut repeat: Option<usize> = None;
    let mut sizes: Vec<usize> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--repeat" {
            repeat = Some(
                args.next()
                    .and_then(|v| v.parse().ok())
                    .expect("--repeat needs a number"),
            );
        } else {
            sizes.push(arg.parse().expect("each size is a number of payouts"));
        }
    }
    if sizes.is_empty() {
        sizes = vec![2, 10, 50, 100, 330];
    }
    // The first verification builds the Halo2 verifying key, once; do it before timing anything.
    eprintln!("warming up (verifying key)...");
    let _ = measure(2);

    println!(
        "| Payouts | Transaction size | Fee (zat, 5,000 per action) | Prove and sign, best | median | Verify | Runs |"
    );
    println!("|---:|---:|---:|---:|---:|---:|---:|");
    for n in sizes {
        let runs = repeat.unwrap_or(if n <= 100 { 3 } else { 1 });
        eprintln!("{n} payouts, {runs} run(s)...");
        let rows: Vec<Row> = (0..runs).map(|_| measure(n)).collect();
        let mut builds: Vec<f64> = rows.iter().map(|r| r.build_secs).collect();
        builds.sort_by(f64::total_cmp);
        let mut verifies: Vec<f64> = rows.iter().map(|r| r.verify_secs).collect();
        verifies.sort_by(f64::total_cmp);
        let first = &rows[0];
        println!(
            "| {} | {:.1} KB | {} | {:.1} s | {:.1} s | {:.2} s | {} |",
            first.payouts,
            first.bytes as f64 / 1000.0,
            first.fee,
            builds[0],
            median(&builds),
            median(&verifies),
            runs
        );
    }
    eprintln!(
        "threads available: {}",
        std::thread::available_parallelism().map_or(0, usize::from)
    );
}
