//! The chain port [`crate::ZcashDistributor`] needs. A lightwalletd/Zaino implementation lives
//! outside this crate (this crate makes no network calls); tests use an in-memory fake.

use drop_core::{OutPoint, Txid};

/// A transparent output as it exists on chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrevOut {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

/// What the node knows about a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxStatus {
    Unknown,
    Mempool,
    Mined { height: u32 },
}

/// The outcome of submitting raw transaction bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Submitted {
    Accepted,
    /// The node already has it: counts as success (`Distributor::broadcast` must be idempotent).
    AlreadyKnown,
    /// The node refused it; retrying the same bytes cannot help.
    Rejected(String),
}

pub trait ChainBackend {
    /// Network/IO errors. `Display` must not contain recipient data.
    type Error: std::error::Error + 'static;

    fn tip_height(&mut self) -> Result<u32, Self::Error>;

    /// The consensus branch id the node reports for its current tip, if this backend can ask.
    /// The distributor refuses to build when it differs from the id this build derives for the
    /// target height, so a build that does not know the network's current upgrade never sends.
    /// The default is "unknown", which skips the check (in-memory fakes).
    fn consensus_branch_id(&mut self) -> Result<Option<u32>, Self::Error> {
        Ok(None)
    }

    /// The Ironwood note-commitment-tree root after block `height`, as `orchard::Anchor` bytes.
    fn ironwood_anchor(&mut self, height: u32) -> Result<[u8; 32], Self::Error>;

    /// The unspent output `outpoint`, or `None` if the node does not know it as unspent.
    fn prevout(&mut self, outpoint: &OutPoint) -> Result<Option<PrevOut>, Self::Error>;

    fn submit(&mut self, raw_tx: &[u8]) -> Result<Submitted, Self::Error>;

    fn status(&mut self, txid: &Txid) -> Result<TxStatus, Self::Error>;
}
