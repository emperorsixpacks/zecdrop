//! # drop-chain
//!
//! A lightwalletd / Zaino gRPC client for ZecDrop: it reads transactions and the
//! tip (as a [`drop_verify::ChainSource`]), broadcasts raw transactions, and lists
//! the unspent outputs of a transparent address.
//!
//! The endpoint URL and the expected network are configuration
//! ([`ChainConfig`]); no endpoint is built in. Two public endpoints were checked with a
//! raw `GetLightdInfo` call on 2026-10-07 and are the suggested defaults:
//!
//! | Network | Endpoint | Reported |
//! |---------|----------|----------|
//! | testnet | `https://testnet.zec.rocks:443` | chain `test`, branch `77190ad9` (NU7), lightwalletd v0.5.4, Zebra 7.0.0-rc.0 |
//! | mainnet | `https://zec.rocks:443` | chain `main`, branch `37a5165b` (NU6.3), lightwalletd v0.5.3 |
//!
//! Public testnet is already on NU7, so the 330-actions-per-transaction limit applies there.
//!
//! [`LightwalletdSource::connect`] reads `GetLightdInfo` once and fails fast with
//! [`ChainError::WrongNetwork`] if the server's chain name does not match the configured
//! network, so a mainnet/testnet mix-up is caught before anything is read or sent. The
//! same call returns the live tip height and consensus branch id ([`ChainInfo`]), which
//! the transaction builder needs to choose the right branch.
//!
//! The gRPC calls sit behind the small [`StreamerApi`] trait so the mapping logic
//! (byte orders, heights, "not found" versus "unavailable", value range checks) is
//! unit-tested with a fake and needs no network.
//!
//! **No key types.** This crate does not use `zcash_client_backend`; the tonic client
//! is generated at build time from the upstream `.proto` files (see `PROVENANCE.md`),
//! so that nothing here, or in the hosted verifier that uses it, depends on
//! `zcash_keys` (REQ-VER-002).

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod api;
pub mod client;
pub mod config;
/// The lightwalletd protocol, generated at build time from `proto/*.proto` by `build.rs`.
pub mod proto {
    #![allow(
        missing_docs,
        clippy::all,
        clippy::pedantic,
        clippy::nursery,
        unreachable_pub,
        unused_qualifications
    )]
    include!(concat!(env!("OUT_DIR"), "/cash.z.wallet.sdk.rpc.rs"));
}

pub use api::{ApiError, GrpcApi, RawTx, SendResponse, ServerInfo, StreamerApi, UtxoReply};
pub use client::{
    refusal_says_already_known, BroadcastError, BroadcastOutcome, ChainError, ChainInfo,
    LightwalletdSource, Utxo,
};
pub use config::ChainConfig;

#[cfg(test)]
mod tests {
    use super::proto::{ChainMetadata, CompactTx, PoolType};

    // covers: REQ-VER-001
    #[test]
    fn the_generated_protocol_covers_the_ironwood_fields() {
        // These compile only if the pinned .proto (v0.5.0) has the Ironwood additions.
        let tx = CompactTx::default();
        assert!(tx.ironwood_actions.is_empty());
        assert_eq!(ChainMetadata::default().ironwood_commitment_tree_size, 0);
        assert_eq!(PoolType::Ironwood as i32, 4);
    }
}
