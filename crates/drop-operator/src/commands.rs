//! The non-serving subcommands, written against explicit inputs and outputs so they can be
//! tested without a terminal: `audit` and `export-ufvk`.
//!
//! Neither command logs. The viewing key is read from stdin or a file (never from argv) and
//! the only place it is ever written is `export-ufvk`'s standard output, on request.

use std::io::{Read, Write};
use std::sync::Arc;

use drop_core::{CampaignId, Ledger, ManifestCommitment};
use drop_verify::ChainSource;
use drop_zcash::{zcash_network, CampaignKeys};
use thiserror::Error;

use crate::audit::{audit_campaign, read_ufvk, AuditError, AuditInput, UfvkSource};
use crate::config::{AuditArgs, ExportArgs, PayslipsArgs};
use crate::error::StoreError;
use crate::payslips::{issue_campaign_payslips, write_payslips, PayslipsError};
use crate::secret::SecretSeed;
use crate::store::Store;

/// Why a subcommand failed. Fixed text; never contains key material or recipient data.
#[derive(Debug, Error)]
pub enum CommandError {
    /// The campaign id is malformed or unknown.
    #[error("no such campaign")]
    NoSuchCampaign,
    /// `--receipt-commitment` is not 64 hexadecimal characters.
    #[error("--receipt-commitment must be 64 hexadecimal characters")]
    BadCommitment,
    /// Exporting a viewing key needs the explicit acknowledgement.
    #[error("{}", DISCLOSURE_WARNING)]
    NotConfirmed,
    /// The wallet seed is not the one this campaign was created with.
    #[error("this campaign was created with a different wallet seed than the one in use")]
    WrongWallet,
    /// The campaign's keys could not be derived.
    #[error("the campaign's keys could not be derived")]
    Keys,
    /// The tool was started for another network than the campaign's.
    #[error(
        "this is a {campaign} campaign but the tool was started for {tool}; pass --network \
         {campaign} (mainnet also needs --allow-mainnet and ZECDROP_CONFIRM_MAINNET)"
    )]
    WrongNetwork {
        /// The campaign's network.
        campaign: drop_core::Network,
        /// The network the tool was started for.
        tool: drop_core::Network,
    },
    /// The store failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The audit could not be carried out.
    #[error(transparent)]
    Audit(#[from] AuditError),
    /// The payslips could not be issued, written, read or checked.
    #[error(transparent)]
    Payslips(#[from] PayslipsError),
    /// Writing the result failed.
    #[error("could not write the result")]
    Io,
}

/// What exporting a viewing key means. Part of the contract wherever the key is exported:
/// the CLI prints it, and the API returns it in a `warning` field the UI must show.
pub const DISCLOSURE_WARNING: &str =
    "A campaign viewing key lets its holder see every payout of this campaign: each \
recipient address, amount and memo. Giving it away cannot be undone, and anyone it reaches \
can keep it forever. Share it only with the auditor you intend, over a channel you trust.";

/// A campaign belongs to one network, and a tool must be started for that network. Without this a
/// mainnet campaign's viewing key could be exported with no mainnet flag at all, because the gate
/// only looks at the network the tool was told (REQ-OPS-004).
pub fn ensure_campaign_network(
    store: &Store,
    id: &str,
    network: drop_core::Network,
) -> Result<(), CommandError> {
    let record = load_campaign(store, id)?;
    if record.network == network {
        Ok(())
    } else {
        Err(CommandError::WrongNetwork {
            campaign: record.network,
            tool: network,
        })
    }
}

fn load_campaign(store: &Store, id: &str) -> Result<crate::store::CampaignRecord, CommandError> {
    let id = CampaignId::new(id).map_err(|_| CommandError::NoSuchCampaign)?;
    store
        .load_campaign(&id)?
        .ok_or(CommandError::NoSuchCampaign)
}

/// Runs `audit`. Returns whether the campaign reconciled. The report goes to `out`.
pub async fn run_audit<S: ChainSource>(
    store: &Arc<Store>,
    args: &AuditArgs,
    source: &S,
    required_depth: u32,
    stdin: &mut dyn Read,
    out: &mut dyn Write,
) -> Result<bool, CommandError> {
    let record = load_campaign(store, &args.campaign)?;
    let ufvk = match &args.ufvk_file {
        Some(path) => read_ufvk(UfvkSource::File(path), stdin)?,
        None => read_ufvk(UfvkSource::Stdin, stdin)?,
    };
    let receipt_commitment = match &args.receipt_commitment {
        Some(text) => text
            .parse::<ManifestCommitment>()
            .map_err(|_| CommandError::BadCommitment)?,
        None => record.commitment,
    };
    let batch_count = u32::try_from(crate::api_plan_len(&record)?).map_err(|_| AuditError::Plan)?;
    let statuses = store
        .ledger()
        .statuses(&record.id, batch_count)
        .map_err(|e| StoreError::Database(e.to_string()))?;

    let report = audit_campaign(
        source,
        AuditInput {
            record: &record,
            statuses: &statuses,
            ufvk: &ufvk,
            receipt_commitment,
            required_depth,
        },
    )
    .await?;

    let text = if args.json {
        serde_json::to_string_pretty(&report).map_err(|_| CommandError::Io)? + "\n"
    } else {
        report.render()
    };
    out.write_all(text.as_bytes())
        .map_err(|_| CommandError::Io)?;
    Ok(report.reconciled)
}

/// Runs `payslips`: one payslip per payout of the campaign, written into the new directory
/// `args.out_dir` (REQ-PAY-002). Needs every batch to be final on the chain. Prints counts and a
/// reminder to `out`, never an address, an amount, a memo or a key. Returns whether every payout
/// row got a payslip and no opened output was left over.
pub async fn run_payslips<S: ChainSource>(
    store: &Arc<Store>,
    seed: &SecretSeed,
    args: &PayslipsArgs,
    source: &S,
    required_depth: u32,
    out: &mut dyn Write,
) -> Result<bool, CommandError> {
    let record = load_campaign(store, &args.campaign)?;
    if record
        .seed_fingerprint
        .as_deref()
        .is_some_and(|recorded| recorded != seed.fingerprint())
    {
        return Err(CommandError::WrongWallet);
    }
    let ufvk = campaign_ufvk(seed, record.network, record.account)?;
    let batch_count = u32::try_from(crate::api_plan_len(&record)?).map_err(|_| AuditError::Plan)?;
    let statuses = store
        .ledger()
        .statuses(&record.id, batch_count)
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let issued = issue_campaign_payslips(source, &record, &statuses, &ufvk, required_depth).await?;
    let written = write_payslips(&args.out_dir, &issued.rows)?;
    let missing = issued.rows.len() - written;
    writeln!(
        out,
        "Wrote {written} payslip(s) to {}, one owner-only file per payout, numbered in the order of the payout list.",
        args.out_dir.display()
    )
    .map_err(|_| CommandError::Io)?;
    writeln!(
        out,
        "Each one names its recipient's receiver and amount, and its rseed also opens that output's memo: give each only to its recipient."
    )
    .map_err(|_| CommandError::Io)?;
    if missing > 0 || issued.unmatched_outputs > 0 {
        writeln!(
            out,
            "WARNING: {missing} payout(s) got no payslip and {} opened output(s) matched no payout: the chain and the payout list differ; run the audit.",
            issued.unmatched_outputs
        )
        .map_err(|_| CommandError::Io)?;
    }
    Ok(missing == 0 && issued.unmatched_outputs == 0)
}

/// Runs `export-ufvk`: the warning to `err`, the key alone to `out`.
pub fn run_export_ufvk(
    store: &Store,
    seed: &SecretSeed,
    args: &ExportArgs,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<(), CommandError> {
    if !args.i_understand_this_is_irreversible {
        return Err(CommandError::NotConfirmed);
    }
    let record = load_campaign(store, &args.campaign)?;
    if record
        .seed_fingerprint
        .as_deref()
        .is_some_and(|recorded| recorded != seed.fingerprint())
    {
        return Err(CommandError::WrongWallet);
    }
    let ufvk = campaign_ufvk(seed, record.network, record.account)?;
    writeln!(err, "WARNING: {DISCLOSURE_WARNING}").map_err(|_| CommandError::Io)?;
    writeln!(out, "{}", ufvk.as_str()).map_err(|_| CommandError::Io)?;
    Ok(())
}

/// The campaign's encoded viewing key, in a zeroizing buffer.
pub fn campaign_ufvk(
    seed: &SecretSeed,
    network: drop_core::Network,
    account: u32,
) -> Result<zeroize::Zeroizing<String>, CommandError> {
    let keys = CampaignKeys::derive(seed.expose_secret(), zcash_network(network), account)
        .map_err(|_| CommandError::Keys)?;
    keys.ufvk_encoded()
        .map(zeroize::Zeroizing::new)
        .map_err(|_| CommandError::Keys)
}
