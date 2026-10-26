//! # drop-near
//!
//! Optional campaign funding through the NEAR Intents **1Click** API (ADR 0004, REQ-FUND-001):
//! "fund this campaign from any asset". Manual funding always works; this is a convenience.
//!
//! Facts it relies on (checked 2026-10-07):
//! * `GET /v0/tokens` needs no auth and lists native ZEC as `nep141:zec.omft.near`, blockchain
//!   `zec`, 8 decimals. It also lists *bridged* ZEC on NEAR, Solana, Starknet and Aptos with the
//!   same symbol, so [`find_zec`] matches the blockchain, not the symbol.
//! * NEAR Intents is **mainnet-only** (no testnet ZEC) and pays Zcash to **transparent**
//!   addresses only, so the recipient is the campaign's mainnet `t1`/`t3` funding address
//!   ([`CampaignTransparentAddress`]); testnet addresses are refused.
//! * A **dry** quote worked without a JWT (HTTP 201). A JWT, if used, comes from
//!   [`client::JWT_ENV_VAR`] only and is never printed.
//!
//! Flow: [`OneClick::tokens`] → [`find_zec`] → [`DryQuoteRequest::exact_zec_to_campaign`]
//! (EXACT_OUTPUT of `funding_required` zatoshi) → [`OneClick::quote_dry`] →
//! [`DryQuoteRequest::confirm`] → [`OneClick::quote_live`] (shows the funder a deposit address) →
//! poll [`OneClick::status`] → [`StatusResponse::next_step`].
//!
//! **Not "funded".** No type here says a campaign is funded. `SUCCESS` becomes
//! [`NextStep::VerifyOnChain`]: the operator marks the campaign funded only when it sees the
//! UTXO at the campaign address on chain at the required depth (REQ-FUND-002).

pub mod address;
pub mod client;
pub mod error;
pub mod quote;
pub mod status;
pub mod tokens;

pub use address::CampaignTransparentAddress;
pub use client::{HttpClient, HttpResponse, Jwt, OneClick, UreqClient};
pub use error::{AddressError, NearError};
pub use quote::{
    DepositInstructions, DryQuoteRequest, FundingQuote, LiveQuoteRequest, QuoteResponse,
};
pub use status::{NextStep, StatusResponse, SwapDetails, SwapStatus};
pub use tokens::{find_zec, Token};
