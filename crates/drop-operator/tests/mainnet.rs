//! The operator on mainnet, over an in-memory node: the same path as `real_chain.rs` with mainnet
//! parameters (`t1…` and `u1…` addresses, branch `37a5165b`, a tip near the real one) and
//! TEST-ONLY keys. The transactions are genuine librustzcash transactions; nothing here touches
//! a network and nothing can move money.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use common::zcash::*;
use common::*;
use drop_core::{CampaignId, CampaignPhase, Network, PublicReceipt, Zatoshi};
use drop_operator::error::StoreError;
use drop_operator::state::{Options, RunState, DEFAULT_MAINNET_MAX_FUNDING_ZAT};
use drop_verify::{verify_campaign, FetchedTx, ParsedTx, VerifyConfig, VerifyRequest};
use drop_zcash::inspect::{public_totals, recover_with_ufvk};
use drop_zcash::CampaignKeys;
use serde_json::{json, Value};
use zcash_protocol::consensus::{BranchId, Network::MainNetwork};

const DEPTH: u32 = 3;

/// Three payouts that differ (no privacy warning about equal amounts).
fn rows() -> Vec<Row> {
    vec![
        Row {
            address: recipient_ua_on(MainNetwork, 0),
            zat: 3_141_592,
            memo: Some("mainnet hello".into()),
        },
        Row {
            address: recipient_ua_on(MainNetwork, 1),
            zat: 2_718_281,
            memo: None,
        },
        Row {
            address: recipient_ua_on(MainNetwork, 2),
            zat: 1_618_033,
            memo: Some("mainnet thanks".into()),
        },
    ]
}

/// 7,477,906 declared + (3 outputs + 1 transparent) * 5,000.
const REQUIRED: u64 = 7_497_906;

fn body(rows: &[Row]) -> Value {
    let mut csv = String::from("address,amount,memo\n");
    for r in rows {
        csv.push_str(&format!(
            "{},{},{}\n",
            r.address,
            Zatoshi::new(r.zat).unwrap().format_zec(),
            r.memo.clone().unwrap_or_default()
        ));
    }
    json!({ "name": "Mainnet drop", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" })
}

/// A mainnet operator that was given the permit, over a node near the real mainnet tip that
/// reports branch `37a5165b`.
fn mainnet(node: &SharedNode) -> Harness {
    {
        let mut n = node.lock();
        n.tip = MAINNET_TIP;
        n.branch = Some(MAINNET_BRANCH);
    }
    mainnet_harness_with_cap(node, DEPTH, true, DEFAULT_MAINNET_MAX_FUNDING_ZAT)
}

async fn create(h: &Harness, rows: &[Row]) -> (CampaignId, Value) {
    let reply = h.post("/api/campaigns", body(rows)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let view = reply.json();
    (CampaignId::new(view["id"].as_str().unwrap()).unwrap(), view)
}

async fn fund(h: &Harness, node: &SharedNode, id: &CampaignId, view: &Value, salt: u8) -> Vec<u8> {
    let address = view["funding_address"].as_str().unwrap().to_owned();
    let (_, raw) = put_deposit(node, &address, REQUIRED, Some(MAINNET_TIP - 100), salt);
    let reply = h
        .post_empty(&format!("/api/campaigns/{id}/check-funding"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json()["phase"]["phase"], "funded");
    raw
}

// covers: REQ-OPS-001, REQ-TX-001, REQ-TX-004, REQ-VER-001
#[tokio::test]
async fn a_mainnet_campaign_is_built_sent_and_verified_with_mainnet_addresses() {
    let node = SharedNode::default();
    let h = mainnet(&node);
    let reply = h.get("/api/health").await;
    assert_eq!(
        reply.json(),
        json!({ "ok": true, "network": "mainnet", "mock": false })
    );

    let (id, view) = create(&h, &rows()).await;
    assert_eq!(view["network"], "mainnet");
    assert_eq!(view["funding_required"], REQUIRED.to_string());
    let address = view["funding_address"].as_str().unwrap().to_owned();
    assert!(
        address.starts_with("t1"),
        "a mainnet P2PKH address: {address}"
    );
    assert_eq!(
        address,
        CampaignKeys::derive(&TEST_SEED, MainNetwork, 0)
            .unwrap()
            .funding_address()
    );

    // Funded with exactly what is required: no change output, and the fee is the whole remainder.
    let funding_raw = fund(&h, &node, &id, &view, 7).await;
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

    let submitted = node.lock().submitted.clone();
    assert_eq!(submitted.len(), 1, "one batch, one transaction");
    let batch = ParsedTx::parse(&submitted[0]).unwrap();
    let funding_out = ParsedTx::parse_any_version(&funding_raw)
        .unwrap()
        .output(0)
        .unwrap();
    let totals = public_totals(&submitted[0], |_| Some(funding_out.clone())).unwrap();
    assert_eq!(
        totals.branch_id,
        BranchId::Nu6_3,
        "stamped for NU6.3, as the node said"
    );
    assert_eq!(totals.tx_version, "V6");
    assert_eq!(totals.net_into_ironwood, 7_477_906);
    assert_eq!((totals.t_out_total, totals.fee), (0, 20_000));
    assert!(totals.balances());

    // The verifier's own code, over a chain made of what was sent, reads it as mainnet.
    let deposit = node.lock().deposits[0].outpoint;
    let mut chain = StaticChain {
        tip: node.lock().tip,
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
            network: Network::Mainnet,
            txids: vec![batch.txid()],
            manifest_commitment: h
                .state
                .store()
                .load_campaign(&id)
                .unwrap()
                .unwrap()
                .commitment,
            declared_total: Zatoshi::new(7_477_906).unwrap(),
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
    assert_eq!(receipt.network, Network::Mainnet);
    assert_eq!(receipt.funding_address.as_deref(), Some(address.as_str()));
    assert_eq!(receipt.batches[0].fee, Some(Zatoshi::new(20_000).unwrap()));
    assert_eq!(receipt.batches[0].shielded_actions, Some(3));
    assert_eq!(receipt.phase, CampaignPhase::Settled);

    // The campaign's own viewing key recovers exactly the payout list, from mainnet bytes.
    let ufvk = drop_operator::commands::campaign_ufvk(h.state.seed(), Network::Mainnet, 0).unwrap();
    assert!(ufvk.starts_with("uview1"), "a mainnet viewing key");
    let outputs = recover_with_ufvk(&submitted[0], MainNetwork, &ufvk).unwrap();
    let mut values: Vec<u64> = outputs.iter().map(|o| o.value).collect();
    values.sort_unstable();
    assert_eq!(values, vec![1_618_033, 2_718_281, 3_141_592]);

    // The operator's own receipt agrees.
    let reply = h.get(&format!("/api/campaigns/{id}/receipt")).await;
    let operator_receipt: PublicReceipt = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!(operator_receipt.network, Network::Mainnet);
    assert_eq!(
        operator_receipt.funding_address.as_deref(),
        Some(address.as_str())
    );
    assert_eq!(operator_receipt.phase, CampaignPhase::Settled);

    // Nothing private left the operator (REQ-PRIV-002).
    let mut needles: Vec<String> = rows().iter().map(|r| r.address.clone()).collect();
    needles.extend(
        [
            "mainnet hello",
            "mainnet thanks",
            "3141592",
            "2718281",
            "1618033",
        ]
        .map(String::from),
    );
    needles.push(ufvk.to_string());
    needles.push(hex::encode(TEST_SEED));
    for text in [
        h.logs.lines().join("\n"),
        reply.text(),
        view.to_string(),
        h.get(&format!("/api/campaigns/{id}")).await.text(),
        h.get(&format!("/api/campaigns/{id}/events")).await.text(),
    ] {
        assert_clean("output", &text, &needles);
    }
}

// covers: REQ-TX-004
#[tokio::test]
async fn a_node_on_another_upgrade_stops_the_run_before_anything_is_sent() {
    let node = SharedNode::default();
    let h = mainnet(&node);
    // After mainnet moves to NU7 the node says so, and the pinned crates (no mainnet NU7 height)
    // would still stamp NU6.3: the build must refuse instead of sending a doomed transaction.
    node.lock().branch = Some(0x7719_0ad9);
    let (id, view) = create(&h, &rows()).await;
    fund(&h, &node, &id, &view, 8).await;
    let start = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(start.status, StatusCode::ACCEPTED, "{}", start.text());
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Halted);
    assert!(node.lock().submitted.is_empty(), "nothing reached the node");
    let logs = h.logs.lines().join("\n");
    let status = h.get(&format!("/api/campaigns/{id}")).await.text();
    assert!(
        logs.contains("77190ad9") || status.contains("77190ad9"),
        "the refusal names the branch ids: {logs}\n{status}"
    );
    // The deposit is untouched: still one unspent output at the funding address.
    assert_eq!(node.lock().deposits.len(), 1);
}

// covers: REQ-OPS-001
#[tokio::test]
async fn a_mainnet_operator_without_the_permit_cannot_run_a_campaign() {
    let node = SharedNode::default();
    {
        let mut n = node.lock();
        n.tip = MAINNET_TIP;
        n.branch = Some(MAINNET_BRANCH);
    }
    // The backend was never told that the flag and the confirmation had passed.
    let h = mainnet_harness_with_cap(&node, DEPTH, false, DEFAULT_MAINNET_MAX_FUNDING_ZAT);
    let (id, view) = create(&h, &rows()).await;
    fund(&h, &node, &id, &view, 9).await;
    let start = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(start.status, StatusCode::ACCEPTED, "{}", start.text());
    let end = h.state.wait_for_run(&id).await;
    assert_ne!(end, RunState::Settled, "a mainnet run needs the permit");
    assert!(node.lock().submitted.is_empty(), "nothing reached the node");
}

// covers: REQ-OPS-003
#[tokio::test]
async fn a_mainnet_campaign_above_the_cap_is_refused_before_anything_is_stored() {
    let node = SharedNode::default();
    let h = mainnet(&node);
    // 0.2 ZEC to one of three recipients: 0.2 + small ones is above the 0.1 ZEC default cap.
    let mut big = rows();
    big[0].zat = 20_000_000;
    let reply = h.post("/api/campaigns", body(&big)).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        reply.text()
    );
    let error = &reply.json()["error"];
    assert_eq!(error["code"], "mainnet_cap_exceeded");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains("0.1 ZEC"), "{message}");
    assert!(message.contains("--mainnet-max-funding-zat"), "{message}");
    // Negative: no payout row appears in the refusal (addresses, memos, single amounts).
    let mut needles: Vec<String> = big.iter().map(|r| r.address.clone()).collect();
    needles.extend(["mainnet hello", "mainnet thanks", "20000000", "0.2 ZEC"].map(String::from));
    assert_clean("the cap refusal", &reply.text(), &needles);
    assert!(
        h.get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty(),
        "nothing stored"
    );

    // A campaign that needs exactly the cap is allowed: required = declared + fee.
    // 9,980,000 declared + 4 actions * 5,000 = 10,000,000.
    let mut at_cap = rows();
    at_cap[0].zat = 9_980_000 - at_cap[1].zat - at_cap[2].zat;
    let reply = h.post("/api/campaigns", body(&at_cap)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    assert_eq!(reply.json()["funding_required"], "10000000");
}

// covers: REQ-OPS-003
#[tokio::test]
async fn the_cap_does_not_apply_on_testnet() {
    let node = SharedNode::default();
    let h = real_harness(&node, DEPTH);
    let mut big: Vec<Row> = (0..3)
        .map(|i| Row {
            address: recipient_ua(i),
            zat: 500_000_000 + u64::from(i),
            memo: None,
        })
        .collect();
    big[0].memo = Some("testnet is play money".into());
    let reply = h.post("/api/campaigns", body(&big)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
}

// covers: REQ-OPS-004
#[tokio::test]
async fn a_store_with_campaigns_of_another_network_is_refused_at_start_up() {
    // A testnet operator creates a campaign...
    let node = SharedNode::default();
    node.lock().tip = u32::from(ironwood_height());
    let h = real_harness(&node, DEPTH);
    let reply = h
        .post(
            "/api/campaigns",
            body(
                &(0..3)
                    .map(|i| Row {
                        address: recipient_ua(i),
                        zat: 10_000 + u64::from(i) * 1_000,
                        memo: None,
                    })
                    .collect::<Vec<_>>(),
            ),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    assert_eq!(
        h.state.verify_store().unwrap(),
        1,
        "the same network passes"
    );

    // ...and the same store, opened by a mainnet operator, is refused with words that name only
    // the two networks.
    let Harness {
        dir,
        db,
        chain,
        web_dir,
        state,
        router,
        ..
    } = h;
    drop((state, router));
    let store = Arc::new(drop_operator::store::Store::open(&db, PASSPHRASE).unwrap());
    let mainnet_node = SharedNode::default();
    mainnet_node.lock().mainnet = true;
    let other = Harness::from_parts(
        dir,
        db,
        store,
        chain,
        Builder {
            seed: TEST_SEED,
            network: Network::Mainnet,
            web_dir,
            backend: Some(Arc::new(drop_operator::real::ZcashBackend::new(
                FakeConnector(mainnet_node),
            ))),
            codec: Some(Arc::new(drop_zcash::ZcashAddressCodec::new(MainNetwork))),
            allow_mainnet: true,
            options: Options {
                required_depth: DEPTH,
                ..Builder::default().options
            },
            ..Builder::default()
        },
    );
    let error = other.state.verify_store().unwrap_err();
    assert!(
        matches!(
            error,
            StoreError::WrongNetwork {
                campaign: Network::Testnet,
                operator: Network::Mainnet
            }
        ),
        "{error}"
    );
    let text = error.to_string();
    assert!(
        text.contains("testnet") && text.contains("mainnet"),
        "{text}"
    );
    assert!(text.contains("separate --db"), "{text}");
    // Fixed text: nothing of the campaign (its name, id or any address) is in it.
    assert!(
        !text.contains("Mainnet drop") && !text.contains("c-"),
        "{text}"
    );
}
