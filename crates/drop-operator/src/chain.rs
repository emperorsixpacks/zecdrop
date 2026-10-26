//! The chain port the operator runs the engine against.
//!
//! `drop-core` defines [`Distributor`] with an associated error type, which cannot
//! be used as a trait object. [`ChainPort`] is the object-safe form with one error
//! type, [`ChainError`]; any `Distributor` becomes a `ChainPort` automatically, so
//! the real Zcash distributor from `drop-zcash` plugs in through [`ChainBackend`]
//! with no other change to this crate.

use drop_core::{
    Batch, BuiltBatch, CampaignId, Distributor, FailureKind, FeePolicy, FundingRef, Network,
    OutPoint, Txid, Zatoshi,
};
use thiserror::Error;

use crate::secret::SecretSeed;

/// A chain failure, already classified as retryable or not.
///
/// The message is stored in the ledger and shown to users, so adapters must keep
/// recipient data out of it.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct ChainError {
    /// What went wrong.
    pub message: String,
    /// Whether retrying can help.
    pub kind: FailureKind,
}

/// The object-safe form of [`Distributor`].
pub trait ChainPort: Send {
    /// See [`Distributor::build_batch`].
    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, ChainError>;

    /// See [`Distributor::broadcast`].
    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), ChainError>;

    /// See [`Distributor::confirmations`].
    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, ChainError>;
}

fn classified<D: Distributor>(distributor: &D, error: D::Error) -> ChainError {
    ChainError {
        kind: distributor.classify(&error),
        message: error.to_string(),
    }
}

impl<D: Distributor + Send> ChainPort for D {
    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, ChainError> {
        Distributor::build_batch(self, batch, funding).map_err(|e| classified(self, e))
    }

    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), ChainError> {
        Distributor::broadcast(self, built).map_err(|e| classified(self, e))
    }

    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, ChainError> {
        Distributor::confirmations(self, txid).map_err(|e| classified(self, e))
    }
}

/// A boxed [`ChainPort`] that is itself a [`Distributor`], so the engine can use it.
pub struct BoxedDistributor(pub Box<dyn ChainPort>);

impl Distributor for BoxedDistributor {
    type Error = ChainError;

    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, ChainError> {
        self.0.build_batch(batch, funding)
    }

    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), ChainError> {
        self.0.broadcast(built)
    }

    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, ChainError> {
        self.0.confirmations(txid)
    }

    fn classify(&self, error: &ChainError) -> FailureKind {
        error.kind
    }
}

/// How a backend arranges the funding inputs of a campaign's batches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FundingLayout {
    /// The observed deposit is split into one output per batch (the mock chain).
    SplitDeposit,
    /// The observed deposit is the single batch's funding input, spent whole and with
    /// change returned to the campaign. Campaigns with more than one batch need a
    /// funding-split transaction, which is not implemented.
    SingleDeposit,
}

/// What a backend needs to know to run one campaign.
pub struct RunContext<'a> {
    /// The wallet seed (for backends that derive keys).
    pub seed: &'a SecretSeed,
    /// The campaign.
    pub campaign: &'a CampaignId,
    /// The campaign's own ZIP-32 account.
    pub account: u32,
    /// The network.
    pub network: Network,
    /// The fee policy the plan and the engine's funding check use.
    pub fee_policy: FeePolicy,
}

/// An unspent output seen at a campaign's funding address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UtxoSighting {
    /// Which output.
    pub outpoint: OutPoint,
    /// Its value.
    pub amount: Zatoshi,
    /// Confirmations (0 while unmined).
    pub confirmations: u32,
}

/// Supplies what the operator needs from a chain: a distributor per run, and (for real
/// chains) each campaign's funding address and what has arrived there.
///
/// Methods are blocking; the operator calls them from blocking threads.
pub trait ChainBackend: Send + Sync {
    /// Whether this backend is a fake chain. Fake chains allow the dev-only
    /// `fund-observed` endpoint and are refused on mainnet.
    fn is_mock(&self) -> bool;

    /// How funding inputs are arranged for this backend.
    fn funding_layout(&self) -> FundingLayout;

    /// A new distributor connected to this backend's chain, for one campaign run.
    fn distributor(&self, run: &RunContext<'_>) -> Result<Box<dyn ChainPort>, ChainError>;

    /// The transparent address a campaign is funded at, or `None` if this backend has
    /// no addresses of its own (the mock chain).
    fn funding_address(
        &self,
        seed: &SecretSeed,
        network: Network,
        account: u32,
    ) -> Result<Option<String>, ChainError>;

    /// The unspent outputs currently seen at `address`, with their confirmations.
    fn funding_sightings(&self, address: &str) -> Result<Vec<UtxoSighting>, ChainError>;
}
