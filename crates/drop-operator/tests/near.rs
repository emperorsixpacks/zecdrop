//! Funding a campaign through NEAR Intents, through the operator's API (REQ-FUND-001).
//!
//! The service is a stand-in that answers from `drop-near`'s recorded fixtures (the token list and
//! the dry quote were captured from the real service; the live quote and the statuses are shaped
//! from its documentation). **No non-dry quote and no deposit is ever sent by these tests**: the
//! "live" ones talk to the stand-in only.

mod common;

use axum::http::{Method, StatusCode};
use common::near::{Edit, Script, DOCS_DEPOSIT_ADDRESS, STATUSES, USDC};
use common::zcash::*;
use common::*;
use drop_core::{CampaignId, OutPoint, Zatoshi};
use drop_operator::near::{PREVIEW_RECIPIENT, SWAP_WINDOW_SECS};
use drop_operator::store::FundingObserved;
use serde_json::{json, Value};
use zcash_protocol::consensus::Network as ZNetwork;

const CONFIRM: (&str, &str) = ("x-zecdrop-confirm-near", "I-UNDERSTAND");
const REFUND: &str = "refund-account.near";

fn node() -> SharedNode {
    SharedNode::default()
}

/// A mainnet campaign of two recipients on a mainnet operator, and the harness serving it.
async fn mainnet_case(allow_mainnet: bool) -> (Harness, CampaignId, Value) {
    let h = mainnet_harness(&node(), 3, allow_mainnet);
    let csv = format!(
        "address,amount,memo\n{},1.5,\n{},0.75,\n",
        recipient_ua_on(ZNetwork::MainNetwork, 0),
        recipient_ua_on(ZNetwork::MainNetwork, 1)
    );
    let reply = h
        .post(
            "/api/campaigns",
            json!({ "name": "Near drop", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let view = reply.json();
    assert_eq!(view["network"], "mainnet");
    assert!(view["funding_address"].as_str().unwrap().starts_with("t1"));
    (
        h,
        CampaignId::new(view["id"].as_str().unwrap()).unwrap(),
        view,
    )
}

fn path(id: &CampaignId, tail: &str) -> String {
    format!("/api/campaigns/{id}/funding/near/{tail}")
}

async fn dry(h: &Harness, id: &CampaignId, origin: &str) -> Reply {
    h.post(
        &path(id, "dry-quote"),
        json!({ "origin_asset_id": origin, "refund_to": REFUND }),
    )
    .await
}

async fn live_with(h: &Harness, id: &CampaignId, headers: &[(&str, &str)]) -> Reply {
    h.call_with(
        Method::POST,
        &path(id, "live-quote"),
        Auth::Token,
        None,
        headers,
    )
    .await
}

async fn live(h: &Harness, id: &CampaignId) -> Reply {
    live_with(h, id, &[CONFIRM]).await
}

fn asset_ids(tokens: &Value) -> Vec<String> {
    tokens["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["asset_id"].as_str().unwrap().to_owned())
        .collect()
}

// ---------------------------------------------------------------------------
// The token list
// ---------------------------------------------------------------------------

// covers: REQ-FUND-001
#[tokio::test]
async fn the_token_list_is_sorted_has_no_zec_and_is_reused_for_a_minute() {
    let h = Harness::new();
    let reply = h.get("/api/near/tokens").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let tokens = reply.json();
    // Native ZEC and the bridged ZECs are not origins; the rest are, sorted.
    assert_eq!(tokens["count"], 3);
    assert_eq!(
        asset_ids(&tokens),
        vec![
            "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near".to_owned(),
            USDC.to_owned(),
            "nep141:wrap.near".to_owned(),
        ]
    );
    let first = &tokens["tokens"][0];
    assert_eq!(first["symbol"], "USDC");
    assert_eq!(first["blockchain"], "eth");
    assert_eq!(first["decimals"], 6);
    let keys: std::collections::BTreeSet<_> = first
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["asset_id", "blockchain", "decimals", "symbol"]
            .into_iter()
            .collect()
    );

    // A second request inside the minute does not ask the service again.
    h.get("/api/near/tokens").await;
    assert_eq!(h.near.count("GET", "/v0/tokens"), 1);
    h.clock.advance(59);
    h.get("/api/near/tokens").await;
    assert_eq!(
        h.near.count("GET", "/v0/tokens"),
        1,
        "still fresh at 59 seconds"
    );
    h.clock.advance(1);
    h.get("/api/near/tokens").await;
    assert_eq!(h.near.count("GET", "/v0/tokens"), 2, "stale at a minute");
    h.get("/api/near/tokens").await;
    assert_eq!(
        h.near.count("GET", "/v0/tokens"),
        2,
        "and fresh again after the refetch"
    );
}

// covers: REQ-FUND-001, REQ-OPS-002
#[tokio::test]
async fn every_near_route_needs_the_token() {
    let (h, id, _) = mainnet_case(true).await;
    let routes = [
        (Method::GET, "/api/near/tokens".to_owned()),
        (Method::POST, "/api/near/preview".to_owned()),
        (Method::POST, path(&id, "dry-quote")),
        (Method::POST, path(&id, "live-quote")),
        (Method::GET, path(&id, "status")),
    ];
    for (method, route) in routes {
        for auth in [Auth::None, Auth::Wrong] {
            let reply = h
                .call_with(method.clone(), &route, auth, None, &[CONFIRM])
                .await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {route}");
        }
    }
    assert!(
        h.near.calls().is_empty(),
        "nothing reached NEAR without the token"
    );
}

// ---------------------------------------------------------------------------
// The price preview
// ---------------------------------------------------------------------------

// covers: REQ-FUND-001
#[tokio::test]
async fn a_preview_is_a_dry_quote_to_a_placeholder_and_creates_nothing() {
    for h in [Harness::new(), mainnet_harness(&node(), 3, true)] {
        let reply = h
            .post(
                "/api/near/preview",
                json!({ "origin_asset_id": USDC, "amount_zat": 545_000 }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
        let preview = reply.json();
        assert_eq!(preview["preview"], true);
        assert!(preview["note"]
            .as_str()
            .unwrap()
            .contains("no deposit address"));
        assert_eq!(preview["origin_asset"]["symbol"], "USDC");
        assert_eq!(
            preview["destination_asset"]["asset_id"],
            "nep141:zec.omft.near"
        );
        assert_eq!(preview["amount_out_zat"], "545000");
        // The numbers the real service gave for exactly this request (captured).
        assert_eq!(preview["amount_in"], "7679013");
        assert_eq!(preview["amount_in_formatted"], "7.679013");
        assert_eq!(preview["min_amount_in"], "7602222");
        assert_eq!(preview["time_estimate_seconds"], 135);
        assert!(
            preview.get("deposit_address").is_none() && preview.get("depositAddress").is_none()
        );

        // Exactly two calls: the token list, and ONE dry quote to the placeholder.
        let calls = h.near.calls();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(calls[0].url, "https://1click.chaindefuser.com/v0/tokens");
        let body: Value = serde_json::from_str(calls[1].body.as_deref().unwrap()).unwrap();
        assert_eq!(body["dry"], true);
        assert_eq!(body["swapType"], "EXACT_OUTPUT");
        assert_eq!(body["recipient"], PREVIEW_RECIPIENT);
        assert_eq!(body["amount"], "545000");
        assert_eq!(body["destinationAsset"], "nep141:zec.omft.near");
        assert_eq!(body["originAsset"], USDC);
        assert_eq!(h.near.live_quotes(), 0);
        // No campaign was touched, and a preview keeps nothing.
        assert!(h
            .get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty());
    }
}

// covers: REQ-FUND-001
#[tokio::test]
async fn the_amount_may_be_a_number_or_a_decimal_string_and_must_be_sane() {
    let h = Harness::new();
    for amount in [json!(545_000), json!("545000")] {
        let reply = h
            .post(
                "/api/near/preview",
                json!({ "origin_asset_id": USDC, "amount_zat": amount }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }
    let before = h.near.calls().len();
    for bad in [
        json!(0),
        json!("0"),
        json!(""),
        json!("-5"),
        json!("1e6"),
        json!("12.5"),
        json!(" 5"),
        json!("+5"),
        json!(2_100_000_000_000_001u64),
        json!(u64::MAX),
        json!("99999999999999999999999"),
    ] {
        let reply = h
            .post(
                "/api/near/preview",
                json!({ "origin_asset_id": USDC, "amount_zat": bad }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_eq!(
            reply.json()["error"]["code"],
            "amount_out_of_range",
            "{bad}"
        );
    }
    assert_eq!(h.near.calls().len(), before, "a refused amount asks nobody");
}

// covers: REQ-FUND-001
#[tokio::test]
async fn only_a_listed_non_zec_asset_can_be_the_origin() {
    let h = Harness::new();
    let cases = [
        ("nep141:not-listed.near", "unknown_origin_asset"),
        ("", "unknown_origin_asset"),
        ("<script>", "unknown_origin_asset"),
        ("nep141:zec.omft.near", "zec_origin_not_allowed"),
        ("1cs_v1:near:nep141:zec.omft.near", "zec_origin_not_allowed"),
        (
            "1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
            "zec_origin_not_allowed",
        ),
    ];
    for (asset, code) in cases {
        let reply = h
            .post(
                "/api/near/preview",
                json!({ "origin_asset_id": asset, "amount_zat": 1000 }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{asset}");
        assert_eq!(reply.json()["error"]["code"], code, "{asset}");
        assert!(
            !reply.text().contains("<script>"),
            "an error never repeats the input"
        );
    }
    // No quote was asked for any of them.
    assert_eq!(h.near.count("POST", "/v0/quote"), 0);
    // A refund address that is not plain is refused too, and so is an unknown field.
    let reply = h
        .post(
            "/api/near/preview",
            json!({ "origin_asset_id": USDC, "amount_zat": 1000, "refund_to": "bad address!" }),
        )
        .await;
    assert_eq!(reply.json()["error"]["code"], "invalid_refund_address");
    let reply = h
        .post(
            "/api/near/preview",
            json!({ "origin_asset_id": USDC, "amount_zat": 1000, "dry": false }),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::BAD_REQUEST,
        "an unknown field is refused"
    );
    assert_eq!(h.near.count("POST", "/v0/quote"), 0);
}

// covers: REQ-FUND-001, REQ-PRIV-002
#[tokio::test]
async fn a_service_that_misbehaves_is_reported_in_fixed_words_and_nothing_it_said_is_repeated() {
    let h = Harness::new();
    let cases: Vec<(&str, Edit, StatusCode, &str)> = vec![
        (
            "wrong output amount",
            Box::new(|s| s.dry_amount_out = Some("1".into())),
            StatusCode::BAD_GATEWAY,
            "near_quote_mismatch",
        ),
        (
            "a deposit address on a dry quote",
            Box::new(|s| s.dry_with_address = true),
            StatusCode::BAD_GATEWAY,
            "near_bad_response",
        ),
        (
            "credentials refused",
            Box::new(|s| s.fail_with = Some((401, "SERVICEWORDS".into()))),
            StatusCode::BAD_GATEWAY,
            "near_unauthorized",
        ),
        (
            "a refusal with a message",
            Box::new(|s| s.fail_with = Some((400, "SERVICEWORDS go away".into()))),
            StatusCode::BAD_GATEWAY,
            "near_rejected",
        ),
        (
            "unreachable",
            Box::new(|s| s.transport_error = Some("SERVICEWORDS connection refused".into())),
            StatusCode::SERVICE_UNAVAILABLE,
            "near_unavailable",
        ),
    ];
    for (what, edit, status, code) in cases {
        // A fresh token cache each time: the failing call is the one under test.
        h.clock.advance(61);
        h.near.script(|s| *s = Script::default());
        h.near.script(edit);
        let reply = h
            .post(
                "/api/near/preview",
                json!({ "origin_asset_id": USDC, "amount_zat": 545_000 }),
            )
            .await;
        assert_eq!(reply.status, status, "{what}: {}", reply.text());
        assert_eq!(reply.json()["error"]["code"], code, "{what}");
        assert!(
            !reply.text().contains("SERVICEWORDS"),
            "{what}: {}",
            reply.text()
        );
    }
    assert!(!h.logs.lines().join("\n").contains("SERVICEWORDS"));
    assert_eq!(h.near.live_quotes(), 0);
}

// ---------------------------------------------------------------------------
// A campaign's quotes: mainnet only
// ---------------------------------------------------------------------------

// covers: REQ-FUND-001
#[tokio::test]
async fn a_testnet_campaign_cannot_use_near_and_is_told_why() {
    let h = real_harness(&node(), 3);
    let csv = format!("address,amount,memo\n{},1.5,\n", recipient_ua(0));
    let reply = h
        .post(
            "/api/campaigns",
            json!({ "name": "t", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" }),
        )
        .await;
    let id = CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap();
    assert_eq!(reply.json()["network"], "testnet");

    // Even with the acknowledgement, and on an operator that allows mainnet.
    for (method, tail, body) in [
        (
            Method::POST,
            "dry-quote",
            Some(json!({ "origin_asset_id": USDC, "refund_to": REFUND })),
        ),
        (Method::POST, "live-quote", None),
        (Method::GET, "status", None),
    ] {
        let reply = h
            .call_with(method, &path(&id, tail), Auth::Token, body, &[CONFIRM])
            .await;
        assert_eq!(
            reply.status,
            StatusCode::CONFLICT,
            "{tail}: {}",
            reply.text()
        );
        let error = &reply.json()["error"];
        assert_eq!(error["code"], "not_applicable", "{tail}");
        let message = error["message"].as_str().unwrap();
        assert!(
            message.contains("mainnet") && message.contains("testnet"),
            "{message}"
        );
        assert!(
            message.contains("/api/near/preview"),
            "it says what still works: {message}"
        );
    }
    assert!(h.near.calls().is_empty(), "NEAR was not asked");
    assert!(h.state.store().load_near_quote(&id).unwrap().is_none());
}

// covers: REQ-FUND-001
#[tokio::test]
async fn a_dry_quote_for_a_mainnet_campaign_asks_for_exactly_what_it_needs() {
    let (h, id, view) = mainnet_case(true).await;
    let reply = dry(&h, &id, USDC).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let quote = reply.json();
    assert_eq!(quote["dry"], true);
    assert_eq!(quote["campaign_id"], id.to_string());
    assert_eq!(quote["funding_required_zat"], view["funding_required"]);
    assert_eq!(quote["campaign_funding_address"], view["funding_address"]);
    assert_eq!(quote["valid_for_seconds"], 600);
    assert_eq!(quote["amount_in"], "7679013");
    assert!(quote.get("deposit_address").is_none());
    assert!(quote["note"]
        .as_str()
        .unwrap()
        .contains("nothing was created"));
    assert!(quote["expires_at"].as_str().unwrap().ends_with('Z'));

    let calls = h.near.calls();
    let body: Value = serde_json::from_str(calls.last().unwrap().body.as_deref().unwrap()).unwrap();
    assert_eq!(body["dry"], true);
    assert_eq!(body["swapType"], "EXACT_OUTPUT");
    assert_eq!(body["amount"], view["funding_required"]);
    assert_eq!(body["recipient"], view["funding_address"]);
    assert_eq!(body["refundTo"], REFUND);
    assert_eq!(body["originAsset"], USDC);
    assert_eq!(h.near.live_quotes(), 0);
    assert!(h.state.near().has_dry(&id));
    // Nothing is persisted for a dry quote, and the campaign is untouched.
    assert!(h.state.store().load_near_quote(&id).unwrap().is_none());
    assert!(h
        .state
        .store()
        .load_campaign(&id)
        .unwrap()
        .unwrap()
        .funding
        .is_none());
}

// covers: REQ-FUND-001
#[tokio::test]
async fn a_dry_quote_needs_a_listed_origin_a_plain_refund_address_and_an_unfunded_campaign() {
    let (h, id, _) = mainnet_case(true).await;
    let bad = [
        (
            json!({ "origin_asset_id": "nope", "refund_to": REFUND }),
            "unknown_origin_asset",
        ),
        (
            json!({ "origin_asset_id": "nep141:zec.omft.near", "refund_to": REFUND }),
            "zec_origin_not_allowed",
        ),
        (
            json!({ "origin_asset_id": USDC, "refund_to": "" }),
            "invalid_refund_address",
        ),
        (
            json!({ "origin_asset_id": USDC, "refund_to": "a b" }),
            "invalid_refund_address",
        ),
        (
            json!({ "origin_asset_id": USDC, "refund_to": "x".repeat(201) }),
            "invalid_refund_address",
        ),
    ];
    for (body, code) in bad {
        let reply = h.post(&path(&id, "dry-quote"), body).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{code}");
        assert_eq!(reply.json()["error"]["code"], code);
    }
    // A missing field and an unknown one.
    for body in [
        json!({ "origin_asset_id": USDC }),
        json!({ "origin_asset_id": USDC, "refund_to": REFUND, "dry": false }),
    ] {
        let reply = h.post(&path(&id, "dry-quote"), body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(h.near.count("POST", "/v0/quote"), 0);
    assert!(!h.state.near().has_dry(&id));

    // A campaign that already has its deposit is not quoted for.
    h.state
        .store()
        .record_funding(
            &id,
            FundingObserved {
                outpoint: OutPoint {
                    txid: "ab".repeat(32).parse().unwrap(),
                    vout: 0,
                },
                amount: Zatoshi::new(1_000_000_000).unwrap(),
            },
        )
        .unwrap();
    let reply = dry(&h, &id, USDC).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "already_funded");
    assert_eq!(h.near.count("POST", "/v0/quote"), 0);

    // An unknown campaign.
    let ghost = CampaignId::new("c-ffffffffffff").unwrap();
    assert_eq!(dry(&h, &ghost, USDC).await.status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// The live quote: the gates, in order
// ---------------------------------------------------------------------------

// covers: REQ-FUND-001
#[tokio::test]
async fn a_live_quote_needs_the_acknowledgement_before_anything_else_is_asked() {
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    for headers in [
        vec![],
        vec![("x-zecdrop-confirm-near", "")],
        vec![("x-zecdrop-confirm-near", "yes")],
        vec![("x-zecdrop-confirm-near", "i-understand")],
        vec![("x-zecdrop-confirm-near", "I-UNDERSTAND ")],
        vec![("x-zecdrop-confirm-disclosure", "I-UNDERSTAND")],
    ] {
        let reply = live_with(&h, &id, &headers).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{headers:?}");
        let error = &reply.json()["error"];
        assert_eq!(error["code"], "confirmation_required");
        // The refusal carries the warning the UI must show.
        assert!(error["warning"].as_str().unwrap().contains("real swap"));
        assert!(error["message"]
            .as_str()
            .unwrap()
            .contains("X-Zecdrop-Confirm-Near"));
    }
    assert_eq!(h.near.live_quotes(), 0);
    // A refusal for a missing acknowledgement does not use up the dry quote.
    assert!(h.state.near().has_dry(&id));
    assert_eq!(live(&h, &id).await.status, StatusCode::OK);
}

// covers: REQ-FUND-001
#[tokio::test]
async fn an_operator_not_started_for_mainnet_never_asks_for_a_deposit_address() {
    let (h, id, _) = mainnet_case(false).await;
    assert_eq!(
        dry(&h, &id, USDC).await.status,
        StatusCode::OK,
        "a dry quote is only a price"
    );
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json()["error"]["code"], "mainnet_not_enabled");
    assert!(reply.json()["error"]["message"]
        .as_str()
        .unwrap()
        .contains("--allow-mainnet"));
    assert_eq!(h.near.live_quotes(), 0);
    assert!(h.state.store().load_near_quote(&id).unwrap().is_none());
}

// covers: REQ-FUND-001
#[tokio::test]
async fn there_is_no_live_quote_without_a_matching_unexpired_dry_one() {
    let (h, id, _) = mainnet_case(true).await;

    // None at all.
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "no_dry_quote");

    // One that has gone stale: ten minutes.
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    h.clock.advance(600);
    // Exactly at the limit it still counts ...
    assert_eq!(
        live(&h, &id).await.status,
        StatusCode::OK,
        "{}",
        "ten minutes is still good"
    );
    // ... a minute past it does not.
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    h.clock.advance(601);
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "dry_quote_expired");
    assert_eq!(h.near.live_quotes(), 0);
    // And it was used up: a fresh one is needed.
    assert_eq!(live(&h, &id).await.json()["error"]["code"], "no_dry_quote");
}

// covers: REQ-FUND-001
#[tokio::test]
async fn a_dry_quote_for_something_else_is_not_made_live() {
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    // The campaign's needs changed since (a different amount to receive).
    let mut pending = h.state.near().take_dry(&id).unwrap();
    pending.funding_required = Zatoshi::new(pending.funding_required.as_u64() + 1).unwrap();
    h.state.near().keep_dry(id.clone(), pending.clone());
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "dry_quote_stale");

    // Another campaign address.
    pending.funding_required = Zatoshi::new(pending.funding_required.as_u64() - 1).unwrap();
    pending.funding_address = "t1SomeoneElsesAddress0000000000000".into();
    h.state.near().keep_dry(id.clone(), pending);
    assert_eq!(
        live(&h, &id).await.json()["error"]["code"],
        "dry_quote_stale"
    );
    assert_eq!(h.near.live_quotes(), 0);

    // A dry quote for one campaign is no use to another.
    let (h2, id2, _) = mainnet_case(true).await;
    assert_eq!(dry(&h2, &id2, USDC).await.status, StatusCode::OK);
    let other = CampaignId::new("c-000000000099").unwrap();
    assert!(!h2.state.near().has_dry(&other));
}

// covers: REQ-FUND-001
#[tokio::test]
async fn a_live_quote_gives_the_deposit_address_keeps_it_and_never_funds_the_campaign() {
    let (h, id, view) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let quote = reply.json();
    assert_eq!(quote["live"], true);
    assert_eq!(quote["campaign_funded"], false);
    assert_eq!(quote["deposit_address"], DOCS_DEPOSIT_ADDRESS);
    assert_eq!(quote["origin_asset"]["symbol"], "USDC");
    assert_eq!(quote["amount_in"], "7679013");
    assert_eq!(quote["zec_out_zat"], view["funding_required"]);
    assert_eq!(quote["campaign_funding_address"], view["funding_address"]);
    assert_eq!(quote["refund_to"], REFUND);
    assert!(quote["deadline"].as_str().unwrap().ends_with('Z'));
    let instructions: Vec<String> = quote["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_owned())
        .collect();
    assert!(instructions[0].contains(DOCS_DEPOSIT_ADDRESS) && instructions[0].contains("7.679013"));
    assert!(instructions
        .iter()
        .any(|l| l.contains("seen on the Zcash chain")));
    assert_eq!(
        quote["valid_until"].as_str().unwrap(),
        drop_operator::near::iso8601_utc(ManualClock::START + SWAP_WINDOW_SECS)
    );

    // Exactly one live quote was asked for, for exactly the dry quote's request.
    assert_eq!(h.near.live_quotes(), 1);
    let calls = h.near.calls();
    let live_call = calls.iter().find(|c| c.is_live_quote()).unwrap();
    let sent: Value = serde_json::from_str(live_call.body.as_deref().unwrap()).unwrap();
    let dry_call = calls
        .iter()
        .rfind(|c| c.method == "POST" && !c.is_live_quote())
        .unwrap();
    let mut dry_sent: Value = serde_json::from_str(dry_call.body.as_deref().unwrap()).unwrap();
    dry_sent["dry"] = json!(false);
    assert_eq!(
        sent, dry_sent,
        "the live request is the dry one with dry: false, nothing else"
    );

    // Kept, sealed; and nothing says the campaign is funded.
    let stored = h.state.store().load_near_quote(&id).unwrap().unwrap();
    assert_eq!(stored.deposit_address, DOCS_DEPOSIT_ADDRESS);
    assert_eq!(
        stored.funding_address,
        view["funding_address"].as_str().unwrap()
    );
    let record = h.state.store().load_campaign(&id).unwrap().unwrap();
    assert!(
        record.funding.is_none(),
        "a deposit address is not a deposit"
    );
    let got = h.get(&format!("/api/campaigns/{id}")).await.json();
    assert_eq!(got["phase"]["phase"], "awaiting_funding");
    assert!(got["funding"].is_null());
    // The deposit address is not in the store file in the clear.
    let bytes = std::fs::read(&h.db).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(DOCS_DEPOSIT_ADDRESS));
}

// covers: REQ-FUND-001
#[tokio::test]
async fn the_deposit_address_survives_a_restart_and_is_not_replaced_while_it_is_good() {
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    assert_eq!(live(&h, &id).await.status, StatusCode::OK);

    let h = h.restart_as(TEST_SEED, Builder::default().options);
    // The status route finds the quote after the restart, with no dry quote in memory.
    let status = h.get(&path(&id, "status")).await;
    assert_eq!(status.status, StatusCode::OK, "{}", status.text());
    assert_eq!(status.json()["deposit_address"], DOCS_DEPOSIT_ADDRESS);
    let calls = h.near.calls();
    let asked = calls
        .iter()
        .rfind(|c| c.url.contains("/v0/status"))
        .unwrap();
    assert!(asked
        .url
        .contains(&format!("depositAddress={DOCS_DEPOSIT_ADDRESS}")));

    // A new dry quote does not become a second deposit address while the first is valid.
    let asked = h.near.live_quotes();
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "live_quote_exists");
    assert_eq!(
        h.near.live_quotes(),
        asked,
        "no second deposit address was asked for"
    );

    // At its deadline, exactly, a new one may be asked for (one second before, not).
    h.clock.advance(SWAP_WINDOW_SECS - 1);
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    assert_eq!(
        live(&h, &id).await.json()["error"]["code"],
        "live_quote_exists"
    );
    h.clock.advance(1);
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    assert_eq!(live(&h, &id).await.status, StatusCode::OK);
    assert_eq!(h.near.live_quotes(), asked + 1);
}

// covers: REQ-FUND-001
#[tokio::test]
async fn a_deposit_memo_is_shown_kept_and_sent_back_with_every_status_check() {
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    h.near.script(|s| s.live_memo = Some("memo-7".into()));
    let quote = live(&h, &id).await;
    assert_eq!(quote.status, StatusCode::OK, "{}", quote.text());
    assert_eq!(quote.json()["deposit_memo"], "memo-7");
    assert!(quote.json()["instructions"].to_string().contains("memo-7"));
    assert_eq!(
        h.state
            .store()
            .load_near_quote(&id)
            .unwrap()
            .unwrap()
            .deposit_memo
            .as_deref(),
        Some("memo-7")
    );
    assert_eq!(h.get(&path(&id, "status")).await.status, StatusCode::OK);
    let asked = h
        .near
        .calls()
        .into_iter()
        .rfind(|c| c.url.contains("/v0/status"))
        .unwrap();
    assert!(asked.url.contains("depositMemo=memo-7"), "{}", asked.url);
}

// covers: REQ-FUND-001
#[tokio::test]
async fn a_token_list_without_native_zec_is_reported_not_guessed_at() {
    let h = Harness::new();
    // Only bridged ZEC, which would pay out on another chain.
    let without_native: Vec<Value> = serde_json::from_str::<Vec<Value>>(common::near::TOKENS)
        .unwrap()
        .into_iter()
        .filter(|t| t["blockchain"] != "zec")
        .collect();
    h.near
        .script(|s| s.tokens_body = Some(serde_json::to_string(&without_native).unwrap()));
    let reply = h
        .post(
            "/api/near/preview",
            json!({ "origin_asset_id": USDC, "amount_zat": 1000 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json()["error"]["code"], "near_zec_not_listed");
    assert_eq!(h.near.count("POST", "/v0/quote"), 0);
    // Listing the origins still works.
    assert_eq!(h.get("/api/near/tokens").await.status, StatusCode::OK);
}

// covers: REQ-FUND-001, REQ-PRIV-002
#[tokio::test]
async fn a_deposit_address_that_cannot_be_kept_is_handed_over_rather_than_stranded() {
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    // The store refuses to write the quote.
    rusqlite::Connection::open(&h.db)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse BEFORE INSERT ON near_quotes BEGIN SELECT RAISE(ABORT, 'no'); END;",
        )
        .unwrap();
    let reply = live(&h, &id).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    let error = &reply.json()["error"];
    assert_eq!(error["code"], "near_quote_not_saved");
    // The address exists at NEAR: it is told, so that it is not lost, and the message says it
    // is not being tracked.
    assert_eq!(error["deposit_address"], DOCS_DEPOSIT_ADDRESS);
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("will not track"));
    assert!(h.state.store().load_near_quote(&id).unwrap().is_none());
    assert!(h
        .state
        .store()
        .load_campaign(&id)
        .unwrap()
        .unwrap()
        .funding
        .is_none());
}

// covers: REQ-FUND-001, REQ-PRIV-002
#[tokio::test]
async fn a_live_quote_the_service_gets_wrong_keeps_nothing_and_uses_up_the_dry_quote() {
    let cases: Vec<(&str, Edit, &str)> = vec![
        (
            "no deposit address",
            Box::new(|s| s.live_without_address = true),
            "near_bad_response",
        ),
        (
            "wrong output",
            Box::new(|s| s.live_amount_out = Some("1".into())),
            "near_quote_mismatch",
        ),
        (
            "an address with markup",
            Box::new(|s| s.deposit_address = Some("<b>pay me</b>".into())),
            "near_bad_response",
        ),
        (
            "an address with a space",
            Box::new(|s| s.deposit_address = Some("pay me".into())),
            "near_bad_response",
        ),
        (
            "an amount in that is not a number",
            Box::new(|s| s.live_amount_in = Some("<b>7</b>".into())),
            "near_bad_response",
        ),
        (
            "a memo with markup",
            Box::new(|s| s.live_memo = Some("<b>memo</b>".into())),
            "near_bad_response",
        ),
        (
            "an address far too long",
            Box::new(|s| s.deposit_address = Some("a".repeat(200))),
            "near_bad_response",
        ),
        (
            "credentials refused",
            Box::new(|s| s.fail_with = Some((401, "SERVICEWORDS".into()))),
            "near_unauthorized",
        ),
        (
            "unreachable",
            Box::new(|s| s.transport_error = Some("SERVICEWORDS".into())),
            "near_unavailable",
        ),
    ];
    for (what, edit, code) in cases {
        let (h, id, _) = mainnet_case(true).await;
        assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
        h.near.script(edit);
        let reply = live(&h, &id).await;
        assert!(!reply.status.is_success(), "{what}");
        assert_eq!(
            reply.json()["error"]["code"],
            code,
            "{what}: {}",
            reply.text()
        );
        assert!(
            !reply.text().contains("SERVICEWORDS") && !reply.text().contains("<b>"),
            "{what}"
        );
        assert!(
            h.state.store().load_near_quote(&id).unwrap().is_none(),
            "{what}: nothing kept"
        );
        assert!(
            !h.state.near().has_dry(&id),
            "{what}: the dry quote is used up"
        );
        assert!(h
            .state
            .store()
            .load_campaign(&id)
            .unwrap()
            .unwrap()
            .funding
            .is_none());
    }
}

// ---------------------------------------------------------------------------
// Status: never "funded"
// ---------------------------------------------------------------------------

async fn quoted_case() -> (Harness, CampaignId) {
    let (h, id, _) = mainnet_case(true).await;
    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    assert_eq!(live(&h, &id).await.status, StatusCode::OK);
    (h, id)
}

// covers: REQ-FUND-001
#[tokio::test]
async fn every_status_maps_to_a_fixed_word_and_step_and_none_of_them_is_funded() {
    let (h, id) = quoted_case().await;
    let expected = [
        ("pending-deposit", "pending_deposit", "await_deposit"),
        ("known-deposit-tx", "known_deposit_tx", "await_swap"),
        ("processing", "processing", "await_swap"),
        ("success", "success", "verify_on_chain"),
        (
            "incomplete-deposit",
            "incomplete_deposit",
            "top_up_or_await_refund",
        ),
        ("refunded", "refunded", "ended_refunded"),
        ("failed", "failed", "ended_failed"),
        ("mystery-state", "unknown", "investigate"),
    ];
    assert_eq!(expected.len(), STATUSES.len());
    for (fixture, status, step) in expected {
        h.near.script(|s| s.status = fixture);
        let reply = h.get(&path(&id, "status")).await;
        assert_eq!(reply.status, StatusCode::OK, "{fixture}: {}", reply.text());
        let answer = reply.json();
        assert_eq!(answer["status"], status, "{fixture}");
        assert_eq!(answer["step"], step, "{fixture}");
        assert_eq!(
            answer["campaign_funded"], false,
            "{fixture}: the service's word is not funding"
        );
        assert!(!answer["message"].as_str().unwrap().is_empty());
        assert_eq!(answer["deposit_address"], DOCS_DEPOSIT_ADDRESS);
        // Nothing about the campaign changed.
        let record = h.state.store().load_campaign(&id).unwrap().unwrap();
        assert!(record.funding.is_none(), "{fixture}");
        assert_eq!(
            h.get(&format!("/api/campaigns/{id}")).await.json()["phase"]["phase"],
            "awaiting_funding",
            "{fixture}"
        );
    }
}

// covers: REQ-FUND-001, REQ-FUND-002
#[tokio::test]
async fn success_says_to_verify_on_chain_and_funded_means_what_the_store_says() {
    let (h, id) = quoted_case().await;
    h.near.script(|s| s.status = "success");
    let answer = h.get(&path(&id, "status")).await.json();
    assert_eq!(answer["step"], "verify_on_chain");
    assert!(answer["message"].as_str().unwrap().contains("not funding"));
    assert_eq!(
        answer["zec_txids"],
        json!(["a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"])
    );
    assert_eq!(answer["campaign_funded"], false);

    // When the deposit has really been seen and recorded by the operator, and only then, the
    // answer says so: it reads the store, not the service.
    h.state
        .store()
        .record_funding(
            &id,
            FundingObserved {
                outpoint: OutPoint {
                    txid: "cd".repeat(32).parse().unwrap(),
                    vout: 0,
                },
                amount: Zatoshi::new(1_000_000_000).unwrap(),
            },
        )
        .unwrap();
    h.near.script(|s| s.status = "pending-deposit");
    assert_eq!(
        h.get(&path(&id, "status")).await.json()["campaign_funded"],
        true
    );
}

// covers: REQ-FUND-001, REQ-PRIV-002
#[tokio::test]
async fn text_the_service_sends_back_in_a_status_is_filtered_to_what_is_plain() {
    let (h, id) = quoted_case().await;
    // Hostile transaction ids and an unknown status with markup.
    h.near.script(|s| {
        s.status_body = Some(
            json!({
                "status": "SUCCESS",
                "swapDetails": { "destinationChainTxHashes": [
                    { "hash": "<img src=x onerror=alert(1)>" },
                    { "hash": "ab" },
                    { "hash": "A".repeat(64) },
                ]}
            })
            .to_string(),
        );
    });
    let answer = h.get(&path(&id, "status")).await;
    assert!(!answer.text().contains("<img"), "{}", answer.text());
    assert_eq!(
        answer.json()["zec_txids"],
        json!(["a".repeat(64)]),
        "only well-formed ids, lower-cased"
    );

    h.near.script(|s| {
        s.status_body = Some(json!({ "status": "<script>PWNED</script>" }).to_string());
    });
    let answer = h.get(&path(&id, "status")).await;
    assert_eq!(answer.json()["status"], "unknown");
    assert_eq!(answer.json()["step"], "investigate");
    assert!(!answer.text().contains("PWNED"));
    assert!(
        !h.logs.lines().join("\n").contains("PWNED"),
        "not even the log repeats it"
    );
}

// covers: REQ-FUND-001
#[tokio::test]
async fn the_status_needs_a_deposit_address_and_reports_when_it_has_run_out() {
    let (h, id, _) = mainnet_case(true).await;
    let reply = h.get(&path(&id, "status")).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "no_live_quote");
    assert_eq!(h.near.count("GET", "/v0/status"), 0);

    assert_eq!(dry(&h, &id, USDC).await.status, StatusCode::OK);
    assert_eq!(live(&h, &id).await.status, StatusCode::OK);
    let answer = h.get(&path(&id, "status")).await.json();
    assert_eq!(answer["expired"], false);
    h.clock.advance(SWAP_WINDOW_SECS);
    assert_eq!(h.get(&path(&id, "status")).await.json()["expired"], true);

    // The service being down is its own, fixed, answer.
    h.near
        .script(|s| s.transport_error = Some("SERVICEWORDS".into()));
    let reply = h.get(&path(&id, "status")).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.json()["error"]["code"], "near_unavailable");
    assert!(!reply.text().contains("SERVICEWORDS"));
}

// covers: REQ-FUND-001, REQ-SEC-002
#[tokio::test]
async fn a_deposit_address_that_was_edited_in_the_store_is_never_used() {
    let (h, id) = quoted_case().await;
    let conn = rusqlite::Connection::open(&h.db).unwrap();
    // Someone swaps in their own sealed record, or damages the row.
    conn.execute(
        "UPDATE near_quotes SET record_enc = randomblob(400) WHERE campaign_id = ?1",
        [id.as_str()],
    )
    .unwrap();
    let calls_before = h.near.calls().len();
    let reply = h.get(&path(&id, "status")).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.json()["error"]["code"], "store_corrupt");
    assert_eq!(
        h.near.calls().len(),
        calls_before,
        "nothing was asked about an address nobody vouches for"
    );
    assert!(
        h.state.verify_store().is_err(),
        "the start-up check finds it too"
    );
}

// covers: REQ-FUND-001, REQ-PRIV-002
#[tokio::test]
async fn no_response_log_or_request_carries_recipient_data_and_the_service_never_sees_it() {
    let (h, id, view) = mainnet_case(true).await;
    let needles: Vec<String> = [0, 1]
        .iter()
        .map(|i| recipient_ua_on(ZNetwork::MainNetwork, *i))
        .chain([
            "1.5".to_owned(),
            "0.75".to_owned(),
            "150000000".to_owned(),
            "75000000".to_owned(),
        ])
        .collect();
    let mut texts = vec![
        h.get("/api/near/tokens").await.text(),
        h.post(
            "/api/near/preview",
            json!({ "origin_asset_id": USDC, "amount_zat": 545_000 }),
        )
        .await
        .text(),
        dry(&h, &id, USDC).await.text(),
        live(&h, &id).await.text(),
        h.get(&path(&id, "status")).await.text(),
    ];
    texts.push(h.logs.lines().join("\n"));
    for call in h.near.calls() {
        texts.push(call.url.clone());
        texts.extend(call.body.clone());
        texts.extend(call.headers.iter().map(|(k, v)| format!("{k}: {v}")));
    }
    for text in &texts {
        for needle in &needles {
            assert!(
                !text.contains(needle.as_str()),
                "{needle} leaked into: {text}"
            );
        }
    }
    // What the service is told is the campaign's address and what it needs: public things.
    let live_body = h
        .near
        .calls()
        .iter()
        .find(|c| c.is_live_quote())
        .unwrap()
        .body
        .clone()
        .unwrap();
    assert!(live_body.contains(view["funding_address"].as_str().unwrap()));
}
