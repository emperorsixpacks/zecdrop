//! REQ-VER-002, structurally: the hosted verifier cannot even link key types.
//!
//! Runs `cargo metadata`, walks the *normal and build* dependency edges from
//! `drop-verifier` and `drop-verify` (development-only dependencies do not ship) and
//! asserts that `zcash_keys` and anything that stores state are absent.

use std::collections::{BTreeSet, HashMap};
use std::process::Command;

use serde_json::Value;

fn host_triple() -> String {
    let output = Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into()))
        .arg("-vV")
        .output()
        .expect("run rustc -vV");
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix("host: "))
        .expect("rustc reports its host")
        .to_owned()
}

fn metadata() -> Value {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--filter-platform",
            &host_triple(),
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// Names of every package reachable from `root` over normal and build edges.
fn closure(meta: &Value, root: &str) -> BTreeSet<String> {
    let names: HashMap<&str, &str> = meta["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["id"].as_str().unwrap(), p["name"].as_str().unwrap()))
        .collect();
    let nodes: HashMap<&str, &Value> = meta["resolve"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n["id"].as_str().unwrap(), n))
        .collect();
    let start = names
        .iter()
        .find(|(_, name)| **name == root)
        .map(|(id, _)| *id)
        .unwrap_or_else(|| panic!("{root} is not in the workspace"));

    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut stack = vec![start];
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        for dep in nodes[id]["deps"].as_array().unwrap() {
            let ships = dep["dep_kinds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["kind"].is_null() || k["kind"] == "build");
            if ships {
                stack.push(dep["pkg"].as_str().unwrap());
            }
        }
    }
    seen.into_iter().map(|id| names[id].to_owned()).collect()
}

// covers: REQ-VER-002
#[test]
fn neither_the_verifier_nor_the_verification_library_can_link_key_types_or_storage() {
    let meta = metadata();
    for root in ["drop-verifier", "drop-verify", "drop-chain"] {
        let deps = closure(&meta, root);
        // The traversal reaches deep: these prove it is not vacuous.
        assert!(deps.contains("zcash_primitives"), "{root}: {deps:?}");
        assert!(
            deps.contains("orchard"),
            "{root}: traversal did not go deep"
        );
        for forbidden in [
            "zcash_keys",
            "zcash_client_backend",
            "zcash_client_sqlite",
            "bip0039",
            "rusqlite",
            "sqlx",
            "diesel",
        ] {
            assert!(
                !deps.contains(forbidden),
                "{root} must not depend on {forbidden} (REQ-VER-002)"
            );
        }
    }
    let verifier = closure(&meta, "drop-verifier");
    assert!(verifier.contains("drop-verify") && verifier.contains("drop-chain"));
    assert!(verifier.contains("axum"));
}

// covers: REQ-VER-002
#[test]
fn the_walk_finds_storage_and_key_crates_where_they_exist() {
    // Controls: the same walk must see what it is looking for in crates that have it,
    // otherwise "absent" above would prove nothing.
    let meta = metadata();
    assert!(
        closure(&meta, "drop-operator").contains("rusqlite"),
        "the operator stores data, so the walk must see its database"
    );
    // The Zcash adapter is where key handling lives, and it is the key-crate control. If it
    // ever stops depending on `zcash_keys` this check is moot, so it is conditional.
    let has_adapter = meta["packages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["name"] == "drop-zcash");
    if has_adapter {
        let adapter = closure(&meta, "drop-zcash");
        if adapter.contains("zcash_keys") {
            assert!(
                !closure(&meta, "drop-verifier").contains("zcash_keys"),
                "same workspace, same lockfile, and the verifier is still free of it"
            );
        }
    }
}
