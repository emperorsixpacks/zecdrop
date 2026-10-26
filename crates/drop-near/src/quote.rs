//! `POST /v0/quote`, dry first (REQ-FUND-001).
//!
//! The only way to build a request is [`DryQuoteRequest::exact_zec_to_campaign`]; the only way
//! to get a [`LiveQuoteRequest`] is [`DryQuoteRequest::confirm`] with a dry response that echoes
//! the same request and delivers exactly the requested amount. So a live quote can never be
//! sent without a matching dry quote first.
//!
//! The swap is `EXACT_OUTPUT`: the campaign's transparent address receives exactly
//! `funding_required` zatoshi of native ZEC, and the funder pays whatever input that costs.

use drop_core::Zatoshi;
use serde::{Deserialize, Serialize};

use crate::address::CampaignTransparentAddress;
use crate::error::NearError;
use crate::tokens::Token;

/// What the operator supplies for a funding quote.
#[derive(Clone, Debug)]
pub struct FundingQuote<'a> {
    /// The asset the funder pays with, as a 1Click `assetId` (e.g. USDC on NEAR).
    pub origin_asset: &'a str,
    /// Native ZEC from [`crate::find_zec`].
    pub zec: &'a Token,
    /// Exactly what the campaign must receive: batch totals plus fees (drop-core's
    /// `standard_funding_required`).
    pub funding_required: Zatoshi,
    pub campaign_address: &'a CampaignTransparentAddress,
    /// Where 1Click refunds the funder on the origin chain if the swap does not complete.
    pub refund_to: &'a str,
    /// ISO 8601 UTC, e.g. `2026-10-07T23:00:00Z`; refunds start after it.
    pub deadline: &'a str,
    /// Basis points (100 = 1%).
    pub slippage_bps: u16,
}

/// The JSON body of `POST /v0/quote` (field names as in the 1Click docs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuoteBody {
    dry: bool,
    swap_type: &'static str,
    slippage_tolerance: u16,
    origin_asset: String,
    deposit_type: &'static str,
    destination_asset: String,
    amount: String,
    refund_to: String,
    refund_type: &'static str,
    recipient: String,
    recipient_type: &'static str,
    deadline: String,
}

/// A `dry: true` quote request. Sending it creates no deposit address and moves no funds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DryQuoteRequest(QuoteBody);

/// A real (`dry: false`) quote request; only obtainable from a matching dry quote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveQuoteRequest(QuoteBody);

fn is_iso8601_utc(s: &str) -> bool {
    // YYYY-MM-DDTHH:MM:SS[.fff]Z
    let b = s.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    b.len() >= 20
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19)
        && b.last() == Some(&b'Z')
}

impl DryQuoteRequest {
    /// An `EXACT_OUTPUT` quote paying exactly `funding_required` native ZEC to the campaign's
    /// transparent address.
    pub fn exact_zec_to_campaign(q: &FundingQuote<'_>) -> Result<Self, NearError> {
        if q.zec.blockchain != "zec" || q.zec.decimals != 8 {
            return Err(NearError::ZecNotListed);
        }
        if q.refund_to.trim().is_empty() {
            return Err(NearError::EmptyRefundAddress);
        }
        if !is_iso8601_utc(q.deadline) {
            return Err(NearError::BadDeadline);
        }
        Ok(DryQuoteRequest(QuoteBody {
            dry: true,
            swap_type: "EXACT_OUTPUT",
            slippage_tolerance: q.slippage_bps,
            origin_asset: q.origin_asset.to_owned(),
            deposit_type: "ORIGIN_CHAIN",
            destination_asset: q.zec.asset_id.clone(),
            amount: q.funding_required.as_u64().to_string(),
            refund_to: q.refund_to.to_owned(),
            refund_type: "ORIGIN_CHAIN",
            recipient: q.campaign_address.as_str().to_owned(),
            recipient_type: "DESTINATION_CHAIN",
            deadline: q.deadline.to_owned(),
        }))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.0).expect("a quote body always serializes")
    }

    /// Checks a dry response against this request; on success returns the matching live
    /// request. The dry response must echo the same assets, amount, recipient and swap type,
    /// carry no deposit address, and quote exactly the requested output.
    pub fn confirm(self, dry: &QuoteResponse) -> Result<LiveQuoteRequest, NearError> {
        check_quote(&self.0, dry)?;
        if dry.quote.deposit_address.is_some() {
            return Err(NearError::DryQuoteHasDepositAddress);
        }
        Ok(LiveQuoteRequest(QuoteBody {
            dry: false,
            ..self.0
        }))
    }
}

impl LiveQuoteRequest {
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.0).expect("a quote body always serializes")
    }

    /// Checks a live response and extracts what the funder must do.
    pub fn deposit_instructions(
        &self,
        live: &QuoteResponse,
    ) -> Result<DepositInstructions, NearError> {
        check_quote(&self.0, live)?;
        let deposit_address = live
            .quote
            .deposit_address
            .clone()
            .ok_or(NearError::LiveQuoteWithoutDepositAddress)?;
        Ok(DepositInstructions {
            deposit_address,
            deposit_memo: live.quote.deposit_memo.clone(),
            origin_asset: self.0.origin_asset.clone(),
            amount_in: live.quote.amount_in.clone(),
            amount_in_formatted: live.quote.amount_in_formatted.clone(),
            zec_out_zat: self.0.amount.clone(),
            deadline: live.quote.deadline.clone(),
        })
    }
}

fn check_quote(req: &QuoteBody, resp: &QuoteResponse) -> Result<(), NearError> {
    let echo = &resp.quote_request;
    let field = |name: &str| echo.get(name).and_then(serde_json::Value::as_str);
    if field("swapType") != Some(req.swap_type) {
        return Err(NearError::QuoteMismatch("swap type"));
    }
    if field("originAsset") != Some(req.origin_asset.as_str())
        || field("destinationAsset") != Some(req.destination_asset.as_str())
    {
        return Err(NearError::QuoteMismatch("assets"));
    }
    if field("recipient") != Some(req.recipient.as_str()) {
        return Err(NearError::QuoteMismatch("recipient"));
    }
    if field("amount") != Some(req.amount.as_str()) {
        return Err(NearError::QuoteMismatch("requested amount"));
    }
    if echo.get("dry").and_then(serde_json::Value::as_bool) != Some(req.dry) {
        return Err(NearError::QuoteMismatch("dry flag"));
    }
    // EXACT_OUTPUT: the campaign must receive exactly the requested zatoshi.
    if resp.quote.amount_out != req.amount {
        return Err(NearError::QuoteMismatch(
            "quoted output differs from the requested amount",
        ));
    }
    if let Some(min_out) = &resp.quote.min_amount_out {
        let (min_out, wanted) = (min_out.parse::<u128>(), req.amount.parse::<u128>());
        if !matches!((min_out, wanted), (Ok(m), Ok(w)) if m >= w) {
            return Err(NearError::QuoteMismatch(
                "minimum output is below the requested amount",
            ));
        }
    }
    Ok(())
}

/// A `POST /v0/quote` response (dry or live).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub correlation_id: String,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    /// The request as the server understood it.
    pub quote_request: serde_json::Value,
    pub quote: Quote,
}

/// Amounts are integers in the asset's smallest unit, as strings.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// Absent for dry quotes.
    #[serde(default)]
    pub deposit_address: Option<String>,
    #[serde(default)]
    pub deposit_memo: Option<String>,
    pub amount_in: String,
    #[serde(default)]
    pub amount_in_formatted: Option<String>,
    #[serde(default)]
    pub amount_in_usd: Option<String>,
    #[serde(default)]
    pub min_amount_in: Option<String>,
    pub amount_out: String,
    #[serde(default)]
    pub amount_out_formatted: Option<String>,
    #[serde(default)]
    pub min_amount_out: Option<String>,
    /// Absent for dry quotes.
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub time_when_inactive: Option<String>,
    /// Seconds.
    #[serde(default)]
    pub time_estimate: Option<u64>,
    #[serde(default)]
    pub refund_fee: Option<String>,
    #[serde(default)]
    pub withdraw_fee: Option<String>,
}

pub fn parse_quote_response(json: &str) -> Result<QuoteResponse, NearError> {
    serde_json::from_str(json).map_err(|e| NearError::Parse(e.to_string()))
}

/// What the funder must do after a live quote: send `amount_in` of `origin_asset` to
/// `deposit_address` (with `deposit_memo` if set) before `deadline`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositInstructions {
    pub deposit_address: String,
    pub deposit_memo: Option<String>,
    pub origin_asset: String,
    pub amount_in: String,
    pub amount_in_formatted: Option<String>,
    /// What the campaign address will receive, in zatoshi.
    pub zec_out_zat: String,
    pub deadline: Option<String>,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::address::tests::DUMMY_T1;
    use crate::tokens::{find_zec, parse_tokens, tests::TOKENS};

    pub(crate) const USDC_ON_NEAR: &str =
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const DRY: &str = include_str!("../testdata/quote-dry-response.captured.json");
    const LIVE: &str = include_str!("../testdata/quote-live-response.from-docs.json");

    /// The parameters the captured dry quote was requested with.
    pub(crate) fn captured_request() -> DryQuoteRequest {
        let tokens = parse_tokens(TOKENS).unwrap();
        let address = CampaignTransparentAddress::parse_mainnet(DUMMY_T1).unwrap();
        let refund = "11".repeat(32);
        DryQuoteRequest::exact_zec_to_campaign(&FundingQuote {
            origin_asset: USDC_ON_NEAR,
            zec: find_zec(&tokens).unwrap(),
            funding_required: Zatoshi::new(545_000).unwrap(),
            campaign_address: &address,
            refund_to: &refund,
            deadline: "2026-10-07T23:04:22.000Z",
            slippage_bps: 100,
        })
        .unwrap()
    }

    // covers: REQ-FUND-001
    #[test]
    fn request_is_dry_exact_output_native_zec_to_the_transparent_address() {
        let json: serde_json::Value = serde_json::from_str(&captured_request().to_json()).unwrap();
        assert_eq!(json["dry"], true);
        assert_eq!(json["swapType"], "EXACT_OUTPUT");
        assert_eq!(json["destinationAsset"], "nep141:zec.omft.near");
        assert_eq!(json["amount"], "545000");
        assert_eq!(json["recipient"], DUMMY_T1);
        assert_eq!(json["recipientType"], "DESTINATION_CHAIN");
    }

    // covers: REQ-FUND-001
    #[test]
    fn the_captured_dry_quote_confirms_into_a_live_request() {
        let dry = parse_quote_response(DRY).unwrap();
        assert!(dry.quote.deposit_address.is_none());
        assert_eq!(dry.quote.amount_out, "545000");
        let live = captured_request().confirm(&dry).unwrap();
        let json: serde_json::Value = serde_json::from_str(&live.to_json()).unwrap();
        assert_eq!(json["dry"], false);
        assert_eq!(json["amount"], "545000");
    }

    // covers: REQ-FUND-001
    #[test]
    fn a_dry_quote_that_does_not_match_is_refused() {
        let mut dry = parse_quote_response(DRY).unwrap();
        dry.quote.amount_out = "544999".into();
        assert!(matches!(
            captured_request().confirm(&dry),
            Err(NearError::QuoteMismatch(_))
        ));

        let mut dry = parse_quote_response(DRY).unwrap();
        dry.quote_request["recipient"] = "t1SomeoneElse".into();
        assert_eq!(
            captured_request().confirm(&dry),
            Err(NearError::QuoteMismatch("recipient"))
        );

        let mut dry = parse_quote_response(DRY).unwrap();
        dry.quote.deposit_address = Some("deposit.near".into());
        assert_eq!(
            captured_request().confirm(&dry),
            Err(NearError::DryQuoteHasDepositAddress)
        );
    }

    // covers: REQ-FUND-001
    #[test]
    fn a_live_response_yields_deposit_instructions() {
        let live_req = captured_request()
            .confirm(&parse_quote_response(DRY).unwrap())
            .unwrap();
        let live = parse_quote_response(LIVE).unwrap();
        let ins = live_req.deposit_instructions(&live).unwrap();
        assert_eq!(ins.deposit_address, "docs-example-deposit-address.near");
        assert_eq!(
            (ins.origin_asset.as_str(), ins.zec_out_zat.as_str()),
            (USDC_ON_NEAR, "545000")
        );

        let mut no_deposit = live.clone();
        no_deposit.quote.deposit_address = None;
        assert_eq!(
            live_req.deposit_instructions(&no_deposit),
            Err(NearError::LiveQuoteWithoutDepositAddress)
        );
    }

    #[test]
    fn bad_inputs_are_refused_before_any_request() {
        let tokens = parse_tokens(TOKENS).unwrap();
        let address = CampaignTransparentAddress::parse_mainnet(DUMMY_T1).unwrap();
        let base = FundingQuote {
            origin_asset: USDC_ON_NEAR,
            zec: find_zec(&tokens).unwrap(),
            funding_required: Zatoshi::new(545_000).unwrap(),
            campaign_address: &address,
            refund_to: "refund.near",
            deadline: "2026-10-07T23:00:00Z",
            slippage_bps: 100,
        };
        assert!(DryQuoteRequest::exact_zec_to_campaign(&base).is_ok());
        let bad_deadline = FundingQuote {
            deadline: "tomorrow",
            ..base.clone()
        };
        assert_eq!(
            DryQuoteRequest::exact_zec_to_campaign(&bad_deadline),
            Err(NearError::BadDeadline)
        );
        let no_refund = FundingQuote {
            refund_to: " ",
            ..base.clone()
        };
        assert_eq!(
            DryQuoteRequest::exact_zec_to_campaign(&no_refund),
            Err(NearError::EmptyRefundAddress)
        );
        let bridged = tokens
            .iter()
            .find(|t| t.symbol == "ZEC" && t.blockchain == "near")
            .unwrap();
        let wrong_zec = FundingQuote {
            zec: bridged,
            ..base
        };
        assert_eq!(
            DryQuoteRequest::exact_zec_to_campaign(&wrong_zec),
            Err(NearError::ZecNotListed)
        );
    }
}
