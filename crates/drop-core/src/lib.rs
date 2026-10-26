//! # drop-core
//!
//! The chain-agnostic domain core of ZecDrop: confidential batch payouts on Zcash
//! with "private amounts, public accountability". Each batch is one transaction
//! that spends transparent funds into N Orchard outputs. The public can recompute
//! totals from chain data, recipients' amounts stay hidden, and an auditor can hold
//! a viewing key.
//!
//! This crate has **no Zcash or network dependencies**. Everything that touches a
//! chain is a port (a trait) implemented elsewhere: [`codec::AddressCodec`],
//! [`engine::Distributor`] and [`ledger::Ledger`].
//!
//! ## Requirements and where they live
//!
//! Each requirement ID appears in a `// covers:` comment on the tests that verify it.
//!
//! | ID | What | Module |
//! |----|------|--------|
//! | REQ-AMT-001 | Strict ZEC parsing and exact formatting | [`amount`] |
//! | REQ-AMT-002 | Checked totals, never wrap or saturate | [`amount`], [`recipient`] |
//! | REQ-IMP-001 | CSV import reporting every error with line numbers | [`import`], [`codec`] |
//! | REQ-PLAN-001 | Deterministic, lossless batching | [`planner`] |
//! | REQ-PLAN-002 | ZIP-317 fee under a caller-supplied [`fee::FeePolicy`] | [`fee`] |
//! | REQ-PLAN-003 | No singleton batches (unless the campaign has one recipient) | [`planner`] |
//! | REQ-MAN-001 | Salted manifest commitment | [`manifest`] |
//! | REQ-LED-001 | Idempotent, conflict-safe ledger | [`ledger`] |
//! | REQ-RES-001 | Resume never rebuilds or double-pays | [`engine`] |
//! | REQ-PRIV-001 | Public receipt cannot carry recipient data (golden JSON in `fixtures/contract/`) | [`receipt`] |
//! | REQ-PRIV-002 | Redaction in `Debug`, `Display`, errors, events | [`recipient`], [`import`], [`planner`], [`engine`] |
//! | REQ-PRIV-003 | Privacy warnings at review (singleton, small, two-recipient, uniform) | [`warnings`] |
//! | REQ-PHASE-001 | Campaign phases | [`phase`] |
//!
//! Shared vocabulary lives in [`ids`] (campaign id, txid, outpoint, network, pool) and
//! [`error`].
//!
//! ## Data flow
//!
//! ```text
//! CSV --import--> Vec<Recipient> --plan_batches--> Vec<Batch>
//!                       |                              |
//!                       +--> Manifest --commitment()   +--> Engine<Distributor, Ledger>
//!                                          |                       |
//!                                          +--------> PublicReceipt <--- ledger statuses
//! ```
//!
//! ## Privacy rules enforced by the types
//!
//! * [`recipient::Recipient`] redacts address, amount and memo in `Debug`/`Display`.
//! * Error and progress-event types hold only line numbers, counts, indices and txids.
//! * [`receipt::PublicReceipt`] has no field that could hold recipient data.
//! * All zatoshi amounts serialize to JSON as decimal strings.

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod amount;
pub mod codec;
pub mod engine;
pub mod error;
pub mod fee;
pub mod ids;
pub mod import;
pub mod ledger;
pub mod manifest;
pub mod phase;
pub mod planner;
pub mod receipt;
pub mod recipient;
pub mod warnings;

pub use amount::{Zatoshi, MAX_MONEY, ZATOSHI_PER_ZEC};
#[cfg(any(test, feature = "test-util"))]
pub use codec::PermissiveCodec;
pub use codec::{check_policy, AddressCodec, RecipientKind};
pub use engine::{
    BuiltBatch, Distributor, Engine, EngineError, FailureKind, FundingRef, ProgressEvent,
};
pub use error::{
    AddressError, AmountError, IdError, LedgerError, ManifestError, PlanError, RecipientError,
};
pub use fee::{
    batch_fee, batch_funding_required, standard_batch_fee, standard_funding_required, FeePolicy,
};
pub use ids::{CampaignId, Network, OutPoint, Pool, Txid};
pub use import::{
    import_csv_reader, import_csv_str, ImportError, ImportOptions, ImportReport, RowError,
    RowErrorKind,
};
pub use ledger::{BatchStatus, InMemoryLedger, Ledger};
pub use manifest::{Manifest, ManifestCommitment, Salt};
pub use phase::{derive_phase, CampaignPhase, FundingState};
pub use planner::{campaign_total, plan_batches, Batch};
pub use receipt::{
    BatchReceipt, ChainReceiptInputs, Finding, FundingSource, PublicReceipt, ReceiptError,
    ReceiptInputs,
};
pub use recipient::{total_amount, Recipient};
pub use warnings::{privacy_warnings, PrivacyWarning};
