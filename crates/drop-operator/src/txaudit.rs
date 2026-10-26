//! Auditing one transaction from files (REQ-AUD-001), with no store and no node.
//!
//! [`crate::audit`] reconciles a whole campaign: it needs the campaign in the store and a chain
//! source. This is its smaller sibling for a transaction already in hand: the raw bytes (hex), the
//! outputs it spends (value and script, as read from the chain), and a viewing key. It recovers
//! the outputs the key can open and reports, from the same comparisons the campaign audit makes,
//! whether their number and their sum equal what the chain publishes for the transaction.
//!
//! It checks no payout list and no manifest commitment, because it has none. The report holds
//! counts, public sums and the transaction id; no address, memo or per-recipient amount. The key
//! is read the same way as for the campaign audit (stdin or a file, never the command line), or
//! derived from a testnet development seed file and a campaign account number.

use std::path::Path;

use drop_core::{Network, Txid, Zatoshi};
use drop_verify::ParsedTx;
use drop_zcash::inspect::{public_totals, recover_with_ufvk, InspectError};
use drop_zcash::zcash_network;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::Script;
use zcash_transparent::bundle::{OutPoint, TxOut};

use crate::audit::{compare, AuditError};

/// Files are small; anything bigger is not what this expects.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Why a transaction could not be audited. Fixed text; never the key or any content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TxAuditError {
    /// A file could not be read.
    #[error("a file could not be read")]
    Unreadable,
    /// The transaction file is not hexadecimal.
    #[error("the transaction file is not hexadecimal")]
    BadHex,
    /// The prevouts file is not what was expected.
    #[error("the prevouts file is not a list of {{txid, index, value_zat, script_pubkey_hex}}")]
    BadPrevouts,
    /// The bytes are not a transaction this tool can read.
    #[error("the bytes are not a transaction this tool can read")]
    Unparseable,
    /// A spent output is missing from the prevouts file.
    #[error("the prevouts file does not list every output the transaction spends")]
    UnresolvedPrevout,
    /// The viewing key could not be used.
    #[error(transparent)]
    Key(#[from] AuditError),
}

/// One spent output, as listed in a `prevouts.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prevout {
    /// The transaction that created it, in display order.
    pub txid: String,
    /// Its output index.
    pub index: u32,
    /// Its value in zatoshi.
    pub value_zat: u64,
    /// Its script, hexadecimal.
    pub script_pubkey_hex: String,
}

/// What one transaction audit found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TxAudit {
    /// The transaction.
    pub txid: Txid,
    /// The network.
    pub network: Network,
    /// The shielded pool the transaction pays into.
    pub pool: &'static str,
    /// Shielded actions the transaction publishes in that pool.
    pub public_actions: u32,
    /// Value entering the pool, as published.
    pub public_net_into_pool: Option<Zatoshi>,
    /// Transparent value in, out, and the fee.
    pub transparent_in: Zatoshi,
    /// Transparent value out.
    pub transparent_out: Zatoshi,
    /// The fee paid.
    pub fee: Option<Zatoshi>,
    /// Whether `in = out + net into the pool + fee` with a fee of at least zero.
    pub balances: bool,
    /// Outputs recovered with the viewing key.
    pub recovered_outputs: u32,
    /// Their values added up.
    pub recovered_sum: Option<Zatoshi>,
    /// Whether the recovered count equals the public action count (`null`: one output is padded
    /// to two actions, so the counts differ by design).
    pub count_matches: Option<bool>,
    /// Whether the recovered sum equals the published net value.
    pub sum_matches: Option<bool>,
    /// True only if the transaction balances and the count and sum both match.
    pub reconciled: bool,
}

fn read_small(path: &Path) -> Result<Vec<u8>, TxAuditError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| TxAuditError::Unreadable)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(TxAuditError::Unreadable);
    }
    Ok(bytes)
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// Reads a transaction from a file of hexadecimal text.
pub fn read_tx_hex(path: &Path) -> Result<Vec<u8>, TxAuditError> {
    let text = String::from_utf8(read_small(path)?).map_err(|_| TxAuditError::BadHex)?;
    unhex(&text).ok_or(TxAuditError::BadHex)
}

/// Reads a list of spent outputs from a `prevouts.json`.
pub fn read_prevouts(path: &Path) -> Result<Vec<Prevout>, TxAuditError> {
    serde_json::from_slice(&read_small(path)?).map_err(|_| TxAuditError::BadPrevouts)
}

/// The spent outputs, keyed the way the transaction names them (wire order of the txid).
fn outputs(prevouts: &[Prevout]) -> Result<Vec<(OutPoint, TxOut)>, TxAuditError> {
    prevouts
        .iter()
        .map(|p| {
            let mut wire: [u8; 32] = unhex(&p.txid)
                .and_then(|b| b.try_into().ok())
                .ok_or(TxAuditError::BadPrevouts)?;
            wire.reverse();
            let script = unhex(&p.script_pubkey_hex).ok_or(TxAuditError::BadPrevouts)?;
            // `Script::read` takes the length-prefixed form.
            let mut prefixed = Vec::with_capacity(script.len() + 3);
            match u16::try_from(script.len()) {
                Ok(n) if n < 0xfd => prefixed.push(n as u8),
                Ok(n) => {
                    prefixed.push(0xfd);
                    prefixed.extend_from_slice(&n.to_le_bytes());
                }
                Err(_) => return Err(TxAuditError::BadPrevouts),
            }
            prefixed.extend_from_slice(&script);
            let script =
                Script::read(prefixed.as_slice()).map_err(|_| TxAuditError::BadPrevouts)?;
            let value = Zatoshis::from_u64(p.value_zat).map_err(|_| TxAuditError::BadPrevouts)?;
            Ok((OutPoint::new(wire, p.index), TxOut::new(value, script)))
        })
        .collect()
}

/// Reconciled only if the transaction balances, the count does not differ (it may be not
/// comparable) and the sum is known to match.
fn verdict(balances: bool, count_matches: Option<bool>, sum_matches: Option<bool>) -> bool {
    balances && count_matches != Some(false) && sum_matches == Some(true)
}

fn zat(value: i64) -> Option<Zatoshi> {
    u64::try_from(value).ok().and_then(|v| Zatoshi::new(v).ok())
}

/// Audits one transaction against a viewing key. See the module docs.
pub fn audit_transaction(
    raw: &[u8],
    prevouts: &[Prevout],
    network: Network,
    ufvk: &str,
) -> Result<TxAudit, TxAuditError> {
    let spent = outputs(prevouts)?;
    let totals = public_totals(raw, |wanted| {
        spent
            .iter()
            .find(|(outpoint, _)| outpoint.hash() == wanted.hash() && outpoint.n() == wanted.n())
            .map(|(_, coin)| coin.clone())
    })
    .map_err(|e| match e {
        InspectError::UnresolvedPrevout => TxAuditError::UnresolvedPrevout,
        _ => TxAuditError::Unparseable,
    })?;
    let txid = ParsedTx::parse(raw)
        .map_err(|_| TxAuditError::Unparseable)?
        .txid();

    let outputs = recover_with_ufvk(raw, zcash_network(network), ufvk).map_err(|e| match e {
        InspectError::BadViewingKey => TxAuditError::Key(AuditError::UfvkNetwork),
        _ => TxAuditError::Unparseable,
    })?;
    let recovered_outputs = u32::try_from(outputs.len()).unwrap_or(u32::MAX);
    let recovered_sum = Zatoshi::new(outputs.iter().map(|o| o.value).sum()).ok();

    let (pool, actions, net) = if totals.ironwood_actions > 0 {
        (
            "ironwood",
            totals.ironwood_actions,
            totals.net_into_ironwood,
        )
    } else {
        ("orchard", totals.orchard_actions, totals.net_into_shielded)
    };
    let public_actions = u32::try_from(actions).unwrap_or(u32::MAX);
    let public_net = zat(net);
    // How many recipients the transaction was meant for is unknown here: one recovered output in
    // a two-action bundle is the padded single-recipient case, anything else is compared.
    let planned = if recovered_outputs == 1 && public_actions == 2 {
        1
    } else {
        recovered_outputs.max(2)
    };
    let (count_matches, sum_matches) = compare(
        planned,
        Some(public_actions),
        recovered_outputs,
        public_net,
        recovered_sum,
    );
    let balances = totals.balances();
    Ok(TxAudit {
        txid,
        network,
        pool,
        public_actions,
        public_net_into_pool: public_net,
        transparent_in: Zatoshi::new(totals.t_in_total).unwrap_or(Zatoshi::ZERO),
        transparent_out: Zatoshi::new(totals.t_out_total).unwrap_or(Zatoshi::ZERO),
        fee: zat(totals.fee),
        balances,
        recovered_outputs,
        recovered_sum,
        count_matches,
        sum_matches,
        reconciled: verdict(balances, count_matches, sum_matches),
    })
}

impl TxAudit {
    /// A human-readable summary. Never an address, a memo or a per-recipient amount.
    pub fn render(&self) -> String {
        let verdict = |v: Option<bool>| match v {
            Some(true) => "matches",
            Some(false) => "DIFFERS",
            None => "not comparable",
        };
        let coin = self.network.coin();
        let money = |z: Option<Zatoshi>| {
            z.map_or("?".to_owned(), |z| {
                format!("{} {coin} ({} zat)", z.format_zec(), z.as_u64())
            })
        };
        let mut out = format!(
            "Audit of transaction {} ({}, {})\n",
            self.txid, self.network, self.pool
        );
        out.push_str(&format!(
            "  public: {} shielded actions, {} into the pool, fee {}; transparent in {} out {}: {}\n",
            self.public_actions,
            money(self.public_net_into_pool),
            money(self.fee),
            money(Some(self.transparent_in)),
            money(Some(self.transparent_out)),
            if self.balances { "balances" } else { "DOES NOT BALANCE" }
        ));
        out.push_str(&format!(
            "  outputs recovered {} of {} public actions: {}\n",
            self.recovered_outputs,
            self.public_actions,
            verdict(self.count_matches)
        ));
        out.push_str(&format!(
            "  recovered total {} vs public net into pool {}: {}\n",
            money(self.recovered_sum),
            money(self.public_net_into_pool),
            verdict(self.sum_matches)
        ));
        out.push_str(if self.reconciled {
            "\nRESULT: reconciled. The key opens outputs that add up to what the chain publishes.\n"
        } else {
            "\nRESULT: NOT reconciled. See the differences above.\n"
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-AUD-001
    #[test]
    fn the_verdict_needs_every_condition_and_each_one_alone_breaks_it() {
        assert!(verdict(true, Some(true), Some(true)));
        assert!(
            verdict(true, None, Some(true)),
            "an incomparable count does not block"
        );
        assert!(!verdict(false, Some(true), Some(true)), "does not balance");
        assert!(!verdict(true, Some(false), Some(true)), "count differs");
        assert!(!verdict(true, Some(true), Some(false)), "sum differs");
        assert!(
            !verdict(true, None, Some(false)),
            "sum differs, count incomparable"
        );
        assert!(!verdict(true, Some(true), None), "sum unknown");
        assert!(!verdict(true, None, None));
    }
}
