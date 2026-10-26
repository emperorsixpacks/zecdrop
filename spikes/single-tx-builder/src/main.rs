//! `cargo run --release` -- prints the spike's results table.
//!
//! TEST ONLY: every key is derived from a public hard-coded seed, the funding UTXO is fabricated,
//! and nothing is broadcast.
//!
//! Optional env:
//! - `SPIKE_NS=2,5,10`        payout counts to measure (default 2,5,10,25,50,100,200)
//! - `SPIKE_ORCHARD_NU6_2=1`  also measure the Orchard pool at a pre-NU6.3 (NU6.2) height

use std::time::Instant;

use single_tx_builder::*;
use zcash_keys::address::Address;
use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkUpgrade, Parameters, TEST_NETWORK};

fn main() {
    println!("=== ZecDrop SPIKE: single-tx transparent -> N shielded payouts (TEST ONLY, offline) ===\n");
    println!(
        "crates: zcash_primitives 0.30.1, zcash_transparent 0.10.0, zcash_keys 0.16.1, zcash_address 0.13.0,\n        \
         zcash_protocol 0.10.6, orchard 0.15.5, zip32 0.2.1, sapling-crypto 0.7.0 (mock provers only),\n        \
         zcash_client_backend 0.24.0 (co-resolves; not called), secp256k1 0.29.1"
    );

    for nu in [NetworkUpgrade::Nu6_2, NetworkUpgrade::Nu6_3] {
        let h = TEST_NETWORK.activation_height(nu).unwrap();
        let branch = BranchId::for_height(&TEST_NETWORK, h);
        println!("testnet {nu:<6} activation {:>9}  branch id 0x{:08x}", u32::from(h), u32::from(branch));
    }
    let nu6_2 = testnet_nu6_2_height();
    let nu6_3 = testnet_nu6_3_height();
    println!("target heights: NU6.2 epoch {} | NU6.3 epoch {}", u32::from(nu6_2), u32::from(nu6_3));

    let campaign = Campaign::test_only();
    println!("\nTEST ONLY campaign keys (testnet, account 0):");
    println!("  funding t-addr : {}", Address::from(campaign.funding_addr).encode(&TEST_NETWORK));
    println!("  change  t-addr : {}", Address::from(campaign.change_addr).encode(&TEST_NETWORK));
    let ufvk = campaign.ufvk_encoded();
    println!("  UFVK (auditor) : {}... ({} chars)", &ufvk[..24], ufvk.len());
    let r0 = Recipient::test_only(0).unified_address;
    println!("  recipient #0 UA: {}... ({} chars, Orchard receiver only)", &r0[..24], r0.len());

    let pk_time = warm_proving_key(nu6_3);
    println!("\nOrchard/Ironwood proving key (post-NU6.3 circuit) built once in {:.2?} (excluded below)", pk_time);

    // --- The pool question --------------------------------------------------------------------
    println!("\n--- Which pool can receive third-party payouts? (N=2) ---");
    warm_proving_key(nu6_2);
    for (label, pool, height) in [
        ("Orchard  @ NU6.3", Pool::Orchard, nu6_3),
        ("Ironwood @ NU6.3", Pool::Ironwood, nu6_3),
        ("Orchard  @ NU6.2", Pool::Orchard, nu6_2),
    ] {
        let spec = BatchSpec { pool, target_height: height, n: 2, ovk: OvkPolicy::Campaign, rng_seed: 1 };
        match build_batch(&campaign, &spec) {
            Ok(b) => {
                let v = public_view(&b.tx_bytes, b.resolver()).unwrap();
                println!(
                    "  {label}: OK    ({} tx, branch {:?}, {} bytes, valueBalanceOrchard {:+}, valueBalanceIronwood {:+})",
                    v.tx_version, v.branch_id, v.size, v.orchard_value_balance, v.ironwood_value_balance
                );
            }
            Err(e) => println!("  {label}: FAILS -> {e}"),
        }
    }
    println!(
        "  A negative valueBalanceOrchard is value ENTERING Orchard: from NU6.3, ZIP-258 forbids it and Zebra \
         rejects it (zebra-consensus/src/transaction/check.rs::orchard_value_balance_non_negative)."
    );

    // --- Negative OVK test ----------------------------------------------------------------------
    let spec = BatchSpec { pool: Pool::Ironwood, target_height: nu6_3, n: 3, ovk: OvkPolicy::None, rng_seed: 2 };
    let b = build_batch(&campaign, &spec).unwrap();
    let auditor = recover_as_auditor(&b.tx_bytes, &ufvk).unwrap();
    let recipient = decrypt_as_recipient(&b.tx_bytes, &b.recipients[0].ivk()).unwrap();
    println!(
        "\nOVK=None (N=3): sender UFVK recovers {} outputs (tried {} candidate OVKs); recipient #0 still decrypts {}",
        auditor.len(),
        candidate_ovks(&campaign.ufvk).len(),
        recipient.len()
    );
    // Also builds and caches the post-NU6.3 verifying key, so the table's verify column excludes it.
    let t = Instant::now();
    verify_authorization(&b.tx_bytes, b.resolver()).expect("valid");
    println!("verifying key built + first verification in {:.2?} (excluded below)", t.elapsed());

    // --- Measurements ---------------------------------------------------------------------------
    let ns: Vec<usize> = std::env::var("SPIKE_NS")
        .ok()
        .map(|s| s.split(',').map(|x| x.trim().parse().unwrap()).collect())
        .unwrap_or_else(|| vec![2, 5, 10, 25, 50, 100, 200]);

    let (a, b_per) = measure(&campaign, Pool::Ironwood, nu6_3, &ns, &ufvk);

    if std::env::var("SPIKE_ORCHARD_NU6_2").is_ok() {
        measure(&campaign, Pool::Orchard, nu6_2, &ns, &ufvk);
    }

    // --- Size limit -----------------------------------------------------------------------------
    // zcashd's IsStandardTx rejects `size >= MAX_STANDARD_TX_SIZE`, so the largest standard tx
    // is 99_999 bytes.
    let limit = STANDARD_TX_SIZE_LIMIT;
    let max_n = (((limit - 1) as f64 - a) / b_per).floor() as usize;
    println!("\nSize model (Ironwood, 1 P2PKH in, 1 P2PKH change): bytes ~= {a:.0} + {b_per:.1} * N  (N >= 2)");
    for n in [max_n, max_n + 1] {
        let spec = BatchSpec { pool: Pool::Ironwood, target_height: nu6_3, n, ovk: OvkPolicy::Campaign, rng_seed: n as u64 };
        let built = build_batch(&campaign, &spec).unwrap();
        println!(
            "  N={n:>3}: {} bytes -> {}",
            built.tx_bytes.len(),
            if built.tx_bytes.len() < limit { "under 100,000" } else { "OVER 100,000" }
        );
    }
    println!("max N per tx under {limit} bytes: {max_n}");
    println!(
        "max N per tx that fits a 2,000,000-byte block (consensus ceiling, ignoring other txs): {}",
        ((2_000_000f64 - a) / b_per).floor() as usize
    );
}

/// Builds one batch per N and prints a row; returns a linear fit (intercept, bytes per payout).
fn measure(campaign: &Campaign, pool: Pool, height: BlockHeight, ns: &[usize], ufvk: &str) -> (f64, f64) {
    println!(
        "\n--- {pool:?} pool, testnet height {} ({:?}) ---",
        u32::from(height),
        BranchId::for_height(&TEST_NETWORK, height)
    );
    println!(
        "{:>4} {:>7} {:>9} {:>11} {:>9} {:>7} {:>9} {:>8} {:>10} {:>10} {:>8}",
        "N", "actions", "tx_bytes", "build+prove", "fee_zat", "logical", "balances", "auth_ok", "verify", "auditor", "recips"
    );
    let mut points = Vec::new();
    for &n in ns {
        let spec = BatchSpec { pool, target_height: height, n, ovk: OvkPolicy::Campaign, rng_seed: n as u64 };
        let b = build_batch(campaign, &spec).unwrap();
        let v = public_view(&b.tx_bytes, b.resolver()).unwrap();

        let t = Instant::now();
        let auth_ok = verify_authorization(&b.tx_bytes, b.resolver()).is_ok();
        let verify_time = t.elapsed();

        let recovered = recover_as_auditor(&b.tx_bytes, ufvk).unwrap();
        let auditor_sum: u64 = recovered.iter().map(|r| r.value).sum();
        let auditor_ok = recovered.len() == n && auditor_sum as i64 == v.net_into_shielded;

        let recipients_ok = b.recipients.iter().enumerate().all(|(i, r)| {
            let got = decrypt_as_recipient(&b.tx_bytes, &r.ivk()).unwrap();
            got.len() == 1 && got[0].value == u64::from(b.payout_values[i])
        });

        let fee_ok = v.fee_implied as u64 == u64::from(b.fee)
            && v.zip317_conventional_fee == u64::from(b.fee)
            && v.fee_paid_lib == Some(u64::from(b.fee));

        println!(
            "{:>4} {:>7} {:>9} {:>10.2}s {:>9} {:>7} {:>9} {:>8} {:>9.2}s {:>10} {:>8}",
            n,
            v.orchard_actions + v.ironwood_actions,
            v.size,
            b.build_time.as_secs_f64(),
            u64::from(b.fee),
            v.zip317_logical_actions,
            if v.balances() && fee_ok { "yes" } else { "NO" },
            if auth_ok { "yes" } else { "NO" },
            verify_time.as_secs_f64(),
            if auditor_ok { "sum=pool" } else { "MISMATCH" },
            if recipients_ok { "all ok" } else { "FAIL" },
        );
        if n >= 2 {
            points.push((n as f64, v.size as f64));
        }
    }
    linear_fit(&points)
}

/// Least-squares line through (N, bytes); the relation is exactly linear for N >= 2.
fn linear_fit(points: &[(f64, f64)]) -> (f64, f64) {
    let n = points.len() as f64;
    let (sx, sy) = points.iter().fold((0.0, 0.0), |(sx, sy), (x, y)| (sx + x, sy + y));
    let (mx, my) = (sx / n, sy / n);
    let (num, den) = points
        .iter()
        .fold((0.0, 0.0), |(num, den), (x, y)| (num + (x - mx) * (y - my), den + (x - mx) * (x - mx)));
    let slope = num / den;
    (my - slope * mx, slope)
}
