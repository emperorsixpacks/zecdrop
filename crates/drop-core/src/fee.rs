//! ZIP-317 conventional fee for a batch transaction (REQ-PLAN-002).
//!
//! ```text
//! logical_actions = max(ceil(transparent_input_bytes  / 150),
//!                       ceil(transparent_output_bytes /  34))
//!                 + shielded_actions
//! fee             = marginal_fee * max(grace_actions, logical_actions)    zatoshi
//! ```
//!
//! `marginal_fee` and `grace_actions` come from a caller-supplied [`FeePolicy`],
//! not from constants: the ZIP-317 text says 5000 and 2 ([`FeePolicy::zip317_text`]),
//! while Zebra's mempool code uses a marginal fee of 1000 ([`FeePolicy::zebra_main`]).
//! This crate does not decide which applies on a network; that is the chain
//! adapter's job.
//!
//! **Which policy to default to.** A node accepts a fee at or above its own minimum
//! and rejects a lower one. Paying more than needed only wastes a little ZEC, while
//! paying less strands the batch, so callers should default to the higher value
//! unless they know the node's policy.
//!
//! A standard P2PKH input is 150 bytes and a standard P2PKH output 34 bytes, so for
//! standard scripts the transparent term is simply `max(inputs, outputs)`.
//!
//! A batch has no Sapling or Sprout parts. Its shielded bundle (Ironwood or
//! Orchard, which count the same) has no real spends, so it has one action per
//! output, and the builder pads a bundle to at least two actions:
//! `shielded_actions(n) = max(n, 2)` for `n > 0`.
//!
//! The usual batch spends one transparent input and (at most) returns change to
//! one transparent output; see [`standard_batch_fee`].

use serde::{Deserialize, Serialize};

use crate::amount::Zatoshi;
use crate::error::AmountError;

/// Marginal fee per logical action stated in the ZIP-317 text, in zatoshi.
const ZIP317_TEXT_MARGINAL_FEE: u64 = 5_000;

/// Marginal fee per logical action used by Zebra's mempool code, in zatoshi.
const ZEBRA_MAIN_MARGINAL_FEE: u64 = 1_000;

/// Grace actions in both known policies.
const DEFAULT_GRACE_ACTIONS: u32 = 2;

/// Size of a standard P2PKH transparent input, in bytes.
pub const P2PKH_STANDARD_INPUT_SIZE: u64 = 150;

/// Size of a standard P2PKH transparent output, in bytes.
pub const P2PKH_STANDARD_OUTPUT_SIZE: u64 = 34;

/// Minimum number of actions in a non-empty shielded bundle (the builder pads to this).
pub const MIN_SHIELDED_ACTIONS: u32 = 2;

/// The two numbers a ZIP-317 fee depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeePolicy {
    /// Zatoshi charged per logical action.
    pub marginal_fee: u64,
    /// The fee never covers fewer than this many actions.
    pub grace_actions: u32,
}

impl FeePolicy {
    /// A custom policy.
    pub const fn new(marginal_fee: u64, grace_actions: u32) -> Self {
        FeePolicy {
            marginal_fee,
            grace_actions,
        }
    }

    /// The values written in the ZIP-317 text: 5000 zatoshi per action, 2 grace actions.
    pub const fn zip317_text() -> Self {
        FeePolicy::new(ZIP317_TEXT_MARGINAL_FEE, DEFAULT_GRACE_ACTIONS)
    }

    /// The values Zebra's main branch uses: 1000 zatoshi per action, 2 grace actions.
    pub const fn zebra_main() -> Self {
        FeePolicy::new(ZEBRA_MAIN_MARGINAL_FEE, DEFAULT_GRACE_ACTIONS)
    }
}

impl Default for FeePolicy {
    /// The higher of the two known policies, [`FeePolicy::zip317_text`], following
    /// the module advice to overpay rather than risk an underpaid batch.
    fn default() -> Self {
        FeePolicy::zip317_text()
    }
}

/// Number of shielded (Ironwood or Orchard) actions for a bundle with `n_outputs`
/// outputs and no spends.
pub fn shielded_actions(n_outputs: u32) -> u32 {
    if n_outputs == 0 {
        0
    } else {
        n_outputs.max(MIN_SHIELDED_ACTIONS)
    }
}

/// ZIP-317 logical actions for standard P2PKH transparent parts plus a shielded
/// bundle of `n_shielded_outputs` outputs and no spends.
pub fn logical_actions(n_shielded_outputs: u32, n_t_inputs: u32, n_t_outputs: u32) -> u64 {
    let input_bytes = u64::from(n_t_inputs) * P2PKH_STANDARD_INPUT_SIZE;
    let output_bytes = u64::from(n_t_outputs) * P2PKH_STANDARD_OUTPUT_SIZE;
    let transparent = input_bytes
        .div_ceil(P2PKH_STANDARD_INPUT_SIZE)
        .max(output_bytes.div_ceil(P2PKH_STANDARD_OUTPUT_SIZE));
    transparent + u64::from(shielded_actions(n_shielded_outputs))
}

/// The fee under `policy` for a transaction with `n_outputs` shielded outputs,
/// `n_t_inputs` transparent inputs and `n_t_outputs` transparent outputs.
///
/// Errors only if the result would exceed the maximum supply, which cannot happen
/// with the known policies and realistic counts but can with an absurd custom policy.
pub fn batch_fee(
    policy: &FeePolicy,
    n_outputs: u32,
    n_t_inputs: u32,
    n_t_outputs: u32,
) -> Result<Zatoshi, AmountError> {
    let actions =
        logical_actions(n_outputs, n_t_inputs, n_t_outputs).max(u64::from(policy.grace_actions));
    policy
        .marginal_fee
        .checked_mul(actions)
        .ok_or(AmountError::ExceedsMaxMoney)
        .and_then(Zatoshi::new)
}

/// The fee for the standard batch shape: `n_outputs` shielded outputs funded by one
/// transparent input, with one transparent change output.
pub fn standard_batch_fee(policy: &FeePolicy, n_outputs: u32) -> Result<Zatoshi, AmountError> {
    batch_fee(policy, n_outputs, 1, 1)
}

/// The transparent value a batch needs: what enters the pool plus the fee.
pub fn batch_funding_required(batch_total: Zatoshi, fee: Zatoshi) -> Result<Zatoshi, AmountError> {
    batch_total.checked_add(fee)
}

/// [`batch_funding_required`] for the standard batch shape under `policy`.
pub fn standard_funding_required(
    policy: &FeePolicy,
    batch_total: Zatoshi,
    n_outputs: u32,
) -> Result<Zatoshi, AmountError> {
    batch_funding_required(batch_total, standard_batch_fee(policy, n_outputs)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// (shielded outputs, transparent inputs, transparent outputs) and the expected
    /// (logical actions, fee under the ZIP-317 text, fee under Zebra main).
    type Vector = ((u32, u32, u32), (u64, u64, u64));

    const VECTORS: [Vector; 12] = [
        // Nothing at all still pays the two grace actions.
        ((0, 0, 0), (0, 10_000, 2_000)),
        // Shielded-only: one output pads to two actions, which equals the grace minimum.
        ((1, 0, 0), (2, 10_000, 2_000)),
        ((2, 0, 0), (2, 10_000, 2_000)),
        // A transparent leg alone is below the grace minimum.
        ((0, 1, 1), (1, 10_000, 2_000)),
        // Standard batch shape: 1 transparent input + 1 change output.
        ((1, 1, 1), (3, 15_000, 3_000)),
        ((2, 1, 1), (3, 15_000, 3_000)),
        ((3, 1, 1), (4, 20_000, 4_000)),
        ((10, 1, 1), (11, 55_000, 11_000)),
        ((100, 1, 1), (101, 505_000, 101_000)),
        // Transparent term is max(inputs, outputs), not the sum.
        ((2, 3, 1), (5, 25_000, 5_000)),
        ((2, 1, 4), (6, 30_000, 6_000)),
        ((0, 4, 4), (4, 20_000, 4_000)),
    ];

    // covers: REQ-PLAN-002
    #[test]
    fn named_policies_have_the_documented_values() {
        assert_eq!(FeePolicy::zip317_text(), FeePolicy::new(5_000, 2));
        assert_eq!(FeePolicy::zebra_main(), FeePolicy::new(1_000, 2));
        assert_eq!(FeePolicy::default(), FeePolicy::zip317_text());
    }

    // covers: REQ-PLAN-002
    #[test]
    fn fee_test_vectors_under_the_zip317_text_policy() {
        let policy = FeePolicy::zip317_text();
        for ((n_out, n_in, n_t_out), (actions, fee, _)) in VECTORS {
            assert_eq!(
                logical_actions(n_out, n_in, n_t_out),
                actions,
                "actions for {n_out}/{n_in}/{n_t_out}"
            );
            assert_eq!(
                batch_fee(&policy, n_out, n_in, n_t_out).unwrap().as_u64(),
                fee,
                "fee for {n_out}/{n_in}/{n_t_out}"
            );
        }
    }

    // covers: REQ-PLAN-002
    #[test]
    fn fee_test_vectors_under_the_zebra_main_policy() {
        let policy = FeePolicy::zebra_main();
        for ((n_out, n_in, n_t_out), (actions, _, fee)) in VECTORS {
            assert_eq!(
                logical_actions(n_out, n_in, n_t_out),
                actions,
                "actions for {n_out}/{n_in}/{n_t_out}"
            );
            assert_eq!(
                batch_fee(&policy, n_out, n_in, n_t_out).unwrap().as_u64(),
                fee,
                "fee for {n_out}/{n_in}/{n_t_out}"
            );
        }
    }

    // covers: REQ-PLAN-002
    #[test]
    fn grace_actions_come_from_the_policy() {
        let strict = FeePolicy::new(1_000, 4);
        // 3 logical actions are below the 4 grace actions.
        assert_eq!(batch_fee(&strict, 1, 1, 1).unwrap().as_u64(), 4_000);
        // 5 logical actions are above it.
        assert_eq!(batch_fee(&strict, 4, 1, 1).unwrap().as_u64(), 5_000);
        let lax = FeePolicy::new(1_000, 0);
        assert_eq!(batch_fee(&lax, 0, 0, 0).unwrap().as_u64(), 0);
        assert_eq!(batch_fee(&lax, 1, 0, 0).unwrap().as_u64(), 2_000);
    }

    // covers: REQ-PLAN-002
    #[test]
    fn shielded_bundles_pad_to_two_actions() {
        assert_eq!(shielded_actions(0), 0);
        assert_eq!(shielded_actions(1), 2);
        assert_eq!(shielded_actions(2), 2);
        assert_eq!(shielded_actions(3), 3);
        assert_eq!(shielded_actions(100), 100);
    }

    // covers: REQ-PLAN-002
    #[test]
    fn standard_batch_fee_is_one_in_one_change() {
        let text = FeePolicy::zip317_text();
        let zebra = FeePolicy::zebra_main();
        assert_eq!(standard_batch_fee(&text, 1).unwrap().as_u64(), 15_000);
        assert_eq!(standard_batch_fee(&text, 10).unwrap().as_u64(), 55_000);
        assert_eq!(standard_batch_fee(&text, 100).unwrap().as_u64(), 505_000);
        assert_eq!(standard_batch_fee(&zebra, 10).unwrap().as_u64(), 11_000);
        assert_eq!(standard_batch_fee(&text, 10), batch_fee(&text, 10, 1, 1));
        // The higher policy never charges less than the lower one.
        for n in 0..50 {
            assert!(
                standard_batch_fee(&text, n).unwrap() >= standard_batch_fee(&zebra, n).unwrap()
            );
        }
    }

    // covers: REQ-PLAN-002
    #[test]
    fn fee_never_overflows_at_the_u32_extremes_under_known_policies() {
        for policy in [FeePolicy::zip317_text(), FeePolicy::zebra_main()] {
            let fee = batch_fee(&policy, u32::MAX, u32::MAX, u32::MAX).unwrap();
            assert_eq!(fee.as_u64(), policy.marginal_fee * u64::from(u32::MAX) * 2);
        }
    }

    // covers: REQ-PLAN-002
    #[test]
    fn an_absurd_policy_is_an_error_not_a_wrap() {
        let absurd = FeePolicy::new(u64::MAX, 2);
        assert_eq!(
            batch_fee(&absurd, 10, 1, 1),
            Err(AmountError::ExceedsMaxMoney)
        );
        // Not a u64 overflow, but still above the maximum supply.
        let huge = FeePolicy::new(crate::amount::MAX_MONEY, 2);
        assert_eq!(batch_fee(&huge, 1, 1, 1), Err(AmountError::ExceedsMaxMoney));
    }

    // covers: REQ-PLAN-002
    #[test]
    fn funding_required_is_total_plus_fee_and_checked() {
        let total = Zatoshi::new(1_000_000).unwrap();
        let text = FeePolicy::zip317_text();
        let fee = standard_batch_fee(&text, 10).unwrap();
        assert_eq!(
            batch_funding_required(total, fee).unwrap().as_u64(),
            1_055_000
        );
        assert_eq!(
            standard_funding_required(&text, total, 10)
                .unwrap()
                .as_u64(),
            1_055_000
        );
        assert_eq!(
            standard_funding_required(&FeePolicy::zebra_main(), total, 10)
                .unwrap()
                .as_u64(),
            1_011_000
        );
        assert_eq!(
            batch_funding_required(Zatoshi::MAX, fee),
            Err(AmountError::ExceedsMaxMoney)
        );
        assert_eq!(
            standard_funding_required(&text, Zatoshi::MAX, 10),
            Err(AmountError::ExceedsMaxMoney)
        );
    }

    // covers: REQ-PLAN-002
    #[test]
    fn policy_serializes_with_plain_numbers() {
        let json = serde_json::to_string(&FeePolicy::zebra_main()).unwrap();
        assert_eq!(json, r#"{"marginal_fee":1000,"grace_actions":2}"#);
        assert_eq!(
            serde_json::from_str::<FeePolicy>(&json).unwrap(),
            FeePolicy::zebra_main()
        );
    }

    proptest! {
        // covers: REQ-PLAN-002
        #[test]
        fn fee_is_marginal_times_max_grace_and_actions(
            n_out in 0u32..2_000,
            n_in in 0u32..50,
            n_t_out in 0u32..50,
            marginal in 0u64..100_000,
            grace in 0u32..10,
        ) {
            let policy = FeePolicy::new(marginal, grace);
            let actions = logical_actions(n_out, n_in, n_t_out);
            let expected = marginal * actions.max(u64::from(grace));
            prop_assert_eq!(batch_fee(&policy, n_out, n_in, n_t_out).unwrap().as_u64(), expected);
            // Adding an output never lowers the fee.
            prop_assert!(
                batch_fee(&policy, n_out + 1, n_in, n_t_out).unwrap()
                    >= batch_fee(&policy, n_out, n_in, n_t_out).unwrap()
            );
        }
    }
}
