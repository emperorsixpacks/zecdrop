//! The headless, resumable payout engine (REQ-RES-001).
//!
//! The [`Engine`] walks every batch through `Planned -> Built -> Broadcast ->
//! Confirmed`, one unit of work per [`Engine::step`], reporting each step as a
//! serializable [`ProgressEvent`]. It holds no state that cannot be rebuilt from
//! the [`Ledger`], so a crashed process resumes by constructing a new engine over
//! the same ledger.
//!
//! The rules that make resuming safe:
//!
//! * the built transaction (txid **and** raw bytes) is written to the ledger
//!   *before* it is broadcast;
//! * a batch found in `Built` is broadcast again from the **stored** bytes. The
//!   [`Distributor`] is never asked to build it a second time, so the txid cannot
//!   change and the batch cannot be paid twice;
//! * `Broadcast` batches are polled for confirmations, and batches confirmed at
//!   the required depth are skipped;
//! * a batch whose broadcast transaction the node stops reporting (it was dropped from the
//!   mempool, or the node restarted) is sent again from the **stored** bytes, a bounded number
//!   of times, on a schedule ([`RebroadcastPolicy`]). It is never built again: the txid is the
//!   one the ledger already holds;
//! * a batch already in the ledger is never planned again.
//!
//! Consequence for implementers: [`Distributor::broadcast`] must be idempotent.
//! Re-sending a transaction the node already knows must succeed, because a crash
//! between a successful broadcast and the ledger write leads to a second send.
//!
//! The campaign is `Settled` only when every batch is confirmed at the required depth.
//! Pick a depth deep enough that a reorganization is not a practical concern; the
//! engine does not undo a batch once it is final.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::amount::Zatoshi;
use crate::error::{AmountError, LedgerError};
use crate::fee::{standard_funding_required, FeePolicy};
use crate::ids::{CampaignId, OutPoint, Txid};
use crate::ledger::{BatchStatus, Ledger};
use crate::phase::{derive_phase, is_final, CampaignPhase, FundingState};
use crate::planner::Batch;

/// The transparent funds one batch spends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FundingRef {
    /// The unspent output to spend.
    pub outpoint: OutPoint,
    /// Its value. Must cover the batch total plus the ZIP-317 fee.
    pub value: Zatoshi,
}

/// A fully built, signed batch transaction.
#[derive(Clone, PartialEq, Eq)]
pub struct BuiltBatch {
    /// The transaction id.
    pub txid: Txid,
    /// The serialized transaction, exactly as it will be broadcast.
    pub raw_tx: Vec<u8>,
}

impl fmt::Debug for BuiltBatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "BuiltBatch{{txid: {}, raw_tx: <{} bytes>}}",
            self.txid,
            self.raw_tx.len()
        )
    }
}

/// How the engine should treat a [`Distributor`] error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// Worth retrying later (network down, node busy). The batch stays as it is.
    Transient,
    /// Retrying cannot help (transaction rejected, funds missing). The batch is
    /// marked `Failed` and left for a human.
    Permanent,
}

/// The chain-facing port, implemented in `drop-zcash`.
pub trait Distributor {
    /// The adapter's error type. Its `Display` text may be stored in the ledger
    /// and shown to users, so it must not contain recipient data.
    type Error: std::error::Error + 'static;

    /// Builds and signs the transaction for `batch`, spending `funding`.
    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, Self::Error>;

    /// Submits a built transaction to the network. Must be idempotent: sending a
    /// transaction the node already has counts as success.
    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), Self::Error>;

    /// How many confirmations `txid` has: `None` if the node does not know it,
    /// `Some(0)` if it is only in the mempool, `Some(n)` once mined (counting the
    /// including block).
    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, Self::Error>;

    /// Classifies an error. The default treats every error as transient.
    fn classify(&self, _error: &Self::Error) -> FailureKind {
        FailureKind::Transient
    }
}

impl<D: Distributor + ?Sized> Distributor for &mut D {
    type Error = D::Error;

    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, Self::Error> {
        (**self).build_batch(batch, funding)
    }

    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), Self::Error> {
        (**self).broadcast(built)
    }

    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, Self::Error> {
        (**self).confirmations(txid)
    }

    fn classify(&self, error: &Self::Error) -> FailureKind {
        (**self).classify(error)
    }
}

/// One step of progress, for streaming to a UI. Carries batch indices, counts and
/// transaction ids only; never recipient data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProgressEvent {
    /// A batch transaction was built and stored.
    Built {
        /// Batch index.
        batch_index: u32,
        /// The stored transaction id.
        txid: Txid,
        /// Number of Orchard outputs in the batch.
        outputs: u32,
    },
    /// The stored transaction was broadcast.
    Broadcast {
        /// Batch index.
        batch_index: u32,
        /// The transaction id.
        txid: Txid,
    },
    /// A batch's confirmation count was recorded.
    Confirmed {
        /// Batch index.
        batch_index: u32,
        /// The transaction id.
        txid: Txid,
        /// Confirmations now on record.
        depth: u32,
        /// Depth at which the batch counts as final.
        required_depth: u32,
    },
    /// Nothing advanced: a batch is still waiting for confirmations.
    Waiting {
        /// Batch that was polled.
        batch_index: u32,
        /// Confirmations the node reported (0 if unseen or unconfirmed).
        observed_depth: u32,
        /// Depth at which the batch counts as final.
        required_depth: u32,
    },
    /// A batch failed permanently and was marked `Failed`.
    Failed {
        /// Batch index.
        batch_index: u32,
        /// Why (adapter text, free of recipient data).
        reason: String,
    },
    /// Nothing more can be done automatically because some batches failed.
    Halted {
        /// Indices of the failed batches.
        failed_batches: Vec<u32>,
    },
    /// Every batch is confirmed at the required depth.
    Settled {
        /// The campaign.
        campaign_id: CampaignId,
        /// Number of batches.
        batches: u32,
    },
}

/// Why the engine could not be built or could not take a step.
#[derive(Debug, Error)]
pub enum EngineError<E: std::error::Error + 'static> {
    /// The engine was given inconsistent inputs.
    #[error("invalid engine setup: {0}")]
    Config(&'static str),
    /// A batch's funding input cannot cover its total plus fee.
    #[error(
        "batch {batch_index} needs {required} coins of funding but its input holds {available}"
    )]
    Underfunded {
        /// Batch index.
        batch_index: u32,
        /// Total plus fee.
        required: Zatoshi,
        /// Value of the funding input.
        available: Zatoshi,
    },
    /// Amount arithmetic failed.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// The ledger refused or failed an operation.
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    /// The ledger has no entry for a batch the engine registered. Re-planning it
    /// could pay it twice, so the engine stops.
    #[error("ledger has no record of batch {batch_index}; refusing to plan it again")]
    MissingStatus {
        /// Batch index.
        batch_index: u32,
    },
    /// The distributor failed with a transient error; the batch is unchanged and
    /// the step can be retried.
    #[error("distributor failed on batch {batch_index}: {source}")]
    Distributor {
        /// Batch index.
        batch_index: u32,
        /// The adapter's error.
        #[source]
        source: E,
    },
}

/// When a stored transaction that the node no longer reports is sent again.
///
/// Only a transaction the node does not know at all counts as unseen: one in the mempool with
/// no confirmations yet is known, and is waited for. The counts are per batch and per engine, so
/// a restarted process starts a fresh, equally bounded round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RebroadcastPolicy {
    /// Consecutive polls that find the transaction unseen before it is first sent again.
    pub after_unseen_polls: u32,
    /// Further unseen polls between one re-send and the next.
    pub every_unseen_polls: u32,
    /// The most times one transaction is sent again; 0 turns re-sending off.
    pub max_rebroadcasts: u32,
}

impl Default for RebroadcastPolicy {
    fn default() -> Self {
        RebroadcastPolicy {
            after_unseen_polls: 5,
            every_unseen_polls: 10,
            max_rebroadcasts: 5,
        }
    }
}

/// How a batch's transaction has been missing, in this engine.
#[derive(Clone, Copy, Debug, Default)]
struct Unseen {
    /// Consecutive polls that found it unknown to the node.
    polls: u32,
    /// Times it has been sent again.
    resent: u32,
}

/// The resumable payout state machine.
pub struct Engine<D: Distributor, L: Ledger> {
    campaign_id: CampaignId,
    batches: Vec<Batch>,
    fundings: Vec<FundingRef>,
    required_depth: u32,
    distributor: D,
    ledger: L,
    poll_cursor: usize,
    rebroadcast: RebroadcastPolicy,
    unseen: HashMap<u32, Unseen>,
}

impl<D: Distributor, L: Ledger> fmt::Debug for Engine<D, L> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Engine{{campaign_id: {}, batches: {}, required_depth: {}}}",
            self.campaign_id,
            self.batches.len(),
            self.required_depth
        )
    }
}

type StepResult<D> = Result<ProgressEvent, EngineError<<D as Distributor>::Error>>;

impl<D: Distributor, L: Ledger> Engine<D, L> {
    /// Sets up an engine over `batches`, with one funding input per batch.
    ///
    /// Batches the ledger has never seen are recorded as `Planned`; batches it
    /// already knows are left exactly as they are. Fails if there are no batches,
    /// the funding list does not match the batches, `required_depth` is zero, or a
    /// funding input is too small for its batch under `fee_policy` (the policy the
    /// distributor builds with; the engine uses it only for that check).
    pub fn new(
        campaign_id: CampaignId,
        batches: Vec<Batch>,
        fundings: Vec<FundingRef>,
        required_depth: u32,
        fee_policy: &FeePolicy,
        distributor: D,
        mut ledger: L,
    ) -> Result<Self, EngineError<D::Error>> {
        if batches.is_empty() {
            return Err(EngineError::Config("no batches to run"));
        }
        if fundings.len() != batches.len() {
            return Err(EngineError::Config(
                "need exactly one funding input per batch",
            ));
        }
        if required_depth == 0 {
            return Err(EngineError::Config(
                "required confirmation depth must be at least 1",
            ));
        }
        for (position, (batch, funding)) in batches.iter().zip(&fundings).enumerate() {
            if usize::try_from(batch.index()).ok() != Some(position) {
                return Err(EngineError::Config("batch indices must be 0, 1, 2, ..."));
            }
            let required =
                standard_funding_required(fee_policy, batch.total(), batch.output_count())?;
            if funding.value < required {
                return Err(EngineError::Underfunded {
                    batch_index: batch.index(),
                    required,
                    available: funding.value,
                });
            }
        }
        for batch in &batches {
            if ledger.get(&campaign_id, batch.index())?.is_none() {
                ledger.record(&campaign_id, batch.index(), BatchStatus::Planned)?;
            }
        }
        Ok(Engine {
            campaign_id,
            batches,
            fundings,
            required_depth,
            distributor,
            ledger,
            poll_cursor: 0,
            rebroadcast: RebroadcastPolicy::default(),
            unseen: HashMap::new(),
        })
    }

    /// Replaces the schedule on which a transaction the node no longer reports is sent again.
    #[must_use]
    pub fn with_rebroadcast_policy(mut self, policy: RebroadcastPolicy) -> Self {
        self.rebroadcast = policy;
        self
    }

    /// The campaign this engine runs.
    pub fn campaign_id(&self) -> &CampaignId {
        &self.campaign_id
    }

    /// The planned batches.
    pub fn batches(&self) -> &[Batch] {
        &self.batches
    }

    /// The confirmation depth at which a batch counts as final.
    pub fn required_depth(&self) -> u32 {
        self.required_depth
    }

    /// The ledger.
    pub fn ledger(&self) -> &L {
        &self.ledger
    }

    /// The distributor.
    pub fn distributor(&self) -> &D {
        &self.distributor
    }

    /// Gives back the distributor and ledger, for example to resume with new ones.
    pub fn into_parts(self) -> (D, L) {
        (self.distributor, self.ledger)
    }

    /// The current per-batch statuses, in batch order.
    pub fn statuses(&self) -> Result<Vec<BatchStatus>, EngineError<D::Error>> {
        self.batches
            .iter()
            .map(|batch| {
                self.ledger.get(&self.campaign_id, batch.index())?.ok_or(
                    EngineError::MissingStatus {
                        batch_index: batch.index(),
                    },
                )
            })
            .collect::<Result<Vec<_>, EngineError<D::Error>>>()
    }

    /// The campaign phase. The engine only runs funded campaigns, so funding is
    /// taken as confirmed.
    pub fn phase(&self) -> Result<CampaignPhase, EngineError<D::Error>> {
        Ok(derive_phase(
            FundingState::Funded,
            &self.statuses()?,
            self.required_depth,
        ))
    }

    /// Advances exactly one unit of work and reports it.
    ///
    /// Work is chosen in this order: the lowest-numbered batch that is `Planned`
    /// is built; else the lowest-numbered `Built` batch is broadcast from its
    /// stored bytes; else one batch awaiting confirmations is polled (round-robin).
    /// With nothing left to do the result is `Settled`, or `Halted` if any batch
    /// failed.
    ///
    /// A transient adapter error is returned as `Err` and leaves the batch as it
    /// was; calling `step` again retries. A permanent adapter error marks the batch
    /// `Failed` and is reported as an event.
    ///
    /// Polling a batch the node does not know at all counts toward sending its stored
    /// transaction again (see [`RebroadcastPolicy`]); doing so is reported as a `Broadcast`
    /// event, like the first send.
    pub fn step(&mut self) -> StepResult<D> {
        let statuses = self.statuses()?;

        for (position, status) in statuses.iter().enumerate() {
            match status {
                BatchStatus::Planned => return self.build(position),
                BatchStatus::Built { txid, raw_tx } => {
                    let built = BuiltBatch {
                        txid: *txid,
                        raw_tx: raw_tx.clone(),
                    };
                    return self.broadcast(position, built);
                }
                _ => {}
            }
        }

        let pending: Vec<usize> = statuses
            .iter()
            .enumerate()
            .filter(|(_, status)| self.awaits_confirmation(status))
            .map(|(position, _)| position)
            .collect();
        let Some(&position) = pending.get(self.poll_cursor % pending.len().max(1)) else {
            return Ok(self.finished(&statuses));
        };
        self.poll_cursor = self.poll_cursor.wrapping_add(1);
        match statuses.get(position) {
            Some(status) => self.poll(position, status),
            None => Err(EngineError::Config("batch position out of range")),
        }
    }

    /// Steps until the campaign is `Settled`, is `Halted`, or `max_idle_steps`
    /// consecutive steps made no progress (all `Waiting`). Each event is passed to
    /// `on_event` as it happens. Returns the final event, which tells the caller
    /// why it stopped; on `Waiting`, sleep and call again.
    ///
    /// A transient adapter error stops the run with `Err`; nothing is lost, and
    /// calling again continues from the ledger.
    pub fn run_to_completion(
        &mut self,
        max_idle_steps: u32,
        mut on_event: impl FnMut(&ProgressEvent),
    ) -> StepResult<D> {
        let mut idle = 0u32;
        loop {
            let event = self.step()?;
            on_event(&event);
            match event {
                ProgressEvent::Settled { .. } | ProgressEvent::Halted { .. } => return Ok(event),
                ProgressEvent::Waiting { .. } => {
                    idle += 1;
                    if idle > max_idle_steps {
                        return Ok(event);
                    }
                }
                _ => idle = 0,
            }
        }
    }

    fn awaits_confirmation(&self, status: &BatchStatus) -> bool {
        match status {
            BatchStatus::Broadcast { .. } => true,
            BatchStatus::Confirmed { .. } => !is_final(status, self.required_depth),
            _ => false,
        }
    }

    fn finished(&self, statuses: &[BatchStatus]) -> ProgressEvent {
        let failed_batches: Vec<u32> = self
            .batches
            .iter()
            .zip(statuses)
            .filter(|(_, status)| matches!(status, BatchStatus::Failed { .. }))
            .map(|(batch, _)| batch.index())
            .collect();
        if failed_batches.is_empty() {
            ProgressEvent::Settled {
                campaign_id: self.campaign_id.clone(),
                batches: u32::try_from(self.batches.len()).unwrap_or(u32::MAX),
            }
        } else {
            ProgressEvent::Halted { failed_batches }
        }
    }

    /// Builds a `Planned` batch and stores the result before anything is sent.
    fn build(&mut self, position: usize) -> StepResult<D> {
        let (Some(batch), Some(funding)) =
            (self.batches.get(position), self.fundings.get(position))
        else {
            return Err(EngineError::Config("batch position out of range"));
        };
        let batch_index = batch.index();
        let outputs = batch.output_count();
        match self.distributor.build_batch(batch, funding) {
            Ok(built) => {
                let txid = built.txid;
                self.ledger.record(
                    &self.campaign_id,
                    batch_index,
                    BatchStatus::Built {
                        txid,
                        raw_tx: built.raw_tx,
                    },
                )?;
                Ok(ProgressEvent::Built {
                    batch_index,
                    txid,
                    outputs,
                })
            }
            Err(error) => self.on_error(batch_index, error),
        }
    }

    /// Broadcasts a `Built` batch from its stored bytes.
    fn broadcast(&mut self, position: usize, built: BuiltBatch) -> StepResult<D> {
        let Some(batch) = self.batches.get(position) else {
            return Err(EngineError::Config("batch position out of range"));
        };
        let batch_index = batch.index();
        match self.distributor.broadcast(&built) {
            Ok(()) => {
                self.ledger.record(
                    &self.campaign_id,
                    batch_index,
                    BatchStatus::Broadcast { txid: built.txid },
                )?;
                Ok(ProgressEvent::Broadcast {
                    batch_index,
                    txid: built.txid,
                })
            }
            Err(error) => self.on_error(batch_index, error),
        }
    }

    /// Asks the node about a broadcast (or not yet deep enough) batch.
    fn poll(&mut self, position: usize, status: &BatchStatus) -> StepResult<D> {
        let (Some(batch), Some(txid)) = (self.batches.get(position), status.txid()) else {
            return Err(EngineError::Config("batch position out of range"));
        };
        let batch_index = batch.index();
        let reported = match self.distributor.confirmations(&txid) {
            Ok(confirmations) => confirmations,
            Err(error) => return self.on_error(batch_index, error),
        };
        let observed = reported.unwrap_or(0);
        let recorded = match status {
            BatchStatus::Confirmed { depth, .. } => *depth,
            _ => 0,
        };
        if reported.is_none() {
            return self.on_unseen(batch_index, txid);
        }
        // The node knows the transaction again: the count of missing polls starts over.
        self.unseen.remove(&batch_index);
        if observed >= 1 && observed != recorded {
            self.ledger.record(
                &self.campaign_id,
                batch_index,
                BatchStatus::Confirmed {
                    txid,
                    depth: observed,
                },
            )?;
            Ok(ProgressEvent::Confirmed {
                batch_index,
                txid,
                depth: observed,
                required_depth: self.required_depth,
            })
        } else {
            Ok(ProgressEvent::Waiting {
                batch_index,
                observed_depth: observed,
                required_depth: self.required_depth,
            })
        }
    }

    /// A poll found the batch's transaction unknown to the node. Counts it, and when the
    /// schedule says so sends the **stored** transaction again: it is read back from the
    /// ledger, never rebuilt, so it is the same transaction with the same id.
    fn on_unseen(&mut self, batch_index: u32, txid: Txid) -> StepResult<D> {
        let policy = self.rebroadcast;
        let entry = self.unseen.entry(batch_index).or_default();
        entry.polls = entry.polls.saturating_add(1);
        let due_at = policy
            .after_unseen_polls
            .saturating_add(entry.resent.saturating_mul(policy.every_unseen_polls));
        let due = entry.resent < policy.max_rebroadcasts && entry.polls >= due_at;
        if due {
            // Counted before the call, so that a send that keeps failing is still bounded.
            entry.resent += 1;
        }
        let waiting = ProgressEvent::Waiting {
            batch_index,
            observed_depth: 0,
            required_depth: self.required_depth,
        };
        if !due {
            return Ok(waiting);
        }
        let Some((stored_txid, raw_tx)) = self.ledger.built_tx(&self.campaign_id, batch_index)?
        else {
            return Ok(waiting);
        };
        if stored_txid != txid {
            return Err(EngineError::Config(
                "the stored transaction is not the one the batch is waiting for",
            ));
        }
        match self.distributor.broadcast(&BuiltBatch {
            txid: stored_txid,
            raw_tx,
        }) {
            Ok(()) => Ok(ProgressEvent::Broadcast { batch_index, txid }),
            Err(error) => self.on_error(batch_index, error),
        }
    }

    /// Applies the adapter's classification of an error.
    fn on_error(&mut self, batch_index: u32, error: D::Error) -> StepResult<D> {
        match self.distributor.classify(&error) {
            FailureKind::Transient => Err(EngineError::Distributor {
                batch_index,
                source: error,
            }),
            FailureKind::Permanent => {
                let reason = error.to_string();
                self.ledger.record(
                    &self.campaign_id,
                    batch_index,
                    BatchStatus::Failed {
                        reason: reason.clone(),
                        // The ledger fills in the transaction built for the batch, if any.
                        txid: None,
                    },
                )?;
                Ok(ProgressEvent::Failed {
                    batch_index,
                    reason,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::InMemoryLedger;
    use crate::planner::plan_batches;
    use crate::recipient::Recipient;
    use std::collections::HashMap;

    // ---- fakes -----------------------------------------------------------

    #[derive(Debug, Error)]
    enum FakeError {
        #[error("node unreachable")]
        Unreachable,
        #[error("transaction rejected by the node")]
        Rejected,
    }

    /// A scriptable distributor. Every build yields a *new* txid (batch index plus a
    /// per-batch counter), so any unexpected rebuild shows up as a changed txid.
    #[derive(Default)]
    struct FakeDistributor {
        built: Vec<u32>,
        broadcasts: Vec<(Txid, Vec<u8>)>,
        polled: Vec<Txid>,
        builds_per_batch: HashMap<u32, u8>,
        depth: HashMap<Txid, u32>,
        /// Number of upcoming broadcast calls that fail transiently.
        fail_broadcasts: u32,
        /// Batch indices whose build is rejected permanently.
        reject_build: Vec<u32>,
        /// Whether broadcast calls are rejected permanently.
        reject_broadcast: bool,
        /// Whether confirmations calls fail transiently.
        fail_polls: bool,
        /// Whether the node ignores what it is sent: a broadcast succeeds but the transaction
        /// stays unknown to it.
        silent_broadcasts: bool,
    }

    impl FakeDistributor {
        fn txid_of(&self, batch: u32) -> Option<Txid> {
            self.built_txids().get(&batch).copied()
        }

        fn built_txids(&self) -> HashMap<u32, Txid> {
            let mut out = HashMap::new();
            for (txid, raw) in &self.broadcasts {
                out.insert(u32::from(raw[0]), *txid);
            }
            out
        }

        fn set_depth(&mut self, txid: Txid, depth: u32) {
            self.depth.insert(txid, depth);
        }

        /// The node no longer knows the transaction (dropped from the mempool, restarted).
        fn forget(&mut self, txid: Txid) {
            self.depth.remove(&txid);
        }
    }

    impl Distributor for FakeDistributor {
        type Error = FakeError;

        fn build_batch(&mut self, batch: &Batch, _: &FundingRef) -> Result<BuiltBatch, FakeError> {
            if self.reject_build.contains(&batch.index()) {
                return Err(FakeError::Rejected);
            }
            self.built.push(batch.index());
            let nonce = self.builds_per_batch.entry(batch.index()).or_insert(0);
            *nonce += 1;
            let index = u8::try_from(batch.index()).unwrap();
            Ok(BuiltBatch {
                txid: Txid::from_bytes([index.wrapping_add(*nonce * 16); 32]),
                raw_tx: vec![index, *nonce, 0xaa],
            })
        }

        fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), FakeError> {
            if self.reject_broadcast {
                return Err(FakeError::Rejected);
            }
            if self.fail_broadcasts > 0 {
                self.fail_broadcasts -= 1;
                return Err(FakeError::Unreachable);
            }
            self.broadcasts.push((built.txid, built.raw_tx.clone()));
            if !self.silent_broadcasts {
                self.depth.entry(built.txid).or_insert(0);
            }
            Ok(())
        }

        fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, FakeError> {
            if self.fail_polls {
                return Err(FakeError::Unreachable);
            }
            self.polled.push(*txid);
            Ok(self.depth.get(txid).copied())
        }

        fn classify(&self, error: &FakeError) -> FailureKind {
            match error {
                FakeError::Unreachable => FailureKind::Transient,
                FakeError::Rejected => FailureKind::Permanent,
            }
        }
    }

    /// A ledger that "crashes" (fails without applying) on chosen record calls.
    struct CrashingLedger<'a> {
        inner: &'a mut InMemoryLedger,
        calls: usize,
        crash_on_call: Option<usize>,
    }

    impl<'a> CrashingLedger<'a> {
        fn new(inner: &'a mut InMemoryLedger) -> Self {
            Self {
                inner,
                calls: 0,
                crash_on_call: None,
            }
        }

        /// Makes the next `record` call fail without applying anything.
        fn crash_next(&mut self) {
            self.crash_on_call = Some(self.calls);
        }
    }

    impl Ledger for CrashingLedger<'_> {
        fn get(&self, c: &CampaignId, i: u32) -> Result<Option<BatchStatus>, LedgerError> {
            self.inner.get(c, i)
        }

        fn record(
            &mut self,
            c: &CampaignId,
            i: u32,
            status: BatchStatus,
        ) -> Result<(), LedgerError> {
            let call = self.calls;
            self.calls += 1;
            if self.crash_on_call == Some(call) {
                return Err(LedgerError::Storage("simulated crash".into()));
            }
            self.inner.record(c, i, status)
        }
    }

    // ---- fixtures --------------------------------------------------------

    fn campaign() -> CampaignId {
        CampaignId::new("camp").unwrap()
    }

    fn policy() -> FeePolicy {
        FeePolicy::zip317_text()
    }

    fn recipients(n: usize) -> Vec<Recipient> {
        (0..n)
            .map(|i| {
                Recipient::new(
                    format!("u1row{i:04}"),
                    Zatoshi::new(1_000_000 + i as u64).unwrap(),
                    None,
                )
                .unwrap()
            })
            .collect()
    }

    /// `n_batches` batches of two recipients each.
    fn batches(n_batches: usize) -> Vec<Batch> {
        plan_batches(&recipients(n_batches * 2), 2).unwrap()
    }

    fn fundings(batches: &[Batch]) -> Vec<FundingRef> {
        batches
            .iter()
            .map(|b| FundingRef {
                outpoint: OutPoint {
                    txid: Txid::from_bytes([0xf0 + b.index() as u8; 32]),
                    vout: 0,
                },
                value: Zatoshi::new(b.total().as_u64() + 1_000_000).unwrap(),
            })
            .collect()
    }

    type TestEngine<'a> = Engine<&'a mut FakeDistributor, &'a mut InMemoryLedger>;

    fn engine<'a>(
        n_batches: usize,
        depth: u32,
        d: &'a mut FakeDistributor,
        l: &'a mut InMemoryLedger,
    ) -> TestEngine<'a> {
        let b = batches(n_batches);
        let f = fundings(&b);
        Engine::new(campaign(), b, f, depth, &policy(), d, l).unwrap()
    }

    // ---- REQ-RES-001 -----------------------------------------------------

    // covers: REQ-RES-001
    #[test]
    fn builds_then_broadcasts_then_confirms_in_order() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l);

        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Built {
                batch_index: 0,
                outputs: 2,
                ..
            }
        ));
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Broadcast { batch_index: 0, .. }
        ));
        // Mempool only: still waiting.
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Waiting {
                batch_index: 0,
                observed_depth: 0,
                required_depth: 1
            }
        ));
        let txid = e.distributor().txid_of(0).unwrap();
        e.distributor.set_depth(txid, 1);
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Confirmed { depth: 1, .. }
        ));
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Settled { batches: 1, .. }
        ));
        assert_eq!(e.phase().unwrap(), CampaignPhase::Settled);
    }

    // covers: REQ-RES-001
    #[test]
    fn the_built_tx_is_in_the_ledger_before_it_is_broadcast() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        {
            let mut e = engine(1, 1, &mut d, &mut l);
            e.step().unwrap(); // build only
        }
        assert!(d.broadcasts.is_empty(), "nothing sent yet");
        match l.get(&campaign(), 0).unwrap().unwrap() {
            BatchStatus::Built { txid, raw_tx } => {
                assert_eq!(raw_tx, vec![0, 1, 0xaa]);
                assert_eq!(txid, Txid::from_bytes([16; 32]));
            }
            other => panic!("expected Built, got {other:?}"),
        }
    }

    // covers: REQ-RES-001
    #[test]
    fn crash_after_build_before_broadcast_resumes_with_the_same_txid() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        // Run 1: build the batch, then "crash" (drop the engine).
        let first_txid = {
            let mut e = engine(1, 1, &mut d, &mut l);
            match e.step().unwrap() {
                ProgressEvent::Built { txid, .. } => txid,
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(d.built, vec![0]);
        assert!(d.broadcasts.is_empty());

        // Run 2: a fresh engine over the same ledger and distributor.
        let mut e = engine(1, 1, &mut d, &mut l);
        match e.step().unwrap() {
            ProgressEvent::Broadcast { txid, .. } => assert_eq!(txid, first_txid),
            other => panic!("{other:?}"),
        }
        drop(e);

        assert_eq!(d.built, vec![0], "no second build");
        assert_eq!(d.broadcasts.len(), 1, "broadcast exactly once more");
        assert_eq!(d.broadcasts[0].0, first_txid);
        assert_eq!(
            d.broadcasts[0].1,
            vec![0, 1, 0xaa],
            "stored bytes, not rebuilt"
        );
        assert_eq!(
            l.get(&campaign(), 0).unwrap(),
            Some(BatchStatus::Broadcast { txid: first_txid })
        );
    }

    // covers: REQ-RES-001
    #[test]
    fn crash_while_storing_the_built_tx_never_broadcasts_an_unstored_tx() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        // The ledger write of the built tx fails, as if the process died right then.
        let b = batches(1);
        let f = fundings(&b);
        {
            // `Planned` is written in `new`, so crash on the *next* record call.
            let mut crashing = CrashingLedger::new(&mut l);
            let mut e = Engine::new(
                campaign(),
                b.clone(),
                f.clone(),
                1,
                &policy(),
                &mut d,
                &mut crashing,
            )
            .unwrap();
            e.ledger.crash_next();
            assert!(matches!(
                e.step(),
                Err(EngineError::Ledger(LedgerError::Storage(_)))
            ));
        }
        assert!(
            d.broadcasts.is_empty(),
            "an unstored tx must never be broadcast"
        );
        assert_eq!(l.get(&campaign(), 0).unwrap(), Some(BatchStatus::Planned));

        // Resume: the batch is built again, stored, and only that tx is broadcast.
        let mut e = Engine::new(campaign(), b, f, 1, &policy(), &mut d, &mut l).unwrap();
        e.step().unwrap();
        e.step().unwrap();
        drop(e);
        assert_eq!(d.built, vec![0, 0], "the unstored build was discarded");
        let stored = l.get(&campaign(), 0).unwrap().unwrap().txid().unwrap();
        assert_eq!(d.broadcasts.len(), 1);
        assert_eq!(d.broadcasts[0].0, stored);
        assert_eq!(stored, Txid::from_bytes([32; 32]), "second build's txid");
    }

    // covers: REQ-RES-001
    #[test]
    fn crash_after_broadcast_is_recorded_polls_without_rebuilding_or_resending() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        {
            let mut e = engine(1, 2, &mut d, &mut l);
            e.step().unwrap();
            e.step().unwrap(); // broadcast recorded, then crash
        }
        let txid = d.txid_of(0).unwrap();
        d.set_depth(txid, 1);

        let mut e = engine(1, 2, &mut d, &mut l);
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Confirmed { depth: 1, .. }
        ));
        e.distributor.set_depth(txid, 2);
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Confirmed { depth: 2, .. }
        ));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Settled { .. }));
        drop(e);

        assert_eq!(d.built, vec![0]);
        assert_eq!(d.broadcasts.len(), 1, "never re-sent");
    }

    // covers: REQ-RES-001
    #[test]
    fn crash_after_broadcast_but_before_it_is_recorded_resends_the_same_bytes() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let b = batches(1);
        let f = fundings(&b);
        {
            let mut crashing = CrashingLedger::new(&mut l);
            let mut e = Engine::new(
                campaign(),
                b.clone(),
                f.clone(),
                1,
                &policy(),
                &mut d,
                &mut crashing,
            )
            .unwrap();
            e.step().unwrap(); // Built is stored
                               // The broadcast reaches the network, but the ledger write after it fails.
            e.ledger.crash_next();
            assert!(matches!(
                e.step(),
                Err(EngineError::Ledger(LedgerError::Storage(_)))
            ));
        }
        assert_eq!(d.broadcasts.len(), 1, "the first send happened");
        let first = d.broadcasts[0].clone();
        assert!(matches!(
            l.get(&campaign(), 0).unwrap(),
            Some(BatchStatus::Built { .. })
        ));

        let mut e = Engine::new(campaign(), b, f, 1, &policy(), &mut d, &mut l).unwrap();
        assert!(matches!(e.step().unwrap(), ProgressEvent::Broadcast { .. }));
        drop(e);

        assert_eq!(d.built, vec![0], "no second build");
        assert_eq!(d.broadcasts.len(), 2, "re-sent once");
        assert_eq!(d.broadcasts[1], first, "same txid and same raw bytes");
    }

    // covers: REQ-RES-001
    #[test]
    fn built_batches_never_consult_the_distributor_build_even_if_it_would_change_the_txid() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        // Pre-load the ledger with a Built tx whose txid the fake would never produce.
        let stored = Txid::from_bytes([0x77; 32]);
        l.record(&campaign(), 0, BatchStatus::Planned).unwrap();
        l.record(
            &campaign(),
            0,
            BatchStatus::Built {
                txid: stored,
                raw_tx: vec![9, 9, 9],
            },
        )
        .unwrap();

        let mut e = engine(1, 1, &mut d, &mut l);
        match e.step().unwrap() {
            ProgressEvent::Broadcast { txid, .. } => assert_eq!(txid, stored),
            other => panic!("{other:?}"),
        }
        drop(e);
        assert!(
            d.built.is_empty(),
            "build_batch must not be called for a Built batch"
        );
        assert_eq!(d.broadcasts, vec![(stored, vec![9, 9, 9])]);
    }

    // covers: REQ-RES-001
    #[test]
    fn recorded_batches_are_never_replanned() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let stored = Txid::from_bytes([0x55; 32]);
        l.record(&campaign(), 0, BatchStatus::Planned).unwrap();
        l.record(
            &campaign(),
            0,
            BatchStatus::Built {
                txid: stored,
                raw_tx: vec![1],
            },
        )
        .unwrap();
        l.record(&campaign(), 0, BatchStatus::Broadcast { txid: stored })
            .unwrap();
        l.record(
            &campaign(),
            0,
            BatchStatus::Confirmed {
                txid: stored,
                depth: 4,
            },
        )
        .unwrap();

        // Creating the engine must not touch the recorded batch.
        let e = engine(2, 3, &mut d, &mut l);
        assert_eq!(
            e.statuses().unwrap(),
            vec![
                BatchStatus::Confirmed {
                    txid: stored,
                    depth: 4
                },
                BatchStatus::Planned
            ]
        );
    }

    // covers: REQ-RES-001
    #[test]
    fn confirmed_batches_are_skipped() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(2, 1, &mut d, &mut l);
        for _ in 0..4 {
            e.step().unwrap(); // build 0, send 0, build 1, send 1
        }
        let t0 = e.distributor().txid_of(0).unwrap();
        let t1 = e.distributor().txid_of(1).unwrap();
        e.distributor.set_depth(t0, 5);
        e.distributor.set_depth(t1, 1);
        let mut events = Vec::new();
        let last = e
            .run_to_completion(5, |ev| events.push(ev.clone()))
            .unwrap();
        assert!(matches!(last, ProgressEvent::Settled { batches: 2, .. }));
        let polled_after_final = e.distributor().polled.iter().filter(|t| **t == t0).count();
        assert_eq!(
            polled_after_final, 1,
            "batch 0 was polled once, then skipped"
        );
    }

    // covers: REQ-RES-001
    #[test]
    fn transient_broadcast_errors_leave_the_batch_built_and_retry_succeeds() {
        let (mut d, mut l) = (
            FakeDistributor {
                fail_broadcasts: 2,
                ..Default::default()
            },
            InMemoryLedger::new(),
        );
        let mut e = engine(1, 1, &mut d, &mut l);
        e.step().unwrap(); // built
        for _ in 0..2 {
            match e.step() {
                Err(EngineError::Distributor { batch_index: 0, .. }) => {}
                other => panic!("expected a transient error, got {other:?}"),
            }
            assert!(
                matches!(e.statuses().unwrap()[0], BatchStatus::Built { .. }),
                "status stays Built"
            );
        }
        assert!(matches!(e.step().unwrap(), ProgressEvent::Broadcast { .. }));
        drop(e);
        assert_eq!(d.built, vec![0], "retries never rebuild");
        assert_eq!(d.broadcasts.len(), 1);
    }

    // covers: REQ-RES-001
    #[test]
    fn transient_poll_errors_change_nothing() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l);
        e.step().unwrap();
        e.step().unwrap();
        e.distributor.fail_polls = true;
        assert!(matches!(e.step(), Err(EngineError::Distributor { .. })));
        assert!(matches!(
            e.statuses().unwrap()[0],
            BatchStatus::Broadcast { .. }
        ));
        assert!(e.phase().unwrap() != CampaignPhase::Settled);
    }

    // covers: REQ-RES-001
    #[test]
    fn settled_only_when_every_batch_is_confirmed_at_the_required_depth() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(2, 3, &mut d, &mut l);
        for _ in 0..4 {
            e.step().unwrap();
        }
        let t0 = e.distributor().txid_of(0).unwrap();
        let t1 = e.distributor().txid_of(1).unwrap();

        // Batch 0 deep enough, batch 1 one short: never Settled.
        e.distributor.set_depth(t0, 3);
        e.distributor.set_depth(t1, 2);
        let mut events = Vec::new();
        let last = e
            .run_to_completion(3, |ev| events.push(ev.clone()))
            .unwrap();
        assert!(matches!(last, ProgressEvent::Waiting { .. }), "{last:?}");
        assert!(!events
            .iter()
            .any(|ev| matches!(ev, ProgressEvent::Settled { .. })));
        assert_eq!(
            e.phase().unwrap(),
            CampaignPhase::Sending { done: 1, total: 2 }
        );

        // Depth 3 for the second batch finishes the campaign.
        e.distributor.set_depth(t1, 3);
        let last = e
            .run_to_completion(3, |ev| events.push(ev.clone()))
            .unwrap();
        assert!(matches!(last, ProgressEvent::Settled { batches: 2, .. }));
        assert_eq!(e.phase().unwrap(), CampaignPhase::Settled);
        // Settled stays settled and is idempotent.
        assert!(matches!(e.step().unwrap(), ProgressEvent::Settled { .. }));
    }

    // covers: REQ-RES-001
    #[test]
    fn depth_updates_are_recorded_as_confirmations_grow() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 3, &mut d, &mut l);
        e.step().unwrap();
        e.step().unwrap();
        let txid = e.distributor().txid_of(0).unwrap();
        for depth in 1..=3 {
            e.distributor.set_depth(txid, depth);
            match e.step().unwrap() {
                ProgressEvent::Confirmed {
                    depth: got,
                    required_depth: 3,
                    ..
                } => assert_eq!(got, depth),
                other => panic!("{other:?}"),
            }
            assert_eq!(
                e.statuses().unwrap()[0],
                BatchStatus::Confirmed { txid, depth }
            );
        }
        assert!(matches!(e.step().unwrap(), ProgressEvent::Settled { .. }));
    }

    // covers: REQ-RES-001
    #[test]
    fn a_shallow_batch_the_node_stops_reporting_just_waits() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 3, &mut d, &mut l);
        e.step().unwrap();
        e.step().unwrap();
        let txid = e.distributor().txid_of(0).unwrap();
        e.distributor.set_depth(txid, 2);
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Confirmed { depth: 2, .. }
        ));

        // The node now reports the transaction as unconfirmed, then as unknown. The
        // engine records nothing new and never settles on stale depth.
        for observed in [Some(0), None] {
            match observed {
                Some(depth) => e.distributor.set_depth(txid, depth),
                None => {
                    e.distributor.depth.remove(&txid);
                }
            }
            assert!(matches!(
                e.step().unwrap(),
                ProgressEvent::Waiting {
                    observed_depth: 0,
                    ..
                }
            ));
            assert_eq!(
                e.statuses().unwrap()[0],
                BatchStatus::Confirmed { txid, depth: 2 }
            );
            assert_eq!(
                e.phase().unwrap(),
                CampaignPhase::Sending { done: 0, total: 1 }
            );
        }

        // It comes back and reaches the required depth.
        e.distributor.set_depth(txid, 3);
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Confirmed { depth: 3, .. }
        ));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Settled { .. }));
    }

    // covers: REQ-RES-001
    #[test]
    fn permanent_errors_mark_the_batch_failed_and_the_campaign_halts() {
        let (mut d, mut l) = (
            FakeDistributor {
                reject_build: vec![0],
                ..Default::default()
            },
            InMemoryLedger::new(),
        );
        let mut e = engine(2, 1, &mut d, &mut l);
        match e.step().unwrap() {
            ProgressEvent::Failed {
                batch_index: 0,
                reason,
            } => {
                assert_eq!(reason, "transaction rejected by the node");
            }
            other => panic!("{other:?}"),
        }
        // The other batch still runs; the failed one is never retried automatically.
        let t1 = {
            e.step().unwrap(); // build 1
            e.step().unwrap(); // send 1
            e.distributor().txid_of(1).unwrap()
        };
        e.distributor.set_depth(t1, 1);
        let result = e.run_to_completion(2, |_| {}).unwrap();
        assert_eq!(
            result,
            ProgressEvent::Halted {
                failed_batches: vec![0]
            }
        );
        assert_eq!(e.phase().unwrap(), CampaignPhase::Failed);
        assert_eq!(e.distributor().built, vec![1]);
    }

    // covers: REQ-RES-001
    #[test]
    fn permanent_broadcast_rejection_fails_the_batch() {
        let (mut d, mut l) = (
            FakeDistributor {
                reject_broadcast: true,
                ..Default::default()
            },
            InMemoryLedger::new(),
        );
        let mut e = engine(1, 1, &mut d, &mut l);
        e.step().unwrap();
        assert!(matches!(e.step().unwrap(), ProgressEvent::Failed { .. }));
        assert!(matches!(
            e.statuses().unwrap()[0],
            BatchStatus::Failed { .. }
        ));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Halted { .. }));
    }

    // covers: REQ-RES-001
    #[test]
    fn run_to_completion_reports_waiting_when_the_chain_is_quiet() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l);
        let mut events = Vec::new();
        let last = e
            .run_to_completion(2, |ev| events.push(ev.clone()))
            .unwrap();
        // built, broadcast, then 3 waits (budget of 2 idle steps exceeded on the third).
        assert!(matches!(last, ProgressEvent::Waiting { .. }));
        assert_eq!(events.len(), 5, "{events:?}");
    }

    // covers: REQ-RES-001
    #[test]
    fn polling_is_round_robin_so_one_stuck_batch_does_not_starve_others() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(3, 1, &mut d, &mut l);
        for _ in 0..6 {
            e.step().unwrap();
        }
        // Batch 0 never confirms; batches 1 and 2 do.
        let t1 = e.distributor().txid_of(1).unwrap();
        let t2 = e.distributor().txid_of(2).unwrap();
        e.distributor.set_depth(t1, 1);
        e.distributor.set_depth(t2, 1);
        let mut confirmed = Vec::new();
        for _ in 0..6 {
            if let ProgressEvent::Confirmed { batch_index, .. } = e.step().unwrap() {
                confirmed.push(batch_index);
            }
        }
        assert_eq!(confirmed, vec![1, 2]);
    }

    /// An engine over one batch that has been built and broadcast, whose transaction the node
    /// then forgets and keeps ignoring. Returns the engine's txid.
    fn forgotten(e: &mut TestEngine<'_>) -> Txid {
        e.step().unwrap(); // built
        e.step().unwrap(); // broadcast
        let txid = e.distributor().txid_of(0).unwrap();
        e.distributor.forget(txid);
        e.distributor.silent_broadcasts = true;
        txid
    }

    fn quick(after: u32, every: u32, max: u32) -> RebroadcastPolicy {
        RebroadcastPolicy {
            after_unseen_polls: after,
            every_unseen_polls: every,
            max_rebroadcasts: max,
        }
    }

    // covers: REQ-RES-001
    #[test]
    fn a_transaction_the_node_forgets_is_sent_again_from_the_stored_bytes_on_a_bounded_schedule() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(2, 3, 2));
        let txid = forgotten(&mut e);

        // Unseen polls 1..=12: sent again at the 2nd and the 5th, and never after that.
        let events: Vec<ProgressEvent> = (0..12).map(|_| e.step().unwrap()).collect();
        let resent_at: Vec<usize> = events
            .iter()
            .enumerate()
            .filter(|(_, ev)| matches!(ev, ProgressEvent::Broadcast { batch_index: 0, .. }))
            .map(|(i, _)| i + 1)
            .collect();
        assert_eq!(resent_at, vec![2, 5]);
        assert!(events
            .iter()
            .filter(|ev| !matches!(ev, ProgressEvent::Broadcast { .. }))
            .all(|ev| matches!(
                ev,
                ProgressEvent::Waiting {
                    observed_depth: 0,
                    ..
                }
            )));
        drop(e);

        // Every send was the same transaction, byte for byte, and it was built exactly once.
        assert_eq!(d.broadcasts.len(), 3, "the first send and two more");
        assert!(d
            .broadcasts
            .iter()
            .all(|sent| sent.0 == txid && sent.1 == d.broadcasts[0].1));
        assert_eq!(d.built, vec![0], "never built a second time");
        assert_eq!(
            l.get(&campaign(), 0).unwrap(),
            Some(BatchStatus::Broadcast { txid }),
            "and the ledger is as it was"
        );
    }

    // covers: REQ-RES-001
    #[test]
    fn a_transaction_the_node_knows_is_never_sent_again_however_long_it_waits() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(1, 1, 100));
        e.step().unwrap();
        e.step().unwrap();
        // In the mempool with no confirmations: known, so waited for.
        for _ in 0..30 {
            assert!(matches!(
                e.step().unwrap(),
                ProgressEvent::Waiting {
                    observed_depth: 0,
                    ..
                }
            ));
        }
        drop(e);
        assert_eq!(d.broadcasts.len(), 1);
    }

    // covers: REQ-RES-001
    #[test]
    fn seeing_the_transaction_again_starts_the_count_over() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(3, 3, 5));
        let txid = forgotten(&mut e);
        assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. })); // unseen 1
        assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. })); // unseen 2
        e.distributor.set_depth(txid, 0); // the node has it after all
        assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        e.distributor.forget(txid);
        // Two more unseen polls are not enough: the count began again at the sighting.
        assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Broadcast { .. }));
        drop(e);
        assert_eq!(d.broadcasts.len(), 2);
    }

    // covers: REQ-RES-001
    #[test]
    fn sending_again_can_be_turned_off() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(1, 1, 0));
        forgotten(&mut e);
        for _ in 0..10 {
            assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        }
        drop(e);
        assert_eq!(d.broadcasts.len(), 1);
    }

    // covers: REQ-RES-001
    #[test]
    fn a_resend_that_keeps_failing_transiently_is_still_bounded() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(1, 1, 2));
        forgotten(&mut e);
        e.distributor.fail_broadcasts = 100;
        // Two attempts fail with a retryable error and leave the batch as it was ...
        for _ in 0..2 {
            assert!(matches!(
                e.step(),
                Err(EngineError::Distributor { batch_index: 0, .. })
            ));
        }
        // ... and then the engine stops trying, however long the node stays silent.
        for _ in 0..10 {
            assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        }
        assert!(matches!(
            e.ledger().get(&campaign(), 0).unwrap(),
            Some(BatchStatus::Broadcast { .. })
        ));
    }

    // covers: REQ-RES-001, REQ-LED-001
    #[test]
    fn a_resend_the_node_rejects_fails_the_batch_and_keeps_the_transaction_id() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(1, 1, 3));
        let txid = forgotten(&mut e);
        e.distributor.reject_broadcast = true;
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Failed { batch_index: 0, .. }
        ));
        // The batch needs a person, and the record still names the transaction that may be
        // in a block already.
        assert_eq!(e.phase().unwrap(), CampaignPhase::Failed);
        let status = e.ledger().get(&campaign(), 0).unwrap().unwrap();
        assert!(matches!(status, BatchStatus::Failed { .. }));
        assert_eq!(status.txid(), Some(txid));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Halted { .. }));
        drop(e);
        assert_eq!(d.built, vec![0], "never rebuilt");
    }

    // covers: REQ-RES-001
    #[test]
    fn a_confirmed_but_not_final_batch_the_node_forgets_is_sent_again_too() {
        // A reorganisation can take the transaction out of the chain and the mempool both.
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = engine(1, 3, &mut d, &mut l).with_rebroadcast_policy(quick(2, 5, 1));
        e.step().unwrap();
        e.step().unwrap();
        let txid = e.distributor().txid_of(0).unwrap();
        e.distributor.set_depth(txid, 1);
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Confirmed { depth: 1, .. }
        ));
        e.distributor.forget(txid);
        e.distributor.silent_broadcasts = true;
        assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        assert!(matches!(
            e.step().unwrap(),
            ProgressEvent::Broadcast { batch_index: 0, .. }
        ));
        // The record is not rewound: it stays Confirmed until the node says otherwise.
        assert!(matches!(
            e.ledger().get(&campaign(), 0).unwrap(),
            Some(BatchStatus::Confirmed { depth: 1, .. })
        ));
        drop(e);
        assert_eq!(d.built, vec![0]);
    }

    // covers: REQ-RES-001
    #[test]
    fn a_ledger_that_cannot_give_the_bytes_back_cannot_cause_a_resend() {
        let (mut d, mut inner) = (FakeDistributor::default(), InMemoryLedger::new());
        let b = batches(1);
        let f = fundings(&b);
        // Only `get` and `record` are forwarded: the default `built_tx` knows Built batches only.
        let mut ledger = CrashingLedger::new(&mut inner);
        let mut e = Engine::new(campaign(), b, f, 1, &policy(), &mut d, &mut ledger)
            .unwrap()
            .with_rebroadcast_policy(quick(1, 1, 5));
        e.step().unwrap();
        e.step().unwrap();
        let txid = e.distributor().txid_of(0).unwrap();
        e.distributor.forget(txid);
        for _ in 0..8 {
            assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
        }
        drop(e);
        assert_eq!(d.broadcasts.len(), 1);
    }

    /// A ledger whose stored transaction is not the one it says the batch has: it cannot happen
    /// with a sound ledger, and the engine must not send what it cannot vouch for.
    struct Inconsistent<'a>(&'a mut InMemoryLedger);

    impl Ledger for Inconsistent<'_> {
        fn get(&self, c: &CampaignId, i: u32) -> Result<Option<BatchStatus>, LedgerError> {
            self.0.get(c, i)
        }

        fn record(&mut self, c: &CampaignId, i: u32, s: BatchStatus) -> Result<(), LedgerError> {
            self.0.record(c, i, s)
        }

        fn built_tx(&self, c: &CampaignId, i: u32) -> Result<Option<(Txid, Vec<u8>)>, LedgerError> {
            Ok(self
                .0
                .built_tx(c, i)?
                .map(|(_, raw)| (Txid::from_bytes([0xee; 32]), raw)))
        }
    }

    // covers: REQ-RES-001
    #[test]
    fn a_stored_transaction_that_is_not_the_batchs_own_is_never_sent() {
        let (mut d, mut inner) = (FakeDistributor::default(), InMemoryLedger::new());
        let b = batches(1);
        let f = fundings(&b);
        let mut ledger = Inconsistent(&mut inner);
        let mut e = Engine::new(campaign(), b, f, 1, &policy(), &mut d, &mut ledger)
            .unwrap()
            .with_rebroadcast_policy(quick(1, 1, 5));
        e.step().unwrap();
        e.step().unwrap();
        let txid = e.distributor().txid_of(0).unwrap();
        e.distributor.forget(txid);
        assert!(matches!(e.step(), Err(EngineError::Config(_))));
        drop(e);
        assert_eq!(d.broadcasts.len(), 1, "nothing was sent");
    }

    // covers: REQ-RES-001
    #[test]
    fn a_restarted_engine_gets_a_fresh_bounded_round() {
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        {
            let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(1, 1, 1));
            forgotten(&mut e);
            assert!(matches!(e.step().unwrap(), ProgressEvent::Broadcast { .. }));
            for _ in 0..5 {
                assert!(matches!(e.step().unwrap(), ProgressEvent::Waiting { .. }));
            }
        }
        assert_eq!(d.broadcasts.len(), 2);
        let mut e = engine(1, 1, &mut d, &mut l).with_rebroadcast_policy(quick(1, 1, 1));
        assert!(matches!(e.step().unwrap(), ProgressEvent::Broadcast { .. }));
        drop(e);
        assert_eq!(d.broadcasts.len(), 3);
        assert_eq!(d.built, vec![0], "still built once");
    }

    // covers: REQ-RES-001
    #[test]
    fn the_default_schedule_is_bounded_and_not_hasty() {
        let policy = RebroadcastPolicy::default();
        assert_eq!(
            policy,
            RebroadcastPolicy {
                after_unseen_polls: 5,
                every_unseen_polls: 10,
                max_rebroadcasts: 5
            }
        );
    }

    // covers: REQ-RES-001
    #[test]
    fn the_underfunded_message_names_no_particular_coin() {
        // The engine does not know the network: it must not call testnet money by the mainnet name.
        let error: EngineError<FakeError> = EngineError::Underfunded {
            batch_index: 2,
            required: Zatoshi::new(5).unwrap(),
            available: Zatoshi::new(1).unwrap(),
        };
        let text = error.to_string();
        assert!(!text.contains("ZEC") && text.contains("batch 2"), "{text}");
    }

    // covers: REQ-RES-001
    #[test]
    fn setup_validation() {
        let b = batches(2);
        let f = fundings(&b);
        let mk = |b: Vec<Batch>, f: Vec<FundingRef>, depth: u32| {
            Engine::new(
                campaign(),
                b,
                f,
                depth,
                &policy(),
                FakeDistributor::default(),
                InMemoryLedger::new(),
            )
            .map(|_| ())
        };
        assert!(matches!(mk(vec![], vec![], 1), Err(EngineError::Config(_))));
        assert!(matches!(
            mk(b.clone(), f[..1].to_vec(), 1),
            Err(EngineError::Config(_))
        ));
        assert!(matches!(
            mk(b.clone(), f.clone(), 0),
            Err(EngineError::Config(_))
        ));
        // Batches must be numbered 0, 1, ... in order.
        let swapped = vec![b[1].clone(), b[0].clone()];
        assert!(matches!(
            mk(swapped, f.clone(), 1),
            Err(EngineError::Config(_))
        ));
        // A funding input smaller than total + fee is rejected up front.
        let mut poor = f.clone();
        poor[1].value = b[1].total();
        match mk(b.clone(), poor, 1) {
            Err(EngineError::Underfunded {
                batch_index: 1,
                required,
                available,
            }) => {
                assert_eq!(available, b[1].total());
                assert_eq!(
                    required.as_u64(),
                    b[1].total().as_u64()
                        + crate::fee::standard_batch_fee(&policy(), 2)
                            .unwrap()
                            .as_u64()
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(mk(b, f, 1).is_ok());
    }

    // covers: REQ-RES-001, REQ-PLAN-002
    #[test]
    fn the_funding_check_uses_the_supplied_fee_policy() {
        let b = batches(1);
        // Exactly total + the lower Zebra fee: enough under that policy, short under the ZIP text.
        let exact_for_zebra = FundingRef {
            outpoint: OutPoint {
                txid: Txid::from_bytes([0xf0; 32]),
                vout: 0,
            },
            value: crate::fee::standard_funding_required(
                &FeePolicy::zebra_main(),
                b[0].total(),
                b[0].output_count(),
            )
            .unwrap(),
        };
        let mk = |policy: FeePolicy| {
            Engine::new(
                campaign(),
                b.clone(),
                vec![exact_for_zebra],
                1,
                &policy,
                FakeDistributor::default(),
                InMemoryLedger::new(),
            )
            .map(|_| ())
        };
        assert!(mk(FeePolicy::zebra_main()).is_ok());
        assert!(matches!(
            mk(FeePolicy::zip317_text()),
            Err(EngineError::Underfunded { batch_index: 0, .. })
        ));
        // An absurd policy surfaces as an amount error, not a wrapped fee.
        assert!(matches!(
            mk(FeePolicy::new(u64::MAX, 2)),
            Err(EngineError::Amount(_))
        ));
    }

    // covers: REQ-RES-001
    #[test]
    fn a_missing_ledger_record_stops_the_engine_instead_of_replanning() {
        /// A ledger that forgets everything it is told (a broken backend).
        struct Amnesiac;
        impl Ledger for Amnesiac {
            fn get(&self, _: &CampaignId, _: u32) -> Result<Option<BatchStatus>, LedgerError> {
                Ok(None)
            }
            fn record(
                &mut self,
                _: &CampaignId,
                _: u32,
                _: BatchStatus,
            ) -> Result<(), LedgerError> {
                Ok(())
            }
        }
        let b = batches(1);
        let f = fundings(&b);
        let mut e = Engine::new(
            campaign(),
            b,
            f,
            1,
            &policy(),
            FakeDistributor::default(),
            Amnesiac,
        )
        .unwrap();
        assert!(matches!(
            e.step(),
            Err(EngineError::MissingStatus { batch_index: 0 })
        ));
        assert!(e.distributor().built.is_empty());
    }

    // covers: REQ-RES-001
    #[test]
    fn events_serialize_with_an_event_tag() {
        let txid = Txid::from_bytes([1; 32]);
        let events = [
            ProgressEvent::Built {
                batch_index: 0,
                txid,
                outputs: 2,
            },
            ProgressEvent::Waiting {
                batch_index: 1,
                observed_depth: 0,
                required_depth: 3,
            },
            ProgressEvent::Halted {
                failed_batches: vec![2],
            },
            ProgressEvent::Settled {
                campaign_id: campaign(),
                batches: 4,
            },
        ];
        let json = serde_json::to_value(&events).unwrap();
        assert_eq!(json[0]["event"], "built");
        assert_eq!(json[0]["txid"], "01".repeat(32));
        assert_eq!(json[1]["event"], "waiting");
        assert_eq!(json[2]["failed_batches"][0], 2);
        assert_eq!(json[3]["campaign_id"], "camp");
        for ev in events {
            let back: ProgressEvent =
                serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
            assert_eq!(back, ev);
        }
    }

    // ---- REQ-PRIV-002 ----------------------------------------------------

    // covers: REQ-PRIV-002
    #[test]
    fn engine_events_and_debug_never_contain_recipient_data() {
        let rows: Vec<Recipient> = [
            (
                "u1sentinelengineaddr0000000001",
                7_777_001u64,
                Some("sentinel-engine-memo"),
            ),
            ("u1sentinelengineaddr0000000002", 3_333_007, None),
        ]
        .into_iter()
        .map(|(a, z, m)| Recipient::new(a, Zatoshi::new(z).unwrap(), m.map(str::to_owned)).unwrap())
        .collect();
        let b = plan_batches(&rows, 2).unwrap();
        let f = fundings(&b);
        let (mut d, mut l) = (FakeDistributor::default(), InMemoryLedger::new());
        let mut e = Engine::new(campaign(), b.clone(), f, 1, &policy(), &mut d, &mut l).unwrap();

        let mut texts = vec![
            format!("{e:?}"),
            format!("{b:?}"),
            format!("{:?}", e.batches()),
        ];
        e.step().unwrap();
        e.step().unwrap();
        e.distributor.set_depth(Txid::from_bytes([16; 32]), 1);
        let mut events = Vec::new();
        e.run_to_completion(3, |ev| events.push(ev.clone()))
            .unwrap();
        for ev in &events {
            texts.push(format!("{ev:?}"));
            texts.push(serde_json::to_string(ev).unwrap());
        }
        texts.push(format!("{:?}", e.statuses().unwrap()));
        texts.push(format!("{:?}", e.phase().unwrap()));
        assert!(!events.is_empty());
        for text in texts {
            for needle in [
                "sentinelengine",
                "7777001",
                "3333007",
                "sentinel-engine-memo",
            ] {
                assert!(!text.contains(needle), "{needle} leaked: {text}");
            }
        }
    }
}
