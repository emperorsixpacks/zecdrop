//! Funding a campaign through NEAR Intents (REQ-FUND-001): the operator's side.
//!
//! `drop-near` knows the 1Click API; this module is what the operator adds around it.
//!
//! * [`NearGateway`] is the four calls the operator makes, behind a trait so tests run on recorded
//!   fixtures and a fake HTTP client. The real one is `drop_near::OneClick` over `ureq`, called
//!   from `spawn_blocking`: the browser's CSP forbids calling NEAR directly, so the operator does.
//! * A **dry** quote kept for a campaign lives in memory for [`DRY_TTL_SECS`]. It is cheap to ask
//!   again and worth nothing minutes later (prices move), so persisting it would add a table and a
//!   thing to keep fresh for no gain; a restart simply means "ask again". Only a **live** quote,
//!   which holds a deposit address a person may have already paid, is persisted
//!   ([`NearQuoteRecord`], sealed and authenticated in the store).
//! * Nothing here says a campaign is funded. A swap that reports `SUCCESS` is
//!   [`NearStep::VerifyOnChain`]; the campaign becomes funded only through the operator's own
//!   on-chain deposit detection (REQ-FUND-002).
//!
//! **Not exercised against the real service:** the live quote and the status calls. Their shapes
//! come from the 1Click documentation (`drop-near/testdata/*.from-docs.json`), and NEAR is
//! mainnet-only, so no test or tool here sends a non-dry quote or a deposit. The token list and
//! the dry quote were captured from the real service on 2026-10-07.

use drop_near::{
    DepositInstructions, DryQuoteRequest, HttpClient, LiveQuoteRequest, NearError, OneClick,
    QuoteResponse, StatusResponse, Token,
};
use serde::{Deserialize, Serialize};

/// How long a token list is reused.
pub const TOKENS_TTL_SECS: u64 = 60;

/// How long a dry quote for a campaign can be turned into a live one.
pub const DRY_TTL_SECS: u64 = 600;

/// How long a swap's deposit address stays valid, counted from its dry quote.
pub const SWAP_WINDOW_SECS: u64 = 6 * 3600;

/// 1% (basis points).
pub const SLIPPAGE_BPS: u16 = 100;

/// The recipient of a price preview: a syntactically valid mainnet address over a hash of all
/// `0x11` bytes, which no known key controls (the address the captured dry quote used). It is
/// checked with `drop_near::CampaignTransparentAddress` before use.
pub const PREVIEW_RECIPIENT: &str = "t1KRqwQhktLV4BjbNLiuH6pb3AMoszZKcQB";

/// The refund address a price preview carries (the captured dry quote's): nothing is ever sent, so
/// nothing can be refunded.
pub const PREVIEW_REFUND_TO: &str =
    "1111111111111111111111111111111111111111111111111111111111111111";

/// What the operator needs from the 1Click API.
pub trait NearGateway: Send + Sync {
    /// `GET /v0/tokens`.
    fn tokens(&self) -> Result<Vec<Token>, NearError>;
    /// `POST /v0/quote` with `dry: true`: creates nothing.
    fn quote_dry(&self, request: &DryQuoteRequest) -> Result<QuoteResponse, NearError>;
    /// `POST /v0/quote` with `dry: false`: creates a deposit address. Reachable only with a
    /// [`LiveQuoteRequest`], which `drop-near` hands out only for a matching dry response.
    fn quote_live(&self, request: &LiveQuoteRequest) -> Result<DepositInstructions, NearError>;
    /// `GET /v0/status`.
    fn status(
        &self,
        deposit_address: &str,
        deposit_memo: Option<&str>,
    ) -> Result<StatusResponse, NearError>;
}

impl<C: HttpClient + Send + Sync + 'static> NearGateway for OneClick<C> {
    fn tokens(&self) -> Result<Vec<Token>, NearError> {
        OneClick::tokens(self)
    }

    fn quote_dry(&self, request: &DryQuoteRequest) -> Result<QuoteResponse, NearError> {
        OneClick::quote_dry(self, request)
    }

    fn quote_live(&self, request: &LiveQuoteRequest) -> Result<DepositInstructions, NearError> {
        OneClick::quote_live(self, request)
    }

    fn status(
        &self,
        deposit_address: &str,
        deposit_memo: Option<&str>,
    ) -> Result<StatusResponse, NearError> {
        OneClick::status(self, deposit_address, deposit_memo)
    }
}

/// Wall-clock seconds, injectable so expiry can be tested.
pub trait Clock: Send + Sync {
    /// Seconds since the Unix epoch.
    fn now_secs(&self) -> u64;
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// What the operator's NEAR routes need besides the store.
#[derive(Clone)]
pub struct NearParts {
    /// The 1Click API.
    pub gateway: std::sync::Arc<dyn NearGateway>,
    /// The time source.
    pub clock: std::sync::Arc<dyn Clock>,
    /// Whether the operator was started with `--allow-mainnet`: a real swap is mainnet money.
    pub allow_mainnet: bool,
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a Unix time (UTC, proleptic Gregorian).
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// Whether `text` is safe to show a person as an address, memo or reference that came from
/// outside: ASCII letters, digits and `. - _ : +` only, between 1 and `max` characters. Nothing
/// that came from the service is shown otherwise.
pub fn plain_text(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'+'))
}

/// The state the NEAR routes keep between requests: the token list for a minute, and the dry
/// quotes waiting to be made live.
pub struct NearState {
    parts: NearParts,
    tokens: std::sync::Mutex<Option<(u64, std::sync::Arc<Vec<Token>>)>>,
    dry: std::sync::Mutex<std::collections::HashMap<drop_core::CampaignId, PendingDry>>,
}

impl NearState {
    /// State over `parts`, empty.
    pub fn new(parts: NearParts) -> Self {
        NearState {
            parts,
            tokens: std::sync::Mutex::new(None),
            dry: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The gateway, clock and mainnet permission.
    pub fn parts(&self) -> &NearParts {
        &self.parts
    }

    /// Now, by the injected clock.
    pub fn now(&self) -> u64 {
        self.parts.clock.now_secs()
    }

    /// The token list fetched less than [`TOKENS_TTL_SECS`] ago, if there is one.
    pub fn cached_tokens(&self) -> Option<std::sync::Arc<Vec<Token>>> {
        let now = self.now();
        let guard = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .filter(|(fetched, _)| now.saturating_sub(*fetched) < TOKENS_TTL_SECS)
            .map(|(_, tokens)| std::sync::Arc::clone(tokens))
    }

    /// Remembers a freshly fetched token list.
    pub fn remember_tokens(&self, tokens: Vec<Token>) -> std::sync::Arc<Vec<Token>> {
        let tokens = std::sync::Arc::new(tokens);
        *self.tokens.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((self.now(), std::sync::Arc::clone(&tokens)));
        tokens
    }

    /// Keeps a dry quote for a campaign, replacing an older one.
    pub fn keep_dry(&self, campaign: drop_core::CampaignId, dry: PendingDry) {
        self.dry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(campaign, dry);
    }

    /// Takes the campaign's dry quote out, whether or not it is still good: a dry quote is used
    /// at most once, so two requests can never both turn it into a live one.
    pub fn take_dry(&self, campaign: &drop_core::CampaignId) -> Option<PendingDry> {
        self.dry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(campaign)
    }

    /// Whether a dry quote is waiting for the campaign.
    pub fn has_dry(&self, campaign: &drop_core::CampaignId) -> bool {
        self.dry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(campaign)
    }
}

/// An asset the funder can pay with, as the operator shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OriginAsset {
    /// The 1Click asset id.
    pub asset_id: String,
    /// Its symbol.
    pub symbol: String,
    /// The chain it lives on.
    pub blockchain: String,
    /// Its decimals.
    pub decimals: u8,
}

impl From<&Token> for OriginAsset {
    fn from(token: &Token) -> Self {
        OriginAsset {
            asset_id: token.asset_id.clone(),
            symbol: token.symbol.clone(),
            blockchain: token.blockchain.clone(),
            decimals: token.decimals,
        }
    }
}

/// Whether a token may be an origin: any ZEC asset (native, or bridged on another chain) is out,
/// since the point is to turn something else into native ZEC.
pub fn is_origin(token: &Token) -> bool {
    token.symbol != "ZEC" && token.blockchain != "zec"
}

/// The usable origin assets, sorted by symbol, then chain, then id.
pub fn origins(tokens: &[Token]) -> Vec<OriginAsset> {
    let mut list: Vec<OriginAsset> = tokens
        .iter()
        .filter(|t| is_origin(t))
        .map(OriginAsset::from)
        .collect();
    list.sort_by(|a, b| {
        (&a.symbol, &a.blockchain, &a.asset_id).cmp(&(&b.symbol, &b.blockchain, &b.asset_id))
    });
    list.dedup_by(|a, b| a.asset_id == b.asset_id);
    list
}

/// A dry quote waiting to be turned into a live one.
#[derive(Clone, Debug)]
pub struct PendingDry {
    /// The request that was sent.
    pub request: DryQuoteRequest,
    /// What the service answered.
    pub response: QuoteResponse,
    /// The asset the funder pays with.
    pub origin: OriginAsset,
    /// Where the service refunds on the origin chain.
    pub refund_to: String,
    /// What the campaign needed at the time.
    pub funding_required: drop_core::Zatoshi,
    /// The campaign address the swap pays.
    pub funding_address: String,
    /// When it was asked for (Unix seconds).
    pub quoted_at: u64,
}

impl PendingDry {
    /// When it stops being usable.
    pub fn expires_at(&self) -> u64 {
        self.quoted_at.saturating_add(DRY_TTL_SECS)
    }
}

/// A live quote: what the funder was told to pay, kept so a restart does not lose the deposit
/// address. Sealed and authenticated in the store. It holds no recipient data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NearQuoteRecord {
    /// Where the funder sends the origin asset.
    pub deposit_address: String,
    /// The memo to send with it, if the chain needs one.
    pub deposit_memo: Option<String>,
    /// The asset to pay with.
    pub origin_asset: String,
    /// Its symbol, for display.
    pub origin_symbol: String,
    /// How much to pay, in the origin asset's smallest unit.
    pub amount_in: String,
    /// The same, formatted by the service.
    pub amount_in_formatted: Option<String>,
    /// What the campaign address receives, in zatoshi.
    pub zec_out_zat: String,
    /// The campaign address the swap pays.
    pub funding_address: String,
    /// Where the service refunds on the origin chain.
    pub refund_to: String,
    /// When the deposit address stops being valid (ISO 8601, as the service said).
    pub deadline: Option<String>,
    /// When the quote was made (Unix seconds).
    pub created_at: u64,
    /// When the deposit address stops being valid (Unix seconds), from the operator's own
    /// request, so expiry never depends on parsing the service's text.
    pub valid_until: u64,
}

/// What the operator should do about a swap, from the service's status. There is deliberately no
/// "funded" among them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NearStep {
    /// Keep waiting for the funder's deposit.
    AwaitDeposit,
    /// The deposit is seen or the swap is running.
    AwaitSwap,
    /// The service reports delivery: check the chain; the campaign is not funded until the
    /// operator sees the output at the required depth.
    VerifyOnChain,
    /// The deposit was smaller than quoted.
    TopUpOrAwaitRefund,
    /// The swap ended and the funder was refunded.
    EndedRefunded,
    /// The swap failed.
    EndedFailed,
    /// A status the documentation does not list: stop and look.
    Investigate,
}

/// The documented statuses as a closed set of words.
pub fn status_word(status: &drop_near::SwapStatus) -> &'static str {
    use drop_near::SwapStatus::*;
    match status {
        PendingDeposit => "pending_deposit",
        KnownDepositTx => "known_deposit_tx",
        Processing => "processing",
        Success => "success",
        IncompleteDeposit => "incomplete_deposit",
        Refunded => "refunded",
        Failed => "failed",
        Unknown(_) => "unknown",
    }
}

/// The step for a status response, and the transaction ids (64 hexadecimal characters only) the
/// service claims paid the campaign.
pub fn step_for(response: &StatusResponse) -> (NearStep, Vec<String>) {
    use drop_near::NextStep as N;
    match response.next_step() {
        N::AwaitDeposit => (NearStep::AwaitDeposit, Vec::new()),
        N::AwaitSwap => (NearStep::AwaitSwap, Vec::new()),
        N::VerifyOnChain { zec_txids } => (
            NearStep::VerifyOnChain,
            zec_txids
                .into_iter()
                .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(|t| t.to_ascii_lowercase())
                .collect(),
        ),
        N::TopUpOrAwaitRefund => (NearStep::TopUpOrAwaitRefund, Vec::new()),
        N::Ended { refunded: true } => (NearStep::EndedRefunded, Vec::new()),
        N::Ended { refunded: false } => (NearStep::EndedFailed, Vec::new()),
        N::Investigate { .. } => (NearStep::Investigate, Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-FUND-001
    #[test]
    fn unix_times_become_iso_8601_utc() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso8601_utc(951_782_400),
            "2000-02-29T00:00:00Z",
            "a leap day"
        );
        assert_eq!(iso8601_utc(1_791_409_462), "2026-10-07T21:44:22Z");
        assert_eq!(iso8601_utc(1_709_251_199), "2024-02-29T23:59:59Z");
        assert_eq!(iso8601_utc(1_709_251_200), "2024-03-01T00:00:00Z");
        assert_eq!(iso8601_utc(4_102_444_799), "2099-12-31T23:59:59Z");
        assert_eq!(iso8601_utc(4_102_444_800), "2100-01-01T00:00:00Z");
    }

    // covers: REQ-FUND-001, REQ-PRIV-002
    #[test]
    fn text_from_the_service_is_shown_only_if_it_is_plain() {
        for ok in ["tmabc", "0xAbC123", "bc1qxyz", "GABC:memo-1_2.3+4", "1"] {
            assert!(plain_text(ok, 64), "{ok}");
        }
        for bad in [
            "",
            "has space",
            "a\nb",
            "<script>",
            "é",
            "a/b",
            "a;b",
            "'x'",
            &"a".repeat(65),
        ] {
            assert!(!plain_text(bad, 64), "{bad:?}");
        }
    }

    fn token(id: &str, symbol: &str, chain: &str) -> Token {
        serde_json::from_value(serde_json::json!({
            "assetId": id, "decimals": 6, "blockchain": chain, "symbol": symbol
        }))
        .unwrap()
    }

    // covers: REQ-FUND-001
    #[test]
    fn origins_exclude_every_zec_asset_and_come_out_sorted() {
        let tokens = vec![
            token("nep141:zec.omft.near", "ZEC", "zec"),
            token("nep141:bridged-zec", "ZEC", "near"),
            token("sol:zec", "ZEC", "sol"),
            token("nep141:usdc", "USDC", "near"),
            token("eth:usdc", "USDC", "eth"),
            token("nep141:wrap.near", "wNEAR", "near"),
            token("nep141:usdc", "USDC", "near"),
        ];
        let list = origins(&tokens);
        let ids: Vec<&str> = list.iter().map(|o| o.asset_id.as_str()).collect();
        assert_eq!(ids, vec!["eth:usdc", "nep141:usdc", "nep141:wrap.near"]);
    }

    // covers: REQ-FUND-001
    #[test]
    fn the_preview_recipient_is_a_valid_mainnet_transparent_address() {
        assert!(drop_near::CampaignTransparentAddress::parse_mainnet(PREVIEW_RECIPIENT).is_ok());
    }

    // covers: REQ-FUND-001
    #[test]
    fn a_success_names_only_well_formed_transaction_ids_and_is_never_funded() {
        let ok = "ab".repeat(32);
        let response: StatusResponse = serde_json::from_value(serde_json::json!({
            "status": "SUCCESS",
            "swapDetails": { "destinationChainTxHashes": [
                { "hash": ok }, { "hash": "not a txid <b>" }, { "hash": "ab" }
            ]}
        }))
        .unwrap();
        let (step, txids) = step_for(&response);
        assert_eq!(step, NearStep::VerifyOnChain);
        assert_eq!(txids, vec![ok]);
        assert_eq!(status_word(&response.status), "success");
    }
}
