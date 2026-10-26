//! The port through which the verifier reads the chain.
//!
//! Implemented over lightwalletd/Zaino gRPC by `drop-chain`, and by in-memory
//! fakes in tests. The verifier trusts the source for *data* only; it re-derives
//! every fact itself and checks that a returned transaction really has the id that
//! was asked for.

use std::future::Future;

use drop_core::Txid;
use thiserror::Error;

/// A transaction as the chain source returned it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedTx {
    /// The serialized transaction.
    pub raw: Vec<u8>,
    /// The height of the block that mined it, or `None` if it is only in the mempool
    /// (or mined on a fork that is not the main chain).
    pub mined_height: Option<u32>,
}

/// Why the chain source could not answer. Fixed text only: a source's own error
/// messages never reach a receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SourceError {
    /// The source could not be reached or refused the request.
    #[error("the chain source is unavailable")]
    Unavailable,
    /// The source returned data that contradicts what was asked for.
    #[error("the chain source returned inconsistent data")]
    Inconsistent,
}

/// Read access to a Zcash chain.
pub trait ChainSource {
    /// The transaction with this id, or `None` if the source does not know it.
    fn transaction(
        &self,
        txid: &Txid,
    ) -> impl Future<Output = Result<Option<FetchedTx>, SourceError>> + Send;

    /// The height of the chain tip.
    fn tip_height(&self) -> impl Future<Output = Result<u32, SourceError>> + Send;
}

/// Confirmations of a transaction mined at `mined_height` when the tip is at
/// `tip_height`: 1 for a transaction in the tip block, 0 if unmined (or if the
/// source claims a height above its own tip).
pub fn confirmations(tip_height: u32, mined_height: Option<u32>) -> u32 {
    match mined_height {
        Some(height) if height <= tip_height => tip_height - height + 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-VER-003
    #[test]
    fn confirmations_count_the_mining_block() {
        assert_eq!(confirmations(100, Some(100)), 1);
        assert_eq!(confirmations(100, Some(98)), 3);
        assert_eq!(confirmations(100, Some(1)), 100);
        assert_eq!(confirmations(100, None), 0, "mempool");
        assert_eq!(
            confirmations(100, Some(101)),
            0,
            "a height above the tip is not believed"
        );
        assert_eq!(confirmations(0, Some(0)), 1);
    }
}
