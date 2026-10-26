//! Generates (or checks) the fixture transactions.
//!
//! The fixtures are real librustzcash transactions built with TEST-ONLY keys. They
//! are committed, so ordinary test runs only read them. This test rebuilds them and
//! fails if the committed files differ (the builder is deterministic for a fixed
//! seed), so the fixtures cannot silently go stale. Regenerate with:
//!
//! ```text
//! UPDATE_FIXTURES=1 cargo test -p drop-verify --test generate_fixtures -- --ignored
//! ```
//!
//! The check is `#[ignore]`d because rebuilding the proofs takes about a minute; run it
//! with `cargo test -p drop-verify --test generate_fixtures -- --ignored`. Every other
//! test reads the committed files, so a stale fixture would fail those first.

mod support;

use support::builder::{
    generate, generate_with_fee_rate, generate_with_funding_key, nu6_2_height, nu6_3_height,
    PayPool,
};
use support::{fixture_path, to_json};

// covers: REQ-VER-001
#[test]
#[ignore = "slow: rebuilds the Halo2 proofs (about a minute); run with --ignored"]
fn committed_fixtures_are_what_the_generator_builds() {
    let cases = [
        (
            "ironwood_batch_3",
            "Three Ironwood payouts + transparent change, V6, NU6.3 epoch. TEST-ONLY keys.",
            "ironwood",
            generate(PayPool::Ironwood, nu6_3_height(), 3, 42),
        ),
        (
            "ironwood_batch_low_fee",
            "As ironwood_batch_3 but paying 1000 zatoshi per action, as Zebra's mempool minimum allows. TEST-ONLY keys.",
            "ironwood",
            generate_with_fee_rate(PayPool::Ironwood, nu6_3_height(), 3, 42, 1_000),
        ),
        (
            "ironwood_batch_other_funder",
            "As ironwood_batch_3 but funded from a different transparent address (another funding key). TEST-ONLY keys.",
            "ironwood",
            generate_with_funding_key(PayPool::Ironwood, nu6_3_height(), 3, 42, [0x12; 32]),
        ),
        (
            "orchard_batch_old_height",
            "Three Orchard payouts at an NU6.2-epoch height, V5. Valid then, unexpected now. TEST-ONLY keys.",
            "orchard",
            generate(PayPool::Orchard, nu6_2_height(), 3, 42),
        ),
    ];
    let update = std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1");
    for (name, description, pool, generated) in cases {
        let mut fresh =
            serde_json::to_string_pretty(&to_json(description, pool, &generated)).unwrap();
        fresh.push('\n');
        let path = fixture_path(name);
        if update {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &fresh).unwrap();
            continue;
        }
        let stored = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            stored == fresh,
            "{name}.json is stale or missing; regenerate with UPDATE_FIXTURES=1 cargo test -p drop-verify --test generate_fixtures -- --ignored"
        );
    }
}
