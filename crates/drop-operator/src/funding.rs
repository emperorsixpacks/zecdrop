//! Turning a campaign's plan into funding requirements, and a single observed
//! deposit into the one-input-per-batch references the engine needs.
//!
//! The engine spends one funding input per batch. For the mock chain the
//! operator assumes the observed deposit is a run of consecutive outputs
//! `vout, vout+1, ...`, one per batch, each worth that batch's total plus fee.
//! A real adapter may arrange its inputs differently; this module is the single
//! place that mapping lives.

use drop_core::{
    standard_batch_fee, standard_funding_required, AmountError, Batch, FeePolicy, FundingRef,
    OutPoint, Zatoshi,
};

use crate::chain::FundingLayout;
use crate::store::FundingObserved;

/// What a plan costs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundingPlan {
    /// ZIP-317 fee of each batch.
    pub fees: Vec<Zatoshi>,
    /// Total plus fee of each batch.
    pub per_batch: Vec<Zatoshi>,
    /// Sum of the batch totals.
    pub declared_total: Zatoshi,
    /// Sum of the fees.
    pub fee_total: Zatoshi,
    /// Everything the deposit must cover.
    pub required: Zatoshi,
}

/// Computes the funding a set of batches needs under `policy`.
pub fn funding_plan(batches: &[Batch], policy: &FeePolicy) -> Result<FundingPlan, AmountError> {
    let mut fees = Vec::with_capacity(batches.len());
    let mut per_batch = Vec::with_capacity(batches.len());
    for batch in batches {
        fees.push(standard_batch_fee(policy, batch.output_count())?);
        per_batch.push(standard_funding_required(
            policy,
            batch.total(),
            batch.output_count(),
        )?);
    }
    Ok(FundingPlan {
        declared_total: Zatoshi::checked_sum(batches.iter().map(Batch::total))?,
        fee_total: Zatoshi::checked_sum(fees.iter().copied())?,
        required: Zatoshi::checked_sum(per_batch.iter().copied())?,
        fees,
        per_batch,
    })
}

/// Why a deposit cannot fund a plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FundingShortfall {
    /// The deposit is worth less than the plan needs.
    Insufficient {
        /// What the plan needs.
        required: Zatoshi,
    },
    /// The output index would overflow.
    BadOutpoint,
    /// The backend spends one deposit per batch and this plan has several batches. That
    /// needs a funding-split transaction, which is not implemented.
    NeedsSplit,
}

/// Splits one observed deposit into a funding reference per batch.
pub fn split_funding(
    deposit: &FundingObserved,
    plan: &FundingPlan,
) -> Result<Vec<FundingRef>, FundingShortfall> {
    if deposit.amount < plan.required {
        return Err(FundingShortfall::Insufficient {
            required: plan.required,
        });
    }
    plan.per_batch
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let offset = u32::try_from(index).map_err(|_| FundingShortfall::BadOutpoint)?;
            Ok(FundingRef {
                outpoint: OutPoint {
                    txid: deposit.outpoint.txid,
                    vout: deposit
                        .outpoint
                        .vout
                        .checked_add(offset)
                        .ok_or(FundingShortfall::BadOutpoint)?,
                },
                value: *value,
            })
        })
        .collect()
}

/// Funding inputs for the engine under the backend's `layout`.
///
/// * [`FundingLayout::SplitDeposit`]: see [`split_funding`].
/// * [`FundingLayout::SingleDeposit`]: one batch only; its funding input is the deposit
///   itself, with its exact on-chain value (the transaction builder checks the value, and
///   returns the change to the campaign).
pub fn fundings_for(
    layout: FundingLayout,
    deposit: &FundingObserved,
    plan: &FundingPlan,
) -> Result<Vec<FundingRef>, FundingShortfall> {
    match layout {
        FundingLayout::SplitDeposit => split_funding(deposit, plan),
        FundingLayout::SingleDeposit => {
            if plan.per_batch.len() != 1 {
                return Err(FundingShortfall::NeedsSplit);
            }
            if deposit.amount < plan.required {
                return Err(FundingShortfall::Insufficient {
                    required: plan.required,
                });
            }
            Ok(vec![FundingRef {
                outpoint: deposit.outpoint,
                value: deposit.amount,
            }])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use drop_core::{plan_batches, Recipient, Txid};

    fn batches() -> Vec<Batch> {
        let rows: Vec<Recipient> = (0..5)
            .map(|i| {
                Recipient::new(
                    format!("u1fundrow{i:08}"),
                    Zatoshi::new(1_000_000 * (i + 1)).unwrap(),
                    None,
                )
                .unwrap()
            })
            .collect();
        plan_batches(&rows, 3).unwrap()
    }

    #[test]
    fn plan_adds_fee_to_every_batch() {
        let b = batches();
        let plan = funding_plan(&b, &FeePolicy::zip317_text()).unwrap();
        assert_eq!(b.len(), 2);
        // sizes 3 and 2: totals 6_000_000 and 9_000_000; fees 20_000 and 15_000.
        assert_eq!(
            plan.fees,
            vec![Zatoshi::new(20_000).unwrap(), Zatoshi::new(15_000).unwrap()]
        );
        assert_eq!(plan.declared_total.as_u64(), 15_000_000);
        assert_eq!(plan.fee_total.as_u64(), 35_000);
        assert_eq!(plan.required.as_u64(), 15_035_000);
        assert_eq!(plan.per_batch[0].as_u64(), 6_020_000);
        let cheap = funding_plan(&b, &FeePolicy::zebra_main()).unwrap();
        assert_eq!(cheap.fee_total.as_u64(), 7_000);
    }

    #[test]
    fn a_deposit_is_split_into_consecutive_outputs() {
        let b = batches();
        let plan = funding_plan(&b, &FeePolicy::zip317_text()).unwrap();
        let deposit = FundingObserved {
            outpoint: OutPoint {
                txid: Txid::from_bytes([7; 32]),
                vout: 4,
            },
            amount: plan.required,
        };
        let refs = split_funding(&deposit, &plan).unwrap();
        assert_eq!(refs.len(), 2);
        assert_eq!((refs[0].outpoint.vout, refs[1].outpoint.vout), (4, 5));
        assert_eq!(refs[0].outpoint.txid, deposit.outpoint.txid);
        assert_eq!(refs[0].value, plan.per_batch[0]);
    }

    #[test]
    fn an_underfunded_or_overflowing_deposit_is_refused() {
        let b = batches();
        let plan = funding_plan(&b, &FeePolicy::zip317_text()).unwrap();
        let short = FundingObserved {
            outpoint: OutPoint {
                txid: Txid::from_bytes([7; 32]),
                vout: 0,
            },
            amount: Zatoshi::new(plan.required.as_u64() - 1).unwrap(),
        };
        assert_eq!(
            split_funding(&short, &plan),
            Err(FundingShortfall::Insufficient {
                required: plan.required
            })
        );
        let edge = FundingObserved {
            outpoint: OutPoint {
                txid: Txid::from_bytes([7; 32]),
                vout: u32::MAX,
            },
            amount: plan.required,
        };
        assert_eq!(
            split_funding(&edge, &plan),
            Err(FundingShortfall::BadOutpoint)
        );
    }

    #[test]
    fn a_single_deposit_funds_exactly_one_batch_with_its_exact_value() {
        let one: Vec<Batch> = {
            let rows: Vec<Recipient> = (0..3)
                .map(|i| {
                    Recipient::new(
                        format!("u1single{i:08}"),
                        Zatoshi::new(1_000_000 + i).unwrap(),
                        None,
                    )
                    .unwrap()
                })
                .collect();
            plan_batches(&rows, 5).unwrap()
        };
        assert_eq!(one.len(), 1);
        let plan = funding_plan(&one, &FeePolicy::zip317_text()).unwrap();
        let deposit = FundingObserved {
            outpoint: OutPoint {
                txid: Txid::from_bytes([3; 32]),
                vout: 7,
            },
            amount: Zatoshi::new(plan.required.as_u64() + 12_345).unwrap(),
        };
        let refs = fundings_for(FundingLayout::SingleDeposit, &deposit, &plan).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(
            refs[0].outpoint, deposit.outpoint,
            "the deposit itself, not a derived output"
        );
        assert_eq!(
            refs[0].value, deposit.amount,
            "the exact on-chain value, not the requirement"
        );

        let short = FundingObserved {
            amount: Zatoshi::new(plan.required.as_u64() - 1).unwrap(),
            ..deposit
        };
        assert_eq!(
            fundings_for(FundingLayout::SingleDeposit, &short, &plan),
            Err(FundingShortfall::Insufficient {
                required: plan.required
            })
        );
    }

    #[test]
    fn several_batches_cannot_share_a_single_deposit() {
        let b = batches();
        assert_eq!(b.len(), 2);
        let plan = funding_plan(&b, &FeePolicy::zip317_text()).unwrap();
        let deposit = FundingObserved {
            outpoint: OutPoint {
                txid: Txid::from_bytes([3; 32]),
                vout: 0,
            },
            amount: plan.required,
        };
        assert_eq!(
            fundings_for(FundingLayout::SingleDeposit, &deposit, &plan),
            Err(FundingShortfall::NeedsSplit)
        );
        assert!(fundings_for(FundingLayout::SplitDeposit, &deposit, &plan).is_ok());
    }
}
