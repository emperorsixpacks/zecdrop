//! The NEAR Intents funding routes (REQ-FUND-001). The domain side is in [`crate::near`].
//!
//! | Route | What it does |
//! |---|---|
//! | `GET /api/near/tokens` | the assets a funder could pay with (never a ZEC asset), sorted |
//! | `POST /api/near/preview` | a **dry** price quote for delivering some ZEC; creates nothing |
//! | `POST /api/campaigns/{id}/funding/near/dry-quote` | mainnet campaigns: a dry quote for exactly what the campaign needs |
//! | `POST /api/campaigns/{id}/funding/near/live-quote` | mainnet only, after a dry quote and with an explicit acknowledgement: asks for a deposit address |
//! | `GET /api/campaigns/{id}/funding/near/status` | mainnet only: where the swap stands, as a closed set of words |
//!
//! None of them ever marks a campaign funded: that happens only when the operator sees the
//! deposit on the Zcash chain at the required depth (REQ-FUND-002). Everything that comes from the
//! service is either a number checked to be a number, text checked to be plain, or a fixed word
//! chosen here; the service's own error messages are never repeated. The API key is never in a
//! response, a log line or an error.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use drop_core::{Network, Zatoshi};
use drop_near::{
    find_zec, AddressError, CampaignTransparentAddress, DryQuoteRequest, FundingQuote, NearError,
    Token,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::load;
use crate::funding::funding_plan;
use crate::http::{ApiError, ApiJson};
use crate::near::{
    is_origin, iso8601_utc, origins, plain_text, status_word, step_for, NearGateway,
    NearQuoteRecord, NearStep, OriginAsset, PendingDry, DRY_TTL_SECS, PREVIEW_RECIPIENT,
    PREVIEW_REFUND_TO, SLIPPAGE_BPS, SWAP_WINDOW_SECS,
};
use crate::state::AppState;
use crate::store::CampaignRecord;

/// The header that must carry [`CONFIRMATION`] before a deposit address is requested.
const CONFIRM_HEADER: &str = "x-zecdrop-confirm-near";

/// The value acknowledging that a live swap is mainnet money.
const CONFIRMATION: &str = "I-UNDERSTAND";

const PREVIEW_NOTE: &str = "A price preview only, not a quote you can pay. It asks NEAR Intents \
what it would cost today to deliver this much ZEC to a placeholder address, which is what \
funding a campaign of this size from this asset would cost on mainnet. It creates no deposit \
address and moves nothing. Testnet campaigns cannot be funded this way: NEAR Intents has no \
testnet ZEC.";

const DRY_NOTE: &str = "A price check, not a payment: nothing was created and there is no \
deposit address yet. It stays good for ten minutes; to get a deposit address, POST live-quote \
with the confirmation header.";

const LIVE_WARNING: &str = "This starts a real swap on NEAR Intents, on mainnet: it gives you a \
deposit address on the origin chain and starts a deadline. Send only the quoted amount of the \
quoted asset to that address, before the deadline. A deposit that is late or the wrong amount is \
refunded to the refund address, minus fees, or may be lost. The campaign is not funded until \
its deposit is seen on the Zcash chain at the required depth.";

const NOT_MAINNET: &str = "NEAR Intents pays out mainnet ZEC only; this campaign runs on testnet, \
where there is no such thing to swap into. Fund it by sending testnet coins (TAZ) to its funding \
address. You can still ask what a campaign of some size would cost to fund on mainnet with \
POST /api/near/preview.";

fn near_kind(error: &NearError) -> &'static str {
    match error {
        NearError::Address(_) => "address",
        NearError::ZecNotListed => "zec_not_listed",
        NearError::UnexpectedZecDecimals(_) => "zec_decimals",
        NearError::BadDeadline => "bad_deadline",
        NearError::EmptyRefundAddress => "empty_refund",
        NearError::QuoteMismatch(_) => "quote_mismatch",
        NearError::DryQuoteHasDepositAddress => "dry_has_deposit_address",
        NearError::LiveQuoteWithoutDepositAddress => "live_without_deposit_address",
        NearError::Rejected { .. } => "rejected",
        NearError::Unauthorized => "unauthorized",
        NearError::Parse(_) => "parse",
        NearError::Transport(_) => "transport",
    }
}

/// An error from the service as an API error. The service's own words are never repeated; the
/// log gets only what kind of failure it was.
fn near_error(state: &AppState, error: NearError) -> ApiError {
    state
        .logger()
        .warn(format_args!("near error: {}", near_kind(&error)));
    let bad = |code: &'static str, message: &str| {
        ApiError::new(StatusCode::BAD_GATEWAY, code, message.to_owned())
    };
    match error {
        NearError::Unauthorized => bad(
            "near_unauthorized",
            "NEAR Intents rejected the credentials; check the NEAR_INTENTS_JWT the operator was started with",
        ),
        NearError::Rejected { status, .. } => bad(
            "near_rejected",
            &format!("NEAR Intents refused the request (HTTP {status})"),
        ),
        NearError::Transport(_) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "near_unavailable",
            "could not reach NEAR Intents; try again shortly",
        ),
        NearError::QuoteMismatch(reason) => bad(
            "near_quote_mismatch",
            &format!("NEAR Intents answered with a quote that does not match the request: {reason}"),
        ),
        NearError::ZecNotListed | NearError::UnexpectedZecDecimals(_) => bad(
            "near_zec_not_listed",
            "NEAR Intents does not list native ZEC the way this operator expects",
        ),
        NearError::Address(reason) => ApiError::conflict("not_applicable", reason.to_string()),
        NearError::EmptyRefundAddress => ApiError::unprocessable(
            "invalid_refund_address",
            "a refund address on the origin chain is needed",
        ),
        NearError::BadDeadline => ApiError::internal(),
        NearError::Parse(_)
        | NearError::DryQuoteHasDepositAddress
        | NearError::LiveQuoteWithoutDepositAddress => bad(
            "near_bad_response",
            "NEAR Intents answered with something this operator cannot use",
        ),
    }
}

/// Runs a gateway call on a blocking thread (the HTTP client is blocking).
async fn blocking<T, F>(state: &AppState, call: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(Arc<dyn NearGateway>) -> Result<T, NearError> + Send + 'static,
{
    let gateway = Arc::clone(&state.near().parts().gateway);
    match tokio::task::spawn_blocking(move || call(gateway)).await {
        Ok(result) => result.map_err(|e| near_error(state, e)),
        Err(_) => Err(ApiError::internal()),
    }
}

/// The token list, reused for [`crate::near::TOKENS_TTL_SECS`].
async fn token_list(state: &AppState) -> Result<Arc<Vec<Token>>, ApiError> {
    if let Some(cached) = state.near().cached_tokens() {
        return Ok(cached);
    }
    let fresh = blocking(state, |gateway| gateway.tokens()).await?;
    Ok(state.near().remember_tokens(fresh))
}

/// The origin asset the caller named, which must be listed and must not be a ZEC asset.
fn find_origin<'a>(tokens: &'a [Token], asset_id: &str) -> Result<&'a Token, ApiError> {
    // Found by exact match in the service's own list, so nothing else can get through.
    let token = tokens
        .iter()
        .find(|t| t.asset_id == asset_id)
        .ok_or_else(|| {
            ApiError::unprocessable(
                "unknown_origin_asset",
                "that is not an asset NEAR Intents lists; see GET /api/near/tokens",
            )
        })?;
    if !is_origin(token) {
        return Err(ApiError::unprocessable(
            "zec_origin_not_allowed",
            "ZEC is what the campaign receives; pay with another asset",
        ));
    }
    Ok(token)
}

fn check_refund(refund_to: &str) -> Result<(), ApiError> {
    if plain_text(refund_to, 200) {
        Ok(())
    } else {
        Err(ApiError::unprocessable(
            "invalid_refund_address",
            "the refund address must be an address on the origin chain: letters, digits and . - _ : + only",
        ))
    }
}

/// A decimal number as text, for a value the service sent.
fn decimal_text(text: &str) -> Option<String> {
    let dots = text.bytes().filter(|b| *b == b'.').count();
    (!text.is_empty()
        && text.len() <= 40
        && dots <= 1
        && text.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && !text.starts_with('.')
        && !text.ends_with('.'))
    .then(|| text.to_owned())
}

fn native_zec(zec: &Token) -> OriginAsset {
    OriginAsset::from(zec)
}

/// `GET /api/near/tokens`.
pub(crate) async fn near_tokens(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let tokens = token_list(&state).await?;
    let list = origins(&tokens);
    Ok(Json(json!({ "count": list.len(), "tokens": list })))
}

/// An amount of zatoshi as a JSON string or number.
#[derive(Deserialize)]
#[serde(untagged)]
enum Amount {
    Text(String),
    Number(u64),
}

impl Amount {
    fn zatoshi(&self) -> Result<Zatoshi, ApiError> {
        let value = match self {
            Amount::Number(n) => Some(*n),
            Amount::Text(text) => {
                (!text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| text.parse().ok())
                    .flatten()
            }
        };
        value
            .filter(|v| *v > 0)
            .and_then(|v| Zatoshi::new(v).ok())
            .ok_or_else(|| {
                ApiError::unprocessable(
                    "amount_out_of_range",
                    "amount_zat must be a whole number of zatoshi, above zero and no more than the total supply",
                )
            })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewBody {
    origin_asset_id: String,
    amount_zat: Amount,
    #[serde(default)]
    refund_to: Option<String>,
}

fn quote_summary(dry: &drop_near::QuoteResponse) -> Value {
    let quote = &dry.quote;
    json!({
        "amount_in": decimal_text(&quote.amount_in),
        "amount_in_formatted": quote.amount_in_formatted.as_deref().and_then(decimal_text),
        "amount_in_usd": quote.amount_in_usd.as_deref().and_then(decimal_text),
        "min_amount_in": quote.min_amount_in.as_deref().and_then(decimal_text),
        "time_estimate_seconds": quote.time_estimate,
    })
}

/// `POST /api/near/preview`: a dry price quote for delivering `amount_zat` of native ZEC.
pub(crate) async fn near_preview(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<PreviewBody>,
) -> Result<Json<Value>, ApiError> {
    let amount = body.amount_zat.zatoshi()?;
    let refund_to = body.refund_to.as_deref().unwrap_or(PREVIEW_REFUND_TO);
    check_refund(refund_to)?;
    let tokens = token_list(&state).await?;
    let origin = find_origin(&tokens, &body.origin_asset_id)?;
    let zec = find_zec(&tokens).map_err(|e| near_error(&state, e))?;
    let recipient = CampaignTransparentAddress::parse_mainnet(PREVIEW_RECIPIENT)
        .map_err(|e| near_error(&state, NearError::Address(e)))?;

    let now = state.near().now();
    let deadline = iso8601_utc(now.saturating_add(SWAP_WINDOW_SECS));
    let request = DryQuoteRequest::exact_zec_to_campaign(&FundingQuote {
        origin_asset: &origin.asset_id,
        zec,
        funding_required: amount,
        campaign_address: &recipient,
        refund_to,
        deadline: &deadline,
        slippage_bps: SLIPPAGE_BPS,
    })
    .map_err(|e| near_error(&state, e))?;
    let sent = request.clone();
    let dry = blocking(&state, move |gateway| gateway.quote_dry(&sent)).await?;
    // Checked against the request like any dry quote. The live request this would hand back is
    // dropped on the spot: a preview never goes any further.
    request.confirm(&dry).map_err(|e| near_error(&state, e))?;

    let mut answer = quote_summary(&dry);
    answer["preview"] = json!(true);
    answer["note"] = json!(PREVIEW_NOTE);
    answer["origin_asset"] = json!(OriginAsset::from(origin));
    answer["destination_asset"] = json!(native_zec(zec));
    answer["amount_out_zat"] = json!(amount.as_u64().to_string());
    answer["slippage_bps"] = json!(SLIPPAGE_BPS);
    Ok(Json(answer))
}

/// The campaign, which must be a mainnet one for anything that actually swaps.
fn mainnet_campaign(state: &AppState, id: &str) -> Result<CampaignRecord, ApiError> {
    let record = load(state, id)?;
    if record.network != Network::Mainnet {
        return Err(ApiError::conflict("not_applicable", NOT_MAINNET));
    }
    Ok(record)
}

/// The campaign's funding address and what it needs, for a mainnet campaign that is not yet
/// funded.
fn campaign_target(
    state: &AppState,
    record: &CampaignRecord,
) -> Result<(CampaignTransparentAddress, Zatoshi), ApiError> {
    if record.funding.is_some() {
        return Err(ApiError::conflict(
            "already_funded",
            "this campaign already has its deposit",
        ));
    }
    let address = state.funding_address(record)?.ok_or_else(|| {
        ApiError::conflict(
            "not_applicable",
            "this chain backend has no funding addresses",
        )
    })?;
    let parsed = CampaignTransparentAddress::parse_mainnet(&address)
        .map_err(|e: AddressError| ApiError::conflict("not_applicable", e.to_string()))?;
    let batches = state.plan(record)?;
    let required = funding_plan(&batches, &record.fee_policy)
        .map_err(|e| state.internal(&e))?
        .required;
    Ok((parsed, required))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DryQuoteBody {
    origin_asset_id: String,
    refund_to: String,
}

/// `POST /api/campaigns/{id}/funding/near/dry-quote`.
pub(crate) async fn near_dry_quote(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<DryQuoteBody>,
) -> Result<Json<Value>, ApiError> {
    let record = mainnet_campaign(&state, &id)?;
    check_refund(&body.refund_to)?;
    let (address, required) = campaign_target(&state, &record)?;
    let tokens = token_list(&state).await?;
    let origin = find_origin(&tokens, &body.origin_asset_id)?;
    let zec = find_zec(&tokens).map_err(|e| near_error(&state, e))?;

    let now = state.near().now();
    let deadline = iso8601_utc(now.saturating_add(SWAP_WINDOW_SECS));
    let request = DryQuoteRequest::exact_zec_to_campaign(&FundingQuote {
        origin_asset: &origin.asset_id,
        zec,
        funding_required: required,
        campaign_address: &address,
        refund_to: &body.refund_to,
        deadline: &deadline,
        slippage_bps: SLIPPAGE_BPS,
    })
    .map_err(|e| near_error(&state, e))?;
    let sent = request.clone();
    let dry = blocking(&state, move |gateway| gateway.quote_dry(&sent)).await?;
    request
        .clone()
        .confirm(&dry)
        .map_err(|e| near_error(&state, e))?;

    let mut answer = quote_summary(&dry);
    answer["dry"] = json!(true);
    answer["note"] = json!(DRY_NOTE);
    answer["campaign_id"] = json!(record.id);
    answer["origin_asset"] = json!(OriginAsset::from(origin));
    answer["campaign_funding_address"] = json!(address.as_str());
    answer["funding_required_zat"] = json!(required.as_u64().to_string());
    answer["valid_for_seconds"] = json!(DRY_TTL_SECS);
    answer["expires_at"] = json!(iso8601_utc(now.saturating_add(DRY_TTL_SECS)));

    state.near().keep_dry(
        record.id.clone(),
        PendingDry {
            request,
            response: dry,
            origin: OriginAsset::from(origin),
            refund_to: body.refund_to,
            funding_required: required,
            funding_address: address.as_str().to_owned(),
            quoted_at: now,
        },
    );
    Ok(Json(answer))
}

fn valid_until_text(secs: u64) -> String {
    iso8601_utc(secs)
}

fn instructions(record: &NearQuoteRecord) -> Vec<String> {
    let symbol = &record.origin_symbol;
    let mut lines = vec![format!(
        "Send exactly {} {symbol} (smallest units: {}) to {} on the {symbol} network.",
        record
            .amount_in_formatted
            .clone()
            .unwrap_or_else(|| record.amount_in.clone()),
        record.amount_in,
        record.deposit_address
    )];
    if let Some(memo) = &record.deposit_memo {
        lines.push(format!(
            "Include the memo {memo}; without it the deposit cannot be matched."
        ));
    }
    lines.push(format!(
        "Do it before {}. After that the address is no longer good and a late deposit is refunded to {}.",
        record
            .deadline
            .clone()
            .unwrap_or_else(|| valid_until_text(record.valid_until)),
        record.refund_to
    ));
    lines.push(
        "The campaign counts as funded only when its deposit is seen on the Zcash chain at the required depth. The status route says where the swap stands; it never says the campaign is funded.".to_owned(),
    );
    lines
}

/// What a live quote looks like to the caller.
fn live_answer(record: &NearQuoteRecord, origin: &OriginAsset, funded: bool) -> Value {
    json!({
        "live": true,
        "campaign_funded": funded,
        "deposit_address": record.deposit_address,
        "deposit_memo": record.deposit_memo,
        "origin_asset": origin,
        "amount_in": record.amount_in,
        "amount_in_formatted": record.amount_in_formatted,
        "zec_out_zat": record.zec_out_zat,
        "campaign_funding_address": record.funding_address,
        "refund_to": record.refund_to,
        "deadline": record.deadline,
        "valid_until": valid_until_text(record.valid_until),
        "instructions": instructions(record),
    })
}

fn deadline_text(text: &str) -> bool {
    text.len() <= 40
        && text.len() >= 20
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b'T' | b'Z' | b'.'))
}

/// `POST /api/campaigns/{id}/funding/near/live-quote`.
pub(crate) async fn near_live_quote(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let record = mainnet_campaign(&state, &id)?;
    if !state.near().parts().allow_mainnet {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "mainnet_not_enabled",
            "a real swap is mainnet money: start the operator with --allow-mainnet",
        ));
    }
    let confirmed = headers
        .get(CONFIRM_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == CONFIRMATION);
    if !confirmed {
        return Err(ApiError::bad_request(
            "confirmation_required",
            format!(
                "send the header `X-Zecdrop-Confirm-Near: {CONFIRMATION}` after showing the person the warning"
            ),
        )
        .with_details(json!({ "warning": LIVE_WARNING })));
    }

    let now = state.near().now();
    // A deposit address that is still good is not replaced by another.
    if let Some(existing) = state
        .store()
        .load_near_quote(&record.id)
        .map_err(|e| state.internal(&e))?
    {
        if now < existing.valid_until {
            return Err(ApiError::conflict(
                "live_quote_exists",
                "this campaign already has a deposit address that is still valid; use it, or wait for its deadline",
            ));
        }
    }

    // A dry quote is used once, whatever comes of it.
    let Some(pending) = state.near().take_dry(&record.id) else {
        return Err(ApiError::conflict(
            "no_dry_quote",
            "ask for a dry quote first (POST dry-quote): a deposit address is only requested for a quote that was checked",
        ));
    };
    if now > pending.expires_at() {
        return Err(ApiError::conflict(
            "dry_quote_expired",
            "the dry quote is too old; ask for a new one",
        ));
    }
    let (address, required) = campaign_target(&state, &record)?;
    if pending.funding_address != address.as_str() || pending.funding_required != required {
        return Err(ApiError::conflict(
            "dry_quote_stale",
            "the campaign changed since the dry quote; ask for a new one",
        ));
    }

    // The only way to a live request: a dry response that matches this request.
    let live = pending
        .request
        .clone()
        .confirm(&pending.response)
        .map_err(|e| near_error(&state, e))?;
    let deposit = blocking(&state, move |gateway| gateway.quote_live(&live)).await?;

    // Everything shown to the funder is checked to be plain before it is kept or shown.
    let memo_ok = deposit
        .deposit_memo
        .as_deref()
        .is_none_or(|m| plain_text(m, 64));
    let formatted = deposit.amount_in_formatted.as_deref().map(decimal_text);
    let deadline = deposit.deadline.as_deref().filter(|d| deadline_text(d));
    if !plain_text(&deposit.deposit_address, 128)
        || !memo_ok
        || decimal_text(&deposit.amount_in).is_none()
        || formatted == Some(None)
    {
        state
            .logger()
            .warn(format_args!("near error: live quote with unusable fields"));
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "near_bad_response",
            "NEAR Intents answered with something this operator cannot use; nothing was kept",
        ));
    }
    let stored = NearQuoteRecord {
        deposit_address: deposit.deposit_address.clone(),
        deposit_memo: deposit.deposit_memo.clone(),
        origin_asset: pending.origin.asset_id.clone(),
        origin_symbol: pending.origin.symbol.clone(),
        amount_in: deposit.amount_in.clone(),
        amount_in_formatted: formatted.flatten(),
        zec_out_zat: deposit.zec_out_zat.clone(),
        funding_address: address.as_str().to_owned(),
        refund_to: pending.refund_to.clone(),
        deadline: deadline.map(str::to_owned),
        created_at: now,
        valid_until: pending.quoted_at.saturating_add(SWAP_WINDOW_SECS),
    };
    if let Err(error) = state.store().save_near_quote(&record.id, &stored) {
        state
            .logger()
            .warn(format_args!("near quote not saved: {error}"));
        // The address exists at NEAR whether or not it was kept: say it, so it is not stranded.
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "near_quote_not_saved",
            "the deposit address was created but could not be kept; do not send to it unless you copy it now, and note that the operator will not track it",
        )
        .with_details(json!({
            "deposit_address": stored.deposit_address,
            "deadline": stored.deadline,
        })));
    }
    state.logger().info(format_args!(
        "near live quote kept campaign={} origin={}",
        record.id, pending.origin.symbol
    ));
    // Nothing here records a deposit: the campaign is funded only by what the chain shows.
    Ok(Json(live_answer(&stored, &pending.origin, false)))
}

/// What a status means, in words for a person. Fixed text.
fn step_message(step: NearStep) -> &'static str {
    match step {
        NearStep::AwaitDeposit => "Waiting for the deposit to the NEAR Intents address.",
        NearStep::AwaitSwap => "The deposit is seen or the swap is running; waiting for it to finish.",
        NearStep::VerifyOnChain => "NEAR Intents reports the ZEC delivered. That is a claim, not funding: the campaign is funded only when the deposit shows on the Zcash chain at the required depth.",
        NearStep::TopUpOrAwaitRefund => "The deposit was smaller than quoted. Send the rest before the deadline, or expect a refund.",
        NearStep::EndedRefunded => "The swap ended and the deposit was refunded. The campaign was not funded by it.",
        NearStep::EndedFailed => "The swap failed. The campaign was not funded by it.",
        NearStep::Investigate => "NEAR Intents reported a state this operator does not know. Do not send more; look into it.",
    }
}

/// `GET /api/campaigns/{id}/funding/near/status`.
pub(crate) async fn near_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let record = mainnet_campaign(&state, &id)?;
    let Some(stored) = state
        .store()
        .load_near_quote(&record.id)
        .map_err(|e| state.internal(&e))?
    else {
        return Err(ApiError::conflict(
            "no_live_quote",
            "this campaign has no NEAR deposit address; ask for a live quote first",
        ));
    };
    let address = stored.deposit_address.clone();
    let memo = stored.deposit_memo.clone();
    let response = blocking(&state, move |gateway| {
        gateway.status(&address, memo.as_deref())
    })
    .await?;
    let (step, txids) = step_for(&response);
    if matches!(step, NearStep::Investigate) {
        // The word itself came from outside: it goes to the log only if it is plain.
        if let drop_near::SwapStatus::Unknown(raw) = &response.status {
            let shown = if plain_text(raw, 40) {
                raw.as_str()
            } else {
                "<unprintable>"
            };
            state.logger().warn(format_args!(
                "near status not in the documentation: {shown}"
            ));
        }
    }
    // Whether the campaign is funded is what the store says, nothing the service claims.
    let funded = state
        .store()
        .load_campaign(&record.id)
        .map_err(|e| state.internal(&e))?
        .is_some_and(|r| r.funding.is_some());
    let now = state.near().now();
    Ok(Json(json!({
        "status": status_word(&response.status),
        "step": step,
        "message": step_message(step),
        "zec_txids": txids,
        "campaign_funded": funded,
        "deposit_address": stored.deposit_address,
        "valid_until": valid_until_text(stored.valid_until),
        "expired": now >= stored.valid_until,
    })))
}
