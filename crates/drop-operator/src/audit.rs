//! The local audit (REQ-AUD-001, REQ-AUD-003).
//!
//! The public chain shows how much value entered the pool and in how many actions, but not
//! that it reached the people on the payout list. The holder of a campaign's viewing key
//! (UFVK) can close that gap: for every batch, this module
//!
//! 1. fetches the transaction and takes the *public* facts from `drop-verify` (net value into
//!    the pool, shielded action count);
//! 2. recovers the outputs with the UFVK (`drop-zcash`'s auditor recovery);
//! 3. reports whether the recovered count equals the public action count and whether the
//!    recovered values add up to the public net value;
//! 4. matches the recovered outputs against the stored payout list and recomputes the salted
//!    manifest commitment from what the chain proves, comparing it with the commitment on the
//!    receipt.
//!
//! Every difference is reported as a difference, never rounded away: it means a hidden spend,
//! a hidden output, an output built without the campaign's viewing key, or a payout list
//! that is not what was paid.
//!
//! The UFVK stays in this process: it is never logged, printed, stored or sent to a server.
//! The report contains counts, sums that are public anyway, transaction ids and booleans, and
//! no addresses, memos or per-recipient amounts.

use std::io::Read;
use std::path::Path;

use drop_core::{
    plan_batches, BatchStatus, CampaignId, Finding, Manifest, ManifestCommitment, Network, Pool,
    Recipient, Txid, Zatoshi,
};
use drop_verify::{
    verify_campaign, ChainSource, SourceError, VerifyConfig, VerifyError, VerifyRequest,
};
use drop_zcash::inspect::{recover_with_ufvk, InspectError, RecoveredOutput};
use drop_zcash::zcash_network;
use serde::Serialize;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::store::CampaignRecord;

/// Why an audit could not be carried out. Fixed text only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AuditError {
    /// The viewing key could not be read.
    #[error("the viewing key could not be read")]
    UfvkUnreadable,
    /// The viewing key is not shaped like a unified full viewing key.
    #[error("that does not look like a unified full viewing key (it should start with `uview`)")]
    UfvkShape,
    /// The viewing key does not decode for the campaign's network.
    #[error("the viewing key does not decode for this campaign's network")]
    UfvkNetwork,
    /// The chain source failed.
    #[error(transparent)]
    Source(#[from] SourceError),
    /// The campaign's plan could not be rebuilt.
    #[error("the campaign's plan could not be rebuilt")]
    Plan,
    /// The public facts could not be assembled.
    #[error(transparent)]
    Verify(#[from] VerifyError),
}

/// Where the viewing key comes from. Never the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UfvkSource<'a> {
    /// Standard input.
    Stdin,
    /// A file.
    File(&'a Path),
}

/// A unified full viewing key is well under a kilobyte; anything bigger is not one.
const MAX_UFVK_BYTES: usize = 4096;

/// Reads at most [`MAX_UFVK_BYTES`] plus one byte (so "too long" can be told from "full").
/// The buffer is allocated once, so no unwiped copy is left behind by growing it.
fn read_bounded(reader: &mut dyn Read) -> Result<Zeroizing<Vec<u8>>, AuditError> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_UFVK_BYTES + 1));
    (&mut *reader)
        .take(MAX_UFVK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AuditError::UfvkUnreadable)?;
    Ok(bytes)
}

/// Reads the viewing key from stdin or a file, trims it and checks its shape. The text is
/// held in zeroizing buffers and is never echoed in an error.
pub fn read_ufvk(
    source: UfvkSource<'_>,
    stdin: &mut dyn Read,
) -> Result<Zeroizing<String>, AuditError> {
    let bytes = match source {
        UfvkSource::Stdin => read_bounded(stdin)?,
        UfvkSource::File(path) => {
            let mut file = std::fs::File::open(path).map_err(|_| AuditError::UfvkUnreadable)?;
            read_bounded(&mut file)?
        }
    };
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| AuditError::UfvkShape)?
        .trim();
    let shaped = bytes.len() <= MAX_UFVK_BYTES
        && text.starts_with("uview")
        && text.len() > 20
        && text.bytes().all(|b| b.is_ascii_alphanumeric());
    if shaped {
        Ok(Zeroizing::new(text.to_owned()))
    } else {
        Err(AuditError::UfvkShape)
    }
}

/// One batch's reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BatchAudit {
    /// Batch index.
    pub index: u32,
    /// The batch transaction, once built.
    pub txid: Option<Txid>,
    /// Whether the transaction was found on the chain.
    pub found: bool,
    /// Confirmations of the transaction.
    pub confirmations: u32,
    /// Recipients the plan expects in this batch.
    pub planned_recipients: u32,
    /// Shielded actions the transaction publishes.
    pub public_actions: Option<u32>,
    /// Outputs recovered with the viewing key.
    pub recovered_outputs: u32,
    /// Whether the recovered count equals the public action count. `null` when it cannot be
    /// compared: the batch is unfound, or has a single recipient (a bundle pads to two actions).
    pub count_matches: Option<bool>,
    /// Value that entered the pool, as published.
    pub public_net_into_pool: Option<Zatoshi>,
    /// The sum of the recovered outputs' values.
    pub recovered_sum: Option<Zatoshi>,
    /// Whether the recovered sum equals the published net value.
    pub sum_matches: Option<bool>,
    /// Problems the public verification found for this transaction.
    pub findings: Vec<Finding>,
}

/// The manifest check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitmentAudit {
    /// The commitment on the receipt.
    pub receipt: ManifestCommitment,
    /// The commitment recomputed from the stored manifest, keeping only the rows the chain
    /// proves (address from the manifest; amount and memo as recovered). `null` if none.
    pub recomputed: Option<ManifestCommitment>,
    /// Whether the two are equal.
    pub matches: bool,
    /// Payout-list rows that a recovered output confirms.
    pub rows_matched: u32,
    /// Rows in the payout list.
    pub rows_total: u32,
    /// Recovered outputs that match no row of the payout list.
    pub unmatched_outputs: u32,
}

/// The whole audit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditReport {
    /// The campaign.
    pub campaign_id: CampaignId,
    /// The network.
    pub network: Network,
    /// Per-batch results, in batch order.
    pub batches: Vec<BatchAudit>,
    /// The manifest commitment check.
    pub commitment: CommitmentAudit,
    /// True only if every batch was found, is final, and matched in count and sum, the payout
    /// list is fully confirmed by the chain, nothing unexplained was recovered, and the
    /// commitment equals the receipt's.
    pub reconciled: bool,
}

/// What to audit.
pub struct AuditInput<'a> {
    /// The campaign, with its decrypted manifest.
    pub record: &'a CampaignRecord,
    /// One ledger status per batch.
    pub statuses: &'a [BatchStatus],
    /// The campaign viewing key.
    pub ufvk: &'a str,
    /// The commitment to compare with (the receipt's).
    pub receipt_commitment: ManifestCommitment,
    /// Confirmation depth at which a batch is final.
    pub required_depth: u32,
}

/// The identifying content of one payout, for matching rows to recovered outputs.
#[derive(PartialEq, Eq)]
struct PayoutKey {
    receiver: Option<[u8; 43]>,
    value: u64,
    memo: Option<String>,
}

/// The Orchard receiver of a payout row's unified address, as the 43 raw bytes a recovered output
/// and a payslip carry. `None` if the address is not a unified address with an Orchard receiver.
pub(crate) fn row_receiver(network: Network, row: &Recipient) -> Option<[u8; 43]> {
    zcash_keys::address::Address::decode(&zcash_network(network), row.address()).and_then(
        |address| match address {
            zcash_keys::address::Address::Unified(ua) => {
                ua.orchard().map(|receiver| receiver.to_raw_address_bytes())
            }
            _ => None,
        },
    )
}

fn row_key(network: Network, row: &Recipient) -> PayoutKey {
    PayoutKey {
        receiver: row_receiver(network, row),
        value: row.amount().as_u64(),
        memo: row.memo().map(str::to_owned),
    }
}

fn output_key(output: &RecoveredOutput) -> PayoutKey {
    PayoutKey {
        receiver: Some(output.recipient.to_raw_address_bytes()),
        value: output.value,
        memo: output.memo.clone(),
    }
}

/// Matches each row to a distinct recovered output with the same receiver, value and memo.
/// Returns, per row, the index of its output, and how many outputs matched no row.
fn match_rows(
    network: Network,
    rows: &[Recipient],
    outputs: &[RecoveredOutput],
) -> (Vec<Option<usize>>, usize) {
    let output_keys: Vec<PayoutKey> = outputs.iter().map(output_key).collect();
    let mut used = vec![false; outputs.len()];
    let matches: Vec<Option<usize>> = rows
        .iter()
        .map(|row| {
            let key = row_key(network, row);
            let found = output_keys
                .iter()
                .enumerate()
                .find(|(i, candidate)| !used[*i] && **candidate == key)
                .map(|(i, _)| i);
            if let Some(i) = found {
                used[i] = true;
            }
            found
        })
        .collect();
    let unmatched = used.iter().filter(|u| !**u).count();
    (matches, unmatched)
}

/// The count and sum verdicts for one batch.
///
/// The count is compared only for batches of two or more recipients (a single output is padded
/// to two actions); the sum is always compared. Anything not known is a difference, never a
/// match.
pub(crate) fn compare(
    planned_recipients: u32,
    public_actions: Option<u32>,
    recovered_outputs: u32,
    public_net: Option<Zatoshi>,
    recovered_sum: Option<Zatoshi>,
) -> (Option<bool>, Option<bool>) {
    let count = (planned_recipients >= 2).then(|| public_actions == Some(recovered_outputs));
    let sum = matches!((recovered_sum, public_net), (Some(r), Some(p)) if r == p);
    (count, Some(sum))
}

/// Whether the audit found nothing to report.
///
/// Every planned batch must have been found, be final (no public finding of any kind, a batch
/// not yet at the required depth included), and match in count and sum; every payout-list row
/// must be confirmed by a recovered output; nothing unexplained may have been recovered; and
/// the recomputed commitment must equal the receipt's.
fn is_reconciled(
    batches: &[BatchAudit],
    planned_batches: usize,
    commitment: &CommitmentAudit,
) -> bool {
    batches.len() == planned_batches
        && batches.iter().all(|b| {
            b.found
                && b.count_matches != Some(false)
                && b.sum_matches == Some(true)
                && b.findings.is_empty()
        })
        && commitment.matches
        && commitment.rows_matched == commitment.rows_total
        && commitment.unmatched_outputs == 0
}

/// Audits a campaign against the chain. See the module docs.
pub async fn audit_campaign<S: ChainSource>(
    source: &S,
    input: AuditInput<'_>,
) -> Result<AuditReport, AuditError> {
    let AuditInput {
        record,
        statuses,
        ufvk,
        receipt_commitment,
        required_depth,
    } = input;
    let network = record.network;
    let batches = plan_batches(record.manifest.rows(), record.max_outputs_per_batch)
        .map_err(|_| AuditError::Plan)?;

    let mut audits = Vec::with_capacity(batches.len());
    let mut confirmed_rows: Vec<Recipient> = Vec::new();
    let mut unmatched_outputs_total = 0usize;
    let mut rows_matched = 0usize;

    for (batch, status) in batches.iter().zip(statuses) {
        let planned = batch.output_count();
        let mut audit = BatchAudit {
            index: batch.index(),
            txid: status.txid(),
            found: false,
            confirmations: 0,
            planned_recipients: planned,
            public_actions: None,
            recovered_outputs: 0,
            count_matches: None,
            public_net_into_pool: None,
            recovered_sum: None,
            sum_matches: None,
            findings: Vec::new(),
        };
        let Some(txid) = status.txid() else {
            audits.push(audit);
            continue;
        };

        // Public facts, from the same code the hosted verifier runs.
        let receipt = verify_campaign(
            source,
            &VerifyRequest {
                network,
                txids: vec![txid],
                manifest_commitment: receipt_commitment,
                declared_total: batch.total(),
                campaign_id: Some(record.id.clone()),
            },
            &VerifyConfig {
                required_depth,
                expected_pool: Pool::Ironwood,
            },
        )
        .await?;
        let facts = &receipt.batches[0];
        audit.found = !receipt.findings.iter().any(|f| {
            matches!(
                f,
                Finding::TxNotFound { .. } | Finding::TxUnparseable { .. }
            )
        });
        audit.confirmations = facts.confirmations;
        audit.public_actions = facts.shielded_actions;
        audit.public_net_into_pool = facts.net_into_pool;
        audit.findings = receipt.findings.clone();

        if audit.found {
            // The viewing key opens the outputs. A missing transaction yields nothing to open.
            let raw = source
                .transaction(&txid)
                .await?
                .ok_or(AuditError::Source(SourceError::Inconsistent))?
                .raw;
            let outputs = recover_with_ufvk(&raw, zcash_network(network), ufvk).map_err(
                |error| match error {
                    InspectError::BadViewingKey => AuditError::UfvkNetwork,
                    _ => AuditError::Source(SourceError::Inconsistent),
                },
            )?;
            let sum: u64 = outputs.iter().map(|o| o.value).sum();
            audit.recovered_outputs = u32::try_from(outputs.len()).unwrap_or(u32::MAX);
            audit.recovered_sum = Zatoshi::new(sum).ok();
            (audit.count_matches, audit.sum_matches) = compare(
                planned,
                audit.public_actions,
                audit.recovered_outputs,
                audit.public_net_into_pool,
                audit.recovered_sum,
            );

            let (matched, unmatched) = match_rows(network, batch.recipients(), &outputs);
            unmatched_outputs_total += unmatched;
            // A row counts only if a recovered output has its Orchard receiver, its exact
            // value and its exact memo, so a confirmed row is the manifest row itself.
            for (row, found) in batch.recipients().iter().zip(matched) {
                if found.is_some() {
                    rows_matched += 1;
                    confirmed_rows.push(row.clone());
                }
            }
        }
        audits.push(audit);
    }

    let rows_total = record.manifest.rows().len();
    let recomputed = Manifest::new(
        record.id.clone(),
        record.manifest.salt().clone(),
        confirmed_rows,
    )
    .ok()
    .map(|manifest| manifest.commitment());
    let commitment = CommitmentAudit {
        receipt: receipt_commitment,
        matches: recomputed == Some(receipt_commitment),
        recomputed,
        rows_matched: u32::try_from(rows_matched).unwrap_or(u32::MAX),
        rows_total: u32::try_from(rows_total).unwrap_or(u32::MAX),
        unmatched_outputs: u32::try_from(unmatched_outputs_total).unwrap_or(u32::MAX),
    };

    let reconciled = is_reconciled(&audits, batches.len(), &commitment);

    Ok(AuditReport {
        campaign_id: record.id.clone(),
        network,
        batches: audits,
        commitment,
        reconciled,
    })
}

impl AuditReport {
    /// A human-readable summary: ids, counts, sums and verdicts. Never addresses or memos.
    pub fn render(&self) -> String {
        let yes_no = |v: Option<bool>| match v {
            Some(true) => "matches",
            Some(false) => "DIFFERS",
            None => "not comparable",
        };
        let mut out = format!(
            "Audit of campaign {} ({})\n",
            self.campaign_id, self.network
        );
        for b in &self.batches {
            out.push_str(&format!("\nBatch {}\n", b.index));
            match b.txid {
                None => out.push_str("  not built yet: nothing to audit\n"),
                Some(txid) => {
                    out.push_str(&format!(
                        "  transaction {txid} ({} confirmations)\n",
                        b.confirmations
                    ));
                    if !b.found {
                        let unreadable = b
                            .findings
                            .iter()
                            .any(|f| matches!(f, Finding::TxUnparseable { .. }));
                        out.push_str(if unreadable {
                            "  FOUND but it is not a transaction this tool can read\n"
                        } else {
                            "  NOT FOUND on the chain\n"
                        });
                        for finding in &b.findings {
                            out.push_str(&format!("  note: {}\n", finding.message()));
                        }
                        continue;
                    }
                    out.push_str(&format!(
                        "  outputs recovered {} of {} public actions: {}\n",
                        b.recovered_outputs,
                        b.public_actions.map_or("?".to_owned(), |a| a.to_string()),
                        yes_no(b.count_matches)
                    ));
                    let coin = self.network.coin();
                    let money = |z: Option<Zatoshi>| {
                        z.map_or("?".to_owned(), |z| format!("{} {coin}", z.format_zec()))
                    };
                    out.push_str(&format!(
                        "  recovered total {} vs public net into pool {}: {}\n",
                        money(b.recovered_sum),
                        money(b.public_net_into_pool),
                        yes_no(b.sum_matches)
                    ));
                    for finding in &b.findings {
                        out.push_str(&format!("  note: {}\n", finding.message()));
                    }
                }
            }
        }
        let c = &self.commitment;
        out.push_str(&format!(
            "\nPayout list: {} of {} rows confirmed by recovered outputs; {} recovered outputs match no row\n",
            c.rows_matched, c.rows_total, c.unmatched_outputs
        ));
        out.push_str(&format!(
            "Manifest commitment: receipt {}\n  recomputed {}: {}\n",
            c.receipt,
            c.recomputed
                .map_or("(nothing confirmed)".to_owned(), |r| r.to_string()),
            if c.matches { "matches" } else { "DIFFERS" }
        ));
        out.push_str(if self.reconciled {
            "\nRESULT: reconciled. The chain shows exactly the payout list, in the committed amounts.\n"
        } else {
            "\nRESULT: NOT reconciled. See the differences above.\n"
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use drop_zcash::CampaignKeys;
    use zcash_protocol::consensus::Network as ZNetwork;

    use super::*;

    /// Shaped like a UFVK, but not one.
    const KEY: &str = "uview1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

    // TEST ONLY.
    const SEED: [u8; 32] = *b"TEST-ONLY audit unit-test seed!!";

    fn read(text: &[u8]) -> Result<Zeroizing<String>, AuditError> {
        read_ufvk(UfvkSource::Stdin, &mut Cursor::new(text.to_vec()))
    }

    // covers: REQ-AUD-001
    #[test]
    fn a_key_on_stdin_is_trimmed() {
        assert_eq!(
            read(format!("  {KEY}\r\n").as_bytes()).unwrap().as_str(),
            KEY
        );
    }

    // covers: REQ-AUD-001
    #[test]
    fn a_key_in_a_file_is_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("campaign.ufvk");
        std::fs::write(&path, format!("{KEY}\n")).unwrap();
        let got = read_ufvk(UfvkSource::File(&path), &mut Cursor::new(Vec::new())).unwrap();
        assert_eq!(got.as_str(), KEY);
    }

    // covers: REQ-AUD-001
    #[test]
    fn something_that_is_not_shaped_like_a_key_is_refused_and_never_echoed() {
        let marker = "SECRETMARKER";
        let long = format!("uview1{}", "q".repeat(5000));
        let cases: Vec<Vec<u8>> = vec![
            b"".to_vec(),
            b"   \n".to_vec(),
            b"uview1short".to_vec(),
            format!("zview1{marker}qqqqqqqqqqqqqqqqqqqq").into_bytes(),
            format!("uview1 {marker} qqqqqqqqqqqqqqqqqqqq").into_bytes(),
            format!("uview1{marker}\nqqqqqqqqqqqqqqqqqqqq").into_bytes(),
            format!("uview1{marker}_-qqqqqqqqqqqqqqqqqqqq").into_bytes(),
            long.into_bytes(),
            [b"uview1".as_slice(), &[0xff, 0xfe], marker.as_bytes()].concat(),
        ];
        for case in cases {
            let error = read(&case).unwrap_err();
            assert_eq!(
                error,
                AuditError::UfvkShape,
                "{:?}",
                String::from_utf8_lossy(&case)
            );
            let shown = format!("{error} {error:?}");
            assert!(
                !shown.contains(marker) && !shown.contains("qqqq"),
                "{shown}"
            );
        }
    }

    // covers: REQ-AUD-001
    #[test]
    fn the_length_limits_are_exact() {
        // Longer than 20 characters is a key; 20 is not.
        assert!(read(format!("uview{}", "q".repeat(16)).as_bytes()).is_ok());
        assert_eq!(
            read(format!("uview{}", "q".repeat(15)).as_bytes()),
            Err(AuditError::UfvkShape)
        );
        // 4096 bytes is the most that is read as a key.
        let at_limit = format!("uview1{}", "q".repeat(MAX_UFVK_BYTES - 6));
        assert!(read(at_limit.as_bytes()).is_ok());
        assert_eq!(
            read(format!("{at_limit}q").as_bytes()),
            Err(AuditError::UfvkShape)
        );
    }

    struct Endless;

    impl Read for Endless {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            buf.fill(b'q');
            Ok(buf.len())
        }
    }

    struct Broken;

    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("SECRETMARKER device failure"))
        }
    }

    // covers: REQ-AUD-001
    #[test]
    fn reading_is_bounded_and_failures_say_nothing_about_the_input() {
        // An endless stream ends: it is refused without being read to the end.
        assert_eq!(
            read_ufvk(UfvkSource::Stdin, &mut Endless),
            Err(AuditError::UfvkShape)
        );
        let error = read_ufvk(UfvkSource::Stdin, &mut Broken).unwrap_err();
        assert_eq!(error, AuditError::UfvkUnreadable);
        assert!(!format!("{error} {error:?}").contains("SECRETMARKER"));

        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nothing-here");
        assert_eq!(
            read_ufvk(UfvkSource::File(&missing), &mut Cursor::new(Vec::new())),
            Err(AuditError::UfvkUnreadable)
        );
        // A directory opens but cannot be read.
        assert_eq!(
            read_ufvk(UfvkSource::File(dir.path()), &mut Cursor::new(Vec::new())),
            Err(AuditError::UfvkUnreadable)
        );
    }

    fn good_batch() -> BatchAudit {
        BatchAudit {
            index: 0,
            txid: None,
            found: true,
            confirmations: 10,
            planned_recipients: 3,
            public_actions: Some(3),
            recovered_outputs: 3,
            count_matches: Some(true),
            public_net_into_pool: Zatoshi::new(5).ok(),
            recovered_sum: Zatoshi::new(5).ok(),
            sum_matches: Some(true),
            findings: Vec::new(),
        }
    }

    fn good_commitment() -> CommitmentAudit {
        let c = ManifestCommitment::from_bytes([7; 32]);
        CommitmentAudit {
            receipt: c,
            recomputed: Some(c),
            matches: true,
            rows_matched: 3,
            rows_total: 3,
            unmatched_outputs: 0,
        }
    }

    // covers: REQ-AUD-001, REQ-AUD-003
    #[test]
    fn reconciled_needs_every_condition_and_each_one_alone_breaks_it() {
        assert!(is_reconciled(&[good_batch()], 1, &good_commitment()));
        // A batch that cannot compare counts (one recipient) still reconciles.
        let mut single = good_batch();
        single.count_matches = None;
        assert!(is_reconciled(&[single], 1, &good_commitment()));

        type Break = Box<dyn Fn(&mut BatchAudit)>;
        let batch_breaks: [(&str, Break); 6] = [
            ("not found", Box::new(|b| b.found = false)),
            ("count differs", Box::new(|b| b.count_matches = Some(false))),
            ("sum differs", Box::new(|b| b.sum_matches = Some(false))),
            ("sum unknown", Box::new(|b| b.sum_matches = None)),
            (
                "pending",
                Box::new(|b| b.findings = vec![Finding::BatchPending { batch_index: 0 }]),
            ),
            (
                "balance",
                Box::new(|b| b.findings = vec![Finding::BalanceMismatch { batch_index: 0 }]),
            ),
        ];
        for (what, broken) in batch_breaks {
            let mut batch = good_batch();
            broken(&mut batch);
            assert!(!is_reconciled(&[batch], 1, &good_commitment()), "{what}");
        }

        type BreakCommitment = Box<dyn Fn(&mut CommitmentAudit)>;
        let commitment_breaks: [(&str, BreakCommitment); 3] = [
            ("commitment differs", Box::new(|c| c.matches = false)),
            ("a row unconfirmed", Box::new(|c| c.rows_matched = 2)),
            (
                "an output unexplained",
                Box::new(|c| c.unmatched_outputs = 1),
            ),
        ];
        for (what, broken) in commitment_breaks {
            let mut commitment = good_commitment();
            broken(&mut commitment);
            assert!(!is_reconciled(&[good_batch()], 1, &commitment), "{what}");
        }

        // A planned batch that was not audited at all.
        assert!(!is_reconciled(&[good_batch()], 2, &good_commitment()));
        assert!(!is_reconciled(&[], 1, &good_commitment()));
    }

    // covers: REQ-AUD-001
    #[test]
    fn counts_and_sums_are_compared_and_the_unknown_is_a_difference() {
        let z = |n| Zatoshi::new(n).ok();
        // Two or more recipients: the recovered count must equal the public action count.
        assert_eq!(compare(2, Some(2), 2, z(9), z(9)), (Some(true), Some(true)));
        assert_eq!(
            compare(3, Some(3), 2, z(9), z(9)),
            (Some(false), Some(true))
        );
        assert_eq!(
            compare(3, Some(2), 3, z(9), z(9)),
            (Some(false), Some(true))
        );
        assert_eq!(compare(3, None, 3, z(9), z(9)), (Some(false), Some(true)));
        // One recipient: the bundle is padded, the count is not comparable.
        assert_eq!(compare(1, Some(2), 1, z(9), z(9)), (None, Some(true)));
        assert_eq!(compare(1, None, 0, z(9), z(9)), (None, Some(true)));
        // The sum is compared whatever the count, and unknown never matches.
        assert_eq!(
            compare(3, Some(3), 3, z(9), z(8)),
            (Some(true), Some(false))
        );
        assert_eq!(
            compare(3, Some(3), 3, z(8), z(9)),
            (Some(true), Some(false))
        );
        assert_eq!(
            compare(3, Some(3), 3, None, z(9)),
            (Some(true), Some(false))
        );
        assert_eq!(
            compare(3, Some(3), 3, z(9), None),
            (Some(true), Some(false))
        );
        assert_eq!(
            compare(3, Some(3), 3, None, None),
            (Some(true), Some(false))
        );
    }

    fn ua(account: u32) -> String {
        CampaignKeys::derive(&SEED, ZNetwork::TestNetwork, account)
            .unwrap()
            .unified_address()
    }

    fn receiver(address: &str) -> orchard::Address {
        match zcash_keys::address::Address::decode(&ZNetwork::TestNetwork, address) {
            Some(zcash_keys::address::Address::Unified(ua)) => *ua.orchard().unwrap(),
            _ => panic!("not a unified address"),
        }
    }

    fn row(address: &str, zat: u64, memo: Option<&str>) -> Recipient {
        Recipient::new(address, Zatoshi::new(zat).unwrap(), memo.map(str::to_owned)).unwrap()
    }

    fn out(address: &str, zat: u64, memo: Option<&str>) -> RecoveredOutput {
        RecoveredOutput {
            action_index: 0,
            value: zat,
            memo: memo.map(str::to_owned),
            recipient: receiver(address),
        }
    }

    // covers: REQ-AUD-003
    #[test]
    fn rows_are_matched_by_receiver_value_and_memo_in_any_order() {
        let (a, b) = (ua(1), ua(2));
        let rows = [row(&a, 100, Some("one")), row(&b, 200, None)];
        let outputs = [out(&b, 200, None), out(&a, 100, Some("one"))];
        let (matched, unmatched) = match_rows(Network::Testnet, &rows, &outputs);
        assert_eq!(matched, vec![Some(1), Some(0)]);
        assert_eq!(unmatched, 0);
    }

    // covers: REQ-AUD-003
    #[test]
    fn a_difference_in_any_one_part_leaves_the_row_and_the_output_unmatched() {
        let (a, b) = (ua(1), ua(2));
        let rows = [row(&a, 100, Some("one"))];
        for changed in [
            out(&b, 100, Some("one")),  // another receiver
            out(&a, 101, Some("one")),  // another amount
            out(&a, 100, Some("two")),  // another memo
            out(&a, 100, None),         // a missing memo
            out(&a, 100, Some("one ")), // a memo that is not exactly the same
        ] {
            let (matched, unmatched) = match_rows(Network::Testnet, &rows, &[changed]);
            assert_eq!(matched, vec![None]);
            assert_eq!(unmatched, 1);
        }
    }

    // covers: REQ-AUD-003
    #[test]
    fn one_output_confirms_one_row_only() {
        let a = ua(1);
        // Two identical rows, one output: the second row is not confirmed.
        let rows = [row(&a, 100, None), row(&a, 100, None)];
        let (matched, unmatched) = match_rows(Network::Testnet, &rows, &[out(&a, 100, None)]);
        assert_eq!(matched, vec![Some(0), None]);
        assert_eq!(unmatched, 0);
        // One row, two identical outputs: one output is left over.
        let rows = [row(&a, 100, None)];
        let (matched, unmatched) = match_rows(
            Network::Testnet,
            &rows,
            &[out(&a, 100, None), out(&a, 100, None)],
        );
        assert_eq!(matched, vec![Some(0)]);
        assert_eq!(unmatched, 1);
    }

    // covers: REQ-AUD-003
    #[test]
    fn a_row_without_an_orchard_receiver_is_never_confirmed() {
        let transparent = CampaignKeys::derive(&SEED, ZNetwork::TestNetwork, 3)
            .unwrap()
            .funding_address();
        let rows = [row(&transparent, 100, None)];
        let (matched, unmatched) = match_rows(Network::Testnet, &rows, &[out(&ua(3), 100, None)]);
        assert_eq!(matched, vec![None]);
        assert_eq!(unmatched, 1);
    }
}
