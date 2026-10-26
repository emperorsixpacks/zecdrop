//! A by-hand run of a payout's shielded deposit address on public testnet: Checkpoint A of
//! docs/ADR/0006-shielded-inbox.md. It drives the operator's own inbox modules (setup, the wallet's database, the
//! zcash-devtool driver, the check every inbox transaction must pass) and broadcasts through drop-chain. It never prints a
//! secret: no phrase, no identity, no viewing key.
//!
//! ```text
//! cargo run -p drop-operator --example inbox_spike -- <seed-file> <state-dir> setup  <account>
//! cargo run -p drop-operator --example inbox_spike -- <seed-file> <state-dir> status <account>
//! cargo run -p drop-operator --example inbox_spike -- <seed-file> <state-dir> move   <account> <funding-address> <zatoshi>
//! ```
//!
//! `ZECDROP_DEVTOOL` names the zcash-devtool binary (default `target/zcash-devtool/zcash-devtool`), `ZECDROP_LWD` the light
//! wallet server (default `https://testnet.zec.rocks:443`). Testnet only.

use std::{
    error::Error,
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

use drop_chain::{ChainConfig, LightwalletdSource};
use drop_core::Network;
use drop_operator::{
    inbox::{
        devtool::Devtool,
        keys::{age_identity, InboxPhrase},
        setup,
        walletdb::{NoteSpend, WalletDb},
    },
    seedfile::read_seed_file,
};
use drop_zcash::{inbox::InboxTxContext, zcash_network, InboxKeys};

/// Notes from outside need this many confirmations before zcash-devtool spends them (its default policy).
const SPENDABLE_AFTER: u32 = 10;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        return Err("usage: inbox_spike <seed-file> <state-dir> setup|status|move <account> [funding-address zatoshi]".into());
    }
    let seed = read_seed_file(Path::new(&args[0]))?;
    let network = Network::Testnet;
    let root = PathBuf::from(&args[1])
        .join("inbox")
        .join(seed.fingerprint());
    let account: u32 = args[3].parse()?;
    let bin = std::env::var("ZECDROP_DEVTOOL")
        .unwrap_or_else(|_| "target/zcash-devtool/zcash-devtool".into());
    let lwd =
        std::env::var("ZECDROP_LWD").unwrap_or_else(|_| "https://testnet.zec.rocks:443".into());
    let server = lwd.trim_start_matches("https://").to_owned();
    let devtool = Devtool::new(PathBuf::from(bin), server, network);
    devtool.check_patched().await?;
    let (chain, info) = LightwalletdSource::connect(&ChainConfig::new(lwd, network)).await?;
    println!(
        "node tip {} branch {:08x}",
        info.tip_height, info.consensus_branch_id
    );

    let phrase = InboxPhrase::derive(&seed, network, account)?;
    let keys = InboxKeys::derive(phrase.wallet_seed(), zcash_network(network))?;
    drop(phrase);
    let dir = setup::wallet_dir(&root, account);

    match args[2].as_str() {
        "setup" => {
            setup::sweep_leftovers(&root);
            let birthday = info.tip_height.saturating_sub(10);
            let wallet = setup::set_up(&devtool, &seed, network, account, &root, birthday).await?;
            println!("inbox of account {account} set up and checked, scanning from {birthday}");
            println!("address {}", wallet.address);
        }
        "status" => {
            devtool.sync(&dir).await?;
            let db = WalletDb::of(&dir);
            let tip = db.scanned_tip()?.unwrap_or(0);
            println!("wallet scanned to {tip} (node {})", info.tip_height);
            for note in db.ironwood_notes()? {
                println!(
                    "  note {} zat, {} confirmations, change {}, {:?}",
                    note.value,
                    note.confirmations(tip),
                    note.is_change,
                    note.spend
                );
            }
            let orchard = db.unspent_orchard_value()?;
            if orchard > 0 {
                println!("  Orchard notes (not usable by a move): {orchard} zat");
            }
        }
        "move" => {
            let funding_address = args
                .get(4)
                .ok_or("move needs <funding-address> <zatoshi>")?;
            let value: u64 = args.get(5).ok_or("move needs <zatoshi>")?.parse()?;
            devtool.sync(&dir).await?;
            let db = WalletDb::of(&dir);
            let wallet_tip = db
                .scanned_tip()?
                .ok_or("the wallet has not scanned anything")?;
            if info.tip_height.saturating_sub(wallet_tip) > 2 {
                return Err(format!(
                    "the wallet is at {wallet_tip}, more than 2 blocks behind the node"
                )
                .into());
            }
            let account_uuid = db.account()?.ok_or("no account")?.uuid;
            let notes: Vec<([u8; 32], u64)> = db
                .ironwood_notes()?
                .into_iter()
                .filter(|n| {
                    n.spend == NoteSpend::Unspent && n.confirmations(wallet_tip) >= SPENDABLE_AFTER
                })
                .filter_map(|n| n.nullifier.map(|nf| (nf, n.value)))
                .collect();
            println!(
                "{} spendable note(s), {} zat",
                notes.len(),
                notes.iter().map(|n| n.1).sum::<u64>()
            );

            let scratch = dir.join("zecdrop-pczt");
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&scratch)?;
            let step = |name: &str| scratch.join(name);
            devtool
                .create(
                    &dir,
                    &account_uuid,
                    funding_address,
                    value,
                    &step("created.pczt"),
                )
                .await?;
            devtool
                .prove(&dir, &step("created.pczt"), &step("proven.pczt"))
                .await?;
            let identity = age_identity(&seed, network)?;
            devtool
                .sign(&dir, &identity, &step("created.pczt"), &step("signed.pczt"))
                .await?;
            drop(identity);
            devtool
                .combine(
                    &dir,
                    &step("proven.pczt"),
                    &step("signed.pczt"),
                    &step("final.pczt"),
                )
                .await?;
            let txid = devtool
                .extract(&step("final.pczt"), &step("tx.bin"))
                .await?;
            let raw = fs::read(step("tx.bin"))?;
            let context = InboxTxContext {
                branch_id: info.consensus_branch_id,
                tip: info.tip_height,
                notes: &notes,
            };
            let facts = keys.check_move(&raw, funding_address, value, &context);
            let _ = fs::remove_dir_all(&scratch);
            let facts = facts.map_err(|problem| format!("REFUSED, not broadcast: {problem}"))?;
            if facts.txid != txid {
                return Err("the checked transaction is not the one zcash-devtool reported".into());
            }
            println!(
                "checked {}: spends {} zat of the inbox, pays {value} to the funding address, fee {}, change {}, expires at {}",
                facts.txid, facts.spent, facts.fee, facts.change, facts.expiry_height
            );
            let outcome = chain
                .broadcast(&raw)
                .await
                .map_err(|e| format!("broadcast: {e:?}"))?;
            println!("broadcast: {outcome:?}");
            let keep = PathBuf::from(&args[1]).join(format!("inbox-move-{}.hex", facts.txid));
            fs::write(&keep, hex::encode(&raw))?;
            println!("raw move kept at {}", keep.display());
        }
        other => return Err(format!("unknown command {other}").into()),
    }
    Ok(())
}
