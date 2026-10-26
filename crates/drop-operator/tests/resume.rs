//! REQ-RES-001 through the HTTP layer: kill the engine mid-run on the mock chain,
//! restart the operator on the same encrypted store, and check that it continues
//! from the ledger without rebuilding anything.

mod common;

use axum::http::StatusCode;
use common::*;
use drop_core::{BatchStatus, CampaignId, Ledger, Txid};
use drop_operator::mock::MockConfig;
use drop_operator::state::{Options, RunState};
use serde_json::Value;

fn crash_after(steps: u32) -> Builder {
    Builder {
        options: Options {
            crash_after_steps: Some(steps),
            ..Builder::default().options
        },
        ..Builder::default()
    }
}

fn normal() -> Options {
    Builder::default().options
}

async fn crash_then_restart(steps: u32) -> (Harness, CampaignId, Vec<(u32, Txid)>) {
    let h = crash_after(steps).build();
    let (id, view) = h.create().await;
    assert_eq!(h.fund(&id, &view).await.status, StatusCode::OK);
    assert_eq!(
        h.post_empty(&format!("/api/campaigns/{id}/start"))
            .await
            .status,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        h.state.wait_for_run(&id).await,
        RunState::Crashed,
        "steps={steps}"
    );
    let builds_before = h.chain.builds();
    (h, id, builds_before)
}

// covers: REQ-RES-001
#[tokio::test]
async fn a_run_killed_at_any_point_resumes_without_rebuilding_or_double_broadcasting() {
    // Steps for two batches: build 0, send 0, build 1, send 1, then confirmation polls.
    for steps in 1..=8 {
        let (h, id, builds_before) = crash_then_restart(steps).await;
        let broadcasts_before = h.chain.broadcasts();

        // The ledger already holds exactly what the first process did.
        let ledger = h.state.store().ledger();
        let before = ledger.statuses(&id, 2).unwrap();
        let built_before: Vec<u32> = builds_before.iter().map(|(i, _)| *i).collect();
        match steps {
            1 => assert!(
                matches!(before[0], BatchStatus::Built { .. }) && before[1] == BatchStatus::Planned
            ),
            2 => assert!(matches!(before[0], BatchStatus::Broadcast { .. })),
            3 => assert!(matches!(before[1], BatchStatus::Built { .. })),
            _ => {}
        }
        let stored_txids: Vec<Option<Txid>> = before.iter().map(|s| s.txid()).collect();
        drop(ledger);

        // "Restart the process": same file, same chain, new in-memory state.
        let h = h.restart(normal());
        assert_eq!(
            h.state.run_state(&id),
            RunState::Idle,
            "no memory of the old run"
        );
        assert_eq!(h.state.resume_started().unwrap(), 1, "steps={steps}");
        assert_eq!(
            h.state.wait_for_run(&id).await,
            RunState::Settled,
            "steps={steps}"
        );

        // Never rebuilt: each batch was built exactly once across both processes.
        let builds = h.chain.builds();
        assert_eq!(
            builds.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            vec![0, 1],
            "steps={steps}"
        );
        assert!(builds.starts_with(&builds_before), "steps={steps}");
        for (i, txid) in stored_txids.iter().enumerate() {
            if let Some(txid) = txid {
                assert_eq!(
                    builds[i].1, *txid,
                    "the stored txid is the one that settled"
                );
            }
        }
        let _ = built_before;

        // Never broadcast twice: the crash fell between ledger writes, so each tx went out once.
        let mut sent = h.chain.broadcasts();
        assert!(sent.starts_with(&broadcasts_before), "steps={steps}");
        sent.sort();
        let mut expected: Vec<Txid> = builds.iter().map(|(_, t)| *t).collect();
        expected.sort();
        assert_eq!(sent, expected, "steps={steps}");

        // The public result is complete and consistent.
        let receipt = h.get(&format!("/api/campaigns/{id}/receipt")).await.json();
        assert_eq!(receipt["phase"]["phase"], "settled", "steps={steps}");
        for (i, batch) in receipt["batches"].as_array().unwrap().iter().enumerate() {
            assert_eq!(batch["txid"], builds[i].1.to_string());
            assert!(batch["confirmations"].as_u64().unwrap() >= 3);
        }
    }
}

// covers: REQ-RES-001
#[tokio::test]
async fn starting_again_over_http_also_resumes_from_the_ledger() {
    let (h, id, _) = crash_then_restart(3).await;
    let first_txids: Vec<Option<Txid>> = h
        .state
        .store()
        .ledger()
        .statuses(&id, 2)
        .unwrap()
        .iter()
        .map(|s| s.txid())
        .collect();
    assert!(first_txids[0].is_some() && first_txids[1].is_some());

    let h = h.restart(normal());
    let started = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(started.status, StatusCode::ACCEPTED);
    assert_eq!(started.json()["started"], true);
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Settled);

    let builds = h.chain.builds();
    assert_eq!(builds.len(), 2, "no rebuild: {builds:?}");
    let view = h.get(&format!("/api/campaigns/{id}")).await.json();
    assert_eq!(
        view["batches"][0]["txid"],
        first_txids[0].unwrap().to_string()
    );
    assert_eq!(
        view["batches"][1]["txid"],
        first_txids[1].unwrap().to_string()
    );
    assert_eq!(view["phase"]["phase"], "settled");
}

// covers: REQ-RES-001
#[tokio::test]
async fn the_event_stream_after_a_restart_covers_the_resumed_run() {
    let (h, id, _) = crash_then_restart(2).await;
    let h = h.restart(normal());
    assert_eq!(h.state.resume_started().unwrap(), 1);
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Settled);

    let text = h.get(&format!("/api/campaigns/{id}/events")).await.text();
    let kinds: Vec<String> = text
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|d| {
            serde_json::from_str::<Value>(d.trim()).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(kinds.last().map(String::as_str), Some("settled"));
    // Batch 0 was already built and sent before the crash: only batch 1's build appears.
    assert_eq!(
        kinds.iter().filter(|k| *k == "built").count(),
        1,
        "{kinds:?}"
    );
    assert_eq!(
        kinds.iter().filter(|k| *k == "broadcast").count(),
        1,
        "{kinds:?}"
    );
    assert_clean("events", &text, &recipient_needles());
}

// covers: REQ-RES-001
#[tokio::test]
async fn finished_and_failed_campaigns_are_not_restarted_on_boot() {
    let h = Harness::new();
    let (settled, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Settled);
    let builds = h.chain.builds().len();

    let h = h.restart(normal());
    assert_eq!(
        h.state.resume_started().unwrap(),
        0,
        "a settled campaign stays settled"
    );
    assert_eq!(h.state.run_state(&settled), RunState::Idle);
    assert_eq!(h.chain.builds().len(), builds);

    // A halted campaign is left for a human too.
    let failing = Builder {
        mock: MockConfig {
            reject_builds: vec![1],
            ..MockConfig::default()
        },
        ..Builder::default()
    }
    .build();
    let (id, end) = failing.run_to_end().await;
    assert_eq!(end, RunState::Halted);
    let failing = failing.restart(normal());
    assert_eq!(failing.state.resume_started().unwrap(), 0);
    assert_eq!(failing.state.run_state(&id), RunState::Idle);
}

// covers: REQ-RES-001, REQ-SEC-002
#[tokio::test]
async fn the_restarted_operator_needs_the_passphrase_and_loses_nothing() {
    let (h, id, _) = crash_then_restart(2).await;
    let db = h.db.clone();
    let stored = h.state.store().load_campaign(&id).unwrap().unwrap();
    let commitment = stored.commitment;
    drop(stored);
    let h = h.restart(normal());
    let record = h.state.store().load_campaign(&id).unwrap().unwrap();
    assert_eq!(record.commitment, commitment);
    assert_eq!(record.manifest.rows().len(), 5);
    assert!(record.started);
    drop(record);
    // The file only opens with the passphrase; `h` keeps the temp dir alive.
    assert!(matches!(
        drop_operator::store::Store::open(&db, "wrong passphrase"),
        Err(drop_operator::error::StoreError::WrongPassphrase)
    ));
    assert!(drop_operator::store::Store::open(&db, PASSPHRASE).is_ok());
    drop(h);
}
