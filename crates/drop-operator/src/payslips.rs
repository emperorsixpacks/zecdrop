//! `payslips` and `verify-payslip` (REQ-PAY-002, REQ-PAY-003), and the payslips the operator's
//! own page is given (REQ-PAY-005).
//!
//! `payslips` writes one payslip per payout of a settled campaign, from the campaign's own key,
//! on this machine: it needs the passphrase-protected store and a node to fetch the batch
//! transactions, and it prints no address, amount, memo or key. Each file names its recipient's
//! receiver and amount, and its `rseed` also opens that output's memo, so it goes only to its
//! recipient (`docs/PRIVACY_BOUNDARY.md`, "Payslips").
//!
//! The page gets the same payslips with no node ([`issue_stored_payslips`]): they are issued from
//! the transaction bytes the ledger stored before broadcast, which are the bytes that were mined
//! (invariant 3), once the campaign is settled. Both paths match payout rows to opened outputs
//! with the same code ([`issue_from_transactions`]).
//!
//! `verify-payslip` is the key-less check (`drop_verify::payslip`) as a command. With a
//! transaction file it needs no store, no key and no node, so a payslip can be checked without
//! telling anyone about it.

use std::io::Write;
use std::path::Path;

use drop_core::{
    derive_phase, plan_batches, BatchStatus, CampaignPhase, FundingState, Ledger, LedgerError,
    Network,
};
use drop_verify::payslip::{check_payslip, verify_payslip, Payslip, NOT_PROVEN};
use drop_verify::{confirmations, ChainSource, ParsedTx, SourceError};
use drop_zcash::payslip::{issue_payslips, IssueError};
use drop_zcash::zcash_network;
use thiserror::Error;

use crate::audit::row_receiver;
use crate::store::CampaignRecord;

/// The largest payslip or transaction file the commands read. A payslip is about 300 bytes; a
/// 330-payout batch transaction in hexadecimal is about 2 MB.
const MAX_PAYSLIP_BYTES: u64 = 4 * 1024;
const MAX_TX_HEX_BYTES: u64 = 4 * 1024 * 1024;

/// Why a payslip command failed. Fixed text: never a key, address, amount or memo.
#[derive(Debug, Error)]
pub enum PayslipsError {
    /// Some batch of the campaign has no transaction yet, is not on the chain, or is not final.
    #[error("payslips are issued only once every batch of the campaign is final on the chain")]
    NotSettled,
    /// The chain source failed or contradicted itself.
    #[error(transparent)]
    Source(#[from] SourceError),
    /// The campaign's plan could not be rebuilt.
    #[error("the campaign's plan could not be rebuilt")]
    Plan,
    /// The campaign's key did not open the transactions.
    #[error(transparent)]
    Issue(#[from] IssueError),
    /// The ledger could not be read.
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    /// A settled batch has no stored transaction, or its stored bytes are not the transaction
    /// the ledger names.
    #[error("a settled batch's stored transaction is missing or is not the one its ledger names")]
    NotStored,
    /// The output directory exists already; payslips are never written over anything.
    #[error("the output directory already exists; choose a new one")]
    OutDirExists,
    /// A file could not be read, or written.
    #[error("a payslip file could not be read or written")]
    Io,
    /// The payslip file is not a payslip this verifier reads.
    #[error("the file is not a payslip this verifier reads")]
    NotAPayslip,
    /// The transaction file is not hexadecimal text.
    #[error("the transaction file must hold the transaction as hexadecimal text")]
    NotHex,
    /// Neither a transaction file nor a node was given.
    #[error("give --tx <file> (offline), or --lightwalletd-url <url> to fetch the transaction")]
    NoTransaction,
    /// The payslip does not verify.
    #[error(transparent)]
    Verify(#[from] drop_verify::PayslipError),
    /// The payslip could not be checked against the chain.
    #[error(transparent)]
    Check(#[from] drop_verify::CheckError),
}

/// What issuing produced: per payout row, in the campaign's own order, its payslip if the key
/// opened a matching output.
pub struct Issued {
    /// One entry per row of the payout list.
    pub rows: Vec<Option<Payslip>>,
    /// Outputs the key opened that match no row of the payout list.
    pub unmatched_outputs: usize,
}

/// Issues the payslips of a campaign from the chain: for every batch, fetches its transaction,
/// requires it to be final and to be the transaction the ledger names, then issues them with
/// [`issue_from_transactions`].
pub async fn issue_campaign_payslips<S: ChainSource>(
    source: &S,
    record: &CampaignRecord,
    statuses: &[BatchStatus],
    ufvk: &str,
    required_depth: u32,
) -> Result<Issued, PayslipsError> {
    let tip = source.tip_height().await?;
    let mut transactions = Vec::with_capacity(statuses.len());
    for status in statuses {
        let txid = status.txid().ok_or(PayslipsError::NotSettled)?;
        let fetched = source
            .transaction(&txid)
            .await?
            .ok_or(PayslipsError::NotSettled)?;
        if confirmations(tip, fetched.mined_height) < required_depth {
            return Err(PayslipsError::NotSettled);
        }
        // The bytes must be the transaction asked for.
        let parsed = ParsedTx::parse(&fetched.raw).map_err(|_| SourceError::Inconsistent)?;
        if parsed.txid() != txid {
            return Err(SourceError::Inconsistent.into());
        }
        transactions.push(fetched.raw);
    }
    issue_from_transactions(record, &transactions, ufvk)
}

/// Issues the payslips of a settled campaign from the transaction bytes its ledger stored before
/// broadcast, with no chain. The campaign must be settled by the rule its phase and its receipt
/// follow ([`derive_phase`]: every batch confirmed at `required_depth`), and each batch's stored
/// bytes must be the transaction its ledger names. Then as [`issue_from_transactions`].
pub fn issue_stored_payslips<L: Ledger>(
    ledger: &L,
    record: &CampaignRecord,
    statuses: &[BatchStatus],
    ufvk: &str,
    required_depth: u32,
) -> Result<Issued, PayslipsError> {
    let funding = if record.funding.is_some() {
        FundingState::Funded
    } else {
        FundingState::Awaiting
    };
    if derive_phase(funding, statuses, required_depth) != CampaignPhase::Settled {
        return Err(PayslipsError::NotSettled);
    }
    let mut transactions = Vec::with_capacity(statuses.len());
    for (index, status) in (0u32..).zip(statuses) {
        let txid = status.txid().ok_or(PayslipsError::NotSettled)?;
        let (stored, raw) = ledger
            .built_tx(&record.id, index)?
            .ok_or(PayslipsError::NotStored)?;
        // The bytes must be the transaction the ledger confirmed.
        let parsed = ParsedTx::parse(&raw).map_err(|_| PayslipsError::NotStored)?;
        if stored != txid || parsed.txid() != txid {
            return Err(PayslipsError::NotStored);
        }
        transactions.push(raw);
    }
    issue_from_transactions(record, &transactions, ufvk)
}

/// Issues the payslips of a campaign from its batch transactions, one per batch in batch order,
/// each already checked by the caller to be its batch's and final: opens each one's outputs with
/// the campaign key and matches each to a payout row of its batch by receiver and amount (a
/// payslip does not carry the memo, so the memo is not compared). Every payslip has been checked
/// against its own transaction before it is returned (`issue_payslips`).
pub fn issue_from_transactions(
    record: &CampaignRecord,
    transactions: &[Vec<u8>],
    ufvk: &str,
) -> Result<Issued, PayslipsError> {
    let network = record.network;
    let batches = plan_batches(record.manifest.rows(), record.max_outputs_per_batch)
        .map_err(|_| PayslipsError::Plan)?;
    if transactions.len() != batches.len() {
        return Err(PayslipsError::Plan);
    }

    let mut rows = Vec::with_capacity(record.manifest.rows().len());
    let mut unmatched_outputs = 0usize;
    for (batch, raw) in batches.iter().zip(transactions) {
        let issued = issue_payslips(raw, zcash_network(network), ufvk)?;

        let mut used = vec![false; issued.len()];
        for row in batch.recipients() {
            let wanted = row_receiver(network, row);
            let found = issued
                .iter()
                .enumerate()
                .find(|(i, payslip)| {
                    !used[*i]
                        && wanted == Some(payslip.receiver)
                        && payslip.value.as_u64() == row.amount().as_u64()
                })
                .map(|(i, _)| i);
            if let Some(i) = found {
                used[i] = true;
            }
            rows.push(found.map(|i| issued[i].clone()));
        }
        unmatched_outputs += used.iter().filter(|u| !**u).count();
    }
    Ok(Issued {
        rows,
        unmatched_outputs,
    })
}

/// The number of payout row `index` (0-based): its 1-based position in the payout list, which is
/// the order of the CSV it was imported from.
pub fn row_number(index: usize) -> usize {
    index + 1
}

/// The name of the file for payout row `index` (0-based), by its [`row_number`].
pub fn file_name(index: usize) -> String {
    format!("payslip-{:03}.json", row_number(index))
}

/// Writes one owner-only file per row that has a payslip into the new directory `dir`. Returns
/// how many files were written. Never writes over anything: `dir` must not exist.
pub fn write_payslips(dir: &Path, rows: &[Option<Payslip>]) -> Result<usize, PayslipsError> {
    create_private_dir(dir)?;
    let mut written = 0;
    for (index, payslip) in rows.iter().enumerate() {
        let Some(payslip) = payslip else { continue };
        let mut text = serde_json::to_string_pretty(payslip).map_err(|_| PayslipsError::Io)?;
        text.push('\n');
        write_private_file(&dir.join(file_name(index)), text.as_bytes())?;
        written += 1;
    }
    Ok(written)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<(), PayslipsError> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(dir)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => PayslipsError::OutDirExists,
            _ => PayslipsError::Io,
        })
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<(), PayslipsError> {
    std::fs::create_dir(dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => PayslipsError::OutDirExists,
        _ => PayslipsError::Io,
    })
}

#[cfg(unix)]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), PayslipsError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| PayslipsError::Io)?;
    file.write_all(bytes).map_err(|_| PayslipsError::Io)
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), PayslipsError> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| PayslipsError::Io)?;
    file.write_all(bytes).map_err(|_| PayslipsError::Io)
}

/// Reads a payslip file, strictly: at most 4 KiB, the documented JSON, nothing else.
pub fn read_payslip(path: &Path) -> Result<Payslip, PayslipsError> {
    let bytes = read_capped(path, MAX_PAYSLIP_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|_| PayslipsError::NotAPayslip)
}

/// Reads a transaction from a file of hexadecimal text.
pub fn read_tx_file(path: &Path) -> Result<Vec<u8>, PayslipsError> {
    let bytes = read_capped(path, MAX_TX_HEX_BYTES)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| PayslipsError::NotHex)?;
    hex::decode(text.trim()).map_err(|_| PayslipsError::NotHex)
}

fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, PayslipsError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| PayslipsError::Io)?;
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PayslipsError::Io)?;
    if u64::try_from(bytes.len()).map_or(true, |n| n > cap) {
        return Err(PayslipsError::Io);
    }
    Ok(bytes)
}

/// The part of the verdict that is always printed: what a successful check does not prove.
fn not_proven() -> String {
    let mut text = String::from("\nWhat this does not prove:\n");
    for line in NOT_PROVEN {
        text.push_str(&format!("  - {line}\n"));
    }
    text
}

/// Checks the payslip in `payslip_file` against the transaction in `tx_file`, offline: no store,
/// no key, no node. The verdict goes to `out`; it names the transaction and the action, says it
/// did not ask the chain, and lists what a successful check does not prove. It never prints the
/// receiver, the amount or the `rseed`. Fails if the payslip does not verify.
pub fn run_verify_payslip_offline(
    payslip_file: &Path,
    tx_file: &Path,
    out: &mut dyn Write,
) -> Result<(), PayslipsError> {
    let payslip = read_payslip(payslip_file)?;
    let raw = read_tx_file(tx_file)?;
    let proof = verify_payslip(&raw, &payslip)?;
    let text = format!(
        "OK: action {} of transaction {} creates a note with the payslip's receiver and amount.\n\
         This check used only the two files: it did not ask the chain whether the transaction exists or is final.\n{}",
        proof.action,
        proof.txid,
        not_proven()
    );
    out.write_all(text.as_bytes())
        .map_err(|_| PayslipsError::Io)
}

/// As [`run_verify_payslip_offline`], but fetches the transaction from `source` and reports its
/// confirmations with the receipt's rule. Returns whether the payslip verified **and** the
/// transaction is final at `required_depth`; a payslip that verifies on a transaction that is
/// not final yet prints PENDING and returns `false`.
pub async fn run_verify_payslip_on_chain<S: ChainSource>(
    payslip_file: &Path,
    source: &S,
    required_depth: u32,
    out: &mut dyn Write,
) -> Result<bool, PayslipsError> {
    let payslip = read_payslip(payslip_file)?;
    let checked = check_payslip(source, &payslip, required_depth).await?;
    let mut text = format!(
        "OK: action {} of transaction {} creates a note with the payslip's receiver and amount.\n",
        checked.proof.action, checked.proof.txid
    );
    if checked.is_final {
        text.push_str(&format!(
            "The transaction has {} confirmation(s): final at depth {}.\n",
            checked.confirmations, required_depth
        ));
    } else {
        text.push_str(&format!(
            "PENDING: the transaction has {} of {} confirmation(s).\n",
            checked.confirmations, required_depth
        ));
    }
    text.push_str(&not_proven());
    out.write_all(text.as_bytes())
        .map_err(|_| PayslipsError::Io)?;
    Ok(checked.is_final)
}

/// The network a payslip names, for the node the command asks.
pub fn payslip_network(path: &Path) -> Result<Network, PayslipsError> {
    Ok(read_payslip(path)?.network)
}
