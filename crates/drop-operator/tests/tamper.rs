//! A store edited outside the operator is refused, never believed (REQ-SEC-002).
//!
//! The store's plaintext columns are authenticated, so changing one of them with a database
//! tool ends in a clear `store_corrupt` error. The case that matters most: changing a
//! campaign's account number must not make the operator hand out another campaign's viewing key.

mod common;

use axum::http::{Method, StatusCode};
use common::zcash::*;
use common::*;
use drop_core::CampaignId;
use drop_operator::commands::{run_export_ufvk, CommandError};
use drop_operator::config::ExportArgs;
use drop_operator::secret::SecretSeed;
use drop_zcash::CampaignKeys;
use rusqlite::Connection;
use serde_json::{json, Value};

const CONFIRM: (&str, &str) = ("X-Zecdrop-Confirm-Disclosure", "I-UNDERSTAND");

fn ufvk_of(account: u32) -> String {
    CampaignKeys::derive(&TEST_SEED, NETWORK, account)
        .unwrap()
        .ufvk_encoded()
        .unwrap()
}

fn request(i: u32) -> Value {
    json!({
        "name": "Tamper drop",
        "csv": format!("address,amount,memo\n{},1.5,hello\n", recipient_ua(i)),
        "max_outputs_per_batch": 5,
        "fee_policy": "zip317_text",
    })
}

async fn two_campaigns() -> (Harness, CampaignId, CampaignId) {
    let h = real_harness(&SharedNode::default(), 3);
    let mut ids = Vec::new();
    for i in 0..2 {
        let reply = h.post("/api/campaigns", request(i)).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
        ids.push(CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap());
    }
    let b = ids.pop().unwrap();
    let a = ids.pop().unwrap();
    (h, a, b)
}

/// Edits the store file the way someone with a database tool would.
fn edit(h: &Harness, sql: &str) {
    let conn = Connection::open(&h.db).unwrap();
    assert_eq!(conn.execute(sql, []).unwrap(), 1, "{sql}");
}

async fn export(h: &Harness, id: &CampaignId) -> Reply {
    h.call_with(
        Method::GET,
        &format!("/api/campaigns/{id}/audit-ufvk-export"),
        Auth::Token,
        None,
        &[CONFIRM],
    )
    .await
}

// covers: REQ-SEC-002, REQ-AUD-002
#[tokio::test]
async fn changing_a_campaigns_account_never_exports_another_campaigns_key() {
    let (h, a, b) = two_campaigns().await;
    // Sound, to begin with: each campaign exports its own key.
    assert_eq!(export(&h, &a).await.json()["ufvk"], ufvk_of(0));
    assert_eq!(export(&h, &b).await.json()["ufvk"], ufvk_of(1));

    // B is made to look like it had A's account.
    edit(
        &h,
        &format!("UPDATE campaigns SET account = 0 WHERE id = '{b}'"),
    );

    let reply = export(&h, &b).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.json()["error"]["code"], "store_corrupt");
    for key in [ufvk_of(0), ufvk_of(1)] {
        assert!(!reply.text().contains(&key[..40]), "no key in the refusal");
    }
    assert!(!reply.text().contains("uview"));

    // Nothing else of B's is believed either, but A is not B.
    for path in [
        format!("/api/campaigns/{b}"),
        format!("/api/campaigns/{b}/receipt"),
    ] {
        let reply = h.get(&path).await;
        assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR, "{path}");
        assert_eq!(reply.json()["error"]["code"], "store_corrupt", "{path}");
    }
    let start = h.post_empty(&format!("/api/campaigns/{b}/start")).await;
    assert_eq!(start.json()["error"]["code"], "store_corrupt");
    let check = h
        .post_empty(&format!("/api/campaigns/{b}/check-funding"))
        .await;
    assert_eq!(check.json()["error"]["code"], "store_corrupt");
    assert_eq!(export(&h, &a).await.json()["ufvk"], ufvk_of(0));
    assert!(h.state.store().load_campaign(&a).unwrap().is_some());

    // The log says what happened, and holds no key.
    let logs = h.logs.lines().join("\n");
    assert!(logs.contains("tampered"), "{logs}");
    assert!(!logs.contains(&ufvk_of(1)[..40]) && !logs.contains(&ufvk_of(0)[..40]));
}

// covers: REQ-SEC-002
#[tokio::test]
async fn the_listing_refuses_rather_than_skipping_a_row_that_was_edited() {
    let (h, a, _b) = two_campaigns().await;
    assert_eq!(
        h.get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    edit(
        &h,
        &format!("UPDATE campaigns SET created_at = 1 WHERE id = '{a}'"),
    );
    let reply = h.get("/api/campaigns").await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.json()["error"]["code"], "store_corrupt");
}

// covers: REQ-SEC-002, REQ-LED-001
#[tokio::test]
async fn a_ledger_row_that_was_edited_stops_the_campaign_view() {
    let (h, a, _b) = two_campaigns().await;
    let mut ledger = h.state.store().ledger();
    use drop_core::{BatchStatus, Ledger};
    ledger.record(&a, 0, BatchStatus::Planned).unwrap();
    assert_eq!(
        h.get(&format!("/api/campaigns/{a}")).await.status,
        StatusCode::OK
    );
    // Someone marks the batch confirmed so that it would not be paid.
    edit(
        &h,
        &format!(
            "UPDATE batches SET state = 'confirmed', txid = '{}', depth = 9 WHERE campaign_id = '{a}'",
            "07".repeat(32)
        ),
    );
    let reply = h.get(&format!("/api/campaigns/{a}")).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.json()["error"]["code"], "store_corrupt");
}

// covers: REQ-SEC-002, REQ-AUD-002
#[tokio::test]
async fn the_export_command_refuses_a_campaign_whose_row_was_edited() {
    let (h, _a, b) = two_campaigns().await;
    edit(
        &h,
        &format!("UPDATE campaigns SET account = 0 WHERE id = '{b}'"),
    );
    let seed = SecretSeed::from_bytes(TEST_SEED);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let args = ExportArgs {
        campaign: b.to_string(),
        i_understand_this_is_irreversible: true,
    };
    let error = run_export_ufvk(h.state.store(), &seed, &args, &mut out, &mut err).unwrap_err();
    assert!(matches!(
        error,
        CommandError::Store(drop_operator::error::StoreError::Corrupt)
    ));
    assert!(out.is_empty() && err.is_empty(), "no key, no warning");
}

// covers: REQ-SEC-002
#[tokio::test]
async fn the_startup_check_reads_every_row_and_refuses_a_store_that_was_edited() {
    let (h, a, b) = two_campaigns().await;
    {
        use drop_core::{BatchStatus, Ledger};
        let mut ledger = h.state.store().ledger();
        ledger.record(&a, 0, BatchStatus::Planned).unwrap();
    }
    assert_eq!(h.state.verify_store().unwrap(), 2, "a sound store passes");

    // An edited campaign row.
    edit(
        &h,
        &format!("UPDATE campaigns SET account = 5 WHERE id = '{b}'"),
    );
    assert!(matches!(
        h.state.verify_store(),
        Err(drop_operator::error::StoreError::Corrupt)
    ));
    edit(
        &h,
        &format!("UPDATE campaigns SET account = 1 WHERE id = '{b}'"),
    );
    assert_eq!(
        h.state.verify_store().unwrap(),
        2,
        "put back, it is sound again"
    );

    // An edited ledger row, in a campaign whose own row is untouched.
    edit(
        &h,
        &format!("UPDATE batches SET state = 'confirmed', txid = '{}', depth = 3 WHERE campaign_id = '{a}'", "07".repeat(32)),
    );
    assert!(matches!(
        h.state.verify_store(),
        Err(drop_operator::error::StoreError::Corrupt)
    ));
}
