//! The real `drop-operator` binary, run as a process: what its subcommands print, where they
//! print it, and that the viewing key and the wallet seed never go anywhere else.
//!
//! The store is an ordinary one made by the in-process harness (cheap key derivation); the
//! seed files hold the TEST-ONLY seed.

#![cfg(unix)]

mod common;

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use common::zcash::*;
use common::*;
use drop_core::CampaignId;
use drop_operator::commands::DISCLOSURE_WARNING;
use drop_zcash::CampaignKeys;

fn ufvk_of(account: u32) -> String {
    CampaignKeys::derive(&TEST_SEED, NETWORK, account)
        .unwrap()
        .ufvk_encoded()
        .unwrap()
}

/// A seed file the way the operator wants it: hex, owner-only.
fn seed_file(dir: &Path, name: &str, seed: &[u8; 32]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("{}\n", hex::encode(seed))).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path
}

fn operator() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_drop-operator"));
    command
        .env("ZECDROP_PASSPHRASE", PASSPHRASE)
        .env_remove("ZECDROP_CONFIRM_MAINNET");
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
            // The child may exit before reading; that is not the test's concern.
            let _ = pipe.write_all(text.as_bytes());
        }
    }
    child.wait_with_output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A store with one real-backend campaign (account 0), and the seed file that made it.
async fn store_with_campaign(h: &Harness) -> (CampaignId, PathBuf) {
    let reply = h
        .post(
            "/api/campaigns",
            serde_json::json!({
                "name": "CLI drop",
                "csv": format!("address,amount,memo\n{},1.5,hello\n", recipient_ua(0)),
                "max_outputs_per_batch": 5,
                "fee_policy": "zip317_text",
            }),
        )
        .await;
    assert_eq!(
        reply.status,
        axum::http::StatusCode::CREATED,
        "{}",
        reply.text()
    );
    let id = CampaignId::new(reply.json()["id"].as_str().unwrap()).unwrap();
    let seed = seed_file(h.dir.path(), "testnet.seed", &TEST_SEED);
    (id, seed)
}

// covers: REQ-AUD-001, REQ-SEC-001
#[tokio::test]
async fn export_ufvk_prints_the_key_alone_on_stdout_and_the_warning_on_stderr() {
    let h = real_harness(&SharedNode::default(), 3);
    let (id, seed) = store_with_campaign(&h).await;
    let id = id.to_string();
    let key = ufvk_of(0);
    let base = |extra: &[&str]| {
        let mut command = operator();
        command
            .args(["--db", h.db.to_str().unwrap(), "--seed-file"])
            .arg(&seed)
            .args(["export-ufvk", "--campaign", &id])
            .args(extra);
        command
    };

    // Without the acknowledgement: refused, nothing on stdout, and no key anywhere.
    let refused = run(base(&[]), None);
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty(), "{}", text(&refused.stdout));
    let stderr = text(&refused.stderr);
    assert!(stderr.contains("cannot be undone"), "{stderr}");
    assert!(!stderr.contains(&key[..40]));

    // With it: the key, a newline, nothing else; the warning goes to the other stream.
    let ok = run(base(&["--i-understand-this-is-irreversible"]), None);
    assert!(ok.status.success(), "{}", text(&ok.stderr));
    assert_eq!(text(&ok.stdout), format!("{key}\n"));
    let stderr = text(&ok.stderr);
    assert!(stderr.contains(DISCLOSURE_WARNING), "{stderr}");
    assert!(!stderr.contains(&key[..40]), "the key is not on stderr");
}

// covers: REQ-SEC-001, REQ-AUD-002
#[tokio::test]
async fn export_ufvk_with_another_seed_file_prints_no_key() {
    let h = real_harness(&SharedNode::default(), 3);
    let (id, _) = store_with_campaign(&h).await;
    let stranger = seed_file(h.dir.path(), "other.seed", &[0x99; 32]);
    let mut command = operator();
    command
        .args(["--db", h.db.to_str().unwrap(), "--seed-file"])
        .arg(&stranger)
        .args(["export-ufvk", "--campaign", &id.to_string()])
        .arg("--i-understand-this-is-irreversible");
    let output = run(command, None);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty(), "no key on stdout");
    let stderr = text(&output.stderr);
    assert!(stderr.contains("different wallet seed"), "{stderr}");
    assert!(!stderr.contains("uview"));
    assert!(!stderr.contains(&hex::encode([0x99u8; 32])));
}

// covers: REQ-SEC-001
#[tokio::test]
async fn a_seed_file_that_others_can_read_is_refused_and_not_quoted() {
    let h = real_harness(&SharedNode::default(), 3);
    let (id, seed) = store_with_campaign(&h).await;
    std::fs::set_permissions(&seed, std::fs::Permissions::from_mode(0o644)).unwrap();
    let mut command = operator();
    command
        .args(["--db", h.db.to_str().unwrap(), "--seed-file"])
        .arg(&seed)
        .args(["export-ufvk", "--campaign", &id.to_string()])
        .arg("--i-understand-this-is-irreversible");
    let output = run(command, None);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let all = format!("{}{}", text(&output.stdout), text(&output.stderr));
    assert!(!all.contains(&hex::encode(TEST_SEED)), "{all}");
}

// covers: REQ-AUD-001
#[tokio::test]
async fn audit_refuses_to_run_without_a_chain_and_never_repeats_the_key() {
    let h = real_harness(&SharedNode::default(), 3);
    let (id, seed) = store_with_campaign(&h).await;
    let key = ufvk_of(0);

    let mut command = operator();
    command
        .args(["--db", h.db.to_str().unwrap(), "--seed-file"])
        .arg(&seed)
        .args(["audit", "--campaign", &id.to_string(), "--ufvk-stdin"]);
    let output = run(command, Some(&key));
    assert!(!output.status.success());
    let (stdout, stderr) = (text(&output.stdout), text(&output.stderr));
    assert!(stderr.contains("--lightwalletd-url"), "{stderr}");
    for stream in [&stdout, &stderr] {
        assert!(
            !stream.contains(&key[..40]),
            "the key was repeated: {stream}"
        );
    }

    // A node that is not there: the failure names no key either.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let mut command = operator();
    command
        .args(["--db", h.db.to_str().unwrap(), "--lightwalletd-url"])
        .arg(format!("http://127.0.0.1:{closed}"))
        .args(["audit", "--campaign", &id.to_string(), "--ufvk-stdin"]);
    let output = run(command, Some(&key));
    assert!(!output.status.success());
    for stream in [text(&output.stdout), text(&output.stderr)] {
        assert!(
            !stream.contains(&key[..40]),
            "the key was repeated: {stream}"
        );
    }
}

// covers: REQ-AUD-001
#[test]
fn audit_help_shows_the_pipe_that_keeps_the_key_off_the_screen() {
    let mut command = operator();
    command.args(["audit", "--help"]);
    let output = run(command, None);
    assert!(output.status.success());
    let help = text(&output.stdout);
    for part in [
        "export-ufvk --campaign ID --i-understand-this-is-irreversible",
        "| drop-operator FLAGS audit --campaign ID --ufvk-stdin --receipt-commitment HEX",
        "--lightwalletd-url",
        "--state-dir",
        "does not
split a variable",
        "never printed",
    ] {
        assert!(help.contains(part), "{part:?} missing from:\n{help}");
    }
    // The recipe puts no key anywhere: nothing in it looks like one.
    assert!(!help.contains("uview"));
}

// covers: REQ-AUD-001
#[tokio::test]
async fn a_key_on_the_command_line_is_rejected_by_the_binary() {
    let h = real_harness(&SharedNode::default(), 3);
    let (id, _) = store_with_campaign(&h).await;
    let key = ufvk_of(0);
    let mut command = operator();
    command
        .args(["--db", h.db.to_str().unwrap()])
        .args(["audit", "--campaign", &id.to_string(), "--ufvk"])
        .arg(&key);
    let output = run(command, None);
    assert_eq!(output.status.code(), Some(2), "a usage error");
    assert!(output.stdout.is_empty());
}

// covers: REQ-OPS-001
#[tokio::test]
async fn the_tools_obey_the_mainnet_gate() {
    let h = real_harness(&SharedNode::default(), 3);
    let (id, seed) = store_with_campaign(&h).await;
    let mut command = operator();
    command
        .args([
            "--db",
            h.db.to_str().unwrap(),
            "--network",
            "mainnet",
            "--seed-file",
        ])
        .arg(&seed)
        .args(["export-ufvk", "--campaign", &id.to_string()])
        .arg("--i-understand-this-is-irreversible");
    let output = run(command, None);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

// covers: REQ-SEC-001, REQ-SEC-002
#[test]
fn init_wallet_creates_the_seed_and_prints_nothing_secret() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("wallet.sqlite");
    let mut command = operator();
    command.args(["--db", db.to_str().unwrap(), "init-wallet"]);
    let output = run(command, None);
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(db.exists());

    // What it created is a seed in the store; none of it was printed.
    let store = drop_operator::store::Store::open(&db, PASSPHRASE).unwrap();
    let seed = store.load_seed().unwrap().expect("a seed was stored");
    let hex_seed = hex::encode(seed.expose_secret());
    let printed = format!("{}{}", text(&output.stdout), text(&output.stderr));
    assert!(!printed.contains(&hex_seed), "{printed}");
    assert!(
        !printed
            .split(|c: char| !c.is_ascii_hexdigit())
            .any(|run| run.len() >= 32),
        "no long hex string is printed: {printed}"
    );
    // The file is encrypted: the raw seed bytes are not in it.
    let bytes = std::fs::read(&db).unwrap();
    assert!(!bytes
        .windows(32)
        .any(|window| window == seed.expose_secret()));

    // Running it again changes nothing.
    let mut command = operator();
    command.args(["--db", db.to_str().unwrap(), "init-wallet"]);
    let again = run(command, None);
    assert!(again.status.success());
    assert!(text(&again.stdout).contains("already initialised"));
    let store = drop_operator::store::Store::open(&db, PASSPHRASE).unwrap();
    assert_eq!(
        store.load_seed().unwrap().unwrap().expose_secret(),
        seed.expose_secret()
    );
}
