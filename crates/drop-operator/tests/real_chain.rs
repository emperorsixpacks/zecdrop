//! The operator on a "real" chain: ZIP-32 account per campaign, funding detected on chain
//! at the required depth, batches built and sent by `drop-zcash`'s distributor. The node is
//! an in-memory fake; the transactions are genuine librustzcash transactions with TEST-ONLY
//! keys.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use common::zcash::*;
use common::*;
use drop_core::{CampaignId, PublicReceipt, Zatoshi};
use drop_operator::state::{Options, RunState};
use drop_verify::{verify_campaign, FetchedTx, ParsedTx, VerifyConfig, VerifyRequest};
use drop_zcash::inspect::{public_totals, recover_with_ufvk};
use drop_zcash::CampaignKeys;
use serde_json::{json, Value};

const DEPTH: u32 = 3;

fn real(node: &SharedNode) -> Harness {
    real_harness(node, DEPTH)
}

fn rows() -> Vec<Row> {
    vec![
        Row {
            address: recipient_ua(0),
            zat: 150_000_000,
            memo: Some("hello zero".into()),
        },
        Row {
            address: recipient_ua(1),
            zat: 75_000_000,
            memo: None,
        },
        Row {
            address: recipient_ua(2),
            zat: 225_000_000,
            memo: Some("thanks two".into()),
        },
    ]
}

/// 450_000_000 declared + (3 outputs + 1 transparent) * 5000.
const REQUIRED: u64 = 450_020_000;

fn body(rows: &[Row], max_outputs: usize) -> Value {
    let mut csv = String::from("address,amount,memo\n");
    for r in rows {
        csv.push_str(&format!(
            "{},{},{}\n",
            r.address,
            Zatoshi::new(r.zat).unwrap().format_zec(),
            r.memo.clone().unwrap_or_default()
        ));
    }
    json!({ "name": "Real drop", "csv": csv, "max_outputs_per_batch": max_outputs, "fee_policy": "zip317_text" })
}

async fn create(h: &Harness) -> (CampaignId, Value) {
    let reply = h.post("/api/campaigns", body(&rows(), 5)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let view = reply.json();
    (CampaignId::new(view["id"].as_str().unwrap()).unwrap(), view)
}

async fn check(h: &Harness, id: &CampaignId) -> Value {
    let reply = h
        .post_empty(&format!("/api/campaigns/{id}/check-funding"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

// ---------------------------------------------------------------------------
// One account, one address, one viewing key per campaign (REQ-AUD-002)
// ---------------------------------------------------------------------------

// covers: REQ-AUD-002
#[tokio::test]
async fn every_campaign_gets_its_own_account_and_funding_address() {
    let node = SharedNode::default();
    let h = real(&node);
    let (a, view_a) = create(&h).await;
    let (b, view_b) = create(&h).await;

    let account = |id: &CampaignId| h.state.store().load_campaign(id).unwrap().unwrap().account;
    assert_eq!((account(&a), account(&b)), (0, 1));

    let address = |n| {
        CampaignKeys::derive(&TEST_SEED, NETWORK, n)
            .unwrap()
            .funding_address()
    };
    assert_eq!(view_a["funding_address"], address(0));
    assert_eq!(view_b["funding_address"], address(1));
    assert_ne!(view_a["funding_address"], view_b["funding_address"]);
    assert!(
        view_a["funding_address"]
            .as_str()
            .unwrap()
            .starts_with("tm"),
        "a testnet P2PKH address"
    );
    assert_eq!(view_a["wallet_matches"], true);
    assert!(view_a["funding"].is_null() && view_a["funding_progress"].is_null());

    // The same address comes back from the list and from GET.
    let got = h.get(&format!("/api/campaigns/{b}")).await.json();
    assert_eq!(got["funding_address"], address(1));
}

// covers: REQ-AUD-002
#[tokio::test]
async fn the_mock_chain_has_no_funding_address() {
    let h = Harness::new();
    let (_, view) = h.create().await;
    assert!(view["funding_address"].is_null());
    assert_eq!(h.get("/api/health").await.json()["mock"], true);
}

// covers: REQ-OPS-001
#[tokio::test]
async fn health_says_the_chain_is_not_a_mock() {
    let node = SharedNode::default();
    let h = real(&node);
    let reply = h
        .call(axum::http::Method::GET, "/api/health", Auth::None, None)
        .await;
    assert_eq!(
        reply.json(),
        json!({ "ok": true, "network": "testnet", "mock": false })
    );
}

// ---------------------------------------------------------------------------
// Funded only when seen on chain at the required depth (REQ-FUND-002)
// ---------------------------------------------------------------------------

// covers: REQ-FUND-002
#[tokio::test]
async fn a_campaign_is_funded_only_when_the_deposit_is_on_chain_at_the_required_depth() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real(&node);
    let (id, view) = create(&h).await;
    let address = view["funding_address"].as_str().unwrap().to_owned();
    assert_eq!(view["funding_required"], REQUIRED.to_string());

    // Nothing there yet.
    let v = check(&h, &id).await;
    assert!(v["funding"].is_null() && v["funding_progress"].is_null());
    assert_eq!(v["phase"]["phase"], "awaiting_funding");

    // A deep deposit that is too small does not fund it.
    put_deposit(&node, &address, REQUIRED - 1, Some(990), 1);
    let v = check(&h, &id).await;
    assert!(v["funding"].is_null());
    assert_eq!(v["funding_progress"]["sufficient"], false);
    assert_eq!(v["funding_progress"]["confirmations"], 11);

    // A big enough one still in the mempool does not either.
    let (op, _) = put_deposit(&node, &address, REQUIRED, None, 2);
    let v = check(&h, &id).await;
    assert!(v["funding"].is_null());
    assert_eq!(v["funding_progress"]["confirmations"], 0);
    assert_eq!(v["funding_progress"]["sufficient"], true);
    assert_eq!(v["funding_progress"]["required_depth"], DEPTH);

    // Mined, but one block short of the depth: progress only, and nothing can start.
    node.lock().deposits.last_mut().unwrap().height = Some(999);
    let v = check(&h, &id).await;
    assert!(v["funding"].is_null());
    assert_eq!(v["funding_progress"]["confirmations"], 2);
    assert_eq!(v["phase"]["phase"], "awaiting_funding");
    let start = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(start.status, StatusCode::CONFLICT);
    assert_eq!(start.json()["error"]["code"], "not_funded");
    assert!(h.chain.builds().is_empty());

    // One more block: funded, and the progress note goes away.
    node.lock().tip = 1_001;
    let v = check(&h, &id).await;
    assert_eq!(v["phase"]["phase"], "funded");
    assert_eq!(v["funding"]["outpoint"], op.to_string());
    assert_eq!(v["funding"]["amount"], REQUIRED.to_string());
    assert!(v["funding_progress"].is_null());
    // The view hides progress once funded; the state must not keep it around either.
    assert!(h.state.funding_progress(&id).is_none());
    let stored = h.state.store().load_campaign(&id).unwrap().unwrap();
    assert_eq!(stored.funding.unwrap().outpoint, op);
}

// covers: REQ-FUND-002
#[tokio::test]
async fn nothing_but_the_chain_can_mark_a_real_campaign_funded() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real(&node);
    let (id, view) = create(&h).await;
    // The dev-only declaration is refused on a real chain, whatever it claims.
    let declared = h.fund(&id, &view).await;
    assert_eq!(declared.status, StatusCode::FORBIDDEN);
    assert_eq!(declared.json()["error"]["code"], "dev_only");
    assert!(h.get(&format!("/api/campaigns/{id}")).await.json()["funding"].is_null());

    // Funding at someone else's address (another campaign's) does not count for this one.
    let other = CampaignKeys::derive(&TEST_SEED, NETWORK, 9)
        .unwrap()
        .funding_address();
    put_deposit(&node, &other, REQUIRED * 2, Some(500), 3);
    assert!(check(&h, &id).await["funding"].is_null());
}

// covers: REQ-FUND-002
#[tokio::test]
async fn the_background_poller_funds_campaigns_without_being_asked() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real(&node);
    let (id, view) = create(&h).await;
    put_deposit(
        &node,
        view["funding_address"].as_str().unwrap(),
        REQUIRED,
        Some(900),
        4,
    );

    let poller = h
        .state
        .spawn_funding_poller(std::time::Duration::from_millis(10));
    let mut funded = false;
    for _ in 0..200 {
        if h.state
            .store()
            .load_campaign(&id)
            .unwrap()
            .unwrap()
            .funding
            .is_some()
        {
            funded = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    poller.abort();
    assert!(funded, "the poller recorded the deposit");
}

#[tokio::test]
async fn check_funding_is_not_available_on_the_mock_chain() {
    let h = Harness::new();
    let (id, _) = h.create().await;
    let reply = h
        .post_empty(&format!("/api/campaigns/{id}/check-funding"))
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.json()["error"]["code"], "not_applicable");
}

// ---------------------------------------------------------------------------
// Scope: one batch per real campaign
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_campaign_that_needs_several_batches_is_refused_until_funding_split_exists() {
    let node = SharedNode::default();
    let h = real(&node);
    let mut many = rows();
    many.push(Row {
        address: recipient_ua(3),
        zat: 10_000_000,
        memo: None,
    });
    // Four recipients with room for three per batch: two batches.
    let reply = h.post("/api/campaigns", body(&many, 3)).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = &reply.json()["error"];
    assert_eq!(error["code"], "needs_funding_split");
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("not implemented"));
    assert!(
        h.get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty(),
        "nothing stored"
    );

    // The same recipients in one batch are fine.
    assert_eq!(
        h.post("/api/campaigns", body(&many, 10)).await.status,
        StatusCode::CREATED
    );
}

// covers: REQ-IMP-001
#[tokio::test]
async fn real_addresses_are_checked_by_the_zcash_codec() {
    let node = SharedNode::default();
    let h = real(&node);
    let mut bad = rows();
    bad[1].address = "u1notarealaddress0000000000000000000000".into(); // plausible shape, bad checksum
    bad[2].address = CampaignKeys::derive(&TEST_SEED, NETWORK, 5)
        .unwrap()
        .funding_address(); // transparent
    let reply = h.post("/api/campaigns", body(&bad, 5)).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let errors = reply.json()["error"]["errors"].clone();
    assert_eq!(errors.as_array().unwrap().len(), 2, "{errors}");
    assert_eq!(
        errors[1]["kind"]["reason"]["code"],
        "transparent_not_allowed"
    );
    assert!(!reply.text().contains("notarealaddress"));
}

// ---------------------------------------------------------------------------
// A wallet seed that does not belong to the campaign
// ---------------------------------------------------------------------------

// covers: REQ-SEC-001
#[tokio::test]
async fn a_campaign_cannot_be_run_with_a_different_wallet_seed() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real(&node);
    let (id, view) = create(&h).await;
    put_deposit(
        &node,
        view["funding_address"].as_str().unwrap(),
        REQUIRED,
        Some(900),
        5,
    );
    check(&h, &id).await;

    // Restart the operator with another seed over the same store.
    let Harness {
        dir,
        db,
        chain,
        backend,
        codec,
        web_dir,
        state,
        router,
        ..
    } = h;
    drop((state, router));
    let store = Arc::new(drop_operator::store::Store::open(&db, PASSPHRASE).unwrap());
    let other = Harness::from_parts(
        dir,
        db,
        store,
        chain,
        Builder {
            seed: [0x99; 32],
            web_dir,
            backend: Some(backend),
            codec: Some(codec),
            options: Options {
                required_depth: DEPTH,
                ..Builder::default().options
            },
            ..Builder::default()
        },
    );
    let got = other.get(&format!("/api/campaigns/{id}")).await.json();
    assert_eq!(got["wallet_matches"], false);
    assert!(
        got["funding_address"].is_null(),
        "no address from a seed that did not make it"
    );
    let start = other
        .post_empty(&format!("/api/campaigns/{id}/start"))
        .await;
    assert_eq!(start.status, StatusCode::CONFLICT);
    assert_eq!(start.json()["error"]["code"], "wrong_wallet_seed");
    assert!(node.lock().submitted.is_empty());
}

// ---------------------------------------------------------------------------
// End to end: fund, build, send, confirm (REQ-RES-001, REQ-TX-001, REQ-PRIV-002)
// ---------------------------------------------------------------------------

// covers: REQ-RES-001, REQ-FUND-002, REQ-PRIV-002, REQ-SEC-001
#[tokio::test]
async fn a_funded_campaign_is_built_sent_and_confirmed_by_the_zcash_distributor() {
    let node = SharedNode::default();
    // A tip inside the Ironwood epoch, where the batch builder is allowed to build.
    let tip = u32::from(ironwood_height());
    node.lock().tip = tip;
    let h = real(&node);
    let (id, view) = create(&h).await;
    let address = view["funding_address"].as_str().unwrap().to_owned();
    // Over-fund by 1 ZEC: the surplus must come back as change.
    let deposit_value = REQUIRED + 100_000_000;
    let (deposit, funding_raw) = put_deposit(&node, &address, deposit_value, Some(tip - 100), 6);
    assert_eq!(check(&h, &id).await["phase"]["phase"], "funded");

    // Before anything is sent, the public receipt already names the address the batch will
    // spend from: the campaign's own, which is what ties the receipt to it.
    let early = h.get(&format!("/api/campaigns/{id}/receipt")).await.json();
    assert_eq!(early["funding_address"], address.as_str());
    assert_eq!(
        early["funding_address"],
        CampaignKeys::derive(&TEST_SEED, NETWORK, 0)
            .unwrap()
            .funding_address()
    );

    let start = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(start.status, StatusCode::ACCEPTED, "{}", start.text());
    let end = h.state.wait_for_run(&id).await;
    assert_eq!(
        end,
        RunState::Settled,
        "{}\n{}",
        h.get(&format!("/api/campaigns/{id}")).await.text(),
        h.logs.lines().join("\n")
    );

    // Exactly one transaction was sent, spending the deposit.
    let submitted = node.lock().submitted.clone();
    assert_eq!(submitted.len(), 1, "one batch, one transaction");
    let batch = ParsedTx::parse(&submitted[0]).unwrap();

    // The public view of it, from the verifier's own code and a chain made of what was sent.
    let final_tip = node.lock().tip;
    let mut chain = StaticChain {
        tip: final_tip,
        ..StaticChain::default()
    };
    chain.txs.insert(
        deposit.txid,
        FetchedTx {
            raw: funding_raw.clone(),
            mined_height: Some(1),
        },
    );
    let mined = node.lock().mined[&batch.txid()];
    chain.txs.insert(
        batch.txid(),
        FetchedTx {
            raw: submitted[0].clone(),
            mined_height: Some(mined),
        },
    );
    let receipt = verify_campaign(
        &chain,
        &VerifyRequest {
            network: drop_core::Network::Testnet,
            txids: vec![batch.txid()],
            manifest_commitment: h
                .state
                .store()
                .load_campaign(&id)
                .unwrap()
                .unwrap()
                .commitment,
            declared_total: Zatoshi::new(450_000_000).unwrap(),
            campaign_id: Some(id.clone()),
        },
        &VerifyConfig {
            required_depth: DEPTH,
            expected_pool: drop_core::Pool::Ironwood,
        },
    )
    .await
    .unwrap();
    assert!(receipt.findings.is_empty(), "{:?}", receipt.findings);
    assert_eq!(receipt.batches[0].funding_input, Some(deposit));
    assert_eq!(receipt.batches[0].fee, Some(Zatoshi::new(20_000).unwrap()));
    assert_eq!(receipt.batches[0].shielded_actions, Some(3));

    // The surplus returned to the campaign as transparent change.
    let funding_out = ParsedTx::parse_any_version(&funding_raw)
        .unwrap()
        .output(0)
        .unwrap();
    let totals = public_totals(&submitted[0], |_| Some(funding_out.clone())).unwrap();
    assert_eq!(totals.t_out_total, deposit_value - 450_000_000 - 20_000);
    assert_eq!(totals.net_into_ironwood, 450_000_000);

    // The campaign's own viewing key recovers exactly the payout list.
    let ufvk =
        drop_operator::commands::campaign_ufvk(h.state.seed(), drop_core::Network::Testnet, 0)
            .unwrap();
    let outputs = recover_with_ufvk(&submitted[0], NETWORK, &ufvk).unwrap();
    let mut values: Vec<u64> = outputs.iter().map(|o| o.value).collect();
    values.sort_unstable();
    assert_eq!(values, vec![75_000_000, 150_000_000, 225_000_000]);
    let memos: Vec<Option<String>> = {
        let mut m: Vec<_> = outputs.iter().map(|o| o.memo.clone()).collect();
        m.sort();
        m
    };
    assert_eq!(
        memos,
        vec![None, Some("hello zero".into()), Some("thanks two".into())]
    );

    // The operator's own receipt agrees, and its view is settled.
    let reply = h.get(&format!("/api/campaigns/{id}/receipt")).await;
    let operator_receipt: PublicReceipt = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!(operator_receipt.batches[0].funding_input, Some(deposit));
    assert_eq!(operator_receipt.batches[0].txid, Some(batch.txid()));
    assert_eq!(operator_receipt.phase, drop_core::CampaignPhase::Settled);

    // Nothing private left the operator: no response or log line has an address, a memo, an
    // individual amount, the viewing key or the seed.
    let mut needles: Vec<String> = rows().iter().map(|r| r.address.clone()).collect();
    needles.extend(
        [
            "hello zero",
            "thanks two",
            "150000000",
            "75000000",
            "225000000",
        ]
        .map(String::from),
    );
    needles.push(ufvk.to_string());
    needles.push(hex::encode(TEST_SEED));
    needles.push(String::from_utf8_lossy(&TEST_SEED).into_owned());
    let mut texts = vec![h.logs.lines().join("\n"), reply.text(), view.to_string()];
    for path in [
        format!("/api/campaigns/{id}"),
        "/api/campaigns".to_owned(),
        format!("/api/campaigns/{id}/events"),
        "/api/health".to_owned(),
    ] {
        texts.push(h.get(&path).await.text());
    }
    for text in texts {
        assert_clean("output", &text, &needles);
    }
}
