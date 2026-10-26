//! `payslips` and `verify-payslip`: one recipient's proof of payment, issued from the campaign's
//! own key on the operator's machine and checked with no key. The batch is a genuine
//! librustzcash transaction built by the operator over an in-memory node, with TEST-ONLY keys.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use axum::http::StatusCode;
use common::zcash::*;
use common::*;
use drop_core::{CampaignId, Zatoshi};
use drop_operator::commands::{run_payslips, CommandError};
use drop_operator::config::PayslipsArgs;
use drop_operator::payslips::{
    file_name, read_payslip, run_verify_payslip_offline, run_verify_payslip_on_chain, PayslipsError,
};
use drop_operator::state::RunState;
use drop_verify::payslip::verify_payslip;
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

async fn settled() -> Settled {
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
