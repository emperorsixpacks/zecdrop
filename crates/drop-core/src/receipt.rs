//! The public receipt (REQ-PRIV-001): everything the hosted verifier may show.
//!
//! The receipt has **no field** for a recipient address, a per-recipient amount or
//! a memo, so there is nothing to leak by construction. It carries only campaign
//! level facts that anyone can recompute from chain data: totals, per-batch
//! transaction ids, the net value entering the pool, fees, shielded action counts,
//! the pool and confirmations, plus the salted manifest commitment.
//!
//! Two producers build the same shape:
//!
//! * the operator, who knows the plan: [`PublicReceipt::assemble`];
//! * the key-less verifier, who knows only the chain: [`PublicReceipt::from_chain_facts`].
//!
//! The verifier may fail to establish a fact (a transaction is not on the chain
//! yet, a funding input cannot be looked up), so per-batch facts that can be
//! unknown are `null` in JSON, and what went wrong is listed in `findings`, a
//! closed set of codes carrying at most a batch index. Findings never contain
//! text that came from outside.
//!
//! In JSON, zatoshi amounts are decimal strings (JavaScript-safe) and ids are
//! lowercase hex.
//!
//! ## What binds a receipt to a campaign
//!
//! `campaign_id` is an **unverified label**: whoever asks the verifier names it, and nothing on
//! the chain says which campaign a transaction belongs to. What does tie a receipt to a
//! campaign is `funding_address`, the one transparent address every batch spends from. A
//! campaign's organiser publishes that address (and the manifest commitment); a reader compares
//! it with what the receipt shows. When the batches spend from more than one address, each
//! batch that differs from the first known one gets a [`Finding::MixedFundingSources`] and the
//! campaign is `failed`.
//!
//! Known limit of that check: it compares addresses and cannot know that two addresses belong
//! to the same campaign. A batch funded from a campaign's *change* address would therefore be
//! reported as mixed. The funding design never chains a batch from change, so for a campaign
//! built by this software the finding means what it says.
//!
//! ## Where the deposit came from
//!
//! `funding_source` (REQ-VER-007) says what the deposit spent: [`FundingSource::Shielded`] when
//! the transaction that created a batch's funding input had no transparent input, so the chain
//! names no address it came from, and [`FundingSource::Transparent`] when it spent a transparent
//! coin, whose origin is public. It is a privacy fact, not a finding: it never changes the phase,
//! and it never names the address or the amount of anything the deposit spent.
//!
//! Known limit: a batch's `net_into_pool` is the sum of its outputs. A batch with
//! one recipient, or with all-equal amounts, therefore makes those amounts
//! derivable from the receipt. The planner avoids one-recipient batches and
//! [`crate::warnings`] flags the rest.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::amount::Zatoshi;
use crate::engine::FundingRef;
use crate::error::AmountError;
use crate::fee::{shielded_actions, standard_batch_fee, FeePolicy};
use crate::ids::{CampaignId, Network, OutPoint, Pool, Txid};
use crate::ledger::BatchStatus;
use crate::manifest::ManifestCommitment;
use crate::phase::{derive_phase, CampaignPhase, FundingState};
use crate::planner::{campaign_total, Batch};

/// Public facts about one batch transaction. A `null` fact was not established.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchReceipt {
    /// Position of the batch in the campaign.
    pub index: u32,
    /// The batch transaction, once it has been built.
    pub txid: Option<Txid>,
    /// The transparent output the batch spends.
    pub funding_input: Option<OutPoint>,
    /// Value entering the shielded pool: the sum of the batch's outputs.
    pub net_into_pool: Option<Zatoshi>,
    /// The fee paid.
    pub fee: Option<Zatoshi>,
    /// Number of shielded actions (outputs, padded to at least two).
    pub shielded_actions: Option<u32>,
    /// The shielded pool the batch pays into.
    pub pool: Option<Pool>,
    /// Confirmations on record (0 until mined).
    pub confirmations: u32,
}

/// A problem a verifier found. A closed set: a code, and at most a batch index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Finding {
    /// The batches' net values do not add up to the declared campaign total.
    DeclaredTotalMismatch,
    /// The batch transaction is not on the chain (yet).
    TxNotFound {
        /// Batch index.
        batch_index: u32,
    },
    /// The data returned for the transaction is not a valid transaction.
    TxUnparseable {
        /// Batch index.
        batch_index: u32,
    },
    /// A funding input could not be looked up, so fee and balance cannot be checked.
    PrevoutUnresolved {
        /// Batch index.
        batch_index: u32,
    },
    /// The inputs are worth less than outputs plus shielded value, which no valid
    /// transaction can be.
    NegativeFee {
        /// Batch index.
        batch_index: u32,
    },
    /// The transaction's shielded value balance does not verify against its own
    /// binding signature, so the net-into-pool figure cannot be trusted.
    BalanceMismatch {
        /// Batch index.
        batch_index: u32,
    },
    /// The transaction does not move value into the expected shielded pool.
    UnexpectedPool {
        /// Batch index.
        batch_index: u32,
    },
    /// The transaction is found but not yet confirmed to the required depth.
    BatchPending {
        /// Batch index.
        batch_index: u32,
    },
    /// The batch spends from a different transparent address than the first batch whose
    /// address is known, so the batches do not all come from one campaign funding address.
    MixedFundingSources {
        /// Batch index.
        batch_index: u32,
    },
}

impl Finding {
    /// The batch this finding is about, if it is about one.
    pub fn batch_index(&self) -> Option<u32> {
        match self {
            Finding::DeclaredTotalMismatch => None,
            Finding::TxNotFound { batch_index }
            | Finding::TxUnparseable { batch_index }
            | Finding::PrevoutUnresolved { batch_index }
            | Finding::NegativeFee { batch_index }
            | Finding::BalanceMismatch { batch_index }
            | Finding::UnexpectedPool { batch_index }
            | Finding::BatchPending { batch_index }
            | Finding::MixedFundingSources { batch_index } => Some(*batch_index),
        }
    }

    /// Whether the finding means the campaign is wrong (as opposed to merely not
    /// yet verifiable or not yet final). Failures make the phase `failed`.
    pub fn is_failure(&self) -> bool {
        matches!(
            self,
            Finding::DeclaredTotalMismatch
                | Finding::TxUnparseable { .. }
                | Finding::NegativeFee { .. }
                | Finding::BalanceMismatch { .. }
                | Finding::UnexpectedPool { .. }
                | Finding::MixedFundingSources { .. }
        )
    }

    /// A sentence for people. Fixed text plus the batch index; nothing from outside.
    pub fn message(&self) -> String {
        match self {
            Finding::DeclaredTotalMismatch => {
                "The batches add up to a different total than the one declared for this campaign."
                    .to_owned()
            }
            Finding::TxNotFound { batch_index } => {
                format!("Batch {batch_index}: the transaction was not found on the chain.")
            }
            Finding::TxUnparseable { batch_index } => format!(
                "Batch {batch_index}: the data returned for this transaction is not a valid transaction."
            ),
            Finding::PrevoutUnresolved { batch_index } => format!(
                "Batch {batch_index}: a funding input could not be looked up, so the fee cannot be checked."
            ),
            Finding::NegativeFee { batch_index } => format!(
                "Batch {batch_index}: the inputs are worth less than the outputs, which no valid transaction can be."
            ),
            Finding::BalanceMismatch { batch_index } => format!(
                "Batch {batch_index}: the shielded value balance does not match the transaction's own signature."
            ),
            Finding::UnexpectedPool { batch_index } => format!(
                "Batch {batch_index}: the transaction does not pay into the expected shielded pool."
            ),
            Finding::BatchPending { batch_index } => format!(
                "Batch {batch_index}: not yet confirmed to the required depth."
            ),
            Finding::MixedFundingSources { batch_index } => format!(
                "Batch {batch_index}: spends from a different address than the other batches, so they do not all come from one campaign funding address."
            ),
        }
    }
}

/// What the hosted verifier may expose about a campaign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicReceipt {
    /// The campaign, when known (the operator always knows it; a verifier only
    /// if the caller named it).
    pub campaign_id: Option<CampaignId>,
    /// The network it runs on.
    pub network: Network,
    /// The one transparent address every batch spends from: the campaign's funding address,
    /// public on the chain. This, with the manifest commitment, is what ties the receipt to a
    /// campaign; `campaign_id` is only a label. `null` when it is not established: an input
    /// could not be looked up, the batches do not share one address (see
    /// [`Finding::MixedFundingSources`]), or the producer has none (the mock chain).
    pub funding_address: Option<String>,
    /// What the deposit spent (see [`FundingSource`]); `null` when it is not established. A
    /// receipt written before the field existed reads back as `None`.
    pub funding_source: Option<FundingSource>,
    /// Sum of all batch totals, as declared by whoever published the campaign.
    pub declared_total: Zatoshi,
    /// Sum of all batch fees, when every batch's fee is known.
    pub fee_total: Option<Zatoshi>,
    /// Per-batch facts, in batch order.
    pub batches: Vec<BatchReceipt>,
    /// Salted commitment to the private manifest, as hex.
    pub manifest_commitment: ManifestCommitment,
    /// Where the campaign stands.
    pub phase: CampaignPhase,
    /// Problems found; empty when everything checks out.
    pub findings: Vec<Finding>,
}

/// What a campaign's deposit spent, as the chain shows it (REQ-VER-007).
///
/// The deposit of a batch is the transaction that created the batch's funding input. This says
/// only what that transaction spent, never who paid: a shielded deposit names no address, but its
/// amount and its time are public like every deposit's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FundingSource {
    /// The deposit spent no transparent coin: its value came out of a shielded pool, and the
    /// transaction names no address it came from.
    Shielded,
    /// The deposit spent at least one transparent coin (a coinbase input counts as one). Where
    /// that coin came from is public, and the chain now ties it to the campaign.
    Transparent,
}

impl FundingSource {
    /// One answer for several deposits: `Transparent` as soon as one is known to be, `Shielded`
    /// only if there is at least one and every one is known and shielded, and `None` otherwise.
    pub fn combine(
        sources: impl IntoIterator<Item = Option<FundingSource>>,
    ) -> Option<FundingSource> {
        let mut seen = false;
        let mut all_shielded = true;
        for source in sources {
            seen = true;
            match source {
                Some(FundingSource::Transparent) => return Some(FundingSource::Transparent),
                Some(FundingSource::Shielded) => {}
                None => all_shielded = false,
            }
        }
        (seen && all_shielded).then_some(FundingSource::Shielded)
    }
}

/// Why a receipt could not be assembled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ReceiptError {
    /// The input lists do not line up.
    #[error("receipt inputs are inconsistent: {0}")]
    Mismatch(&'static str),
    /// Summing amounts failed.
    #[error(transparent)]
    Amount(#[from] AmountError),
}

/// Everything needed to assemble a [`PublicReceipt`].
#[derive(Clone, Copy, Debug)]
pub struct ReceiptInputs<'a> {
    /// The campaign.
    pub campaign_id: &'a CampaignId,
    /// The network.
    pub network: Network,
    /// Commitment from [`crate::manifest::Manifest::commitment`].
    pub manifest_commitment: ManifestCommitment,
    /// The fee policy the batches were (or will be) built with.
    pub fee_policy: &'a FeePolicy,
    /// The shielded pool every batch pays into.
    pub pool: Pool,
    /// The planned batches. Only counts and totals are read from them.
    pub batches: &'a [Batch],
    /// One funding input per batch.
    pub fundings: &'a [FundingRef],
    /// One ledger status per batch.
    pub statuses: &'a [BatchStatus],
    /// Whether the funding deposit has arrived.
    pub funding_state: FundingState,
    /// Confirmation depth at which a batch counts as final.
    pub required_depth: u32,
    /// The campaign's transparent funding address, if it has one (the mock chain has none).
    pub funding_address: Option<&'a str>,
    /// What the deposit spent, if the producer knows it.
    pub funding_source: Option<FundingSource>,
}

/// What a key-less verifier established from the chain.
#[derive(Clone, Debug)]
pub struct ChainReceiptInputs<'a> {
    /// The campaign, if the caller named it.
    pub campaign_id: Option<&'a CampaignId>,
    /// The network.
    pub network: Network,
    /// The commitment published by the campaign.
    pub manifest_commitment: ManifestCommitment,
    /// The total the campaign declares it paid into the pool.
    pub declared_total: Zatoshi,
    /// Confirmation depth at which a batch counts as final.
    pub required_depth: u32,
    /// What was established per batch, in batch order; `index` must equal the position.
    pub batches: Vec<BatchReceipt>,
    /// Problems found while establishing those facts.
    pub findings: Vec<Finding>,
    /// What the deposits spent, combined with [`FundingSource::combine`]; `None` if not established.
    pub funding_source: Option<FundingSource>,
}

/// Whether `address` can stand in a receipt: letters and digits only, of a plausible length.
/// (A receipt never carries text from outside; an address is encoded by the producer.)
fn plausible_address(address: &str) -> bool {
    (20..=120).contains(&address.len()) && address.bytes().all(|b| b.is_ascii_alphanumeric())
}

impl PublicReceipt {
    /// Assembles a receipt from the plan, the funding and the ledger.
    ///
    /// Recipient data goes in only as part of `batches`, from which just the
    /// output count and the total are read; none of it reaches the result.
    pub fn assemble(inputs: ReceiptInputs<'_>) -> Result<PublicReceipt, ReceiptError> {
        let ReceiptInputs {
            campaign_id,
            network,
            manifest_commitment,
            fee_policy,
            pool,
            batches,
            fundings,
            statuses,
            funding_state,
            required_depth,
            funding_address,
            funding_source,
        } = inputs;
        if fundings.len() != batches.len() || statuses.len() != batches.len() {
            return Err(ReceiptError::Mismatch(
                "need one funding input and one status per batch",
            ));
        }
        if funding_address.is_some_and(|a| !plausible_address(a)) {
            return Err(ReceiptError::Mismatch(
                "a funding address must be 20 to 120 letters and digits",
            ));
        }

        let mut receipts = Vec::with_capacity(batches.len());
        for ((batch, funding), status) in batches.iter().zip(fundings).zip(statuses) {
            receipts.push(BatchReceipt {
                index: batch.index(),
                txid: status.txid(),
                funding_input: Some(funding.outpoint),
                net_into_pool: Some(batch.total()),
                fee: Some(standard_batch_fee(fee_policy, batch.output_count())?),
                shielded_actions: Some(shielded_actions(batch.output_count())),
                pool: Some(pool),
                confirmations: match status {
                    BatchStatus::Confirmed { depth, .. } => *depth,
                    _ => 0,
                },
            });
        }

        Ok(PublicReceipt {
            campaign_id: Some(campaign_id.clone()),
            network,
            funding_address: funding_address.map(str::to_owned),
            funding_source,
            declared_total: campaign_total(batches)?,
            fee_total: Some(Zatoshi::checked_sum(receipts.iter().filter_map(|r| r.fee))?),
            batches: receipts,
            manifest_commitment,
            phase: derive_phase(funding_state, statuses, required_depth),
            findings: Vec::new(),
        })
    }

    /// Builds a receipt from what a verifier found on the chain.
    ///
    /// Adds the findings that depend on the whole picture, after the ones supplied:
    ///
    /// * [`Finding::BatchPending`] for each located batch below `required_depth`;
    /// * [`Finding::DeclaredTotalMismatch`] when every batch's net is known and
    ///   their sum differs from `declared_total`.
    ///
    /// Phase: `failed` if any finding [`is_failure`](Finding::is_failure); `settled`
    /// only if there are no findings (so every batch is located, confirmed to the
    /// required depth, balanced, in the expected pool, and the nets add up to the
    /// declared total); otherwise `sending { done, total }`, where `done` counts
    /// batches that are final and have no finding.
    pub fn from_chain_facts(inputs: ChainReceiptInputs<'_>) -> Result<PublicReceipt, ReceiptError> {
        let unknown = vec![None; inputs.batches.len()];
        PublicReceipt::from_chain_facts_with_funding(inputs, &unknown)
    }

    /// Like [`PublicReceipt::from_chain_facts`], and also says where each batch's funds came
    /// from: `funding_addresses` holds, per batch and in batch order, the transparent address
    /// the batch's input belongs to, or `None` if it could not be established.
    ///
    /// * `funding_address` of the receipt is set only when every batch's address is known and
    ///   they are all the same;
    /// * each batch whose known address differs from the first known one gets a
    ///   [`Finding::MixedFundingSources`] (added after the findings supplied, before the ones
    ///   that depend on the whole picture).
    ///
    /// Fails if the list does not line up with the batches, or an address is not plausible.
    pub fn from_chain_facts_with_funding(
        inputs: ChainReceiptInputs<'_>,
        funding_addresses: &[Option<String>],
    ) -> Result<PublicReceipt, ReceiptError> {
        let ChainReceiptInputs {
            campaign_id,
            network,
            manifest_commitment,
            declared_total,
            required_depth,
            batches,
            mut findings,
            funding_source,
        } = inputs;
        if batches.is_empty() {
            return Err(ReceiptError::Mismatch("a receipt needs at least one batch"));
        }
        for (position, batch) in batches.iter().enumerate() {
            if usize::try_from(batch.index).ok() != Some(position) {
                return Err(ReceiptError::Mismatch("batch indices must be 0, 1, 2, ..."));
            }
        }
        if funding_addresses.len() != batches.len() {
            return Err(ReceiptError::Mismatch(
                "need one funding address (or none) per batch",
            ));
        }
        if funding_addresses
            .iter()
            .flatten()
            .any(|a| !plausible_address(a))
        {
            return Err(ReceiptError::Mismatch(
                "a funding address must be 20 to 120 letters and digits",
            ));
        }
        let reference = funding_addresses.iter().flatten().next();
        if let Some(reference) = reference {
            for (batch, address) in batches.iter().zip(funding_addresses) {
                if address.as_ref().is_some_and(|a| a != reference) {
                    findings.push(Finding::MixedFundingSources {
                        batch_index: batch.index,
                    });
                }
            }
        }
        // Stated only when every batch is known to spend from the same address.
        let funding_address = reference
            .filter(|reference| {
                funding_addresses
                    .iter()
                    .all(|a| a.as_ref() == Some(*reference))
            })
            .cloned();

        let not_located = |index: u32, findings: &[Finding]| {
            findings.iter().any(|f| {
                matches!(
                    f,
                    Finding::TxNotFound { batch_index } | Finding::TxUnparseable { batch_index }
                        if *batch_index == index
                )
            })
        };
        for batch in &batches {
            if !not_located(batch.index, &findings) && batch.confirmations < required_depth {
                findings.push(Finding::BatchPending {
                    batch_index: batch.index,
                });
            }
        }

        let nets: Option<Vec<Zatoshi>> = batches.iter().map(|b| b.net_into_pool).collect();
        if let Some(nets) = nets {
            match Zatoshi::checked_sum(nets) {
                Ok(sum) if sum == declared_total => {}
                _ => findings.push(Finding::DeclaredTotalMismatch),
            }
        }

        let fees: Option<Vec<Zatoshi>> = batches.iter().map(|b| b.fee).collect();
        let fee_total = match fees {
            Some(fees) => Some(Zatoshi::checked_sum(fees)?),
            None => None,
        };

        // A batch with no finding but missing facts would be a caller bug; never settle on it.
        let complete = batches
            .iter()
            .all(|b| b.txid.is_some() && b.net_into_pool.is_some() && b.pool.is_some());
        let phase = if findings.iter().any(Finding::is_failure) {
            CampaignPhase::Failed
        } else if findings.is_empty() && complete {
            CampaignPhase::Settled
        } else {
            let done = batches
                .iter()
                .filter(|b| {
                    b.confirmations >= required_depth
                        && !findings.iter().any(|f| f.batch_index() == Some(b.index))
                })
                .count();
            CampaignPhase::Sending {
                done: u32::try_from(done).unwrap_or(u32::MAX),
                total: u32::try_from(batches.len()).unwrap_or(u32::MAX),
            }
        };

        Ok(PublicReceipt {
            campaign_id: campaign_id.cloned(),
            network,
            funding_address,
            funding_source,
            declared_total,
            fee_total,
            batches,
            manifest_commitment,
            phase,
            findings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{Manifest, Salt};
    use crate::planner::plan_batches;
    use crate::recipient::Recipient;
    use serde_json::Value;
    use std::collections::BTreeSet;

    const SENTINEL_ADDRS: [&str; 6] = [
        "u1sentineladdrAAAAAAAAAAAAAAAAAAAAAA",
        "u1sentineladdrBBBBBBBBBBBBBBBBBBBBBB",
        "u1sentineladdrCCCCCCCCCCCCCCCCCCCCCC",
        "zs1sentineladdrDDDDDDDDDDDDDDDDDDDDD",
        "zs1sentineladdrEEEEEEEEEEEEEEEEEEEEE",
        "t1sentineladdrFFFFFFFFFFFFFFFFFFFFFF",
    ];
    // Distinct, and none equal to a batch sum (7777001+3333007+1111003 = 12221011,
    // 4444009+5555011+6666013 = 16665033).
    const SENTINEL_AMOUNTS: [u64; 6] = [
        7_777_001, 3_333_007, 1_111_003, 4_444_009, 5_555_011, 6_666_013,
    ];
    const SENTINEL_MEMOS: [&str; 6] = [
        "sentinel-memo-one",
        "sentinel-memo-two",
        "sentinel-memo-three",
        "sentinel-memo-four",
        "sentinel-memo-five",
        "sentinel-memo-six",
    ];

    fn sentinel_rows() -> Vec<Recipient> {
        (0..6)
            .map(|i| {
                Recipient::new(
                    SENTINEL_ADDRS[i],
                    Zatoshi::new(SENTINEL_AMOUNTS[i]).unwrap(),
                    Some(SENTINEL_MEMOS[i].to_owned()),
                )
                .unwrap()
            })
            .collect()
    }

    fn txid(n: u8) -> Txid {
        Txid::from_bytes([n; 32])
    }

    struct Fixture {
        campaign: CampaignId,
        batches: Vec<Batch>,
        fundings: Vec<FundingRef>,
        statuses: Vec<BatchStatus>,
        commitment: ManifestCommitment,
    }

    fn fixture() -> Fixture {
        let campaign = CampaignId::new("camp").unwrap();
        let rows = sentinel_rows();
        let manifest =
            Manifest::new(campaign.clone(), Salt::from_bytes([3; 32]), rows.clone()).unwrap();
        let batches = plan_batches(&rows, 3).unwrap();
        let fundings = batches
            .iter()
            .map(|b| FundingRef {
                outpoint: OutPoint {
                    txid: txid(0xf0 + b.index() as u8),
                    vout: b.index(),
                },
                value: Zatoshi::new(b.total().as_u64() + 100_000).unwrap(),
            })
            .collect();
        let statuses = vec![
            BatchStatus::Confirmed {
                txid: txid(1),
                depth: 4,
            },
            BatchStatus::Broadcast { txid: txid(2) },
        ];
        Fixture {
            campaign,
            batches,
            fundings,
            statuses,
            commitment: manifest.commitment(),
        }
    }

    fn receipt(f: &Fixture) -> PublicReceipt {
        PublicReceipt::assemble(ReceiptInputs {
            campaign_id: &f.campaign,
            network: Network::Testnet,
            manifest_commitment: f.commitment,
            fee_policy: &FeePolicy::zip317_text(),
            pool: Pool::Ironwood,
            batches: &f.batches,
            fundings: &f.fundings,
            statuses: &f.statuses,
            funding_state: FundingState::Funded,
            required_depth: 6,
            funding_address: None,
            funding_source: None,
        })
        .unwrap()
    }

    fn keys(value: &Value) -> BTreeSet<String> {
        value.as_object().unwrap().keys().cloned().collect()
    }

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    // covers: REQ-PRIV-001
    #[test]
    fn assembles_public_facts_from_plan_funding_and_ledger() {
        let f = fixture();
        let r = receipt(&f);
        assert_eq!(
            r.declared_total.as_u64(),
            SENTINEL_AMOUNTS.iter().sum::<u64>()
        );
        // Standard shape: 3 outputs -> 3 shielded actions + 1 transparent = 4 actions = 20_000 each.
        assert_eq!(r.batches[0].fee.unwrap().as_u64(), 20_000);
        assert_eq!(r.fee_total.unwrap().as_u64(), 40_000);
        assert_eq!(
            r.batches[0].net_into_pool.unwrap().as_u64(),
            7_777_001 + 3_333_007 + 1_111_003
        );
        assert_eq!(r.batches[0].shielded_actions, Some(3));
        assert!(r.batches.iter().all(|b| b.pool == Some(Pool::Ironwood)));
        assert_eq!(r.batches[0].txid, Some(txid(1)));
        assert_eq!(r.batches[0].confirmations, 4);
        assert_eq!(r.batches[1].txid, Some(txid(2)));
        assert_eq!(r.batches[1].confirmations, 0);
        assert_eq!(r.batches[1].funding_input.unwrap().vout, 1);
        assert_eq!(r.phase, CampaignPhase::Sending { done: 0, total: 2 });
        assert_eq!(r.manifest_commitment, f.commitment);
    }

    // covers: REQ-PRIV-001
    #[test]
    fn unbuilt_batches_have_a_null_txid() {
        let mut f = fixture();
        f.statuses = vec![BatchStatus::Planned, BatchStatus::Planned];
        let r = receipt(&f);
        assert_eq!(r.batches[0].txid, None);
        assert_eq!(r.phase, CampaignPhase::Funded);
        let json = serde_json::to_value(&r).unwrap();
        assert!(json["batches"][0]["txid"].is_null());
    }

    // covers: REQ-PRIV-001
    #[test]
    fn json_contains_no_recipient_address_amount_or_memo() {
        let f = fixture();
        let json = serde_json::to_string(&receipt(&f)).unwrap();
        for addr in SENTINEL_ADDRS {
            assert!(!json.contains(addr), "address leaked: {json}");
            assert!(!json.contains(&addr[..14]), "address prefix leaked: {json}");
        }
        for memo in SENTINEL_MEMOS {
            assert!(!json.contains(memo), "memo leaked: {json}");
        }
        for amount in SENTINEL_AMOUNTS {
            let zat = amount.to_string();
            let zec = Zatoshi::new(amount).unwrap().format_zec();
            assert!(!json.contains(&zat), "amount {zat} leaked: {json}");
            assert!(!json.contains(&zec), "amount {zec} leaked: {json}");
        }
        assert!(!json.contains("sentinel"), "{json}");
        // The Debug form is as clean as the JSON.
        let debug = format!("{:?}", receipt(&f));
        assert!(!debug.contains("sentinel"), "{debug}");
    }

    // covers: REQ-PRIV-001, REQ-VER-007
    #[test]
    fn json_key_set_equals_the_allow_list() {
        let f = fixture();
        let json = serde_json::to_value(receipt(&f)).unwrap();
        assert_eq!(
            keys(&json),
            set(&[
                "campaign_id",
                "network",
                "funding_address",
                "funding_source",
                "declared_total",
                "fee_total",
                "batches",
                "manifest_commitment",
                "phase",
                "findings",
            ])
        );
        let batches = json["batches"].as_array().unwrap();
        assert_eq!(batches.len(), 2);
        for batch in batches {
            assert_eq!(
                keys(batch),
                set(&[
                    "index",
                    "txid",
                    "funding_input",
                    "net_into_pool",
                    "fee",
                    "shielded_actions",
                    "pool",
                    "confirmations",
                ])
            );
        }
        assert_eq!(keys(&json["phase"]), set(&["phase", "done", "total"]));
    }

    // covers: REQ-PRIV-001
    #[test]
    fn amounts_are_decimal_strings_and_counts_are_numbers() {
        let f = fixture();
        let json = serde_json::to_value(receipt(&f)).unwrap();
        for value in [&json["declared_total"], &json["fee_total"]] {
            assert!(value.is_string(), "{value}");
            assert!(value.as_str().unwrap().bytes().all(|b| b.is_ascii_digit()));
        }
        let batch = &json["batches"][0];
        assert!(batch["net_into_pool"].is_string());
        assert!(batch["fee"].is_string());
        assert!(batch["index"].is_u64() && batch["shielded_actions"].is_u64());
        assert_eq!(batch["pool"], "ironwood");
        assert!(batch["confirmations"].is_u64());
        assert_eq!(
            json["declared_total"],
            SENTINEL_AMOUNTS.iter().sum::<u64>().to_string()
        );
        assert_eq!(json["network"], "testnet");
        assert_eq!(json["manifest_commitment"].as_str().unwrap().len(), 64);
    }

    // covers: REQ-PRIV-001, REQ-PLAN-002
    #[test]
    fn fees_follow_the_supplied_policy_and_pool_is_recorded() {
        let f = fixture();
        let r = PublicReceipt::assemble(ReceiptInputs {
            campaign_id: &f.campaign,
            network: Network::Mainnet,
            manifest_commitment: f.commitment,
            fee_policy: &FeePolicy::zebra_main(),
            pool: Pool::Orchard,
            batches: &f.batches,
            fundings: &f.fundings,
            statuses: &f.statuses,
            funding_state: FundingState::Funded,
            required_depth: 6,
            funding_address: None,
            funding_source: None,
        })
        .unwrap();
        // 3 outputs + 1 transparent = 4 actions at 1000 each.
        assert_eq!(r.batches[0].fee.unwrap().as_u64(), 4_000);
        assert_eq!(r.fee_total.unwrap().as_u64(), 8_000);
        assert!(r.batches.iter().all(|b| b.pool == Some(Pool::Orchard)));
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["batches"][1]["pool"], "orchard");

        // An absurd policy is reported, not wrapped.
        let bad = PublicReceipt::assemble(ReceiptInputs {
            fee_policy: &FeePolicy::new(u64::MAX, 2),
            campaign_id: &f.campaign,
            network: Network::Mainnet,
            manifest_commitment: f.commitment,
            pool: Pool::Orchard,
            batches: &f.batches,
            fundings: &f.fundings,
            statuses: &f.statuses,
            funding_state: FundingState::Funded,
            required_depth: 6,
            funding_address: None,
            funding_source: None,
        });
        assert!(matches!(bad, Err(ReceiptError::Amount(_))));
    }

    // covers: REQ-PRIV-001
    #[test]
    fn round_trips_and_refuses_unknown_fields() {
        let f = fixture();
        let r = receipt(&f);
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<PublicReceipt>(&json).unwrap(), r);

        // A receipt smuggling an extra field (say, a recipient address) does not parse.
        let mut value: Value = serde_json::from_str(&json).unwrap();
        value["recipients"] = serde_json::json!(["u1smuggled"]);
        assert!(serde_json::from_value::<PublicReceipt>(value).is_err());
        let mut value: Value = serde_json::from_str(&json).unwrap();
        value["batches"][0]["address"] = serde_json::json!("u1smuggled");
        assert!(serde_json::from_value::<PublicReceipt>(value).is_err());
    }

    // covers: REQ-PRIV-001
    #[test]
    fn assemble_rejects_misaligned_inputs() {
        let mut f = fixture();
        f.statuses.pop();
        let result = PublicReceipt::assemble(ReceiptInputs {
            campaign_id: &f.campaign,
            network: Network::Mainnet,
            manifest_commitment: f.commitment,
            fee_policy: &FeePolicy::zip317_text(),
            pool: Pool::Ironwood,
            batches: &f.batches,
            fundings: &f.fundings,
            statuses: &f.statuses,
            funding_state: FundingState::Funded,
            required_depth: 1,
            funding_address: None,
            funding_source: None,
        });
        assert!(matches!(result, Err(ReceiptError::Mismatch(_))));
    }

    // ---- chain-facts receipts (the key-less verifier's view) ----------------

    fn outpoint(n: u8) -> OutPoint {
        OutPoint {
            txid: txid(n),
            vout: u32::from(n),
        }
    }

    /// A fully established batch: found, balanced, in Ironwood.
    fn good(index: u32, net: u64, confirmations: u32) -> BatchReceipt {
        BatchReceipt {
            index,
            txid: Some(txid(index as u8 + 1)),
            funding_input: Some(outpoint(index as u8)),
            net_into_pool: Some(Zatoshi::new(net).unwrap()),
            fee: Some(Zatoshi::new(20_000).unwrap()),
            shielded_actions: Some(3),
            pool: Some(Pool::Ironwood),
            confirmations,
        }
    }

    /// A batch whose transaction was requested but could not be found.
    fn missing(index: u32) -> BatchReceipt {
        BatchReceipt {
            index,
            txid: Some(txid(index as u8 + 1)),
            funding_input: None,
            net_into_pool: None,
            fee: None,
            shielded_actions: None,
            pool: None,
            confirmations: 0,
        }
    }

    fn chain_receipt(
        declared: u64,
        depth: u32,
        batches: Vec<BatchReceipt>,
        findings: Vec<Finding>,
    ) -> PublicReceipt {
        PublicReceipt::from_chain_facts(ChainReceiptInputs {
            campaign_id: None,
            network: Network::Testnet,
            manifest_commitment: ManifestCommitment::from_bytes([0xee; 32]),
            declared_total: Zatoshi::new(declared).unwrap(),
            required_depth: depth,
            batches,
            findings,
            funding_source: None,
        })
        .unwrap()
    }

    // covers: REQ-VER-001, REQ-VER-003
    #[test]
    fn a_fully_confirmed_and_balanced_campaign_is_settled_without_findings() {
        let r = chain_receipt(3_000, 3, vec![good(0, 1_000, 3), good(1, 2_000, 9)], vec![]);
        assert_eq!(r.phase, CampaignPhase::Settled);
        assert!(r.findings.is_empty());
        assert_eq!(r.fee_total, Some(Zatoshi::new(40_000).unwrap()));
        assert_eq!(r.campaign_id, None);
    }

    // covers: REQ-VER-003
    #[test]
    fn a_batch_below_the_required_depth_is_pending_and_the_campaign_is_never_settled() {
        let r = chain_receipt(3_000, 3, vec![good(0, 1_000, 3), good(1, 2_000, 2)], vec![]);
        assert_eq!(r.findings, vec![Finding::BatchPending { batch_index: 1 }]);
        assert_eq!(r.phase, CampaignPhase::Sending { done: 1, total: 2 });

        // Zero confirmations (in the mempool) is pending too, at depth 1.
        let r = chain_receipt(1_000, 1, vec![good(0, 1_000, 0)], vec![]);
        assert_eq!(r.findings, vec![Finding::BatchPending { batch_index: 0 }]);
        assert_eq!(r.phase, CampaignPhase::Sending { done: 0, total: 1 });

        // Exactly at the depth is final.
        let r = chain_receipt(1_000, 1, vec![good(0, 1_000, 1)], vec![]);
        assert_eq!(r.phase, CampaignPhase::Settled);
    }

    // covers: REQ-VER-001
    #[test]
    fn a_missing_transaction_is_a_finding_not_a_failure_and_not_also_pending() {
        let r = chain_receipt(
            3_000,
            3,
            vec![good(0, 1_000, 5), missing(1)],
            vec![Finding::TxNotFound { batch_index: 1 }],
        );
        assert_eq!(r.findings, vec![Finding::TxNotFound { batch_index: 1 }]);
        assert_eq!(r.phase, CampaignPhase::Sending { done: 1, total: 2 });
        assert_eq!(r.fee_total, None, "a fee total needs every fee");
        // With a net unknown, the declared-total check cannot run.
        assert!(!r.findings.contains(&Finding::DeclaredTotalMismatch));
    }

    // covers: REQ-VER-001
    #[test]
    fn nets_that_do_not_add_up_to_the_declared_total_fail_the_campaign() {
        let r = chain_receipt(3_001, 1, vec![good(0, 1_000, 5), good(1, 2_000, 5)], vec![]);
        assert_eq!(r.findings, vec![Finding::DeclaredTotalMismatch]);
        assert_eq!(r.phase, CampaignPhase::Failed);
        // Even a settled-looking campaign cannot overstate: declared lower is a mismatch too.
        let r = chain_receipt(2_999, 1, vec![good(0, 1_000, 5), good(1, 2_000, 5)], vec![]);
        assert_eq!(r.phase, CampaignPhase::Failed);
    }

    // covers: REQ-VER-001
    #[test]
    fn every_failure_finding_fails_the_campaign_and_the_others_do_not() {
        let failures = [
            Finding::TxUnparseable { batch_index: 0 },
            Finding::NegativeFee { batch_index: 0 },
            Finding::BalanceMismatch { batch_index: 0 },
            Finding::UnexpectedPool { batch_index: 0 },
            Finding::MixedFundingSources { batch_index: 0 },
            Finding::DeclaredTotalMismatch,
        ];
        let others = [
            Finding::TxNotFound { batch_index: 0 },
            Finding::PrevoutUnresolved { batch_index: 0 },
            Finding::BatchPending { batch_index: 0 },
        ];
        for f in failures {
            assert!(f.is_failure(), "{f:?}");
            let r = chain_receipt(1_000, 1, vec![good(0, 1_000, 5)], vec![f]);
            assert_eq!(r.phase, CampaignPhase::Failed, "{f:?}");
        }
        for f in others {
            assert!(!f.is_failure(), "{f:?}");
            let r = chain_receipt(1_000, 1, vec![good(0, 1_000, 5)], vec![f]);
            assert!(matches!(r.phase, CampaignPhase::Sending { .. }), "{f:?}");
        }
    }

    // covers: REQ-VER-001
    #[test]
    fn a_receipt_with_findings_is_never_settled_and_missing_facts_never_settle() {
        let r = chain_receipt(
            1_000,
            1,
            vec![good(0, 1_000, 5)],
            vec![Finding::PrevoutUnresolved { batch_index: 0 }],
        );
        assert!(matches!(r.phase, CampaignPhase::Sending { done: 0, .. }));
        // No findings supplied but facts missing: still not settled.
        let r = chain_receipt(0, 1, vec![missing(0)], vec![]);
        assert!(!matches!(r.phase, CampaignPhase::Settled), "{:?}", r.phase);
    }

    // covers: REQ-VER-001
    #[test]
    fn chain_facts_are_validated_up_front() {
        let attempt = |batches: Vec<BatchReceipt>| {
            PublicReceipt::from_chain_facts(ChainReceiptInputs {
                campaign_id: None,
                network: Network::Testnet,
                manifest_commitment: ManifestCommitment::from_bytes([1; 32]),
                declared_total: Zatoshi::ZERO,
                required_depth: 1,
                batches,
                findings: vec![],
                funding_source: None,
            })
        };
        assert!(matches!(attempt(vec![]), Err(ReceiptError::Mismatch(_))));
        assert!(matches!(
            attempt(vec![good(1, 5, 5)]),
            Err(ReceiptError::Mismatch(_))
        ));
        assert!(matches!(
            attempt(vec![good(0, 5, 5), good(0, 5, 5)]),
            Err(ReceiptError::Mismatch(_))
        ));
    }

    // covers: REQ-PRIV-001
    #[test]
    fn findings_serialize_as_a_snake_case_code_with_at_most_a_batch_index() {
        let cases = [
            (
                Finding::DeclaredTotalMismatch,
                serde_json::json!({"code": "declared_total_mismatch"}),
            ),
            (
                Finding::TxNotFound { batch_index: 2 },
                serde_json::json!({"code": "tx_not_found", "batch_index": 2}),
            ),
            (
                Finding::TxUnparseable { batch_index: 2 },
                serde_json::json!({"code": "tx_unparseable", "batch_index": 2}),
            ),
            (
                Finding::PrevoutUnresolved { batch_index: 2 },
                serde_json::json!({"code": "prevout_unresolved", "batch_index": 2}),
            ),
            (
                Finding::NegativeFee { batch_index: 2 },
                serde_json::json!({"code": "negative_fee", "batch_index": 2}),
            ),
            (
                Finding::BalanceMismatch { batch_index: 2 },
                serde_json::json!({"code": "balance_mismatch", "batch_index": 2}),
            ),
            (
                Finding::UnexpectedPool { batch_index: 2 },
                serde_json::json!({"code": "unexpected_pool", "batch_index": 2}),
            ),
            (
                Finding::BatchPending { batch_index: 2 },
                serde_json::json!({"code": "batch_pending", "batch_index": 2}),
            ),
            (
                Finding::MixedFundingSources { batch_index: 2 },
                serde_json::json!({"code": "mixed_funding_sources", "batch_index": 2}),
            ),
        ];
        for (finding, json) in cases {
            assert_eq!(serde_json::to_value(finding).unwrap(), json);
            assert_eq!(serde_json::from_value::<Finding>(json).unwrap(), finding);
            let message = finding.message();
            assert!(!message.is_empty());
            // Fixed text plus the index: no other digits or hex.
            assert!(
                message.chars().filter(char::is_ascii_digit).count() <= 1,
                "{message}"
            );
        }
        assert!(serde_json::from_value::<Finding>(
            serde_json::json!({"code": "free_text", "text": "x"})
        )
        .is_err());
    }

    // covers: REQ-PRIV-001, REQ-VER-007
    #[test]
    fn chain_receipts_use_the_same_key_allow_list_with_nulls_for_unknown_facts() {
        let r = chain_receipt(
            1_000,
            3,
            vec![good(0, 1_000, 5), missing(1)],
            vec![Finding::TxNotFound { batch_index: 1 }],
        );
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(
            keys(&json),
            set(&[
                "campaign_id",
                "network",
                "funding_address",
                "funding_source",
                "declared_total",
                "fee_total",
                "batches",
                "manifest_commitment",
                "phase",
                "findings",
            ])
        );
        let unknown = &json["batches"][1];
        assert_eq!(
            keys(unknown),
            set(&[
                "index",
                "txid",
                "funding_input",
                "net_into_pool",
                "fee",
                "shielded_actions",
                "pool",
                "confirmations"
            ])
        );
        for key in [
            "funding_input",
            "net_into_pool",
            "fee",
            "shielded_actions",
            "pool",
        ] {
            assert!(unknown[key].is_null(), "{key}");
        }
        assert!(json["campaign_id"].is_null() && json["fee_total"].is_null());
        assert!(json["funding_source"].is_null());
        assert_eq!(serde_json::from_value::<PublicReceipt>(json).unwrap(), r);
    }

    // ---- where the funds came from (V2) --------------------------------------

    const ADDRESS_A: &str = "tFAKEfundingAddressAAAAAAAAAAAAAAAA";
    const ADDRESS_B: &str = "tFAKEfundingAddressBBBBBBBBBBBBBBBB";

    fn with_funding(
        batches: Vec<BatchReceipt>,
        findings: Vec<Finding>,
        addresses: &[Option<&str>],
    ) -> Result<PublicReceipt, ReceiptError> {
        let declared: u64 = batches
            .iter()
            .filter_map(|b| b.net_into_pool)
            .map(Zatoshi::as_u64)
            .sum();
        let addresses: Vec<Option<String>> =
            addresses.iter().map(|a| a.map(str::to_owned)).collect();
        PublicReceipt::from_chain_facts_with_funding(
            ChainReceiptInputs {
                campaign_id: None,
                network: Network::Testnet,
                manifest_commitment: ManifestCommitment::from_bytes([0xee; 32]),
                declared_total: Zatoshi::new(declared).unwrap(),
                required_depth: 1,
                batches,
                findings,
                funding_source: None,
            },
            &addresses,
        )
    }

    // covers: REQ-VER-001, REQ-PRIV-001, REQ-VER-004
    #[test]
    fn batches_that_all_spend_from_one_address_state_it_and_settle() {
        let r = with_funding(
            vec![good(0, 1_000, 5), good(1, 2_000, 5), good(2, 3_000, 5)],
            vec![],
            &[Some(ADDRESS_A), Some(ADDRESS_A), Some(ADDRESS_A)],
        )
        .unwrap();
        assert_eq!(r.funding_address.as_deref(), Some(ADDRESS_A));
        assert!(r.findings.is_empty());
        assert_eq!(r.phase, CampaignPhase::Settled);
    }

    // covers: REQ-VER-001, REQ-VER-004
    #[test]
    fn a_batch_that_spends_from_another_address_is_flagged_and_fails_the_campaign() {
        let r = with_funding(
            vec![good(0, 1_000, 5), good(1, 2_000, 5), good(2, 3_000, 5)],
            vec![],
            &[Some(ADDRESS_A), Some(ADDRESS_B), Some(ADDRESS_A)],
        )
        .unwrap();
        assert_eq!(
            r.findings,
            vec![Finding::MixedFundingSources { batch_index: 1 }]
        );
        assert_eq!(
            r.funding_address, None,
            "there is no single address to state"
        );
        assert_eq!(r.phase, CampaignPhase::Failed);
        // The reference is the first batch with a known address, not batch 0 as such.
        let r = with_funding(
            vec![good(0, 1_000, 5), good(1, 2_000, 5), good(2, 3_000, 5)],
            vec![],
            &[None, Some(ADDRESS_B), Some(ADDRESS_A)],
        )
        .unwrap();
        assert_eq!(
            r.findings,
            vec![Finding::MixedFundingSources { batch_index: 2 }]
        );
        // Every differing batch is named.
        let r = with_funding(
            vec![good(0, 1_000, 5), good(1, 2_000, 5), good(2, 3_000, 5)],
            vec![],
            &[Some(ADDRESS_A), Some(ADDRESS_B), Some(ADDRESS_B)],
        )
        .unwrap();
        assert_eq!(
            r.findings,
            vec![
                Finding::MixedFundingSources { batch_index: 1 },
                Finding::MixedFundingSources { batch_index: 2 },
            ]
        );
    }

    // covers: REQ-VER-001, REQ-VER-004
    #[test]
    fn an_address_is_stated_only_when_every_batch_is_known_to_use_it() {
        // One batch's input could not be resolved: nothing contradicts the others, but the
        // single address is not established either.
        let r = with_funding(
            vec![good(0, 1_000, 5), good(1, 2_000, 5)],
            vec![Finding::PrevoutUnresolved { batch_index: 1 }],
            &[Some(ADDRESS_A), None],
        )
        .unwrap();
        assert_eq!(r.funding_address, None);
        assert_eq!(
            r.findings,
            vec![Finding::PrevoutUnresolved { batch_index: 1 }]
        );
        // None known at all.
        let r = with_funding(vec![good(0, 1_000, 5)], vec![], &[None]).unwrap();
        assert_eq!(r.funding_address, None);
        assert!(r.findings.is_empty());
    }

    // covers: REQ-VER-001, REQ-VER-004
    #[test]
    fn funding_findings_come_after_the_supplied_ones_and_before_the_derived_ones() {
        let r = with_funding(
            vec![good(0, 1_000, 5), good(1, 2_000, 0)],
            vec![],
            &[Some(ADDRESS_A), Some(ADDRESS_B)],
        )
        .unwrap();
        assert_eq!(
            r.findings,
            vec![
                Finding::MixedFundingSources { batch_index: 1 },
                Finding::BatchPending { batch_index: 1 },
            ]
        );
    }

    // covers: REQ-PRIV-001, REQ-VER-004
    #[test]
    fn funding_addresses_must_line_up_with_the_batches_and_look_like_addresses() {
        let one = vec![good(0, 1_000, 5)];
        assert!(matches!(
            with_funding(one.clone(), vec![], &[]),
            Err(ReceiptError::Mismatch(_))
        ));
        assert!(matches!(
            with_funding(one.clone(), vec![], &[None, None]),
            Err(ReceiptError::Mismatch(_))
        ));
        for bad in [
            "",
            "short",
            "has a space in it 0000000",
            "tFAKE-with-punctuation-00000",
            "tFAKEnon\u{e9}asciiAddress000000",
            &"a".repeat(121),
        ] {
            assert!(
                matches!(
                    with_funding(one.clone(), vec![], &[Some(bad)]),
                    Err(ReceiptError::Mismatch(_))
                ),
                "{bad:?}"
            );
        }
        assert!(with_funding(one.clone(), vec![], &[Some(&"a".repeat(20))]).is_ok());
        assert!(with_funding(one.clone(), vec![], &[Some(&"a".repeat(120))]).is_ok());
        assert!(with_funding(one, vec![], &[Some(&"a".repeat(19))]).is_err());
    }

    // covers: REQ-VER-001, REQ-VER-004
    #[test]
    fn without_funding_facts_the_old_entry_point_states_no_address_and_flags_nothing() {
        let r = chain_receipt(1_000, 1, vec![good(0, 1_000, 5)], vec![]);
        assert_eq!(r.funding_address, None);
        assert!(r.findings.is_empty());
        assert_eq!(r.phase, CampaignPhase::Settled);
    }

    // covers: REQ-PRIV-001, REQ-VER-004
    #[test]
    fn the_operator_receipt_states_the_campaign_address_or_none_and_refuses_a_bad_one() {
        let f = fixture();
        let build = |address: Option<&str>| {
            PublicReceipt::assemble(ReceiptInputs {
                campaign_id: &f.campaign,
                network: Network::Testnet,
                manifest_commitment: f.commitment,
                fee_policy: &FeePolicy::zip317_text(),
                pool: Pool::Ironwood,
                batches: &f.batches,
                fundings: &f.fundings,
                statuses: &f.statuses,
                funding_state: FundingState::Funded,
                required_depth: 1,
                funding_address: address,
                funding_source: None,
            })
        };
        assert_eq!(
            build(Some(ADDRESS_A)).unwrap().funding_address.as_deref(),
            Some(ADDRESS_A)
        );
        assert_eq!(build(None).unwrap().funding_address, None);
        assert!(matches!(
            build(Some("not an address")),
            Err(ReceiptError::Mismatch(_))
        ));
    }

    // covers: REQ-PRIV-001, REQ-VER-004
    #[test]
    fn the_funding_address_sits_after_the_network_in_json_and_old_json_still_reads() {
        let r = with_funding(vec![good(0, 1_000, 5)], vec![], &[Some(ADDRESS_A)]).unwrap();
        let text = serde_json::to_string(&r).unwrap();
        let network = text.find("\"network\"").unwrap();
        let funding = text.find("\"funding_address\"").unwrap();
        let declared = text.find("\"declared_total\"").unwrap();
        assert!(network < funding && funding < declared, "{text}");
        // A receipt written before the field existed reads back with no address.
        let mut value = serde_json::to_value(&r).unwrap();
        value.as_object_mut().unwrap().remove("funding_address");
        let old: PublicReceipt = serde_json::from_value(value).unwrap();
        assert_eq!(old.funding_address, None);
        // And it is a closed schema: an unknown key is still refused.
        let mut value = serde_json::to_value(&r).unwrap();
        value["funding_addr"] = serde_json::json!("x");
        assert!(serde_json::from_value::<PublicReceipt>(value).is_err());
    }

    // ---- what the deposit spent ----------------------------------------------

    // covers: REQ-VER-007
    #[test]
    fn deposits_combine_into_one_source_and_one_transparent_deposit_decides() {
        use FundingSource::{Shielded, Transparent};
        assert_eq!(FundingSource::combine([Some(Shielded)]), Some(Shielded));
        assert_eq!(
            FundingSource::combine([Some(Shielded), Some(Shielded)]),
            Some(Shielded)
        );
        assert_eq!(
            FundingSource::combine([Some(Transparent)]),
            Some(Transparent)
        );
        // One transparent deposit is enough, whatever is known about the others.
        assert_eq!(
            FundingSource::combine([Some(Shielded), Some(Transparent)]),
            Some(Transparent)
        );
        assert_eq!(
            FundingSource::combine([None, Some(Transparent)]),
            Some(Transparent)
        );
        // Shielded only when every deposit is known to be.
        assert_eq!(FundingSource::combine([Some(Shielded), None]), None);
        assert_eq!(FundingSource::combine([None]), None);
        assert_eq!(
            FundingSource::combine([]),
            None,
            "no deposit at all is not a shielded one"
        );
    }

    // covers: REQ-VER-007
    #[test]
    fn the_funding_source_sits_after_the_funding_address_and_old_json_still_reads() {
        let mut r = with_funding(vec![good(0, 1_000, 5)], vec![], &[Some(ADDRESS_A)]).unwrap();
        for (source, text) in [
            (FundingSource::Shielded, "\"funding_source\":\"shielded\""),
            (
                FundingSource::Transparent,
                "\"funding_source\":\"transparent\"",
            ),
        ] {
            r.funding_source = Some(source);
            let json = serde_json::to_string(&r).unwrap();
            let address = json.find("\"funding_address\"").unwrap();
            let key = json.find("\"funding_source\"").unwrap();
            let declared = json.find("\"declared_total\"").unwrap();
            assert!(address < key && key < declared, "{json}");
            assert!(json.contains(text), "{json}");
            assert_eq!(serde_json::from_str::<PublicReceipt>(&json).unwrap(), r);
        }
        // A receipt written before the field existed reads back as not established.
        let mut value = serde_json::to_value(&r).unwrap();
        value.as_object_mut().unwrap().remove("funding_source");
        let old: PublicReceipt = serde_json::from_value(value).unwrap();
        assert_eq!(old.funding_source, None);
        // A closed set: nothing else reads.
        for bad in ["mixed", "Shielded", "", "unknown"] {
            let mut value = serde_json::to_value(&r).unwrap();
            value["funding_source"] = serde_json::json!(bad);
            assert!(
                serde_json::from_value::<PublicReceipt>(value).is_err(),
                "{bad:?}"
            );
        }
    }

    // covers: REQ-VER-007
    #[test]
    fn where_the_deposit_came_from_is_not_a_finding_and_never_changes_the_phase() {
        for source in [
            Some(FundingSource::Transparent),
            Some(FundingSource::Shielded),
            None,
        ] {
            let r = PublicReceipt::from_chain_facts_with_funding(
                ChainReceiptInputs {
                    campaign_id: None,
                    network: Network::Testnet,
                    manifest_commitment: ManifestCommitment::from_bytes([0xee; 32]),
                    declared_total: Zatoshi::new(1_000).unwrap(),
                    required_depth: 1,
                    batches: vec![good(0, 1_000, 5)],
                    findings: vec![],
                    funding_source: source,
                },
                &[Some(ADDRESS_A.to_owned())],
            )
            .unwrap();
            assert_eq!(r.funding_source, source);
            assert!(r.findings.is_empty(), "{source:?}");
            assert_eq!(r.phase, CampaignPhase::Settled, "{source:?}");
        }
    }

    // covers: REQ-VER-007
    #[test]
    fn the_operator_receipt_states_the_source_it_is_given() {
        let f = fixture();
        let base = ReceiptInputs {
            campaign_id: &f.campaign,
            network: Network::Testnet,
            manifest_commitment: f.commitment,
            fee_policy: &FeePolicy::zip317_text(),
            pool: Pool::Ironwood,
            batches: &f.batches,
            fundings: &f.fundings,
            statuses: &f.statuses,
            funding_state: FundingState::Funded,
            required_depth: 1,
            funding_address: Some(ADDRESS_A),
            funding_source: None,
        };
        for source in [
            Some(FundingSource::Shielded),
            Some(FundingSource::Transparent),
            None,
        ] {
            let r = PublicReceipt::assemble(ReceiptInputs {
                funding_source: source,
                ..base
            })
            .unwrap();
            assert_eq!(r.funding_source, source);
        }
    }
}
