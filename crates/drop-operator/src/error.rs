//! Error types for configuration, the encrypted store and the crypto layer.
//!
//! None of these messages contain recipient data, passphrases, keys or tokens.

use thiserror::Error;

/// Why the operator refused to start.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ConfigError {
    /// Mainnet was requested without `--allow-mainnet`.
    #[error("mainnet requires the explicit --allow-mainnet flag")]
    MainnetNeedsFlag,
    /// Mainnet was requested without the confirmation environment variable.
    #[error("mainnet also requires the environment variable ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND")]
    MainnetNeedsConfirmation,
    /// The mock chain was combined with mainnet.
    #[error("the mock chain cannot be used on mainnet: its transactions are fake")]
    MockOnMainnet,
    /// No chain was chosen.
    #[error("choose a chain: --lightwalletd-url <url> for a real one, or --mock-chain")]
    NoChainBackend,
    /// Both a real and a fake chain were chosen.
    #[error("--lightwalletd-url and --mock-chain cannot be used together")]
    ChainConflict,
    /// The lightwalletd URL is not usable.
    #[error("--lightwalletd-url must be an http or https URL with a host and no credentials")]
    BadEndpoint,
    /// A seed file was given for mainnet.
    #[error("--seed-file is for testnet only")]
    SeedFileMainnet,
    /// The bind address is not a loopback address.
    #[error("refusing to bind to a non-loopback address; the operator API is local only")]
    NonLoopbackBind,
    /// The bind address could not be parsed.
    #[error("bind address must be an IP and port such as 127.0.0.1:8787")]
    BadBindAddress,
    /// The passphrase is empty.
    #[error("the passphrase must not be empty")]
    EmptyPassphrase,
    /// A new store's passphrase is too short.
    #[error("the passphrase of a new store must be at least 12 characters")]
    PassphraseTooShort,
    /// A numeric option is out of range.
    #[error("option out of range: {0}")]
    BadOption(&'static str),
    /// `--near-base-url` is not a usable http or https URL.
    #[error("--near-base-url must be an http or https URL with a host and no credentials")]
    BadNearUrl,
    /// There is nowhere to keep the account registry.
    #[error("cannot tell where to keep the account registry; pass --state-dir <dir> or set ZECDROP_STATE_DIR")]
    NoStateDir,
}

/// The words of [`StoreError::Corrupt`], which also reach the API through error strings that
/// wrap it (a ledger failure, for instance); the API recognises them and answers `store_corrupt`.
pub const STORE_CORRUPT_TEXT: &str = "stored data is damaged or has been tampered with";

/// Failures in the crypto layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CryptoError {
    /// Key derivation failed or its parameters are unacceptable.
    #[error("key derivation failed")]
    Kdf,
    /// The operating system could not supply random bytes.
    #[error("operating system randomness is unavailable")]
    Randomness,
    /// Encryption failed.
    #[error("encryption failed")]
    Encrypt,
    /// Authentication failed: the record was altered, moved or sealed with another key.
    #[error("stored record failed authentication")]
    Decrypt,
    /// The record is not in the expected format.
    #[error("stored record has an unexpected format")]
    BadFormat,
}

/// Failures of the encrypted local store.
#[derive(Debug, Error)]
pub enum StoreError {
    /// The passphrase does not open this store.
    #[error("wrong passphrase, or the store header is damaged")]
    WrongPassphrase,
    /// There is no store at the path.
    #[error("no store found at this path")]
    Missing,
    /// The file exists but is not a ZecDrop store.
    #[error("the file is not a ZecDrop store")]
    NotAStore,
    /// The store was written by an unsupported format version.
    #[error("unsupported store format")]
    UnsupportedFormat,
    /// A store already exists at the path.
    #[error("a store already exists at this path")]
    AlreadyExists,
    /// A stored record failed authentication or could not be parsed.
    #[error("stored data is damaged or has been tampered with")]
    Corrupt,
    /// The crypto layer failed.
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    /// The database failed. The message is SQLite's, which holds no row data.
    #[error("database error: {0}")]
    Database(String),
    /// A campaign with this id already exists.
    #[error("campaign already exists")]
    Duplicate,
    /// The campaign does not exist.
    #[error("campaign not found")]
    NotFound,
    /// A new store's passphrase is too short.
    #[error("the passphrase of a new store must be at least 12 characters")]
    WeakPassphrase,
    /// The store file's permissions could not be restricted to its owner.
    #[error("the store file's permissions could not be restricted to its owner")]
    Permissions,
    /// No fresh account number could be reserved for the campaign.
    #[error(transparent)]
    Accounts(#[from] crate::accounts::AccountError),
    /// The store holds a campaign of another network than the operator was started for.
    #[error(
        "this store holds {campaign} campaigns but the operator was started for {operator}; \
         use a separate --db (and --state-dir) for each network"
    )]
    WrongNetwork {
        /// The network of the campaign found in the store.
        campaign: drop_core::Network,
        /// The network the operator runs on.
        operator: drop_core::Network,
    },
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Database(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-SEC-002
    #[test]
    fn the_corruption_text_the_api_looks_for_is_the_one_the_error_prints() {
        assert_eq!(StoreError::Corrupt.to_string(), STORE_CORRUPT_TEXT);
        let wrapped = drop_core::LedgerError::Storage(StoreError::Corrupt.to_string());
        assert!(wrapped.to_string().contains(STORE_CORRUPT_TEXT));
    }
}
