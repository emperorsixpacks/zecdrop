//! The shielded deposit address (docs/ADR/0006-shielded-inbox.md): the operator's inbox engine over a fake inbox wallet
//! and the fake node. The real wallet (zcash-devtool) and the check of its transactions are covered where they live
//! (`inbox::devtool`, `inbox::setup`, `drop_zcash::inbox`) and on public testnet; here the engine's own decisions are: when
//! to set up, when to move and how much, that nothing moves twice, and that nothing of the inbox leaks.

mod common;

use axum::http::StatusCode;
use common::inbox::*;
use common::zcash::*;
use common::*;
use drop_core::{CampaignId, Network, Zatoshi};
use drop_operator::{inbox::keys::InboxPhrase, secret::SecretSeed, state::Options};
use drop_zcash::{zcash_network, CampaignKeys, InboxKeys};
use serde_json::{json, Value};

const DEPTH: u32 = 3;

fn rows() -> Vec<Row> {
    vec![
        Row {
            address: recipient_ua(0),
            zat: 60_000,
            memo: Some("hello".into()),
        },
        Row {
            address: recipient_ua(1),
            zat: 40_000,
            memo: None,
        },
    ]
}

/// The two rows above, at the ZIP 317 text policy: 100,000 and a 15,000 batch fee.
const REQUIRED: u64 = 115_000;

async fn create(h: &Harness) -> (CampaignId, Value, u32) {
    let mut csv = String::from("address,amount,memo\n");
    for r in rows() {
        csv.push_str(&format!(
            "{},{},{}\n",
            r.address,
            Zatoshi::new(r.zat).unwrap().format_zec(),
            r.memo.clone().unwrap_or_default()
        ));
    }
    let body = json!({ "name": "Inbox", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" });
    let reply = h.post("/api/campaigns", body).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let view = reply.json();
    let id = CampaignId::new(view["id"].as_str().unwrap()).unwrap();
    let account = h.state.store().load_campaign(&id).unwrap().unwrap().account;
    assert_eq!(view["funding_required"], REQUIRED.to_string());
    (id, view, account)
}

async fn view(h: &Harness, id: &CampaignId) -> Value {
    let reply = h.get(&format!("/api/campaigns/{id}")).await;
    assert_eq!(reply.status, StatusCode::OK);
    reply.json()
}

async fn check(h: &Harness, id: &CampaignId) -> Value {
    let reply = h
        .post_empty(&format!("/api/campaigns/{id}/check-funding"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

// covers: REQ-FUND-005, REQ-FUND-008
#[tokio::test]
async fn an_unfunded_payout_gets_an_inbox_and_the_page_shows_it_from_memory() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, before, account) = create(&h).await;
    // Without inboxes the answer says so with a null, and the public address is unchanged.
    assert!(before["inbox"].is_null());
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    assert!(
        view(&h, &id).await["inbox"].is_null(),
        "nothing until the engine has looked"
    );

    inboxes.round(&h.state).await;
    assert_eq!(
        fake.lock().set_up,
        vec![(account, 990)],
        "set up once, scanning from just below the tip"
    );
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "waiting");
    assert_eq!(v["inbox"]["deposit_address"], FakeInbox::address(account));
    assert_eq!(v["inbox"]["asked"], (REQUIRED + FEE).to_string());
    assert_eq!(v["inbox"]["required_confirmations"], 10);
    assert!(
        v["funding_address"].is_string(),
        "the public address stays, as the fallback"
    );
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    assert_eq!(
        (kept.address.as_str(), kept.birthday),
        (FakeInbox::address(account).as_str(), 990)
    );

    // Reading the page runs nothing: no new setup, no refresh.
    for _ in 0..3 {
        view(&h, &id).await;
    }
    assert_eq!(fake.lock().set_up.len(), 1);
    // A second round checks nothing new is set up.
    inboxes.round(&h.state).await;
    assert_eq!(fake.lock().set_up.len(), 1);
}

// covers: REQ-FUND-006, REQ-FUND-008
#[tokio::test]
async fn the_inbox_moves_exactly_the_funding_once_spendable_and_the_payout_funds_shielded() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, created, account) = create(&h).await;
    let funding_address = created["funding_address"].as_str().unwrap().to_owned();
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;

    // The payer pays what was asked; it confirms.
    fake.deposit(account, REQUIRED + FEE, 1_001, 7);
    fake.tip(1_001);
    inboxes.round(&h.state).await;
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "confirming");
    assert_eq!(v["inbox"]["confirmations"], 1);
    assert_eq!(v["inbox"]["received"], (REQUIRED + FEE).to_string());
    assert!(fake.lock().built.is_empty());

    // Spendable at 10 confirmations: the move is built, for exactly the funding, to the funding address, from that note.
    fake.tip(1_010);
    inboxes.round(&h.state).await;
    {
        let fake = fake.lock();
        assert_eq!(fake.built.len(), 1);
        let (built_account, to, value, notes) = &fake.built[0];
        assert_eq!(
            (*built_account, to.as_str(), *value),
            (account, funding_address.as_str(), REQUIRED)
        );
        assert_eq!(notes, &vec![([7u8; 32], REQUIRED + FEE)]);
        assert_eq!(fake.broadcasts.len(), 1);
    }
    // Stored before it was sent: the record holds exactly the bytes broadcast.
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    let pending = kept.pending.clone().unwrap();
    assert_eq!(
        hex::decode(&pending.raw).unwrap(),
        fake.lock().broadcasts[0]
    );
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "moving");
    assert_eq!(v["inbox"]["txid"], pending.txid);

    // The move is mined and its output reaches the funding address: the payout funds at the depth, and its deposit (a
    // transaction with no transparent input, as a move is) reads shielded.
    fake.mine(&pending.txid, 1_011);
    put_deposit_tx(
        &node,
        &funding_address,
        REQUIRED,
        Some(1_011),
        real_deposit("testnet-ironwood-batch"),
    );
    node.lock().tip = 1_013;
    fake.tip(1_013);
    let v = check(&h, &id).await;
    assert_eq!(v["phase"]["phase"], "funded");
    inboxes.round(&h.state).await;
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "moved");
    assert_eq!(v["funding_source"], "shielded");
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    assert_eq!(kept.moved, Some(pending.txid.clone()));
    assert!(kept.pending.is_none());

    // New notes after the move never make another: the inbox moves once.
    fake.deposit(account, 500_000, 1_014, 8);
    fake.tip(1_030);
    inboxes.round(&h.state).await;
    assert_eq!(fake.lock().built.len(), 1);
}

// covers: REQ-FUND-006, REQ-FUND-008
#[tokio::test]
async fn a_mined_move_is_done_once_the_wallet_has_scanned_it_and_the_page_says_moved_as_soon_as_the_payout_funds(
) {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, created, account) = create(&h).await;
    let funding_address = created["funding_address"].as_str().unwrap().to_owned();
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    fake.deposit(account, REQUIRED + FEE, 990, 7);
    inboxes.round(&h.state).await;
    let txid = h
        .state
        .store()
        .load_inbox(&id)
        .unwrap()
        .unwrap()
        .pending
        .unwrap()
        .txid;

    // The node has the move in a block the wallet has not scanned yet. There its note still looks unspent, so the move is
    // still in flight: done now, the page would say the whole deposit is left over (as it did on testnet).
    fake.mine(&txid, 1_001);
    fake.lock().chain_tip = 1_001;
    inboxes.round(&h.state).await;
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    assert!(kept.pending.is_some());
    assert_eq!(kept.moved, None);
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "moving");
    assert_eq!(v["inbox"]["left"], "0");
    assert_eq!(
        send_back(&h, &id, &recipient_ua(5), true).await.json()["error"]["code"],
        "inbox_busy"
    );

    // Scanned: the move is done, and nothing is left in the inbox.
    fake.tip(1_001);
    inboxes.round(&h.state).await;
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    assert!(kept.pending.is_none());
    assert_eq!(kept.moved, Some(txid));
    let v = view(&h, &id).await;
    assert_eq!(
        v["inbox"]["state"], "moving",
        "moved; the payout is not funded yet"
    );
    assert_eq!(v["inbox"]["received"], "0");

    // The payout funds from it: the next round says so, not ten minutes later.
    put_deposit_tx(
        &node,
        &funding_address,
        REQUIRED,
        Some(1_001),
        real_deposit("testnet-ironwood-batch"),
    );
    node.lock().tip = 1_003;
    fake.tip(1_003);
    assert_eq!(check(&h, &id).await["phase"]["phase"], "funded");
    inboxes.round(&h.state).await;
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "moved");
    assert_eq!(v["inbox"]["left"], "0");

    // From then on it rests: the wallet is synced every ten minutes, not every round.
    let synced = fake.lock().refreshes;
    inboxes.round(&h.state).await;
    assert_eq!(fake.lock().refreshes, synced);
}

// covers: REQ-FUND-006
#[tokio::test]
async fn a_payout_paid_at_its_public_address_is_never_moved_into() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, created, account) = create(&h).await;
    let funding_address = created["funding_address"].as_str().unwrap().to_owned();
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;

    // A big enough deposit straight to the public address, still in the mempool, and a spendable inbox: no move. The fresh
    // look at the funding address, just before the move, sees it.
    put_deposit(&node, &funding_address, REQUIRED, None, 3);
    fake.deposit(account, REQUIRED + FEE, 990, 9);
    inboxes.round(&h.state).await;
    assert!(fake.lock().built.is_empty());

    // Once it funds the payout, the inbox says it was not used, and what it holds can go back.
    node.lock().deposits.last_mut().unwrap().height = Some(1_000);
    node.lock().tip = 1_002;
    assert_eq!(check(&h, &id).await["phase"]["phase"], "funded");
    inboxes.round(&h.state).await;
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "unused");
    assert_eq!(v["inbox"]["left"], (REQUIRED + FEE).to_string());
    assert!(fake.lock().built.is_empty());
}

// covers: REQ-FUND-006
#[tokio::test]
async fn a_payout_funded_before_it_had_an_inbox_never_gets_one() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, created, _) = create(&h).await;
    put_deposit(
        &node,
        created["funding_address"].as_str().unwrap(),
        REQUIRED,
        Some(990),
        4,
    );
    assert_eq!(check(&h, &id).await["phase"]["phase"], "funded");
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    assert!(fake.lock().set_up.is_empty());
    assert!(view(&h, &id).await["inbox"].is_null());
    assert_eq!(h.state.store().load_inbox(&id).unwrap(), None);
}

// covers: REQ-FUND-006
#[tokio::test]
async fn a_move_in_flight_survives_a_restart_and_is_sent_again_never_rebuilt() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, _, account) = create(&h).await;
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    fake.deposit(account, REQUIRED + FEE, 990, 1);
    inboxes.round(&h.state).await;
    assert_eq!(fake.lock().built.len(), 1);
    let sent = fake.lock().broadcasts[0].clone();

    // The process stops before the move is mined; a new one starts with the same store and wallets.
    let h = h.restart(Options {
        required_depth: DEPTH,
        ..Builder::default().options
    });
    let inboxes = attach(&h, &fake);
    fake.tip(1_005);
    inboxes.round(&h.state).await;
    {
        let fake_now = fake.lock();
        assert_eq!(
            fake_now.built.len(),
            1,
            "nothing is rebuilt while the first move could still be mined"
        );
        assert_eq!(fake_now.broadcasts.len(), 2);
        assert_eq!(
            fake_now.broadcasts[1], sent,
            "the stored bytes are sent again, exactly"
        );
    }
    assert_eq!(view(&h, &id).await["inbox"]["state"], "moving");
}

// covers: REQ-FUND-006
#[tokio::test]
async fn a_move_is_rebuilt_only_after_the_wallet_has_scanned_past_its_expiry() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, _, account) = create(&h).await;
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    fake.deposit(account, REQUIRED + FEE, 990, 2);
    inboxes.round(&h.state).await;
    let expiry = h
        .state
        .store()
        .load_inbox(&id)
        .unwrap()
        .unwrap()
        .pending
        .unwrap()
        .expiry_height;
    assert_eq!(expiry, 1_040);

    // At its expiry height it could still be mined: no second move.
    fake.tip(expiry);
    inboxes.round(&h.state).await;
    assert_eq!(fake.lock().built.len(), 1);
    // Past it, unmined, it never can be: the move is built again.
    fake.tip(expiry + 1);
    inboxes.round(&h.state).await;
    assert_eq!(fake.lock().built.len(), 2);
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    assert_eq!(kept.pending.unwrap().expiry_height, expiry + 1 + 40);
}

// covers: REQ-FUND-008
#[tokio::test]
async fn short_and_unavailable_are_said_plainly() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, _, account) = create(&h).await;
    let fake = FakeInbox::default();
    fake.tip(1_000);
    fake.lock().fail_setup = true;
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    assert_eq!(view(&h, &id).await["inbox"]["state"], "unavailable");
    assert!(
        view(&h, &id).await["inbox"]["deposit_address"].is_null(),
        "no address until the wallet is set up and checked"
    );

    fake.lock().fail_setup = false;
    inboxes.round(&h.state).await;
    fake.deposit(account, 100_000, 990, 3);
    inboxes.round(&h.state).await;
    let v = view(&h, &id).await;
    assert_eq!(v["inbox"]["state"], "short");
    assert_eq!(v["inbox"]["need"], (REQUIRED + FEE - 100_000).to_string());
}

// covers: REQ-PRIV-004
#[tokio::test]
async fn nothing_of_the_inbox_reaches_the_receipt_the_logs_or_the_payouts_viewing_key() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, created, account) = create(&h).await;
    let funding_address = created["funding_address"].as_str().unwrap().to_owned();
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    fake.deposit(account, REQUIRED + FEE + 777_000, 990, 4);
    inboxes.round(&h.state).await;
    let pending = h
        .state
        .store()
        .load_inbox(&id)
        .unwrap()
        .unwrap()
        .pending
        .unwrap();
    fake.mine(&pending.txid, 1_001);
    put_deposit_tx(
        &node,
        &funding_address,
        REQUIRED,
        Some(1_001),
        real_deposit("testnet-ironwood-batch"),
    );
    node.lock().tip = 1_003;
    check(&h, &id).await;
    inboxes.round(&h.state).await;

    let receipt = h.get(&format!("/api/campaigns/{id}/receipt")).await;
    assert_eq!(receipt.status, StatusCode::OK, "{}", receipt.text());
    let needles = vec![
        FakeInbox::address(account),
        (REQUIRED + FEE + 777_000).to_string(),
        "777000".to_owned(),
    ];
    assert_clean("receipt", &receipt.text(), &needles);
    assert_clean("logs", &h.logs.lines().join("\n"), &needles);

    // The payout's own viewing key (what an auditor gets) is of a different seed from its inbox: neither of its incoming
    // viewing keys is the inbox's.
    let seed = SecretSeed::from_bytes(TEST_SEED);
    let phrase = InboxPhrase::derive(&seed, Network::Testnet, account).unwrap();
    let inbox = InboxKeys::derive(phrase.wallet_seed(), zcash_network(Network::Testnet)).unwrap();
    let payout =
        CampaignKeys::derive(&TEST_SEED, zcash_network(Network::Testnet), account).unwrap();
    let payout_fvk = payout.ufvk().orchard().unwrap();
    for scope in [
        orchard::keys::Scope::External,
        orchard::keys::Scope::Internal,
    ] {
        assert_ne!(
            payout_fvk.to_ivk(scope).to_bytes(),
            inbox.orchard_ivk_bytes()
        );
    }
    assert_ne!(payout.unified_address(), inbox.address());
}

async fn send_back(h: &Harness, id: &CampaignId, to: &str, confirm: bool) -> Reply {
    let headers: &[(&str, &str)] = if confirm {
        &[("x-zecdrop-confirm-send", "I-UNDERSTAND")]
    } else {
        &[]
    };
    h.call_with(
        axum::http::Method::POST,
        &format!("/api/campaigns/{id}/inbox/return"),
        Auth::Token,
        Some(json!({ "to": to })),
        headers,
    )
    .await
}

// covers: REQ-FUND-007
#[tokio::test]
async fn a_send_back_is_refused_while_a_move_may_happen_and_to_any_address_but_a_shielded_one_of_someone_else(
) {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, _, account) = create(&h).await;
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    // Enough has arrived and is still confirming: a move will happen, so nothing goes back.
    fake.deposit(account, REQUIRED + FEE, 995, 5);
    let busy = send_back(&h, &id, &recipient_ua(5), true).await;
    assert_eq!(busy.status, StatusCode::CONFLICT, "{}", busy.text());
    assert_eq!(busy.json()["error"]["code"], "inbox_busy");
    // It must be confirmed: money leaves for good.
    let unconfirmed = send_back(&h, &id, &recipient_ua(5), false).await;
    assert_eq!(unconfirmed.json()["error"]["code"], "confirmation_required");
    // Never to a transparent address, the inbox itself, or the payout's own account.
    let seed = SecretSeed::from_bytes(TEST_SEED);
    let phrase = InboxPhrase::derive(&seed, Network::Testnet, account).unwrap();
    let own_inbox = InboxKeys::derive(phrase.wallet_seed(), zcash_network(Network::Testnet))
        .unwrap()
        .address();
    let own_payout =
        CampaignKeys::derive(&TEST_SEED, zcash_network(Network::Testnet), account).unwrap();
    for to in [
        own_payout.funding_address(),
        own_inbox,
        own_payout.unified_address(),
        "nonsense".to_owned(),
    ] {
        let refused = send_back(&h, &id, &to, true).await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{to}: {}",
            refused.text()
        );
        assert_eq!(refused.json()["error"]["code"], "inbox_return_refused");
    }
    assert!(fake.lock().returns.is_empty());
}

// covers: REQ-FUND-007
#[tokio::test]
async fn what_is_left_after_the_move_goes_back_stored_before_it_is_sent() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, created, account) = create(&h).await;
    let funding_address = created["funding_address"].as_str().unwrap().to_owned();
    let fake = FakeInbox::default();
    fake.tip(1_000);
    let inboxes = attach(&h, &fake);
    inboxes.round(&h.state).await;
    // More than asked: the move leaves 200,000 of change in the inbox.
    fake.deposit(account, REQUIRED + FEE + 200_000, 990, 6);
    inboxes.round(&h.state).await;
    let pending = h
        .state
        .store()
        .load_inbox(&id)
        .unwrap()
        .unwrap()
        .pending
        .unwrap();
    fake.mine(&pending.txid, 1_001);
    put_deposit_tx(
        &node,
        &funding_address,
        REQUIRED,
        Some(1_001),
        real_deposit("testnet-ironwood-batch"),
    );
    node.lock().tip = 1_004;
    fake.tip(1_004);
    check(&h, &id).await;
    inboxes.round(&h.state).await;
    assert_eq!(view(&h, &id).await["inbox"]["left"], "200000");

    let to = recipient_ua(5);
    let sent = send_back(&h, &id, &to, true).await;
    assert_eq!(sent.status, StatusCode::ACCEPTED, "{}", sent.text());
    let txid = sent.json()["txid"].as_str().unwrap().to_owned();
    let stored = h
        .state
        .store()
        .load_inbox(&id)
        .unwrap()
        .unwrap()
        .pending
        .unwrap();
    {
        let fake = fake.lock();
        assert_eq!(fake.returns.len(), 1);
        assert_eq!(fake.returns[0].1, to);
        assert_eq!(
            fake.returns[0].2,
            vec![([0xcc; 32], 200_000)],
            "only the change, which is all that is left"
        );
        assert_eq!(
            fake.broadcasts.last().map(hex::encode),
            Some(stored.raw.clone()),
            "stored before it was sent"
        );
    }
    assert_eq!(view(&h, &id).await["inbox"]["state"], "returning");
    // A second one while it is in flight is refused.
    assert_eq!(
        send_back(&h, &id, &to, true).await.json()["error"]["code"],
        "inbox_busy"
    );
    // Mined: nothing is left, and nothing more can go.
    fake.mine(&txid, 1_005);
    fake.tip(1_006);
    inboxes.round(&h.state).await;
    let kept = h.state.store().load_inbox(&id).unwrap().unwrap();
    assert!(kept.pending.is_none());
    assert_eq!(kept.moved, Some(pending.txid));
    assert_eq!(view(&h, &id).await["inbox"]["left"], "0");
    assert_eq!(
        send_back(&h, &id, &to, true).await.json()["error"]["code"],
        "inbox_nothing_to_return"
    );
}

// covers: REQ-FUND-007
#[tokio::test]
async fn a_payout_without_an_inbox_has_nothing_to_send_back() {
    let node = SharedNode::default();
    node.lock().tip = 1_000;
    let h = real_harness(&node, DEPTH);
    let (id, _, _) = create(&h).await;
    let reply = send_back(&h, &id, &recipient_ua(5), true).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.json()["error"]["code"], "inbox_not_found");
}
