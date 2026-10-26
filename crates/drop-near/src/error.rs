use thiserror::Error;

/// Every failure in this crate. Messages never contain the JWT.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum NearError {
    #[error("the campaign address is not valid: {0}")]
    Address(#[from] AddressError),
    #[error("native ZEC (blockchain `zec`) is not in the 1Click token list")]
    ZecNotListed,
    #[error("native ZEC is listed with {0} decimals; expected 8 (zatoshi)")]
    UnexpectedZecDecimals(u8),
    #[error("the deadline must be an ISO 8601 UTC timestamp such as 2026-10-07T23:00:00Z")]
    BadDeadline,
    #[error("the refund address is empty")]
    EmptyRefundAddress,
    #[error("the quote does not match the request: {0}")]
    QuoteMismatch(&'static str),
    #[error("a dry quote must not carry a deposit address")]
    DryQuoteHasDepositAddress,
    #[error("a live quote has no deposit address")]
    LiveQuoteWithoutDepositAddress,
    #[error("1Click refused the request (HTTP {status}): {message}")]
    Rejected { status: u16, message: String },
    #[error("1Click rejected the credentials (HTTP 401)")]
    Unauthorized,
    #[error("1Click returned a response that does not parse: {0}")]
    Parse(String),
    #[error("could not reach 1Click: {0}")]
    Transport(String),
}

/// Why a string is not a usable campaign funding address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AddressError {
    #[error("not a Zcash address")]
    Malformed,
    #[error("a testnet address; NEAR Intents is mainnet-only (there is no testnet ZEC)")]
    Testnet,
    #[error(
        "not a transparent (t1/t3) address; NEAR Intents pays ZEC to transparent addresses only"
    )]
    NotTransparent,
}
