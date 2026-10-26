//! # drop-verifier
//!
//! The hosted, stateless, key-less ZecDrop receipt verifier (REQ-VER-002).
//!
//! `GET /v1/receipt?network=testnet&tx=<txid>&tx=<txid>&commitment=<hex>&declared_total=<zatoshi>`
//! reads the named transactions from a lightwalletd-compatible server, re-derives the
//! public facts with [`drop_verify`], and returns a [`drop_core::PublicReceipt`].
//!
//! It holds no keys and no state. It refuses viewing-key-shaped input, bounds the
//! work per request, and never logs or echoes caller-supplied text. `tests/no_keys.rs`
//! asserts that `zcash_keys` is not in this crate's dependency closure.

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod api;
pub mod config;
pub mod log;
pub mod query;
pub mod server;
pub mod startup;
