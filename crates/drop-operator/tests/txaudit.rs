//! Auditing one transaction from files, offline (REQ-AUD-001, REQ-AUD-002): the report on
//! genuine Orchard batch transactions built with TEST-ONLY keys, on the committed live testnet
//! batch, and the `audit-tx` command as a process.

#![cfg(unix)]

mod common;

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;

use common::zcash::*;
use drop_core::{Network as CoreNetwork, Zatoshi};
use drop_operator::txaudit::{
    audit_transaction, read_prevouts, read_tx_hex, Prevout, TxAudit, TxAuditError,
};
use drop_zcash::CampaignKeys;

const LIVE_TXID: &str = "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3";

fn ufvk_of(account: u32) -> String {
    CampaignKeys::derive(&TEST_SEED, NETWORK, account)
        .unwrap()
        .ufvk_encoded()
        .unwrap()
}

fn row(i: u32, zat: u64, memo: Option<&str>) -> Row {
    Row {
        address: recipient_ua(i),
        zat,
        memo: memo.map(str::to_owned),
    }
}

/// A batch transaction with the files an auditor would be handed for it.
struct Case {
    raw: Vec<u8>,
    prevouts: Vec<Prevout>,
    rows: Vec<Row>,
    txid: String,
}

fn make(account: u32, rows: Vec<Row>, salt: u8) -> Case {
    let total: u64 = rows.iter().map(|r| r.zat).sum();
    let value = total + 20_000_000;
    let keys = CampaignKeys::derive(&TEST_SEED, NETWORK, account).unwrap();
    let (funding_txid, _) = funding_tx(&keys.funding_address(), value, salt);
    let (batch_txid, raw) = batch_tx(account, &rows, (&funding_txid, value));
    Case {
        raw,
        prevouts: vec![Prevout {
            txid: funding_txid.to_string(),
            index: 0,
            value_zat: value,
            script_pubkey_hex: hex::encode(script_bytes(&keys.funding_address())),
        }],
        rows,
        txid: batch_txid.to_string(),
    }
}

fn three() -> &'static Case {
    static CASE: OnceLock<Case> = OnceLock::new();
    CASE.get_or_init(|| {
        make(
            0,
            vec![
                row(0, 150_000_000, Some("hello zero")),
                row(1, 75_000_000, None),
                row(2, 225_000_000, Some("thanks two")),
            ],
            21,
        )
    })
}

fn solo() -> &'static Case {
    static CASE: OnceLock<Case> = OnceLock::new();
    CASE.get_or_init(|| make(0, vec![row(20, 40_000_000, Some("solo memo"))], 22))
}

fn audit(case: &Case, ufvk: &str) -> Result<TxAudit, TxAuditError> {
    audit_transaction(&case.raw, &case.prevouts, CoreNetwork::Testnet, ufvk)
}

// covers: REQ-AUD-001
#[test]
fn a_transaction_opened_by_its_own_key_reconciles_to_the_public_totals() {
    let case = three();
    let report = audit(case, &ufvk_of(0)).unwrap();
    assert_eq!(report.txid.to_string(), case.txid);
    assert_eq!(report.pool, "ironwood");
    assert_eq!(report.public_actions, 3);
    assert_eq!(report.recovered_outputs, 3);
    assert_eq!(report.count_matches, Some(true));
    let net = Zatoshi::new(450_000_000).unwrap();
    assert_eq!(report.public_net_into_pool, Some(net));
    assert_eq!(report.recovered_sum, Some(net));
    assert_eq!(report.sum_matches, Some(true));
    assert!(report.balances);
    assert!(report.reconciled);
    // The fee is what the chain's own arithmetic leaves: in, out and the pool add up.
    assert_eq!(
        report.transparent_in.as_u64(),
        report.transparent_out.as_u64() + net.as_u64() + report.fee.unwrap().as_u64()
    );
    let text = report.render();
    assert!(text.contains("RESULT: reconciled"), "{text}");
    for line in ["outputs recovered", "recovered total"] {
        let line = text.lines().find(|l| l.contains(line)).unwrap();
        assert!(line.ends_with("matches"), "{line}");
    }
    assert!(text.contains("450000000 zat"), "{text}");
    // Testnet coins are TAZ; ZEC is the mainnet coin.
    assert!(text.contains("TAZ") && !text.contains("ZEC"), "{text}");
    let mainnet = TxAudit {
        network: CoreNetwork::Mainnet,
        ..report
    };
    let text = mainnet.render();
    assert!(text.contains("ZEC") && !text.contains("TAZ"), "{text}");
}

// covers: REQ-AUD-001, REQ-AUD-002
#[test]
fn another_campaigns_key_recovers_nothing_and_both_differences_are_reported() {
    let report = audit(three(), &ufvk_of(1)).unwrap();
    assert_eq!(report.recovered_outputs, 0);
    assert_eq!(report.recovered_sum, Some(Zatoshi::ZERO));
    assert_eq!(report.count_matches, Some(false));
    assert_eq!(report.sum_matches, Some(false));
    // The chain's own side of the comparison is unchanged.
    assert_eq!(report.public_actions, 3);
    assert!(report.balances);
    assert!(!report.reconciled);
    let text = report.render();
    for line in ["outputs recovered", "recovered total"] {
        let line = text.lines().find(|l| l.contains(line)).unwrap();
        assert!(line.ends_with("DIFFERS"), "{line}");
    }
    assert!(text.contains("NOT reconciled"));
}

// covers: REQ-AUD-001
#[test]
fn one_recipient_is_padded_to_two_actions_and_still_reconciles() {
    let report = audit(solo(), &ufvk_of(0)).unwrap();
    assert_eq!(report.public_actions, 2);
    assert_eq!(report.recovered_outputs, 1);
    assert_eq!(report.count_matches, None, "not comparable by design");
    assert_eq!(report.sum_matches, Some(true));
    assert!(report.reconciled);
    assert!(report.render().contains("not comparable"));
    // The same transaction under another key: nothing opens, and that is a difference.
    let other = audit(solo(), &ufvk_of(3)).unwrap();
    assert_eq!(other.recovered_outputs, 0);
    assert_eq!(other.count_matches, Some(false));
    assert!(!other.reconciled);
}

// covers: REQ-AUD-001
#[test]
fn prevouts_that_do_not_cover_the_outputs_make_the_transaction_not_balance() {
    let case = three();
    // The spent output is worth less than the transaction pays out.
    let mut short = case.prevouts.clone();
    short[0].value_zat = 1_000;
    let report = audit_transaction(&case.raw, &short, CoreNetwork::Testnet, &ufvk_of(0)).unwrap();
    assert!(!report.balances);
    assert!(!report.reconciled, "{}", report.render());
    assert!(report.render().contains("DOES NOT BALANCE"));
    assert_eq!(report.fee, None, "a negative fee is not shown as a number");

    // A listing that leaves out a spent output cannot be audited at all.
    assert_eq!(
        audit_transaction(&case.raw, &[], CoreNetwork::Testnet, &ufvk_of(0)).unwrap_err(),
        TxAuditError::UnresolvedPrevout
    );
    let mut elsewhere = case.prevouts.clone();
    elsewhere[0].index = 5;
    assert_eq!(
        audit_transaction(&case.raw, &elsewhere, CoreNetwork::Testnet, &ufvk_of(0)).unwrap_err(),
        TxAuditError::UnresolvedPrevout
    );
}

// covers: REQ-AUD-001
#[test]
fn inputs_that_are_not_what_was_expected_are_refused_without_being_quoted() {
    let case = three();
    let key = ufvk_of(0);
    assert_eq!(
        audit_transaction(
            b"not a transaction",
            &case.prevouts,
            CoreNetwork::Testnet,
            &key
        )
        .unwrap_err(),
        TxAuditError::Unparseable
    );
    // A key for the other network does not decode.
    let mainnet = CampaignKeys::derive(
        &TEST_SEED,
        zcash_protocol::consensus::Network::MainNetwork,
        0,
    )
    .unwrap()
    .ufvk_encoded()
    .unwrap();
    let error = audit(case, &mainnet).unwrap_err();
    assert!(matches!(error, TxAuditError::Key(_)));
    let shown = format!("{error} {error:?}");
    assert!(
        !shown.contains("uview") && !shown.contains(&mainnet[..20]),
        "{shown}"
    );

    // Malformed prevouts.
    for bad in [
        Prevout {
            txid: "zz".into(),
            ..case.prevouts[0].clone()
        },
        Prevout {
            txid: "ab".repeat(31),
            ..case.prevouts[0].clone()
        },
        Prevout {
            script_pubkey_hex: "7".into(),
            ..case.prevouts[0].clone()
        },
        Prevout {
            script_pubkey_hex: "zz".into(),
            ..case.prevouts[0].clone()
        },
        Prevout {
            value_zat: u64::MAX,
            ..case.prevouts[0].clone()
        },
    ] {
        assert_eq!(
            audit_transaction(&case.raw, &[bad], CoreNetwork::Testnet, &key).unwrap_err(),
            TxAuditError::BadPrevouts
        );
    }
}

fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path
}

// covers: REQ-AUD-001
#[test]
fn the_files_are_read_with_limits_and_failures_say_nothing_about_them() {
    let dir = tempfile::tempdir().unwrap();
    let case = three();
    let tx = write(
        dir.path(),
        "tx.hex",
        &format!("{}\n", hex::encode(&case.raw)),
    );
    assert_eq!(read_tx_hex(&tx).unwrap(), case.raw);
    assert_eq!(
        read_tx_hex(&write(dir.path(), "odd.hex", "abc")).unwrap_err(),
        TxAuditError::BadHex
    );
    assert_eq!(
        read_tx_hex(&write(dir.path(), "bad.hex", "SECRETMARKER!")).unwrap_err(),
        TxAuditError::BadHex
    );
    assert_eq!(
        read_tx_hex(&dir.path().join("missing")).unwrap_err(),
        TxAuditError::Unreadable
    );
    // Far bigger than any transaction.
    let huge = dir.path().join("huge.hex");
    std::fs::write(&huge, vec![b'a'; 5 * 1024 * 1024]).unwrap();
    assert_eq!(read_tx_hex(&huge).unwrap_err(), TxAuditError::Unreadable);

    let good = serde_json::json!([{
        "txid": "ab".repeat(32), "index": 1, "value_zat": 5, "script_pubkey_hex": "76a9"
    }]);
    let prevouts = write(dir.path(), "prevouts.json", &good.to_string());
    assert_eq!(read_prevouts(&prevouts).unwrap().len(), 1);
    for bad in [
        "not json".to_owned(),
        r#"{"txid":"x"}"#.to_owned(),
        r#"[{"txid":"ab","index":0,"value_zat":1,"script_pubkey_hex":"","extra":1}]"#.to_owned(),
        r#"[{"txid":"SECRETMARKER","index":"zero"}]"#.to_owned(),
    ] {
        let error = read_prevouts(&write(dir.path(), "p.json", &bad)).unwrap_err();
        assert_eq!(error, TxAuditError::BadPrevouts);
        assert!(!format!("{error} {error:?}").contains("SECRETMARKER"));
    }
}

// covers: REQ-AUD-001, REQ-PRIV-002
#[test]
fn the_report_holds_no_key_address_memo_or_per_recipient_amount() {
    let case = three();
    let key = ufvk_of(0);
    let report = audit(case, &key).unwrap();
    let text = report.render();
    let json = serde_json::to_string_pretty(&report).unwrap();
    let mut needles = vec![key.clone(), key[..40].to_owned(), hex::encode(TEST_SEED)];
    for r in &case.rows {
        needles.push(r.address.clone());
        needles.push(r.zat.to_string());
        needles.push(Zatoshi::new(r.zat).unwrap().format_zec());
        needles.extend(r.memo.clone());
    }
    for (label, haystack) in [("text", &text), ("json", &json)] {
        for needle in &needles {
            assert!(
                !haystack.contains(needle.as_str()),
                "{label} leaked {needle}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The committed live batch (public chain data only)
// ---------------------------------------------------------------------------

fn live_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/testnet-ironwood-batch")
        .join(LIVE_TXID)
}

// covers: REQ-AUD-001, REQ-AUD-002
#[test]
fn the_live_testnet_batch_shows_the_public_facts_and_a_stranger_key_opens_nothing() {
    let dir = live_dir();
    let raw = read_tx_hex(&dir.join("tx.hex")).unwrap();
    let prevouts = read_prevouts(&dir.join("prevouts.json")).unwrap();
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("expected.json")).unwrap()).unwrap();

    let report = audit_transaction(&raw, &prevouts, CoreNetwork::Testnet, &ufvk_of(0)).unwrap();
    assert_eq!(report.txid.to_string(), LIVE_TXID);
    assert_eq!(report.pool, "ironwood");
    // What the chain published, as recomputed from the real bytes.
    assert_eq!(
        u64::from(report.public_actions),
        expected["ironwood_actions"]
    );
    assert_eq!(report.transparent_in.as_u64(), expected["t_in_zat"]);
    assert_eq!(report.transparent_out.as_u64(), expected["t_out_zat"]);
    assert_eq!(
        report.public_net_into_pool.map(Zatoshi::as_u64),
        expected["net_into_ironwood_zat"].as_u64()
    );
    assert_eq!(
        report.fee.map(Zatoshi::as_u64),
        expected["fee_zat"].as_u64()
    );
    assert!(report.balances);
    // A key that is not the campaign's recovers nothing from a real transaction either.
    assert_eq!(report.recovered_outputs, 0);
    assert!(!report.reconciled);
}

/// The campaign key of the live batch is derived from the owner's development seed, which is
/// not in the repository: run with `-- --ignored` on a machine that has it. Only counts and the
/// account number are printed; the seed and the key never are.
// covers: REQ-AUD-001, REQ-AUD-002
#[test]
#[ignore = "needs the owner's development seed at ~/.zecdrop-dev/testnet.seed"]
fn the_live_testnet_batch_reconciles_under_the_development_seed_campaign_key() {
    let seed_path = Path::new(&std::env::var("HOME").unwrap()).join(".zecdrop-dev/testnet.seed");
    let Ok(seed) = drop_operator::seedfile::read_seed_file(&seed_path) else {
        eprintln!("skipped: no readable development seed");
        return;
    };
    let dir = live_dir();
    let raw = read_tx_hex(&dir.join("tx.hex")).unwrap();
    let prevouts = read_prevouts(&dir.join("prevouts.json")).unwrap();
    let mut reconciling = Vec::new();
    for account in 0..16 {
        let ufvk =
            drop_operator::commands::campaign_ufvk(&seed, CoreNetwork::Testnet, account).unwrap();
        let report = audit_transaction(&raw, &prevouts, CoreNetwork::Testnet, &ufvk).unwrap();
        if report.recovered_outputs > 0 {
            eprintln!(
                "account {account}: recovered {} of {} outputs, sum {} zat, public net {} zat, reconciled {}",
                report.recovered_outputs,
                report.public_actions,
                report.recovered_sum.map_or(0, Zatoshi::as_u64),
                report.public_net_into_pool.map_or(0, Zatoshi::as_u64),
                report.reconciled
            );
            assert!(report.reconciled);
            assert_eq!(report.recovered_outputs, 3);
            assert_eq!(report.recovered_sum.map(Zatoshi::as_u64), Some(60_000));
            reconciling.push(account);
        }
    }
    assert_eq!(
        reconciling.len(),
        1,
        "exactly one campaign account opens the batch"
    );
}

// ---------------------------------------------------------------------------
// The command, as a process
// ---------------------------------------------------------------------------

fn operator() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_drop-operator"));
    command.env_remove("ZECDROP_PASSPHRASE");
    command
}

fn run(mut command: Command, stdin: Option<&str>) -> Output {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    {
        let mut pipe = child.stdin.take().unwrap();
        if let Some(text) = stdin {
            let _ = pipe.write_all(text.as_bytes());
        }
    }
    child.wait_with_output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn files(dir: &Path, case: &Case) -> (PathBuf, PathBuf) {
    (
        write(dir, "tx.hex", &hex::encode(&case.raw)),
        write(
            dir,
            "prevouts.json",
            &serde_json::to_string(&case.prevouts_json()).unwrap(),
        ),
    )
}

impl Case {
    fn prevouts_json(&self) -> serde_json::Value {
        self.prevouts
            .iter()
            .map(|p| {
                serde_json::json!({
                    "txid": p.txid, "index": p.index,
                    "value_zat": p.value_zat, "script_pubkey_hex": p.script_pubkey_hex
                })
            })
            .collect()
    }
}

fn seed_file(dir: &Path) -> PathBuf {
    let path = dir.join("dev.seed");
    std::fs::write(&path, format!("{}\n", hex::encode(TEST_SEED))).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path
}

// covers: REQ-AUD-001
#[test]
fn the_command_reports_on_stdout_takes_the_key_on_stdin_and_exits_by_the_verdict() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, prevouts) = files(dir.path(), three());
    let key = ufvk_of(0);
    let command = |extra: &[&str]| {
        let mut c = operator();
        c.arg("audit-tx")
            .arg("--tx")
            .arg(&tx)
            .arg("--prevouts")
            .arg(&prevouts)
            .args(extra);
        c
    };

    let ok = run(command(&["--ufvk-stdin"]), Some(&key));
    assert_eq!(ok.status.code(), Some(0), "{}", text(&ok.stderr));
    let out = text(&ok.stdout);
    assert!(out.contains("RESULT: reconciled"), "{out}");
    assert!(!out.contains(&key[..40]) && text(&ok.stderr).is_empty());

    // The wrong campaign's key: a completed audit that found differences exits 2.
    let wrong = run(command(&["--ufvk-stdin"]), Some(&ufvk_of(1)));
    assert_eq!(wrong.status.code(), Some(2));
    assert!(text(&wrong.stdout).contains("NOT reconciled"));

    // JSON.
    let json = run(command(&["--ufvk-stdin", "--json"]), Some(&key));
    let parsed: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(parsed["reconciled"], true);
    assert_eq!(parsed["recovered_outputs"], 3);

    // From a key file.
    let key_file = write(dir.path(), "k.ufvk", &format!("{key}\n"));
    let from_file = run(command(&["--ufvk-file", key_file.to_str().unwrap()]), None);
    assert_eq!(from_file.status.code(), Some(0));
}

// covers: REQ-AUD-001, REQ-SEC-001
#[test]
fn the_key_can_be_derived_from_a_development_seed_without_being_printed() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, prevouts) = files(dir.path(), three());
    let seed = seed_file(dir.path());
    let command = |account: &str| {
        let mut c = operator();
        c.arg("--seed-file")
            .arg(&seed)
            .arg("audit-tx")
            .arg("--tx")
            .arg(&tx)
            .arg("--prevouts")
            .arg(&prevouts)
            .args(["--account", account]);
        c
    };
    let ok = run(command("0"), None);
    assert_eq!(ok.status.code(), Some(0), "{}", text(&ok.stderr));
    let other = run(command("1"), None);
    assert_eq!(other.status.code(), Some(2));
    for output in [&ok, &other] {
        let all = format!("{}{}", text(&output.stdout), text(&output.stderr));
        assert!(!all.contains(&hex::encode(TEST_SEED)), "{all}");
        assert!(!all.contains("uview"), "{all}");
        assert!(!all.contains(&ufvk_of(0)[..30]) && !all.contains(&ufvk_of(1)[..30]));
    }

    // Without a seed file there is nothing to derive from; on mainnet it is refused.
    let mut no_seed = operator();
    no_seed
        .arg("audit-tx")
        .arg("--tx")
        .arg(&tx)
        .arg("--prevouts")
        .arg(&prevouts)
        .args(["--account", "0"]);
    let refused = run(no_seed, None);
    assert_eq!(refused.status.code(), Some(1));
    assert!(text(&refused.stderr).contains("--seed-file"));
    let mut mainnet = command("0");
    mainnet.args(["--network", "mainnet"]);
    let refused = run(mainnet, None);
    assert_eq!(refused.status.code(), Some(1));
    assert!(refused.stdout.is_empty());
    // Even with mainnet fully confirmed, a key is never derived from a seed file there.
    let mut confirmed = command("0");
    confirmed
        .args(["--network", "mainnet", "--allow-mainnet"])
        .env("ZECDROP_CONFIRM_MAINNET", "I-UNDERSTAND");
    let refused = run(confirmed, None);
    assert_eq!(refused.status.code(), Some(1));
    assert!(refused.stdout.is_empty());
    assert!(
        text(&refused.stderr).contains("testnet only"),
        "{}",
        text(&refused.stderr)
    );
}

// covers: REQ-AUD-001
#[test]
fn the_command_needs_exactly_one_key_source_and_takes_no_key_as_an_argument() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, prevouts) = files(dir.path(), three());
    let key = ufvk_of(0);
    let base = || {
        let mut c = operator();
        c.arg("audit-tx")
            .arg("--tx")
            .arg(&tx)
            .arg("--prevouts")
            .arg(&prevouts);
        c
    };
    // Usage errors exit 2 before anything is read.
    let mut none = base();
    none.stdin(Stdio::null());
    assert_eq!(run(none, None).status.code(), Some(2));
    let mut two = base();
    two.args(["--ufvk-stdin", "--account", "0"]);
    assert_eq!(run(two, None).status.code(), Some(2));
    let mut argv = base();
    argv.args(["--ufvk", &key]);
    let refused = run(argv, None);
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());

    // A key that is not a key, and a damaged transaction file, fail without quoting either.
    let junk = run(
        {
            let mut c = base();
            c.arg("--ufvk-stdin");
            c
        },
        Some("SECRETMARKER not a key"),
    );
    assert_eq!(junk.status.code(), Some(1));
    assert!(!text(&junk.stderr).contains("SECRETMARKER"));
    let bad_tx = write(dir.path(), "bad.hex", "SECRETMARKER");
    let mut broken = operator();
    broken
        .arg("audit-tx")
        .arg("--tx")
        .arg(&bad_tx)
        .arg("--prevouts")
        .arg(&prevouts)
        .arg("--ufvk-stdin");
    let failed = run(broken, Some(&key));
    assert_eq!(failed.status.code(), Some(1));
    let shown = format!("{}{}", text(&failed.stdout), text(&failed.stderr));
    assert!(
        !shown.contains("SECRETMARKER") && !shown.contains(&key[..40]),
        "{shown}"
    );
}
