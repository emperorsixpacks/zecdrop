//! What the operator keeps about one payout's inbox, sealed in its store and bound to the payout (REQ-FUND-005, REQ-FUND-006).
//!
//! The transaction in flight is kept with its exact bytes, written before it is broadcast (invariant 3): a restart re-sends
//! those bytes and never builds another while they could still be mined. A mined move is recorded once and for all: the
//! inbox never moves again.

use std::fmt;

use serde::{Deserialize, Serialize};

/// What an inbox transaction does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxTxKind {
    /// Moves exactly the payout's funding to its funding address.
    Move,
    /// Sends what is left back to a shielded address.
    Return,
}

/// An inbox transaction that has been checked and stored, and is (or is about to be) broadcast.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxTx {
    /// What it does.
    pub kind: InboxTxKind,
    /// Its id, display order.
    pub txid: String,
    /// The exact bytes that were checked, and that are broadcast, as hex.
    pub raw: String,
    /// The height after which it can never be mined.
    pub expiry_height: u32,
}

impl fmt::Debug for InboxTx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "InboxTx{{kind: {:?}, txid: {}, expiry: {}}}",
            self.kind, self.txid, self.expiry_height
        )
    }
}

/// One payout's inbox, as the store keeps it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxRecord {
    /// When it was set up, in Unix seconds; the store's row carries the same time.
    pub created_at: u64,
    /// Its address: a Unified Address with an Orchard receiver only.
    pub address: String,
    /// The height its wallet scans from.
    pub birthday: u32,
    /// The transaction in flight, if any.
    pub pending: Option<InboxTx>,
    /// The mined move's id, once there is one: the inbox never moves again after it.
    pub moved: Option<String>,
}

impl fmt::Debug for InboxRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The address is the payout's and the payer's business: never in a log.
        write!(
            f,
            "InboxRecord{{created_at: {}, address: <redacted>, birthday: {}, pending: {:?}, moved: {:?}}}",
            self.created_at, self.birthday, self.pending, self.moved
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_address_or_the_bytes() {
        let record = InboxRecord {
            created_at: 1,
            address: "utest1secretaddress".into(),
            birthday: 2,
            pending: Some(InboxTx {
                kind: InboxTxKind::Move,
                txid: "ab".repeat(32),
                raw: "deadbeefcafe".into(),
                expiry_height: 9,
            }),
            moved: None,
        };
        let dbg = format!("{record:?}");
        assert!(!dbg.contains("utest1secretaddress"));
        assert!(!dbg.contains("deadbeefcafe"));
        assert!(dbg.contains(&"ab".repeat(32)), "a txid is public");
    }
}
