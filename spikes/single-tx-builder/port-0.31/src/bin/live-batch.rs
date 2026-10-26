//! TESTNET ONLY: build one V6 batch (transparent -> 3 Ironwood outputs + transparent change) from
//! the dev seed's campaign account, broadcast it through lightwalletd/Zaino, wait until it is
//! mined, then re-fetch it and check it from chain data.
//!
//! Usage:
//!   live-batch info                     server, tip, campaign UTXOs
//!   live-batch probe                    which GetTransaction txid byte order the server expects
//!   live-batch dry-run [--fabricate]    build with the real anchor + UTXOs, print, do NOT broadcast
//!                                       (--fabricate: use a fake coin when the address is unfunded)
//!   live-batch send                     build, persist, broadcast, wait, verify, write fixture
//!   live-batch verify <txid>            re-fetch a mined batch, verify, write fixture
//!   live-batch resend <txid>            re-send the stored bytes once; print the node's reply verbatim
//!   live-batch sweep [--send]           move ALL change-address coins back to the funding address
//!                                       (drop-zcash `build_sweep`); dry run unless --send
//! Env: ZECDROP_LWD (default below), ZECDROP_PAYOUTS="10000,20000,30000" (zatoshis),
//!      ZECDROP_WAIT_MINS (default 60).
//!
//! It prints the dev recipients' decrypted amounts and memos: these are throwaway testnet
//! accounts of the dev seed. Product code must never print recipient data (AGENTS.md).

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use single_tx_builder_port031::{
    build_payout_tx, decrypt_as_recipient, devseed, lwd, orchard_receiver, public_view,
    recover_as_auditor, verify_authorization, warm_proving_key, Campaign, FundingCoin, Payout,
    Pool, Recipient, TxPlan,
};
use zcash_keys::address::Address;
use zcash_primitives::transaction::TxId;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, TEST_NETWORK},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zcash_transparent::bundle::{OutPoint, TxOut};
use zip32::AccountId;

/// Verified with `live-batch info` (GetLightdInfo) on 2026-10-07; see RESULTS.md.
const DEFAULT_LWD: &str = "https://testnet.zec.rocks:443";
const DEFAULT_PAYOUTS: &str = "10000,20000,30000";
/// First account of the demo recipient range.
const DEMO_ACCOUNT_BASE: u32 = 9000;
const FIXTURE_ROOT: &str = "/Users/ram/Desktop/zecdrop/fixtures/testnet-ironwood-batch";

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("info");
    if !matches!(
        cmd,
        "info"
            | "probe"
            | "treestate"
            | "dry-run"
            | "send"
            | "verify"
            | "resend"
            | "sweep"
            | "raw"
            | "fixture"
    ) {
        return Err(format!(
            "unknown command '{cmd}' (info | probe | dry-run [--fabricate] | send | verify <txid> | raw <txid> | fixture <txid> <root>)"
        ));
    }
    if cmd == "fixture" {
        // Key-less: captures a mined batch's public data under <root>/<txid>/ (tx.hex,
        // prevouts.json, expected.json, funding-tx.hex). Runs before the dev seed is loaded.
        let txid = parse_txid(args.get(1).ok_or("fixture needs a txid")?)?;
        let root = PathBuf::from(args.get(2).ok_or("fixture needs a root directory")?);
        let url = std::env::var("ZECDROP_LWD").unwrap_or_else(|_| DEFAULT_LWD.to_string());
        let mut client = lwd::connect(&url).await?;
        return capture_fixture(&mut client, &txid, &root).await;
    }
    if cmd == "raw" {
        // Key-less: prints one transaction's public raw bytes (hex) and nothing else on stdout,
        // so a fixture can be captured with a redirect. Runs before the dev seed is loaded.
        let txid = parse_txid(args.get(1).ok_or("raw needs a txid")?)?;
        let url = std::env::var("ZECDROP_LWD").unwrap_or_else(|_| DEFAULT_LWD.to_string());
        let mut client = lwd::connect(&url).await?;
        let fetched = lwd::get_tx(&mut client, &txid).await?;
        eprintln!(
            "{txid}: {} bytes, mined_height {:?}",
            fetched.bytes.len(),
            fetched.mined_height
        );
        println!("{}", hex::encode(&fetched.bytes));
        return Ok(());
    }

    let seed =
        devseed::load().map_err(|e| format!("dev seed: {e} (run gen-testnet-wallet first)"))?;
    let campaign = Campaign::from_seed(seed.as_bytes(), AccountId::ZERO);
    // Demo recipients 1-3 = ZIP 32 accounts 9000..9002 (the demo range; see examples/README.md),
    // so drop-zcash's `recipient_view` example can show each recipient's side.
    let recipients: Vec<Recipient> = (DEMO_ACCOUNT_BASE..DEMO_ACCOUNT_BASE + 3)
        .map(|i| {
            Recipient::from_seed(
                seed.as_bytes(),
                AccountId::try_from(i).expect("valid account"),
            )
        })
        .collect();
    // The product crate's keys for the same account (used by `sweep`); must match the spike's.
    let product_keys = drop_zcash::CampaignKeys::derive(
        seed.as_bytes(),
        zcash_protocol::consensus::Network::TestNetwork,
        0,
    )
    .map_err(|e| e.to_string())?;
    drop(seed);

    let url = std::env::var("ZECDROP_LWD").unwrap_or_else(|_| DEFAULT_LWD.to_string());
    let mut client = lwd::connect(&url).await?;
    let info = lwd::testnet_info(&mut client).await?;
    let tip = lwd::tip_height(&mut client).await?;
    println!(
        "server {url}: vendor={:?} version={} chain={} tip={tip} branch={}",
        info.vendor, info.version, info.chain_name, info.consensus_branch_id
    );
    let target = BlockHeight::from_u32(tip + 1);
    let branch = BranchId::for_height(&TEST_NETWORK, target);
    let ours = format!("{:08x}", u32::from(branch));
    if !ours.eq_ignore_ascii_case(&info.consensus_branch_id) {
        return Err(format!(
            "branch mismatch: our crates give {branch:?} ({ours}) for height {target}, server reports {}",
            info.consensus_branch_id
        ));
    }

    let funding = Address::from(campaign.funding_addr).encode(&TEST_NETWORK);
    let change = Address::from(campaign.change_addr).encode(&TEST_NETWORK);
    let coins = lwd::utxos(&mut client, &[funding.clone(), change.clone()]).await?;
    let balance: u64 = coins.iter().map(|c| u64::from(c.coin.value())).sum();
    println!(
        "campaign funding {funding} + change {change}: {} UTXOs, {balance} zat",
        coins.len()
    );

    match cmd {
        "info" => Ok(()),
        "treestate" => {
            // Public chain data, for drop-zcash's tree-state parser test.
            let h = args
                .get(1)
                .map(|h| h.parse::<u32>().map_err(|e| e.to_string()))
                .transpose()?
                .unwrap_or(tip);
            let state = client
                .get_tree_state(zcash_client_backend::proto::service::BlockId {
                    height: h.into(),
                    hash: vec![],
                })
                .await
                .map_err(|e| e.to_string())?
                .into_inner();
            let root = state.ironwood_tree().map_err(|e| e.to_string())?.root();
            println!("height {} hash {}", state.height, state.hash);
            println!("ironwood_tree_hex {}", state.ironwood_tree);
            println!(
                "ironwood_root_hex {}",
                hex::encode(orchard::Anchor::from(root).to_bytes())
            );
            Ok(())
        }
        "probe" => {
            println!(
                "GetTransaction byte order: {}",
                lwd::probe_txid_order(&mut client, tip).await?
            );
            Ok(())
        }
        "resend" => {
            // Re-sends the persisted bytes of an already-broadcast tx ONCE and prints the node's
            // verbatim reply (to record the exact "already known" wording).
            let txid = parse_txid(args.get(1).ok_or("resend needs a txid")?)?;
            let hex_bytes =
                std::fs::read_to_string(pending_path(&txid)?).map_err(|e| e.to_string())?;
            let raw = hex::decode(hex_bytes.trim()).map_err(|e| e.to_string())?;
            match lwd::send(&mut client, &raw).await {
                Ok(msg) => println!("re-send ACCEPTED (error_code 0): {msg:?}"),
                Err(e) => println!("re-send reply: {e}"),
            }
            Ok(())
        }
        "sweep" => {
            if product_keys.funding_address() != funding || product_keys.change_address() != change
            {
                return Err("drop-zcash and the spike derive different campaign addresses".into());
            }
            let send = args.iter().any(|a| a == "--send");
            sweep(&mut client, &url, &product_keys, tip, send).await
        }
        "verify" => {
            let txid = parse_txid(args.get(1).ok_or("verify needs a txid")?)?;
            verify_on_chain(&mut client, &campaign, &recipients, &txid).await
        }
        _ => {
            let dry_run = cmd == "dry-run";
            let inputs = if dry_run && args.iter().any(|a| a == "--fabricate") {
                println!("--fabricate: using a FAKE funding coin (dry run only)");
                vec![FundingCoin {
                    outpoint: OutPoint::new([0xfe; 32], 0),
                    coin: TxOut::new(
                        Zatoshis::const_from_u64(1_000_000),
                        campaign.funding_addr.script().into(),
                    ),
                }]
            } else {
                coins
            };
            if inputs.is_empty() {
                return Err(format!("no UTXOs: fund the transparent address {funding} (gen-testnet-wallet), then retry"));
            }
            build_and_maybe_send(&mut client, &campaign, &recipients, tip, inputs, dry_run).await
        }
    }
}

async fn build_and_maybe_send(
    client: &mut lwd::Client,
    campaign: &Campaign,
    recipients: &[Recipient],
    tip: u32,
    inputs: Vec<FundingCoin>,
    dry_run: bool,
) -> Result<(), String> {
    let values: Vec<u64> = std::env::var("ZECDROP_PAYOUTS")
        .unwrap_or_else(|_| DEFAULT_PAYOUTS.to_string())
        .split(',')
        .map(|v| {
            v.trim()
                .parse::<u64>()
                .map_err(|e| format!("ZECDROP_PAYOUTS: {e}"))
        })
        .collect::<Result<_, _>>()?;
    if values.len() != recipients.len() {
        return Err(format!("ZECDROP_PAYOUTS needs {} values", recipients.len()));
    }
    let n = recipients.len();
    let mut payouts = Vec::with_capacity(n);
    for (i, (r, v)) in recipients.iter().zip(&values).enumerate() {
        let text = format!(
            "ZecDrop testnet batch | payout {} of {n} | dev recipient",
            i + 1
        );
        payouts.push(Payout {
            address: orchard_receiver(&r.unified_address)?,
            value: Zatoshis::from_u64(*v).map_err(|e| format!("{e:?}"))?,
            memo: MemoBytes::from(&text.parse::<Memo>().map_err(|e| format!("{e:?}"))?),
        });
    }

    // Anchor at the current tip: a known Ironwood root, as consensus requires.
    let anchor = lwd::ironwood_anchor(client, tip).await?;
    let target = BlockHeight::from_u32(tip + 1);
    println!("proving key built in {:.2?}", warm_proving_key(target));

    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
    let mut rng = ChaCha20Rng::from_seed(seed);
    let plan = TxPlan {
        pool: Pool::Ironwood,
        target_height: target,
        anchor,
        inputs: &inputs,
        payouts: &payouts,
        ovk: Some(campaign.payout_ovk()),
    };
    let tx = build_payout_tx(campaign, &plan, &mut rng)?;

    println!(
        "target height {target} (tip {tip} + 1), Ironwood anchor {} (GetTreeState at {tip})",
        hex::encode(anchor.to_bytes())
    );
    for c in &inputs {
        println!(
            "  input  {}:{} = {} zat",
            c.outpoint.txid(),
            c.outpoint.n(),
            u64::from(c.coin.value())
        );
    }
    for (i, p) in payouts.iter().enumerate() {
        println!(
            "  output demo recipient {} (account {}) = {} zat, Ironwood, campaign OVK",
            i + 1,
            DEMO_ACCOUNT_BASE + i as u32,
            u64::from(p.value)
        );
    }
    println!(
        "  change {} zat -> {}",
        u64::from(tx.change),
        Address::from(campaign.change_addr).encode(&TEST_NETWORK)
    );

    let resolve = |op: &OutPoint| {
        inputs
            .iter()
            .find(|c| &c.outpoint == op)
            .map(|c| c.coin.clone())
    };
    let v = public_view(&tx.tx_bytes, resolve)?;
    verify_authorization(&tx.tx_bytes, resolve)?;
    println!(
        "built {}: {} bytes, {:?}, {} Ironwood actions, fee {} zat, change {} zat, build {:.1?}; \
         local check: balances={} proof+sigs=ok",
        tx.txid,
        v.size,
        v.branch_id,
        v.ironwood_actions,
        u64::from(tx.fee),
        u64::from(tx.change),
        tx.build_time,
        v.balances()
    );
    if dry_run {
        println!("dry run: NOT broadcast");
        return Ok(());
    }

    // Persist the exact bytes before broadcast, so a crash never forces a rebuild (AGENTS.md #3).
    let pending = pending_path(&tx.txid)?;
    std::fs::write(&pending, hex::encode(&tx.tx_bytes)).map_err(|e| e.to_string())?;
    println!("saved raw tx to {}", pending.display());

    let msg = lwd::send(client, &tx.tx_bytes).await?;
    println!("broadcast accepted: {msg}");
    wait_until_mined(client, &tx.txid).await?;
    verify_on_chain(client, campaign, recipients, &tx.txid).await
}

/// Moves every coin at the campaign's change address back to its funding address with
/// drop-zcash's `build_sweep` (transparent only, one output, ZIP-317 fee), then checks the funding
/// address the way the operator's deposit scan does.
async fn sweep(
    client: &mut lwd::Client,
    url: &str,
    keys: &drop_zcash::CampaignKeys,
    tip: u32,
    send: bool,
) -> Result<(), String> {
    let (funding, change) = (keys.funding_address(), keys.change_address());
    let coins = lwd::utxos(client, std::slice::from_ref(&change)).await?;
    if coins.is_empty() {
        return Err(format!("nothing to sweep at {change}"));
    }
    for c in &coins {
        let mined = lwd::get_tx(client, c.outpoint.txid())
            .await?
            .mined_height
            .ok_or("change coin not mined yet")?;
        let confirmations = u64::from(tip).saturating_sub(mined) + 1;
        println!(
            "  input  {}:{} = {} zat at {change} (mined {mined}, {confirmations} confirmations)",
            c.outpoint.txid(),
            c.outpoint.n(),
            u64::from(c.coin.value())
        );
        if confirmations < 3 {
            return Err(format!(
                "change coin has {confirmations} confirmations; need 3"
            ));
        }
    }
    let inputs: Vec<drop_zcash::FundingCoin> = coins
        .iter()
        .map(|c| drop_zcash::FundingCoin {
            outpoint: c.outpoint.clone(),
            coin: c.coin.clone(),
        })
        .collect();
    let target = BlockHeight::from_u32(tip + 1);
    let rule = drop_zcash::builder::fee_rule(&drop_core::FeePolicy::zip317_text())
        .map_err(|e| e.to_string())?;
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
    let tx = drop_zcash::build_sweep(
        keys,
        target,
        &inputs,
        &rule,
        &mut ChaCha20Rng::from_seed(seed),
    )
    .map_err(|e| e.to_string())?;

    let resolve = |op: &OutPoint| {
        inputs
            .iter()
            .find(|c| &c.outpoint == op)
            .map(|c| c.coin.clone())
    };
    let v = drop_zcash::inspect::public_totals(&tx.raw, resolve).map_err(|e| e.to_string())?;
    drop_zcash::inspect::verify_proofs_and_signatures(&tx.raw, resolve)
        .map_err(|e| e.to_string())?;
    println!(
        "  output {} zat -> {funding} (funding address); no other outputs",
        u64::from(tx.change)
    );
    println!(
        "sweep {}: {} {:?} target {target} (tip {tip} + 1), {} bytes, t_in {} = t_out {} + fee {} (FeePolicy::zip317_text); balances={} signatures=ok",
        tx.txid, v.tx_version, v.branch_id, v.size, v.t_in_total, v.t_out_total, v.fee, v.balances()
    );
    if !send {
        println!("dry run: NOT broadcast (pass --send)");
        return Ok(());
    }

    let pending = pending_path(&tx.txid)?;
    std::fs::write(&pending, hex::encode(&tx.raw)).map_err(|e| e.to_string())?;
    println!("saved raw tx to {}", pending.display());
    println!("broadcast accepted: {}", lwd::send(client, &tx.raw).await?);
    wait_until_mined(client, &tx.txid).await?;

    let after = lwd::utxos(client, std::slice::from_ref(&funding)).await?;
    println!("\nGetAddressUtxos({funding}): {} UTXO(s)", after.len());
    for u in &after {
        println!(
            "  {}:{} = {} zat",
            u.outpoint.txid(),
            u.outpoint.n(),
            u64::from(u.coin.value())
        );
    }
    let exact = after.len() == 1 && u64::from(after[0].coin.value()) == u64::from(tx.change);

    // The operator's deposit scan: drop-chain `chain_info` + `utxos(funding address)`.
    let config = drop_chain::ChainConfig::new(url, drop_core::Network::Testnet);
    let (source, info) = drop_chain::LightwalletdSource::connect(&config)
        .await
        .map_err(|e| e.to_string())?;
    let seen = source.utxos(&funding).await.map_err(|e| e.to_string())?;
    println!(
        "operator view (drop-chain utxos, as drop-operator's sightings): {} UTXO(s)",
        seen.len()
    );
    for u in &seen {
        let confirmations = u
            .height
            .map_or(0, |h| info.tip_height.saturating_sub(h) + 1);
        println!(
            "  {} = {} zat, {confirmations} confirmations",
            u.outpoint,
            u.value.as_u64()
        );
    }
    let operator_agrees = seen.len() == 1 && seen[0].value.as_u64() == u64::from(tx.change);
    println!(
        "exactly one UTXO of {} zat at the funding address: {}; operator view agrees: {}",
        u64::from(tx.change),
        yes(exact),
        yes(operator_agrees)
    );
    if exact && operator_agrees {
        Ok(())
    } else {
        Err("post-sweep check failed".into())
    }
}

async fn wait_until_mined(client: &mut lwd::Client, txid: &TxId) -> Result<(), String> {
    let mins: u64 = std::env::var("ZECDROP_WAIT_MINS")
        .ok()
        .and_then(|m| m.parse().ok())
        .unwrap_or(60);
    let start = Instant::now();
    loop {
        match lwd::get_tx(client, txid).await {
            Ok(f) => match f.mined_height {
                Some(h) => {
                    println!("mined at height {h} after {:.0?}", start.elapsed());
                    return Ok(());
                }
                None => println!("[{:>4.0?}] in mempool", start.elapsed()),
            },
            Err(e) => println!("[{:>4.0?}] not visible yet: {e}", start.elapsed()),
        }
        if start.elapsed() > Duration::from_secs(mins * 60) {
            return Err(format!(
                "not mined after {mins} min; re-run `live-batch verify {txid}` later"
            ));
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

/// Re-fetches the mined batch and checks it from chain bytes only (public part), then with keys.
async fn verify_on_chain(
    client: &mut lwd::Client,
    campaign: &Campaign,
    recipients: &[Recipient],
    txid: &TxId,
) -> Result<(), String> {
    let fetched = lwd::get_tx(client, txid).await?;
    let height = fetched.mined_height.ok_or("transaction is not mined yet")?;
    let prevouts = lwd::resolve_prevouts(client, &fetched.bytes).await?;
    let resolve = |op: &OutPoint| prevouts.get(op).cloned();

    let v = public_view(&fetched.bytes, resolve)?;
    let auth = verify_authorization(&fetched.bytes, resolve);
    let audit = recover_as_auditor(&fetched.bytes, &campaign.ufvk_encoded())?;
    let own = decrypt_as_recipient(&fetched.bytes, &recipients[0].ivk())?;
    let audit_sum: u64 = audit.iter().map(|r| r.value).sum();
    let net_into_ironwood = -v.ironwood_value_balance;

    println!("\n=== on-chain batch {txid} (testnet height {height}) ===");
    println!(
        "{:<44} {}",
        "tx version / branch",
        format!("{} / {:?}", v.tx_version, v.branch_id)
    );
    println!("{:<44} {}", "size (bytes)", v.size);
    println!(
        "{:<44} {} zat ({} inputs)",
        "t_in  (resolved prevouts)", v.t_in_total, v.t_in_count
    );
    println!(
        "{:<44} {} zat ({} outputs)",
        "t_out", v.t_out_total, v.t_out_count
    );
    println!(
        "{:<44} {} zat",
        "net into Ironwood (-valueBalanceIronwood)", net_into_ironwood
    );
    println!("{:<44} {}", "valueBalanceOrchard", v.orchard_value_balance);
    println!("{:<44} {} zat", "fee = t_in - t_out - net", v.fee_implied);
    println!(
        "{:<44} {} zat",
        "ZIP-317 conventional fee (5,000/action)", v.zip317_conventional_fee
    );
    println!("{:<44} {}", "Ironwood actions", v.ironwood_actions);
    println!(
        "{:<44} {}",
        "t_in == t_out + net + fee, fee >= 0",
        yes(v.balances())
    );
    println!(
        "{:<44} {}",
        "proof + all signatures verify",
        match &auth {
            Ok(()) => "yes".to_string(),
            Err(e) => format!("NO: {e}"),
        }
    );
    println!(
        "\nauditor (campaign UFVK -> OVK), {} outputs recovered:",
        audit.len()
    );
    for r in &audit {
        println!(
            "  action {:>2}: {:>10} zat  memo {:?}",
            r.action_index,
            r.value,
            r.memo_text.as_deref().unwrap_or("")
        );
    }
    println!(
        "  sum {audit_sum} zat == net into Ironwood: {}",
        yes(audit_sum as i64 == net_into_ironwood)
    );
    println!(
        "  count {} == Ironwood actions: {}",
        audit.len(),
        yes(audit.len() == v.ironwood_actions)
    );
    println!("\nrecipient account 1 (own IVK), {} output(s):", own.len());
    for r in &own {
        println!(
            "  action {:>2}: {:>10} zat  memo {:?}",
            r.action_index,
            r.value,
            r.memo_text.as_deref().unwrap_or("")
        );
    }

    write_fixture(txid, height, &fetched.bytes, &prevouts, &v)?;
    if v.balances() && auth.is_ok() && audit_sum as i64 == net_into_ironwood {
        Ok(())
    } else {
        Err("on-chain checks did not all pass (see table)".into())
    }
}

fn yes(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "NO"
    }
}

fn parse_txid(display_hex: &str) -> Result<TxId, String> {
    let mut bytes: [u8; 32] = hex::decode(display_hex)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "txid must be 32 bytes")?;
    bytes.reverse(); // display order -> internal order
    Ok(TxId::from_bytes(bytes))
}

fn pending_path(txid: &TxId) -> Result<PathBuf, String> {
    let dir = devseed::path()
        .map_err(|e| e.to_string())?
        .with_file_name("pending");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{txid}.hex")))
}

/// Public chain data only (no keys): raw tx, resolved prevouts and the expected public numbers.
/// Public data only: the batch, its resolved prevouts, the recomputed public facts and the one
/// transaction all its inputs spend (so a verifier can name the funding address). Refuses to
/// write anything unless the balance equation holds and the proof and signatures verify.
async fn capture_fixture(client: &mut lwd::Client, txid: &TxId, root: &Path) -> Result<(), String> {
    let fetched = lwd::get_tx(client, txid).await?;
    let height = fetched.mined_height.ok_or("transaction is not mined yet")?;
    let prevouts = lwd::resolve_prevouts(client, &fetched.bytes).await?;
    let resolve = |op: &OutPoint| prevouts.get(op).cloned();
    let v = public_view(&fetched.bytes, resolve)?;
    verify_authorization(&fetched.bytes, resolve)?;
    if !v.balances() {
        return Err("t_in != t_out + net + fee: not writing a fixture".into());
    }
    let mut funding_txids: Vec<TxId> = prevouts.keys().map(|op| *op.txid()).collect();
    funding_txids.sort_by_key(|t| *t.as_ref());
    funding_txids.dedup();
    let [funding_txid] = funding_txids.as_slice() else {
        return Err(format!(
            "expected one funding transaction, found {}",
            funding_txids.len()
        ));
    };
    let funding = lwd::get_tx(client, funding_txid).await?;

    write_fixture_in(root, txid, height, &fetched.bytes, &prevouts, &v)?;
    let dir = root.join(txid.to_string());
    std::fs::write(
        dir.join("funding-tx.hex"),
        hex::encode(&funding.bytes) + "\n",
    )
    .map_err(|e| e.to_string())?;
    println!(
        "{txid}: height {height}, {} bytes, {} Ironwood actions, net {} zat, fee {} zat; funding tx {funding_txid} (height {:?})",
        v.size,
        v.ironwood_actions,
        -v.ironwood_value_balance,
        v.fee_implied,
        funding.mined_height
    );
    println!("wrote {}", dir.display());
    Ok(())
}

fn write_fixture(
    txid: &TxId,
    height: u64,
    tx_bytes: &[u8],
    prevouts: &HashMap<OutPoint, TxOut>,
    v: &single_tx_builder_port031::PublicView,
) -> Result<(), String> {
    write_fixture_in(Path::new(FIXTURE_ROOT), txid, height, tx_bytes, prevouts, v)
}

fn write_fixture_in(
    root: &Path,
    txid: &TxId,
    height: u64,
    tx_bytes: &[u8],
    prevouts: &HashMap<OutPoint, TxOut>,
    v: &single_tx_builder_port031::PublicView,
) -> Result<(), String> {
    let dir = root.join(txid.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tx.hex"), hex::encode(tx_bytes) + "\n").map_err(|e| e.to_string())?;

    let mut prev = String::from("[\n");
    for (i, (op, out)) in prevouts.iter().enumerate() {
        let sep = if i + 1 < prevouts.len() { "," } else { "" };
        writeln!(
            prev,
            "  {{\"txid\": \"{}\", \"index\": {}, \"value_zat\": {}, \"script_pubkey_hex\": \"{}\"}}{sep}",
            op.txid(),
            op.n(),
            u64::from(out.value()),
            hex::encode(&out.script_pubkey().0 .0)
        )
        .unwrap();
    }
    prev.push_str("]\n");
    std::fs::write(dir.join("prevouts.json"), prev).map_err(|e| e.to_string())?;

    let expected = format!(
        "{{\n  \"network\": \"testnet\",\n  \"txid\": \"{txid}\",\n  \"mined_height\": {height},\n  \
         \"tx_version\": \"{}\",\n  \"consensus_branch_id\": \"{:08x}\",\n  \"size_bytes\": {},\n  \
         \"t_in_zat\": {},\n  \"t_out_zat\": {},\n  \"net_into_ironwood_zat\": {},\n  \
         \"value_balance_orchard_zat\": {},\n  \"fee_zat\": {},\n  \"ironwood_actions\": {}\n}}\n",
        v.tx_version,
        u32::from(v.branch_id),
        v.size,
        v.t_in_total,
        v.t_out_total,
        -v.ironwood_value_balance,
        v.orchard_value_balance,
        v.fee_implied,
        v.ironwood_actions
    );
    std::fs::write(dir.join("expected.json"), expected).map_err(|e| e.to_string())?;
    println!("\nfixture (public data only) written to {}", dir.display());
    Ok(())
}
