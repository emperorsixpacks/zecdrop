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

fn deploy_file(name: &str) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../deploy")
            .join(name),
    )
    .unwrap()
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

// covers: REQ-RUN-001
#[test]
fn it_is_published_on_no_other_address_and_keeps_to_a_network_of_its_own() {
    let script = script();
    // Not the host's network, and no port published on every address.
    for never in [
        "--network host",
        "--network=host",
        "--net host",
        "--net=host",
        "--publish-all",
        " -P ",
    ] {
        assert!(!script.contains(never), "{never}");
    }
    // The operator's container is alone on a network of its own; making the wallet uses none.
    assert!(script.contains("docker network create \"$NET\""));
    assert!(script.contains("docker run -d --name \"$NAME\" --network \"$NET\""));
    assert!(script.contains("docker run --rm --network none"));
}

// covers: REQ-RUN-001
#[test]
fn its_log_leaves_the_token_out_and_a_lost_passphrase_is_never_replaced() {
    let script = script();
    assert!(script.contains(r##"gsub(/#token=[0-9a-f]+/, "#token=(hidden: ./zecdrop open)")"##));
    // A new passphrase could not open the store: with the store there and the file gone, it stops and says so.
    assert!(script.contains("[ -f \"$DATA/zecdrop.sqlite\" ]"));
    assert!(script.contains(
        "which holds your store's passphrase, is missing or empty, but your store is there"
    ));
}

// covers: REQ-RUN-001
#[test]
fn the_image_stops_cleanly_and_its_build_sees_no_store_seed_or_env_file() {
    // The operator handles Ctrl-C; as the container's first process it would ignore SIGTERM.
    assert!(deploy_file("operator.Dockerfile").contains("\nSTOPSIGNAL SIGINT\n"));
    let ignore = deploy_file("operator.Dockerfile.dockerignore");
    for pattern in [
        "**/*.sqlite",
        "**/*.seed",
        "**/.env",
        "**/.env.*",
        ".private",
    ] {
        assert!(ignore.lines().any(|line| line == pattern), "{pattern}");
    }
}
