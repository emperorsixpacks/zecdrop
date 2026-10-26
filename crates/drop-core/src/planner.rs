//! Batch planning (REQ-PLAN-001, REQ-PLAN-003).
//!
//! Each batch becomes one transaction. The public net value entering the shielded
//! pool for a batch equals the sum of its outputs, so a batch holding a single
//! recipient would publish that recipient's exact amount. The planner therefore
//! never emits a one-recipient batch unless the whole campaign has one recipient.

use std::fmt;

use crate::amount::Zatoshi;
use crate::error::PlanError;
use crate::recipient::{total_amount, Recipient};

/// One transaction's worth of recipients, in input order.
///
/// A batch holds recipient data, so its `Debug` output shows only the index, the
/// number of outputs and the total (REQ-PRIV-002).
#[derive(Clone, PartialEq, Eq)]
pub struct Batch {
    index: u32,
    recipients: Vec<Recipient>,
    total: Zatoshi,
}

impl Batch {
    /// Position of this batch in the plan, starting at 0.
    pub fn index(&self) -> u32 {
        self.index
    }

    /// The recipients paid by this batch, in input order.
    pub fn recipients(&self) -> &[Recipient] {
        &self.recipients
    }

    /// Number of recipients (and Orchard outputs) in this batch.
    pub fn len(&self) -> usize {
        self.recipients.len()
    }

    /// Whether the batch has no recipients. Planned batches never do.
    pub fn is_empty(&self) -> bool {
        self.recipients.is_empty()
    }

    /// Sum of the batch's amounts: the value that enters the shielded pool.
    pub fn total(&self) -> Zatoshi {
        self.total
    }

    /// Number of outputs as `u32`, saturating (a batch never gets near that size).
    pub fn output_count(&self) -> u32 {
        u32::try_from(self.recipients.len()).unwrap_or(u32::MAX)
    }
}

impl fmt::Debug for Batch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Batch{{index: {}, outputs: {}, total: {}}}",
            self.index,
            self.recipients.len(),
            self.total.as_u64()
        )
    }
}

/// Sum of all batch totals, with checked arithmetic.
pub fn campaign_total(batches: &[Batch]) -> Result<Zatoshi, crate::error::AmountError> {
    Zatoshi::checked_sum(batches.iter().map(Batch::total))
}

/// Splits `rows` into ordered batches of at most `max_outputs_per_batch` recipients.
///
/// * every recipient lands in exactly one batch, in input order;
/// * the result depends only on the inputs (no randomness, no clock);
/// * batch totals add up to the campaign total, which must not exceed the maximum supply;
/// * batches are filled to the maximum in order. If that would leave a final
///   batch of one recipient, one recipient moves back from the previous batch so
///   the last two batches hold `max - 1` and `2`.
///
/// Errors: a zero maximum, no recipients, a total above the maximum supply, or a
/// campaign that cannot be split without a one-recipient batch (a maximum of 1,
/// or a maximum of 2 with an odd number of recipients).
pub fn plan_batches(
    rows: &[Recipient],
    max_outputs_per_batch: usize,
) -> Result<Vec<Batch>, PlanError> {
    if max_outputs_per_batch == 0 {
        return Err(PlanError::ZeroBatchSize);
    }
    if rows.is_empty() {
        return Err(PlanError::NoRecipients);
    }
    total_amount(rows)?;

    let sizes = batch_sizes(rows.len(), max_outputs_per_batch)?;
    let mut batches = Vec::with_capacity(sizes.len());
    let mut rest = rows;
    for (index, size) in sizes.into_iter().enumerate() {
        let (chunk, tail) = rest.split_at(size);
        rest = tail;
        batches.push(Batch {
            index: u32::try_from(index).map_err(|_| PlanError::TooManyBatches)?,
            total: total_amount(chunk)?,
            recipients: chunk.to_vec(),
        });
    }
    Ok(batches)
}

/// Chooses how many recipients go in each batch.
fn batch_sizes(recipients: usize, max: usize) -> Result<Vec<usize>, PlanError> {
    let mut sizes = vec![max; recipients / max];
    if !recipients.is_multiple_of(max) {
        sizes.push(recipients % max);
    }
    if recipients > 1 && sizes.last() == Some(&1) {
        let unavoidable = PlanError::SingletonUnavoidable {
            recipients,
            max_outputs_per_batch: max,
        };
        // Borrow one recipient from the previous batch; that needs it to keep at least two.
        let previous = sizes.len().checked_sub(2).ok_or(unavoidable)?;
        match sizes.get_mut(previous) {
            Some(size) if *size >= 3 => *size -= 1,
            _ => return Err(unavoidable),
        }
        if let Some(last) = sizes.last_mut() {
            *last += 1;
        }
    }
    Ok(sizes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn rows(amounts: &[u64]) -> Vec<Recipient> {
        amounts
            .iter()
            .enumerate()
            .map(|(i, a)| {
                Recipient::new(format!("u1row{i:06}"), Zatoshi::new(*a).unwrap(), None).unwrap()
            })
            .collect()
    }

    fn sizes(batches: &[Batch]) -> Vec<usize> {
        batches.iter().map(Batch::len).collect()
    }

    /// Whether any valid split exists for `n` recipients under `max`.
    fn splittable(n: usize, max: usize) -> bool {
        n == 1 || (max >= 3) || (max == 2 && n.is_multiple_of(2))
    }

    // covers: REQ-PLAN-001
    #[test]
    fn rejects_zero_batch_size_and_empty_input() {
        let r = rows(&[1, 2, 3]);
        assert_eq!(plan_batches(&r, 0), Err(PlanError::ZeroBatchSize));
        assert_eq!(plan_batches(&[], 5), Err(PlanError::NoRecipients));
        // Zero is reported before emptiness.
        assert_eq!(plan_batches(&[], 0), Err(PlanError::ZeroBatchSize));
    }

    // covers: REQ-PLAN-001
    #[test]
    fn rejects_campaign_total_above_max_money() {
        let big = Zatoshi::MAX;
        let r = vec![
            Recipient::new("u1a0000000000000", big, None).unwrap(),
            Recipient::new("u1b0000000000000", Zatoshi::new(1).unwrap(), None).unwrap(),
        ];
        assert_eq!(
            plan_batches(&r, 10),
            Err(PlanError::Amount(
                crate::error::AmountError::ExceedsMaxMoney
            ))
        );
    }

    // covers: REQ-PLAN-001
    #[test]
    fn splits_in_order_with_per_batch_totals() {
        let r = rows(&[10, 20, 30, 40, 50, 60, 70]);
        let batches = plan_batches(&r, 3).unwrap();
        // 3 + 3 + 1 would end in a single, so the tail is rebalanced to 3 + 2 + 2.
        assert_eq!(sizes(&batches), vec![3, 2, 2]);
        assert_eq!(
            batches
                .iter()
                .map(|b| b.total().as_u64())
                .collect::<Vec<_>>(),
            vec![60, 90, 130]
        );
        assert_eq!(
            batches.iter().map(Batch::index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        let flat: Vec<&Recipient> = batches.iter().flat_map(|b| b.recipients()).collect();
        assert_eq!(flat, r.iter().collect::<Vec<_>>());
    }

    // covers: REQ-PLAN-001
    #[test]
    fn exact_multiples_and_single_batch() {
        let r = rows(&[1; 6]);
        assert_eq!(sizes(&plan_batches(&r, 3).unwrap()), vec![3, 3]);
        assert_eq!(sizes(&plan_batches(&r, 6).unwrap()), vec![6]);
        assert_eq!(sizes(&plan_batches(&r, 100).unwrap()), vec![6]);
    }

    // covers: REQ-PLAN-001
    #[test]
    fn planning_is_deterministic() {
        let r = rows(&[5, 6, 7, 8, 9, 10, 11, 12, 13]);
        assert_eq!(plan_batches(&r, 4).unwrap(), plan_batches(&r, 4).unwrap());
    }

    // covers: REQ-PLAN-003
    #[test]
    fn never_emits_a_singleton_batch_unless_campaign_has_one_recipient() {
        // One recipient: the only case a singleton is allowed.
        assert_eq!(sizes(&plan_batches(&rows(&[5]), 10).unwrap()), vec![1]);
        assert_eq!(sizes(&plan_batches(&rows(&[5]), 1).unwrap()), vec![1]);
        // 4 recipients with max 3 would be [3, 1]; rebalanced to [2, 2].
        assert_eq!(sizes(&plan_batches(&rows(&[1; 4]), 3).unwrap()), vec![2, 2]);
        // 11 with max 5 would be [5, 5, 1]; rebalanced to [5, 4, 2].
        assert_eq!(
            sizes(&plan_batches(&rows(&[1; 11]), 5).unwrap()),
            vec![5, 4, 2]
        );
        // Even counts with max 2 pair up.
        assert_eq!(
            sizes(&plan_batches(&rows(&[1; 6]), 2).unwrap()),
            vec![2, 2, 2]
        );
    }

    // covers: REQ-PLAN-003
    #[test]
    fn edge_cases_two_and_three_recipients_and_small_maximums() {
        // total 2: one batch of two when the maximum allows it.
        assert_eq!(sizes(&plan_batches(&rows(&[1; 2]), 2).unwrap()), vec![2]);
        assert_eq!(sizes(&plan_batches(&rows(&[1; 2]), 50).unwrap()), vec![2]);
        // total 3: max 3 and above give one batch; max 2 has no singleton-free split.
        assert_eq!(sizes(&plan_batches(&rows(&[1; 3]), 3).unwrap()), vec![3]);
        assert_eq!(sizes(&plan_batches(&rows(&[1; 3]), 50).unwrap()), vec![3]);
        assert!(matches!(
            plan_batches(&rows(&[1; 3]), 2),
            Err(PlanError::SingletonUnavoidable { .. })
        ));
        // max larger than the whole campaign.
        assert_eq!(sizes(&plan_batches(&rows(&[1; 7]), 1000).unwrap()), vec![7]);
        // max 1 cannot satisfy two or more recipients.
        assert!(matches!(
            plan_batches(&rows(&[1; 2]), 1),
            Err(PlanError::SingletonUnavoidable { .. })
        ));
        // A single recipient is the one allowed singleton, even at max 1.
        assert_eq!(sizes(&plan_batches(&rows(&[1]), 1).unwrap()), vec![1]);
    }

    // covers: REQ-PLAN-003
    #[test]
    fn reports_when_no_split_avoids_a_singleton() {
        for (n, max) in [(2, 1), (3, 1), (3, 2), (5, 2), (7, 2)] {
            assert_eq!(
                plan_batches(&rows(&vec![1; n]), max),
                Err(PlanError::SingletonUnavoidable {
                    recipients: n,
                    max_outputs_per_batch: max
                }),
                "n={n} max={max}"
            );
        }
    }

    // covers: REQ-PRIV-002
    #[test]
    fn batch_debug_shows_index_count_and_total_only() {
        let r = vec![
            Recipient::new(
                "u1sentinelbatchaddress000000",
                Zatoshi::new(3_333_007).unwrap(),
                Some("sentinel-batch-memo".into()),
            )
            .unwrap(),
            Recipient::new(
                "u1sentinelbatchaddress111111",
                Zatoshi::new(7_777_001).unwrap(),
                None,
            )
            .unwrap(),
        ];
        let batches = plan_batches(&r, 10).unwrap();
        let text = format!("{:?} {:#?}", batches, batches[0]);
        assert!(
            text.contains("index: 0") && text.contains("outputs: 2"),
            "{text}"
        );
        for needle in ["sentinelbatch", "3333007", "7777001", "sentinel-batch-memo"] {
            // The batch total (11110008) is allowed; individual amounts are not.
            assert!(!text.contains(needle), "{needle} leaked: {text}");
        }
    }

    proptest! {
        // covers: REQ-PLAN-001, REQ-PLAN-003
        #[test]
        fn partition_properties(
            amounts in proptest::collection::vec(1u64..1_000_000_000, 1..120),
            max in 1usize..30,
        ) {
            let r = rows(&amounts);
            let n = r.len();
            let plan = plan_batches(&r, max);
            if !splittable(n, max) {
                prop_assert_eq!(
                    plan,
                    Err(PlanError::SingletonUnavoidable { recipients: n, max_outputs_per_batch: max })
                );
                return Ok(());
            }
            let batches = plan.unwrap();

            // Every row in exactly one batch, input order preserved.
            let flat: Vec<Recipient> =
                batches.iter().flat_map(|b| b.recipients().iter().cloned()).collect();
            prop_assert_eq!(&flat, &r);

            // Each batch within the maximum and non-empty; indices are 0..k.
            for (i, b) in batches.iter().enumerate() {
                prop_assert!(!b.is_empty() && b.len() <= max);
                prop_assert_eq!(b.index() as usize, i);
                // Batch total equals the sum of its own rows.
                let own: u64 = b.recipients().iter().map(|x| x.amount().as_u64()).sum();
                prop_assert_eq!(b.total().as_u64(), own);
                // No singleton unless the campaign is a single recipient.
                if n > 1 { prop_assert!(b.len() >= 2); }
            }

            // Batch totals sum to the campaign total.
            let expected: u64 = amounts.iter().sum();
            prop_assert_eq!(campaign_total(&batches).unwrap().as_u64(), expected);

            // Minimal number of batches, and deterministic.
            prop_assert_eq!(batches.len(), n.div_ceil(max));
            prop_assert_eq!(plan_batches(&r, max).unwrap(), batches);
        }
    }
}
