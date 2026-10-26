//! A shielded deposit address for every payout: "the inbox" (docs/ADR/0006-shielded-inbox.md, openspec change
//! `shielded-inbox`).
//!
//! A payer pays the inbox from a shielded wallet. Once the notes are confirmed, and after a random delay, the operator moves
//! exactly the payout's funding from the inbox to its transparent funding address, in one transaction it checks before
//! broadcasting; from there the payout runs as it always has, and the public total stays checkable. The inbox is a
//! zcash-devtool wallet of its own per payout, set up from a phrase derived from the operator's seed ([`keys`]).

pub mod backend;
pub mod devtool;
pub mod engine;
pub mod keys;
pub mod plan;
pub mod record;
pub mod setup;
pub mod walletdb;
