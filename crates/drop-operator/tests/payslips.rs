//! `payslips` and `verify-payslip`: one recipient's proof of payment, issued from the campaign's
//! own key on the operator's machine and checked with no key; and the route that gives every
//! payslip of a settled campaign to the payer's own page. The batch is a genuine librustzcash
//! transaction built by the operator over an in-memory node, with TEST-ONLY keys.

mod common;

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use axum::http::{header, Method, StatusCode};
use common::zcash::*;
use common::*;
use drop_core::{BatchStatus, CampaignId, Ledger, OutPoint, Zatoshi};
use drop_operator::commands::{run_payslips, CommandError, PAYSLIPS_WARNING};
use drop_operator::config::PayslipsArgs;
use drop_operator::payslips::{
    file_name, read_payslip, run_verify_payslip_offline, run_verify_payslip_on_chain, PayslipsError,
};
use drop_operator::state::{Options, RunState};
use drop_verify::payslip::{verify_payslip, Payslip};
use drop_verify::{FetchedTx, ParsedTx, PayslipError};
use serde_json::{json, Value};

const DEPTH: u32 = 3;

/// Three payouts that differ, with 9-digit amounts that cannot turn up inside a hash by chance.
fn rows() -> Vec<Row> {
    vec![
        Row {
            address: recipient_ua(0),
            zat: 150_000_000,
            memo: Some("payslip zero".into()),
        },
        Row {
            address: recipient_ua(1),
            zat: 75_000_000,
            memo: None,
        },
        Row {
            address: recipient_ua(2),
            zat: 225_000_000,
            memo: Some("payslip two".into()),
        },
    ]
}

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
    json!({ "name": "Payslip drop", "csv": csv, "max_outputs_per_batch": 5, "fee_policy": "zip317_text" })
}

/// A campaign the operator ran to `Settled` on an in-memory node, and what its chain holds.
struct Settled {
    h: Harness,
    id: CampaignId,
    /// The chain as a verifier sees it: the deposit and the batch.
    chain: StaticChain,
    batch_raw: Vec<u8>,
    funding_raw: Vec<u8>,
}

/// A campaign whose deposit is on an in-memory node at the required depth, not started.
struct Funded {
    h: Harness,
    node: SharedNode,
    id: CampaignId,
    deposit: OutPoint,
    funding_raw: Vec<u8>,
}

async fn funded() -> Funded {
    let node = SharedNode::default();
    let tip = u32::from(ironwood_height());
    node.lock().tip = tip;
    let h = real_harness(&node, DEPTH);
    let reply = h.post("/api/campaigns", body(&rows())).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let view = reply.json();
    let id = CampaignId::new(view["id"].as_str().unwrap()).unwrap();
    let address = view["funding_address"].as_str().unwrap().to_owned();
    // Exactly what is required: 450,000,000 declared + (3 outputs + 1 transparent) * 5,000.
    let (deposit, funding_raw) = put_deposit(&node, &address, 450_020_000, Some(tip - 100), 11);
    let funded = h
        .post_empty(&format!("/api/campaigns/{id}/check-funding"))
        .await;
    assert_eq!(funded.json()["phase"]["phase"], "funded");
    Funded {
        h,
        node,
        id,
        deposit,
        funding_raw,
    }
}

async fn settled() -> Settled {
    let Funded {
        h,
        node,
        id,
        deposit,
        funding_raw,
    } = funded().await;
    let start = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(start.status, StatusCode::ACCEPTED, "{}", start.text());
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Settled);

    let batch_raw = node.lock().submitted[0].clone();
    let batch = ParsedTx::parse(&batch_raw).unwrap();
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
            raw: batch_raw.clone(),
            mined_height: Some(mined),
        },
    );
    Settled {
        h,
        id,
        chain,
        batch_raw,
        funding_raw,
    }
}

fn args(id: &CampaignId, dir: &Path) -> PayslipsArgs {
    PayslipsArgs {
        campaign: id.to_string(),
        out_dir: dir.to_path_buf(),
    }
}

async fn issue(s: &Settled, dir: &Path) -> Result<(bool, String), CommandError> {
    let mut out = Vec::new();
    let complete = run_payslips(
        s.h.state.store(),
        s.h.state.seed(),
        &args(&s.id, dir),
        &s.chain,
        DEPTH,
        &mut out,
    )
    .await?;
    Ok((complete, String::from_utf8(out).unwrap()))
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

// covers: REQ-PAY-002
#[tokio::test]
async fn a_settled_campaign_gets_one_private_payslip_per_payout_in_payout_order() {
    let s = settled().await;
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("payslips");
    let (complete, printed) = issue(&s, &dir).await.unwrap();
    assert!(complete, "{printed}");

    // One owner-only file per payout, numbered as the payout list is, in an owner-only directory.
    assert_eq!(mode(&dir), 0o700);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec![file_name(0), file_name(1), file_name(2)]);
    let amounts = [150_000_000u64, 75_000_000, 225_000_000];
    for (i, want) in amounts.iter().enumerate() {
        let path = dir.join(file_name(i));
        assert_eq!(mode(&path), 0o600, "{}", path.display());
        let payslip = read_payslip(&path).unwrap();
        assert_eq!(
            payslip.value.as_u64(),
            *want,
            "row {i} keeps its own amount"
        );
        // Each one verifies against the real batch with no key at all.
        let proof = verify_payslip(&s.batch_raw, &payslip).unwrap();
        assert_eq!(proof.ironwood_actions, 3);
    }

    // What the command printed names no recipient: no address, memo, amount or key.
    let mut needles: Vec<String> = rows().iter().map(|r| r.address.clone()).collect();
    needles.extend(
        [
            "payslip zero",
            "payslip two",
            "150000000",
            "75000000",
            "225000000",
        ]
        .map(String::from),
    );
    needles.push(hex::encode(TEST_SEED));
    assert_clean("the command's output", &printed, &needles);
    assert!(printed.contains("Wrote 3 payslip(s)"), "{printed}");
}

// covers: REQ-PAY-002
#[tokio::test]
async fn nothing_is_issued_for_a_batch_that_is_not_final_or_over_an_existing_directory() {
    let mut s = settled().await;
    let work = tempfile::tempdir().unwrap();

    // The chain says the batch has fewer confirmations than the depth: nothing is written.
    let real_tip = s.chain.tip;
    s.chain.tip = real_tip - 5;
    let dir = work.path().join("early");
    let error = issue(&s, &dir).await.unwrap_err();
    assert!(
        matches!(error, CommandError::Payslips(PayslipsError::NotSettled)),
        "{error}"
    );
    assert!(!dir.exists(), "no directory was created");
    s.chain.tip = real_tip;

    // A directory that exists is never written into.
    let taken = work.path().join("taken");
    std::fs::create_dir(&taken).unwrap();
    let error = issue(&s, &taken).await.unwrap_err();
    assert!(
        matches!(error, CommandError::Payslips(PayslipsError::OutDirExists)),
        "{error}"
    );
    assert_eq!(std::fs::read_dir(&taken).unwrap().count(), 0);
}

// covers: REQ-PAY-002
#[tokio::test]
async fn another_wallet_seed_cannot_issue_payslips() {
    let s = settled().await;
    let work = tempfile::tempdir().unwrap();
    let other = drop_operator::secret::SecretSeed::from_bytes([0x99; 32]);
    let mut out = Vec::new();
    let error = run_payslips(
        s.h.state.store(),
        &other,
        &args(&s.id, &work.path().join("never")),
        &s.chain,
        DEPTH,
        &mut out,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, CommandError::WrongWallet), "{error}");
    assert!(out.is_empty());
    assert!(!work.path().join("never").exists());
}

// covers: REQ-PAY-003, REQ-PAY-001
#[tokio::test]
async fn a_payslip_is_checked_offline_from_two_files_and_says_what_it_does_not_prove() {
    let s = settled().await;
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("payslips");
    issue(&s, &dir).await.unwrap();
    let tx_file = work.path().join("tx.hex");
    std::fs::write(&tx_file, format!("{}\n", hex::encode(&s.batch_raw))).unwrap();
    let payslip_file = dir.join(file_name(1));
    let payslip = read_payslip(&payslip_file).unwrap();

    let mut out = Vec::new();
    run_verify_payslip_offline(&payslip_file, &tx_file, &mut out).unwrap();
    let verdict = String::from_utf8(out).unwrap();
    assert!(verdict.starts_with("OK: action"), "{verdict}");
    assert!(verdict.contains(&payslip.txid.to_string()), "{verdict}");
    assert!(verdict.contains("did not ask the chain"), "{verdict}");
    assert!(verdict.contains("What this does not prove"), "{verdict}");
    assert!(verdict.contains("bearer document"), "{verdict}");
    // Negative: the verdict repeats neither the receiver nor the amount nor the rseed.
    let json = serde_json::to_value(&payslip).unwrap();
    for field in ["receiver", "rseed"] {
        assert_clean(
            "the verdict",
            &verdict,
            &[json[field].as_str().unwrap().to_owned()],
        );
    }
    assert_clean("the verdict", &verdict, &["75000000".to_owned()]);

    // A payslip changed in any field is refused, with words that echo nothing.
    let mut changed = json.clone();
    changed["value"] = json!("75000001");
    let tampered = work.path().join("tampered.json");
    std::fs::write(&tampered, serde_json::to_string(&changed).unwrap()).unwrap();
    let mut out = Vec::new();
    let error = run_verify_payslip_offline(&tampered, &tx_file, &mut out).unwrap_err();
    assert!(
        matches!(
            error,
            PayslipsError::Verify(PayslipError::CommitmentMismatch)
        ),
        "{error}"
    );
    assert!(out.is_empty());
    assert_clean("the refusal", &error.to_string(), &["75000001".to_owned()]);

    // Another transaction's bytes do not open it (the deposit transaction is a real other one); a
    // file that is not a payslip, or not a transaction, is refused for what it is.
    let other_tx = work.path().join("other.hex");
    std::fs::write(&other_tx, format!("{}\n", hex::encode(&s.funding_raw))).unwrap();
    assert!(matches!(
        run_verify_payslip_offline(&payslip_file, &other_tx, &mut Vec::new()).unwrap_err(),
        PayslipsError::Verify(PayslipError::TxidMismatch)
    ));
    let junk_tx = work.path().join("junk.hex");
    std::fs::write(&junk_tx, "not hex").unwrap();
    assert!(matches!(
        run_verify_payslip_offline(&payslip_file, &junk_tx, &mut Vec::new()).unwrap_err(),
        PayslipsError::NotHex
    ));
    let not_a_payslip = work.path().join("note.json");
    std::fs::write(&not_a_payslip, "{\"hello\": 1}").unwrap();
    assert!(matches!(
        run_verify_payslip_offline(&not_a_payslip, &tx_file, &mut Vec::new()).unwrap_err(),
        PayslipsError::NotAPayslip
    ));
}

// covers: REQ-PAY-003
#[tokio::test]
async fn against_a_node_the_verdict_adds_the_depth_and_a_young_batch_is_pending() {
    let mut s = settled().await;
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("payslips");
    issue(&s, &dir).await.unwrap();
    let payslip_file = dir.join(file_name(0));

    let mut out = Vec::new();
    let is_final = run_verify_payslip_on_chain(&payslip_file, &s.chain, DEPTH, &mut out)
        .await
        .unwrap();
    let verdict = String::from_utf8(out).unwrap();
    assert!(is_final, "{verdict}");
    assert!(verdict.contains("final at depth 3"), "{verdict}");

    // The same payslip with the chain one block short of the depth: it verifies, but it is pending.
    let mined = s.chain.tip - DEPTH; // the batch was mined at tip - 2 or earlier
    s.chain.tip = mined + 1; // one confirmation
    let mut out = Vec::new();
    let is_final = run_verify_payslip_on_chain(&payslip_file, &s.chain, DEPTH, &mut out)
        .await
        .unwrap();
    let verdict = String::from_utf8(out).unwrap();
    assert!(!is_final, "{verdict}");
    assert!(verdict.contains("PENDING"), "{verdict}");
    assert!(verdict.contains("What this does not prove"), "{verdict}");

    // A payslip for a transaction the chain does not know is "not found", not a pass.
    let mut json: Value = serde_json::to_value(read_payslip(&payslip_file).unwrap()).unwrap();
    json["txid"] = json!("ab".repeat(32));
    let unknown = work.path().join("unknown.json");
    std::fs::write(&unknown, json.to_string()).unwrap();
    let error = run_verify_payslip_on_chain(&unknown, &s.chain, DEPTH, &mut Vec::new())
        .await
        .unwrap_err();
    assert!(matches!(error, PayslipsError::Check(_)), "{error}");
}

fn binary() -> std::process::Command {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_drop-operator"));
    command
        .env_remove("ZECDROP_PASSPHRASE")
        .env_remove("ZECDROP_CONFIRM_MAINNET")
        .stdin(std::process::Stdio::null());
    command
}

// covers: REQ-PAY-003, REQ-PAY-001
#[tokio::test]
async fn the_binary_checks_a_payslip_from_two_files_with_no_passphrase_store_or_node() {
    let s = settled().await;
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("payslips");
    issue(&s, &dir).await.unwrap();
    let tx_file = work.path().join("tx.hex");
    std::fs::write(&tx_file, hex::encode(&s.batch_raw)).unwrap();
    let payslip_file = dir.join(file_name(2));

    let ok = binary()
        .args(["verify-payslip", "--payslip"])
        .arg(&payslip_file)
        .arg("--tx")
        .arg(&tx_file)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&ok.stdout);
    assert!(
        ok.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    assert!(stdout.starts_with("OK: action"), "{stdout}");
    assert!(stdout.contains("What this does not prove"), "{stdout}");
    assert_clean("the verdict", &stdout, &["225000000".to_owned()]);

    // A changed payslip: exit 1, nothing on stdout, a sentence on stderr that echoes nothing.
    let mut json: Value = serde_json::from_slice(&std::fs::read(&payslip_file).unwrap()).unwrap();
    json["action"] = json!(99);
    let bad = work.path().join("bad.json");
    std::fs::write(&bad, json.to_string()).unwrap();
    let refused = binary()
        .args(["verify-payslip", "--payslip"])
        .arg(&bad)
        .arg("--tx")
        .arg(&tx_file)
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(1));
    assert!(refused.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(stderr.contains("no such action"), "{stderr}");

    // Neither a file nor a node: told what to give.
    let neither = binary()
        .args(["verify-payslip", "--payslip"])
        .arg(&payslip_file)
        .output()
        .unwrap();
    assert!(!neither.status.success());
    assert!(String::from_utf8_lossy(&neither.stderr).contains("--tx <file>"));
}

// covers: REQ-PAY-002, REQ-OPS-004
#[tokio::test]
async fn the_payslips_command_refuses_a_campaign_of_another_network_before_it_asks_a_node() {
    let s = settled().await;
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("payslips");
    // A testnet campaign, the tool started for mainnet with the gate open: refused at once.
    let output = binary()
        .env("ZECDROP_PASSPHRASE", PASSPHRASE)
        .env("ZECDROP_CONFIRM_MAINNET", "I-UNDERSTAND")
        .args(["--db", s.h.db.to_str().unwrap()])
        .args(["--network", "mainnet", "--allow-mainnet"])
        .args(["--lightwalletd-url", "https://zec.rocks:443"])
        .args(["payslips", "--campaign", &s.id.to_string(), "--out-dir"])
        .arg(&dir)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("testnet campaign"), "{stderr}");
    assert!(!dir.exists(), "nothing was written");
}

// ---------------------------------------------------------------------------
// The payer's page: GET /api/campaigns/{id}/payslips
// ---------------------------------------------------------------------------

const CONFIRM: (&str, &str) = ("X-Zecdrop-Confirm-Disclosure", "I-UNDERSTAND");

fn payslips_path(id: &CampaignId) -> String {
    format!("/api/campaigns/{id}/payslips")
}

/// Asks for a campaign's payslips as the page does once the person has read the warning.
async fn export(h: &Harness, id: &CampaignId) -> Reply {
    h.call_with(
        Method::GET,
        &payslips_path(id),
        Auth::Token,
        None,
        &[CONFIRM],
    )
    .await
}

/// The Orchard receiver inside a row's unified address: what the row's payslip must name.
fn receiver_of(address: &str) -> [u8; 43] {
    match zcash_keys::address::Address::decode(&NETWORK, address) {
        Some(zcash_keys::address::Address::Unified(ua)) => {
            ua.orchard().unwrap().to_raw_address_bytes()
        }
        _ => panic!("not a unified address"),
    }
}

/// Each row's address, memo and amount: in no log line, refusal or store file.
fn row_needles() -> Vec<String> {
    let mut needles: Vec<String> = rows().iter().map(|r| r.address.clone()).collect();
    needles.extend(
        [
            "payslip zero",
            "payslip two",
            "150000000",
            "75000000",
            "225000000",
        ]
        .map(String::from),
    );
    needles
}

/// The store file and its journals, as text.
fn store_text(h: &Harness) -> String {
    let mut bytes = std::fs::read(&h.db).unwrap();
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut sibling = h.db.as_os_str().to_owned();
        sibling.push(suffix);
        if let Ok(extra) = std::fs::read(sibling) {
            bytes.extend(extra);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn depth(required_depth: u32) -> Options {
    Options {
        required_depth,
        ..Builder::default().options
    }
}

// covers: REQ-PAY-005
#[tokio::test]
async fn a_settled_campaign_gives_the_payers_page_every_payslip_in_payout_order() {
    let s = settled().await;
    let logged_before = s.h.logs.lines().len();
    let reply = export(&s.h, &s.id).await;
    let logged: Vec<String> = s.h.logs.lines()[logged_before..].to_vec();
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    let view = reply.json();
    assert_eq!(view["warning"], PAYSLIPS_WARNING);
    assert_eq!(view["campaign_id"], s.id.to_string());
    assert_eq!(view["network"], "testnet");
    assert_eq!(view["unmatched_outputs"], 0);

    // One entry per payout, in the payout list's order, each with its own row as it was imported
    // and a payslip for that row's output that verifies, with no key, against the transaction the
    // node mined.
    let entries = view["payslips"].as_array().unwrap();
    assert_eq!(entries.len(), rows().len());
    let mut actions = BTreeSet::new();
    for (i, (entry, row)) in entries.iter().zip(rows()).enumerate() {
        assert_eq!(entry["number"], i + 1);
        assert_eq!(entry["address"], row.address.as_str(), "row {i}");
        assert_eq!(entry["amount"], row.zat.to_string(), "row {i}");
        assert_eq!(entry["memo"], json!(row.memo), "row {i}");
        let payslip: Payslip = serde_json::from_value(entry["payslip"].clone()).unwrap();
        assert_eq!(
            payslip.value.as_u64(),
            row.zat,
            "row {i} has its own payslip"
        );
        assert_eq!(
            payslip.receiver,
            receiver_of(&row.address),
            "row {i} has its own payslip"
        );
        let proof = verify_payslip(&s.batch_raw, &payslip).unwrap();
        assert_eq!(proof.ironwood_actions, 3);
        actions.insert(payslip.action);
    }
    assert_eq!(actions.len(), 3, "each payslip opens an output of its own");

    // They are the payslips the `payslips` command writes from the node's copy of the batch.
    let work = tempfile::tempdir().unwrap();
    let dir = work.path().join("payslips");
    let (complete, _) = issue(&s, &dir).await.unwrap();
    assert!(complete);
    for (i, entry) in entries.iter().enumerate() {
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join(file_name(i))).unwrap()).unwrap();
        assert_eq!(entry["payslip"], written, "row {i}");
    }

    // Negative: the request logged its route and nothing else, and neither the log nor the store
    // file holds a row's address, memo or amount, or a payslip's receiver or rseed.
    assert_eq!(logged, ["[info] GET /api/campaigns/{id}/payslips -> 200"]);
    let mut needles = row_needles();
    for entry in entries {
        for field in ["receiver", "rseed"] {
            needles.push(entry["payslip"][field].as_str().unwrap().to_owned());
        }
    }
    assert_clean("the operator's log", &s.h.logs.lines().join("\n"), &needles);
    assert_clean("the store file", &store_text(&s.h), &needles);
}

// covers: REQ-PAY-005, REQ-OPS-002
#[tokio::test]
async fn the_payslips_are_refused_without_the_acknowledgement_the_token_the_campaign_or_its_wallet()
{
    let s = settled().await;
    let path = payslips_path(&s.id);
    let needles = row_needles();

    // Without the acknowledgement, or with anything but exactly it: 400, with the warning for the
    // page to show, and nothing of any row.
    let plain = s.h.get(&path).await;
    assert_eq!(plain.status, StatusCode::BAD_REQUEST, "{}", plain.text());
    let error = plain.json()["error"].clone();
    assert_eq!(error["code"], "confirmation_required");
    assert_eq!(error["warning"], PAYSLIPS_WARNING);
    assert_clean("the refusal", &plain.text(), &needles);
    for near_miss in [
        (CONFIRM.0, ""),
        (CONFIRM.0, "i-understand"),
        (CONFIRM.0, "yes"),
        (CONFIRM.0, "I-UNDERSTAND "),
        ("X-Zecdrop-Confirm-Near", CONFIRM.1),
    ] {
        let reply =
            s.h.call_with(Method::GET, &path, Auth::Token, None, &[near_miss])
                .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{near_miss:?}");
        assert_eq!(reply.json()["error"]["code"], "confirmation_required");
        assert_eq!(reply.json()["error"]["warning"], PAYSLIPS_WARNING);
        assert_clean("the refusal", &reply.text(), &needles);
    }

    // No token, or a wrong one, even with the acknowledgement.
    for auth in [Auth::None, Auth::Wrong] {
        let reply =
            s.h.call_with(Method::GET, &path, auth, None, &[CONFIRM])
                .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{auth:?}");
        assert_clean("the refusal", &reply.text(), &needles);
    }

    // A campaign this store does not hold.
    let ghost = CampaignId::new("c-000000000000").unwrap();
    let reply = export(&s.h, &ghost).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{}", reply.text());
    assert_eq!(reply.json()["error"]["code"], "not_found");
    assert_clean("the operator's log", &s.h.logs.lines().join("\n"), &needles);

    // The same store opened by an operator holding another wallet seed.
    let other = s.h.restart_as([0x99; 32], depth(DEPTH));
    let reply = export(&other, &s.id).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.text());
    assert_eq!(reply.json()["error"]["code"], "wrong_wallet_seed");
    assert_clean("the refusal", &reply.text(), &needles);
}

// covers: REQ-PAY-005
#[tokio::test]
async fn payslips_wait_until_every_batch_is_confirmed_at_the_required_depth() {
    let needles = row_needles();
    let refused = |reply: &Reply| {
        assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.text());
        assert_eq!(reply.json()["error"]["code"], "not_settled");
        assert_clean("the refusal", &reply.text(), &needles);
    };

    // Funded and never started: no batch has a transaction.
    let f = funded().await;
    refused(&export(&f.h, &f.id).await);

    // A batch that failed: the campaign is not settled, and never will be by itself.
    let mut ledger = f.h.state.store().ledger();
    ledger.record(&f.id, 0, BatchStatus::Planned).unwrap();
    ledger
        .record(
            &f.id,
            0,
            BatchStatus::Failed {
                reason: "the node rejected the transaction".into(),
                txid: None,
            },
        )
        .unwrap();
    refused(&export(&f.h, &f.id).await);

    // Sent and confirmed, but not as deep as this operator now requires: its bytes are in the
    // store and still nothing is issued, while the campaign's own phase says it is not complete.
    let s = settled().await;
    let deeper = s.h.restart(depth(10));
    refused(&export(&deeper, &s.id).await);
    let view = deeper.get(&format!("/api/campaigns/{}", s.id)).await.json();
    assert_eq!(view["phase"]["phase"], "sending", "{view}");

    // At the depth it was confirmed to, the same campaign is settled and gets its payslips.
    let again = deeper.restart(depth(DEPTH));
    let reply = export(&again, &s.id).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json()["payslips"].as_array().unwrap().len(), 3);
}

// covers: REQ-PAY-005
#[tokio::test]
async fn the_mock_chain_has_no_payslips_to_give() {
    let h = Harness::new();
    let (id, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Settled);
    for headers in [&[CONFIRM][..], &[]] {
        let reply = h
            .call_with(Method::GET, &payslips_path(&id), Auth::Token, None, headers)
            .await;
        assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.text());
        assert_eq!(reply.json()["error"]["code"], "not_available");
        assert_clean("the refusal", &reply.text(), &recipient_needles());
    }
    assert_clean("the log", &h.logs.lines().join("\n"), &recipient_needles());
}
