//! `./zecdrop`, the one command that runs the operator on your own computer (REQ-RUN-001). What it promises, checked without
//! Docker: the commands it offers, a page published on this computer's loopback address only, testnet only, and the store's
//! passphrase passed in a file, never on a command line.

use std::path::PathBuf;
use std::process::Command;

fn launcher() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../zecdrop")
}

fn script() -> String {
    std::fs::read_to_string(launcher()).unwrap()
}

// covers: REQ-RUN-001
#[test]
fn it_says_what_each_command_does() {
    let out = Command::new("bash")
        .arg(launcher())
        .arg("help")
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let text = String::from_utf8(out.stdout).unwrap();
    for command in ["up", "open", "status", "logs", "down", "update"] {
        assert!(
            text.contains(&format!("./zecdrop {command}")),
            "{command}: {text}"
        );
    }
    // Only the comment at the top: no code.
    assert!(!text.contains("set -euo"), "{text}");
}

// covers: REQ-RUN-001
#[test]
fn its_page_is_published_on_the_loopback_address_only() {
    let script = script();
    let publishes: Vec<&str> = script
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            line.starts_with("-p ")
                || line.contains("--publish")
                || (line.contains(" -p ") && line.contains("docker run"))
        })
        .collect();
    assert!(!publishes.is_empty(), "it publishes the page");
    for line in publishes {
        assert!(line.contains("-p \"127.0.0.1:"), "{line}");
    }
    // The operator listens inside the container only because it is told it runs in one.
    assert!(script.contains("--container --bind \"0.0.0.0:"));
}

// covers: REQ-RUN-001
#[test]
fn it_runs_on_testnet_and_never_puts_the_passphrase_on_a_command_line() {
    let script = script();
    for never in [
        "--allow-mainnet",
        "--network mainnet",
        "ZECDROP_CONFIRM_MAINNET",
        "-e ZECDROP_PASSPHRASE",
        "--env ZECDROP_PASSPHRASE",
    ] {
        assert!(!script.contains(never), "{never}");
    }
    assert!(script.contains("https://testnet.zec.rocks:443"));
    assert!(script.contains("--env-file \"$DATA/env\""));
    assert!(script.contains("umask 077"));
    assert!(script.contains("chmod 700 \"$DATA\""));
    assert!(script.contains("chmod 600 \"$DATA/env\""));
}
