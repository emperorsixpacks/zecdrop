//! One wallet seed, one ZIP-32 account per campaign, across stores (REQ-AUD-002).
//!
//! A store only knows its own campaigns, so a fresh store opened with the same seed used to
//! start again at account 0 and hand a new campaign the funding address and viewing key of an
//! older one. The account registry (a file per seed, outside the store) carries the count.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use common::zcash::*;
use common::*;
use drop_core::CampaignId;
use drop_operator::accounts::{AccountAllocator, FileAccounts};
use drop_operator::commands::campaign_ufvk;
use drop_operator::real::ZcashBackend;
use drop_operator::secret::SecretSeed;
use drop_zcash::{CampaignKeys, ZcashAddressCodec};
use serde_json::{json, Value};

/// A harness over the real Zcash backend, numbering accounts with `accounts`.
fn harness(seed: [u8; 32], accounts: Arc<dyn AccountAllocator>) -> Harness {
    Builder {
        seed,
        backend: Some(Arc::new(ZcashBackend::new(FakeConnector(
            SharedNode::default(),
        )))),
        codec: Some(Arc::new(ZcashAddressCodec::new(NETWORK))),
        accounts: Some(accounts),
        ..Builder::default()
    }
    .build()
}

fn request(i: u32) -> Value {
    json!({
        "name": "Registry drop",
        "csv": format!("address,amount,memo\n{},1.5,hello\n", recipient_ua(i)),
        "max_outputs_per_batch": 5,
        "fee_policy": "zip317_text",
    })
}

async fn create(h: &Harness, i: u32) -> (CampaignId, Value) {
    let reply = h.post("/api/campaigns", request(i)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let view = reply.json();
    (CampaignId::new(view["id"].as_str().unwrap()).unwrap(), view)
}

fn account_of(h: &Harness, id: &CampaignId) -> u32 {
    h.state.store().load_campaign(id).unwrap().unwrap().account
}

fn funding_address(account: u32) -> String {
    CampaignKeys::derive(&TEST_SEED, NETWORK, account)
        .unwrap()
        .funding_address()
}

// covers: REQ-AUD-002
#[tokio::test]
async fn a_new_store_with_the_same_seed_gets_the_next_account() {
    let state = tempfile::tempdir().unwrap();
    let registry: Arc<dyn AccountAllocator> = Arc::new(FileAccounts::new(state.path()));

    // The first store: campaigns 0 and 1.
    let first = harness(TEST_SEED, Arc::clone(&registry));
    let (a, view_a) = create(&first, 0).await;
    let (b, view_b) = create(&first, 1).await;
    assert_eq!((account_of(&first, &a), account_of(&first, &b)), (0, 1));
    assert_eq!(view_a["funding_address"], funding_address(0));
    assert_eq!(view_b["funding_address"], funding_address(1));

    // A brand-new store (another file, no campaigns) with the same seed carries on.
    let fresh = harness(TEST_SEED, Arc::clone(&registry));
    assert!(fresh
        .get("/api/campaigns")
        .await
        .json()
        .as_array()
        .unwrap()
        .is_empty());
    let (c, view_c) = create(&fresh, 2).await;
    assert_eq!(account_of(&fresh, &c), 2);
    assert_eq!(view_c["funding_address"], funding_address(2));

    // None of the three shares an address or a viewing key with another.
    let seed = SecretSeed::from_bytes(TEST_SEED);
    let keys: Vec<String> = (0..3)
        .map(|n| {
            campaign_ufvk(&seed, drop_core::Network::Testnet, n)
                .unwrap()
                .as_str()
                .to_owned()
        })
        .collect();
    assert_eq!(
        keys.iter().collect::<std::collections::BTreeSet<_>>().len(),
        3
    );
    let addresses =
        [&view_a, &view_b, &view_c].map(|v| v["funding_address"].as_str().unwrap().to_owned());
    assert_eq!(
        addresses
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
}

// covers: REQ-AUD-002
#[tokio::test]
async fn a_restarted_operator_continues_the_count() {
    let state = tempfile::tempdir().unwrap();
    let registry: Arc<dyn AccountAllocator> = Arc::new(FileAccounts::new(state.path()));
    let h = harness(TEST_SEED, Arc::clone(&registry));
    let (a, _) = create(&h, 0).await;
    assert_eq!(account_of(&h, &a), 0);
    // The process restarts: the same store file, the registry directory as it was left.
    let h = h.restart_as(TEST_SEED, Builder::default().options);
    let (b, _) = create(&h, 1).await;
    assert_eq!(account_of(&h, &b), 1);
}

// covers: REQ-AUD-002
#[tokio::test]
async fn another_wallet_seed_has_its_own_count() {
    let state = tempfile::tempdir().unwrap();
    let registry: Arc<dyn AccountAllocator> = Arc::new(FileAccounts::new(state.path()));
    let mine = harness(TEST_SEED, Arc::clone(&registry));
    create(&mine, 0).await;
    create(&mine, 1).await;
    // Another seed in the same registry directory starts at 0 for itself.
    let theirs = harness([0x77; 32], Arc::clone(&registry));
    let (id, _) = create(&theirs, 2).await;
    assert_eq!(account_of(&theirs, &id), 0);
    // And one file per seed was written.
    let files: Vec<_> = std::fs::read_dir(state.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("accounts-") && n.ends_with(".json"))
        .collect();
    assert_eq!(files.len(), 2, "{files:?}");
}

// covers: REQ-AUD-002
#[tokio::test]
async fn an_account_reserved_but_never_used_is_skipped_not_reused() {
    let state = tempfile::tempdir().unwrap();
    let registry = Arc::new(FileAccounts::new(state.path()));
    let h = harness(TEST_SEED, registry.clone());
    let (a, _) = create(&h, 0).await;
    assert_eq!(account_of(&h, &a), 0);

    // The process died after the registry was updated and before the store was written:
    // account 1 was reserved and never used.
    let fingerprint = SecretSeed::from_bytes(TEST_SEED).fingerprint();
    assert_eq!(registry.reserve(&fingerprint, Some(0)), Ok(1));

    let (b, view) = create(&h, 1).await;
    assert_eq!(
        account_of(&h, &b),
        2,
        "1 is skipped, never handed out again"
    );
    assert_eq!(view["funding_address"], funding_address(2));
}

// covers: REQ-AUD-002
#[tokio::test]
async fn a_registry_that_cannot_be_written_refuses_the_campaign() {
    // The registry directory is a file: nothing can be recorded there.
    let state = tempfile::tempdir().unwrap();
    let blocked = state.path().join("not-a-directory");
    std::fs::write(&blocked, b"x").unwrap();
    let h = harness(TEST_SEED, Arc::new(FileAccounts::new(&blocked)));
    let reply = h.post("/api/campaigns", request(0)).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    let error = &reply.json()["error"];
    assert_eq!(error["code"], "account_registry_error");
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("no campaign was created"));
    assert!(
        !reply.text().contains(blocked.to_str().unwrap()),
        "no path in the reply"
    );
    assert!(h
        .get("/api/campaigns")
        .await
        .json()
        .as_array()
        .unwrap()
        .is_empty());
}

// covers: REQ-AUD-002
#[tokio::test]
async fn a_damaged_registry_refuses_the_campaign_and_is_left_for_a_person() {
    let state = tempfile::tempdir().unwrap();
    let registry = Arc::new(FileAccounts::new(state.path()));
    let h = harness(TEST_SEED, registry.clone());
    create(&h, 0).await;
    let fingerprint = SecretSeed::from_bytes(TEST_SEED).fingerprint();
    let file = registry.file_for(&fingerprint).unwrap();
    std::fs::write(&file, "garbage").unwrap();

    let reply = h.post("/api/campaigns", request(1)).await;
    assert_eq!(reply.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(reply.json()["error"]["code"], "account_registry_error");
    assert!(reply.json()["error"]["message"]
        .as_str()
        .unwrap()
        .contains("damaged"));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "garbage",
        "not overwritten"
    );
    assert_eq!(
        h.get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

// covers: REQ-AUD-002, REQ-SEC-001
#[tokio::test]
async fn the_registry_holds_a_count_and_nothing_derived_from_the_seed_but_its_fingerprint() {
    let state = tempfile::tempdir().unwrap();
    let h = harness(TEST_SEED, Arc::new(FileAccounts::new(state.path())));
    create(&h, 0).await;
    create(&h, 1).await;

    let fingerprint = SecretSeed::from_bytes(TEST_SEED).fingerprint();
    let mut names = Vec::new();
    for entry in std::fs::read_dir(state.path()).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        let bytes = std::fs::read(entry.path()).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        for needle in [
            hex::encode(TEST_SEED),
            String::from_utf8_lossy(&TEST_SEED).into_owned(),
        ] {
            assert!(
                !name.contains(&needle) && !text.contains(&needle),
                "{name} holds the seed"
            );
        }
        assert!(
            !bytes.windows(32).any(|w| w == TEST_SEED),
            "{name} holds the raw seed"
        );
        names.push((name, text.into_owned()));
    }
    let record = names
        .iter()
        .find(|(n, _)| *n == format!("accounts-{fingerprint}.json"))
        .unwrap_or_else(|| panic!("no registry file in {names:?}"));
    let parsed: Value = serde_json::from_str(&record.1).unwrap();
    assert_eq!(parsed, json!({ "version": 1, "highest": 1 }));
    // The name is a short hash of the seed, which is not the seed.
    assert_eq!(fingerprint.len(), 16);
}
