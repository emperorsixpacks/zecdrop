//! # drop-verify
//!
//! Key-less verification of ZecDrop batch transactions from public chain data.
//!
//! Given a campaign's published transaction ids, declared total and manifest
//! commitment, [`verify_campaign`] reads the chain through a [`ChainSource`] and
//! returns the same [`drop_core::PublicReceipt`] the operator produces, with
//! `findings` for anything it could not establish or that does not add up:
//!
//! * the balance equation `t_in = t_out + net_into_pool + fee`, with `fee >= 0`,
//!   and the fee *reported*, not compared with a fixed rate (REQ-VER-001);
//! * the shielded value balance, checked against the bundle's own binding
//!   signature, so a tampered figure is caught;
//! * the confirmation depth: below it a batch is pending and the campaign is never
//!   settled (REQ-VER-003).
//!
//! It cannot tell where the shielded value went. That is the auditor's check.
//!
//! **No keys (REQ-VER-002).** This crate depends on no spend-key or viewing-key
//! types; the hosted verifier's structural test asserts `zcash_keys` is absent from
//! its dependency closure.

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod analyze;
pub mod source;
pub mod verify;

pub use analyze::{ParsedTx, Problem, TxAnalysis, Unparseable};
pub use source::{confirmations, ChainSource, FetchedTx, SourceError};
pub use verify::{p2pkh_address, verify_campaign, VerifyConfig, VerifyError, VerifyRequest};
