//! Shared error types.
//!
//! None of these errors carry recipient addresses, amounts or memos: variants hold
//! only static text, counts and line numbers, so their `Display` and `Debug` output
//! is safe to log or send to a UI (REQ-PRIV-002).

use serde::Serialize;
use thiserror::Error;

use crate::ids::Txid;

/// Why a ZEC amount string or a sum of amounts was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AmountError {
    /// The input was empty or only whitespace.
    #[error("amount is empty")]
    Empty,
    /// The input started with a minus sign.
    #[error("amount must not be negative")]
    Negative,
    /// The input used exponent notation such as `1e3`.
    #[error("scientific notation is not allowed; write the amount as a plain decimal")]
    ScientificNotation,
    /// The input contained something other than ASCII digits and one decimal point.
    #[error(
        "amount may contain only digits and one decimal point (no spaces, signs or separators)"
    )]
    InvalidCharacter,
    /// The decimal point had no digits on one side (`.5`, `1.`) or appeared twice.
    #[error("amount must look like 1 or 0.5, with digits on both sides of the decimal point")]
    MalformedDecimal,
    /// More than eight digits after the decimal point.
    #[error("amount has more than 8 decimal places")]
    TooManyDecimals,
    /// The amount, or a sum of amounts, is above the maximum possible supply.
    #[error("amount exceeds the maximum possible supply of 21,000,000 ZEC")]
    ExceedsMaxMoney,
}

/// Why an address was rejected. Implemented by [`crate::codec::AddressCodec`] adapters.
///
/// Variants never echo the address itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AddressError {
    /// The address was empty.
    #[error("address is empty")]
    Empty,
    /// The address could not be decoded. `reason` is a short static explanation.
    #[error("address is not valid: {reason}")]
    Malformed {
        /// Static, address-free explanation such as `"bad checksum"`.
        reason: &'static str,
    },
    /// The address belongs to a different network than the campaign.
    #[error("address is for a different network")]
    WrongNetwork,
    /// The address decoded but has no receiver this product can pay.
    #[error("address has no receiver that can be paid")]
    UnsupportedReceiver,
    /// A transparent address was given while transparent recipients are not allowed.
    #[error("transparent addresses are not allowed; use a shielded or unified address")]
    TransparentNotAllowed,
}

/// Why a [`crate::ids::CampaignId`] or [`crate::ids::Txid`] was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum IdError {
    /// The campaign id was empty.
    #[error("campaign id is empty")]
    EmptyCampaignId,
    /// The campaign id was longer than the allowed maximum.
    #[error("campaign id is longer than {max} bytes")]
    CampaignIdTooLong {
        /// Maximum allowed length in bytes.
        max: usize,
    },
    /// The campaign id contained characters outside `A-Z a-z 0-9 . _ -`.
    #[error("campaign id may contain only letters, digits, '.', '_' and '-'")]
    CampaignIdCharset,
    /// The string was not 64 hexadecimal characters.
    #[error("transaction id must be 64 hexadecimal characters")]
    BadTxid,
    /// The outpoint was not of the form `<txid>:<index>`.
    #[error("outpoint must look like <txid>:<index>")]
    BadOutPoint,
}

/// Why a [`crate::recipient::Recipient`] could not be constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RecipientError {
    /// The address was empty.
    #[error("address is empty")]
    EmptyAddress,
    /// The address was longer than any real address.
    #[error("address is longer than {max} bytes")]
    AddressTooLong {
        /// Maximum allowed length in bytes.
        max: usize,
    },
    /// The amount was zero.
    #[error("amount must be greater than zero")]
    ZeroAmount,
    /// The memo exceeded the 512-byte Zcash memo field.
    #[error("memo is {bytes} bytes; the limit is {max} bytes")]
    MemoTooLong {
        /// Actual memo length in UTF-8 bytes.
        bytes: usize,
        /// Maximum allowed length in bytes.
        max: usize,
    },
}

/// Why a batch plan could not be produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum PlanError {
    /// `max_outputs_per_batch` was zero.
    #[error("max outputs per batch must be at least 1")]
    ZeroBatchSize,
    /// There were no recipients to plan.
    #[error("there are no recipients to plan")]
    NoRecipients,
    /// The plan would need more batches than a `u32` index can number.
    #[error("too many batches")]
    TooManyBatches,
    /// The campaign total was above the maximum supply.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// No split exists without a one-recipient batch (which would reveal that amount).
    #[error(
        "cannot split {recipients} recipients into batches of at most {max_outputs_per_batch} \
         without a single-recipient batch; raise the batch size"
    )]
    SingletonUnavoidable {
        /// Number of recipients in the campaign.
        recipients: usize,
        /// The requested batch size ceiling.
        max_outputs_per_batch: usize,
    },
}

/// Why a manifest, salt or commitment was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ManifestError {
    /// A salt must be exactly 32 bytes.
    #[error("salt must be exactly 32 bytes, got {got}")]
    BadSaltLength {
        /// Number of bytes supplied.
        got: usize,
    },
    /// A salt or commitment was not valid hexadecimal of the right length.
    #[error("expected 64 hexadecimal characters")]
    BadHex,
    /// The operating system could not supply random bytes.
    #[error("operating system randomness is unavailable")]
    Randomness,
    /// A manifest needs at least one recipient.
    #[error("manifest has no recipients")]
    NoRecipients,
    /// The recipients' amounts add up to more than the maximum supply.
    #[error(transparent)]
    Amount(#[from] AmountError),
    /// The recomputed commitment differs from the expected one.
    #[error("manifest commitment does not match")]
    CommitmentMismatch,
}

/// Why a ledger operation failed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LedgerError {
    /// A different transaction is already recorded for this batch (double-pay guard).
    #[error("batch {batch_index} already has transaction {existing_txid}; refusing to record a different one")]
    Conflict {
        /// Index of the batch.
        batch_index: u32,
        /// The transaction already on record.
        existing_txid: Txid,
    },
    /// The requested status change is not allowed from the current status.
    #[error("batch {batch_index}: cannot move from {from} to {to}")]
    IllegalTransition {
        /// Index of the batch.
        batch_index: u32,
        /// Name of the current status (`none` if absent).
        from: &'static str,
        /// Name of the requested status.
        to: &'static str,
    },
    /// The status itself is malformed (for example a confirmation depth of zero).
    #[error("batch {batch_index}: invalid status: {reason}")]
    InvalidStatus {
        /// Index of the batch.
        batch_index: u32,
        /// Static explanation.
        reason: &'static str,
    },
    /// The storage backend failed. Backends must keep recipient data out of this text.
    #[error("ledger storage failed: {0}")]
    Storage(String),
}
