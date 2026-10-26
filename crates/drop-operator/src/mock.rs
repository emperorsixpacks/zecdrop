//! A deterministic fake chain for development, demos and tests (`--mock-chain`).
//!
//! * Transaction ids are derived by hashing the funding outpoint, batch index,
//!   batch total, output count and a per-batch build counter. A given plan always
//!   produces the same ids, and a *rebuild* produces a different id, so any code
//!   that rebuilds instead of re-broadcasting is caught by the ledger.
//! * Confirmations grow with each poll after a configurable delay.
//! * Failures can be injected: transient broadcast errors and permanent build
//!   rejections.
//! * The chain "remembers" any transaction id it is asked about, so a run resumed in
//!   a new process (which has a fresh mock) still progresses. The recorded
//!   `builds()` and `broadcasts()` logs are what tests inspect.
//!
//! It contains nothing from the recipient list: raw "transactions" hold only the
//! batch index and public batch total.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use drop_core::{
    Batch, BuiltBatch, Distributor, FailureKind, FundingRef, FundingSource, OutPoint, Txid,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::chain::{ChainBackend, ChainError, FundingLayout, RunContext, UtxoSighting};
use crate::secret::SecretSeed;

/// How the fake chain behaves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockConfig {
    /// Polls that report "in the mempool" (0 confirmations) before the first block.
    pub confirm_after_polls: u32,
    /// Confirmations gained per poll once mined. At least 1.
    pub depth_per_poll: u32,
    /// How many upcoming broadcast calls fail with a transient error.
    pub transient_broadcast_failures: u32,
    /// Batch indices whose build is rejected permanently.
    pub reject_builds: Vec<u32>,
}

impl Default for MockConfig {
    fn default() -> Self {
        MockConfig {
            confirm_after_polls: 1,
            depth_per_poll: 1,
            transient_broadcast_failures: 0,
            reject_builds: Vec::new(),
        }
    }
}

/// Failures the mock injects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum MockError {
    /// A retryable network-style failure.
    #[error("mock node unreachable (injected failure)")]
    Unreachable,
    /// The node refused the transaction for good.
    #[error("mock node rejected the transaction (injected failure)")]
    Rejected,
}

#[derive(Default)]
struct MockState {
    builds: Vec<(u32, Txid)>,
    broadcasts: Vec<Txid>,
    polls: HashMap<Txid, u32>,
    attempts: HashMap<(OutPoint, u32), u32>,
    broadcast_failures_left: u32,
}

/// The shared fake chain. Clones see the same state, which stands in for "the
/// network" surviving an operator restart.
#[derive(Clone)]
pub struct MockChain {
    config: Arc<MockConfig>,
    state: Arc<Mutex<MockState>>,
}

impl MockChain {
    /// A fresh chain with the given behaviour.
    pub fn new(config: MockConfig) -> Self {
        let state = MockState {
            broadcast_failures_left: config.transient_broadcast_failures,
            ..MockState::default()
        };
        MockChain {
            config: Arc::new(config),
            state: Arc::new(Mutex::new(state)),
        }
    }

    fn lock(&self) -> MutexGuard<'_, MockState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A distributor on this chain.
    pub fn distributor(&self) -> MockDistributor {
        MockDistributor {
            chain: self.clone(),
        }
    }

    /// Every build so far, as `(batch index, txid)`, in order.
    pub fn builds(&self) -> Vec<(u32, Txid)> {
        self.lock().builds.clone()
    }

    /// Every successful broadcast so far, in order (duplicates included).
    pub fn broadcasts(&self) -> Vec<Txid> {
        self.lock().broadcasts.clone()
    }
}

impl Default for MockChain {
    fn default() -> Self {
        MockChain::new(MockConfig::default())
    }
}

/// A [`Distributor`] on a [`MockChain`].
pub struct MockDistributor {
    chain: MockChain,
}

impl Distributor for MockDistributor {
    type Error = MockError;

    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, MockError> {
        if self.chain.config.reject_builds.contains(&batch.index()) {
            return Err(MockError::Rejected);
        }
        let mut state = self.chain.lock();
        let attempt = state
            .attempts
            .entry((funding.outpoint, batch.index()))
            .or_insert(0);
        *attempt += 1;

        let mut hasher = Sha256::new();
        hasher.update(b"zecdrop-mock-tx\0");
        hasher.update(funding.outpoint.to_string().as_bytes());
        hasher.update(batch.index().to_be_bytes());
        hasher.update(batch.total().as_u64().to_be_bytes());
        hasher.update(batch.output_count().to_be_bytes());
        hasher.update(attempt.to_be_bytes());
        let txid = Txid::from_bytes(hasher.finalize().into());

        let mut raw_tx = b"MOCKTX\0".to_vec();
        raw_tx.extend_from_slice(txid.as_bytes());
        raw_tx.extend_from_slice(&batch.index().to_be_bytes());
        raw_tx.extend_from_slice(&batch.total().as_u64().to_be_bytes());

        state.builds.push((batch.index(), txid));
        Ok(BuiltBatch { txid, raw_tx })
    }

    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), MockError> {
        let mut state = self.chain.lock();
        if state.broadcast_failures_left > 0 {
            state.broadcast_failures_left -= 1;
            return Err(MockError::Unreachable);
        }
        state.broadcasts.push(built.txid);
        state.polls.entry(built.txid).or_insert(0);
        Ok(())
    }

    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, MockError> {
        let config = Arc::clone(&self.chain.config);
        let mut state = self.chain.lock();
        let polls = state.polls.entry(*txid).or_insert(0);
        *polls += 1;
        if *polls <= config.confirm_after_polls {
            return Ok(Some(0));
        }
        let mined_polls = *polls - config.confirm_after_polls;
        Ok(Some(
            mined_polls.saturating_mul(config.depth_per_poll.max(1)),
        ))
    }

    fn classify(&self, error: &MockError) -> FailureKind {
        match error {
            MockError::Unreachable => FailureKind::Transient,
            MockError::Rejected => FailureKind::Permanent,
        }
    }
}

/// A [`ChainBackend`] over a [`MockChain`].
#[derive(Clone)]
pub struct MockBackend {
    chain: MockChain,
}

impl MockBackend {
    /// A backend whose distributors all share `chain`.
    pub fn new(chain: MockChain) -> Self {
        MockBackend { chain }
    }
}

impl ChainBackend for MockBackend {
    fn is_mock(&self) -> bool {
        true
    }

    fn funding_layout(&self) -> FundingLayout {
        FundingLayout::SplitDeposit
    }

    fn distributor(
        &self,
        _run: &RunContext<'_>,
    ) -> Result<Box<dyn crate::chain::ChainPort>, ChainError> {
        Ok(Box::new(self.chain.distributor()))
    }

    /// The mock chain has no addresses; funding is declared with `fund-observed`.
    fn funding_address(
        &self,
        _seed: &SecretSeed,
        _network: drop_core::Network,
        _account: u32,
    ) -> Result<Option<String>, ChainError> {
        Ok(None)
    }

    fn funding_sightings(&self, _address: &str) -> Result<Vec<UtxoSighting>, ChainError> {
        Ok(Vec::new())
    }

    /// The mock chain holds no deposit transaction; `fund-observed` may declare a source instead.
    fn deposit_source(&self, _deposit: &Txid) -> Result<Option<FundingSource>, ChainError> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use drop_core::{plan_batches, Recipient, Zatoshi};

    fn batch_and_funding() -> (Batch, FundingRef) {
        let rows: Vec<Recipient> = (0..2)
            .map(|i| {
                Recipient::new(
                    format!("u1mockrow{i:08}"),
                    Zatoshi::new(1_000_000 + i).unwrap(),
                    None,
                )
                .unwrap()
            })
            .collect();
        let batch = plan_batches(&rows, 2).unwrap().remove(0);
        let funding = FundingRef {
            outpoint: OutPoint {
                txid: Txid::from_bytes([9; 32]),
                vout: 0,
            },
            value: Zatoshi::new(10_000_000).unwrap(),
        };
        (batch, funding)
    }

    #[test]
    fn txids_are_deterministic_across_chains_but_change_on_rebuild() {
        let (batch, funding) = batch_and_funding();
        let first = MockChain::default()
            .distributor()
            .build_batch(&batch, &funding)
            .unwrap();
        let again = MockChain::default()
            .distributor()
            .build_batch(&batch, &funding)
            .unwrap();
        assert_eq!(first.txid, again.txid, "same plan, same txid");

        let chain = MockChain::default();
        let mut d = chain.distributor();
        let a = d.build_batch(&batch, &funding).unwrap();
        let b = d.build_batch(&batch, &funding).unwrap();
        assert_ne!(a.txid, b.txid, "a rebuild must be visible");
        assert_eq!(chain.builds().len(), 2);
    }

    #[test]
    fn raw_transactions_hold_no_recipient_data() {
        let (batch, funding) = batch_and_funding();
        let built = MockChain::default()
            .distributor()
            .build_batch(&batch, &funding)
            .unwrap();
        let raw = String::from_utf8_lossy(&built.raw_tx).into_owned();
        assert!(!raw.contains("u1mockrow"));
        assert!(built.raw_tx.starts_with(b"MOCKTX\0"));
    }

    #[test]
    fn confirmations_follow_the_configured_delay_and_rate() {
        let chain = MockChain::new(MockConfig {
            confirm_after_polls: 2,
            depth_per_poll: 3,
            ..MockConfig::default()
        });
        let mut d = chain.distributor();
        let txid = Txid::from_bytes([1; 32]);
        d.broadcast(&BuiltBatch {
            txid,
            raw_tx: vec![],
        })
        .unwrap();
        let seen: Vec<_> = (0..5).map(|_| d.confirmations(&txid).unwrap()).collect();
        assert_eq!(seen, vec![Some(0), Some(0), Some(3), Some(6), Some(9)]);
    }

    #[test]
    fn injected_failures_are_classified() {
        let chain = MockChain::new(MockConfig {
            transient_broadcast_failures: 2,
            reject_builds: vec![0],
            ..MockConfig::default()
        });
        let mut d = chain.distributor();
        let built = BuiltBatch {
            txid: Txid::from_bytes([2; 32]),
            raw_tx: vec![],
        };
        for _ in 0..2 {
            let err = d.broadcast(&built).unwrap_err();
            assert_eq!(d.classify(&err), FailureKind::Transient);
        }
        d.broadcast(&built).unwrap();
        assert_eq!(chain.broadcasts(), vec![built.txid]);

        let (batch, funding) = batch_and_funding();
        let err = d.build_batch(&batch, &funding).unwrap_err();
        assert_eq!(d.classify(&err), FailureKind::Permanent);
        assert!(chain.builds().is_empty());
    }

    #[test]
    fn clones_share_one_chain() {
        let chain = MockChain::default();
        let backend = MockBackend::new(chain.clone());
        let (batch, funding) = batch_and_funding();
        let seed = SecretSeed::from_bytes([1; 32]);
        let campaign = drop_core::CampaignId::new("c").unwrap();
        let run = RunContext {
            seed: &seed,
            campaign: &campaign,
            account: 0,
            network: drop_core::Network::Testnet,
            fee_policy: drop_core::FeePolicy::zip317_text(),
        };
        backend
            .distributor(&run)
            .unwrap()
            .build_batch(&batch, &funding)
            .unwrap();
        assert_eq!(chain.builds().len(), 1);
        assert!(backend.is_mock());
    }
}
