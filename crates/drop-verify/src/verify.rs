//! Verifying a campaign from the chain (REQ-VER-001, REQ-VER-003).
//!
//! Given the batch transaction ids a campaign publishes, its declared total and its
//! manifest commitment, [`verify_campaign`] reads each transaction and the outputs
//! it spends from a [`ChainSource`], establishes the public facts, and returns a
//! [`PublicReceipt`]. Whatever cannot be established becomes a [`Finding`]; nothing
//! here panics on bad data, and nothing a source says is copied into the receipt as
//! text.
//!
//! A source that cannot answer at all (unreachable) is *not* a finding: it is an
//! error, so an outage can never look like "your transaction does not exist".
//!
//! Funding (REQ-VER-004): each batch's funding address is the transparent P2PKH address every
//! one of its inputs spends from, encoded for the request's network. It is unknown (`None`) when
//! an input cannot be resolved or is not P2PKH. A batch whose inputs come from more than one
//! address gets a [`Finding::MixedFundingSources`] here; mixing *between* batches is detected
//! by `PublicReceipt::from_chain_facts_with_funding`.

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use drop_core::{
    BatchReceipt, CampaignId, ChainReceiptInputs, Finding, ManifestCommitment, Network, Pool,
    PublicReceipt, ReceiptError, Txid, Zatoshi,
};
use thiserror::Error;
use zcash_address::{ToAddress, ZcashAddress};
use zcash_protocol::consensus::NetworkType;
use zcash_transparent::bundle::TxOut;

use crate::analyze::{ParsedTx, Problem, Unparseable};
use crate::source::{confirmations, ChainSource, SourceError};

/// What to verify.
#[derive(Clone, Debug)]
pub struct VerifyRequest {
    /// The network the transactions are on.
    pub network: Network,
    /// The campaign's batch transactions, in batch order.
    pub txids: Vec<Txid>,
    /// The commitment the campaign published.
    pub manifest_commitment: ManifestCommitment,
    /// The total the campaign declares it moved into the pool.
    pub declared_total: Zatoshi,
    /// The campaign id, if the caller names it (echoed, not checked).
    pub campaign_id: Option<CampaignId>,
}

/// How to judge it.
#[derive(Clone, Copy, Debug)]
pub struct VerifyConfig {
    /// Confirmations at which a batch is final; below that it is pending.
    pub required_depth: u32,
    /// The pool batches must pay into.
    pub expected_pool: Pool,
}

impl Default for VerifyConfig {
    fn default() -> Self {
        VerifyConfig {
            required_depth: 3,
            expected_pool: Pool::Ironwood,
        }
    }
}

/// Why no receipt could be produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum VerifyError {
    /// The chain source failed; try again later.
    #[error(transparent)]
    Source(#[from] SourceError),
    /// The request lists no transactions.
    #[error("no transactions to verify")]
    NoTransactions,
    /// The same transaction id appears twice, which would count its value twice.
    #[error("a transaction id appears more than once")]
    DuplicateTxid,
    /// The required depth must be at least one.
    #[error("the required confirmation depth must be at least 1")]
    ZeroDepth,
    /// The receipt could not be assembled.
    #[error(transparent)]
    Receipt(#[from] ReceiptError),
}

/// A funding transaction's outputs, fetched once per request.
type OutputCache = HashMap<Txid, Option<ParsedTx>>;

/// Verifies a campaign against the chain. See the module docs.
pub async fn verify_campaign<S: ChainSource>(
    source: &S,
    request: &VerifyRequest,
    config: &VerifyConfig,
) -> Result<PublicReceipt, VerifyError> {
    if request.txids.is_empty() {
        return Err(VerifyError::NoTransactions);
    }
    if config.required_depth == 0 {
        return Err(VerifyError::ZeroDepth);
    }
    for (i, txid) in request.txids.iter().enumerate() {
        if request.txids[..i].contains(txid) {
            return Err(VerifyError::DuplicateTxid);
        }
    }

    let tip = source.tip_height().await?;
    let mut funding: OutputCache = HashMap::new();
    let mut batches = Vec::with_capacity(request.txids.len());
    let mut findings = Vec::new();
    let mut funding_addresses: Vec<Option<String>> = Vec::with_capacity(request.txids.len());

    for (position, txid) in request.txids.iter().enumerate() {
        let index = u32::try_from(position).unwrap_or(u32::MAX);
        let mut batch = BatchReceipt {
            index,
            txid: Some(*txid),
            funding_input: None,
            net_into_pool: None,
            fee: None,
            shielded_actions: None,
            pool: None,
            confirmations: 0,
        };

        let Some(fetched) = source.transaction(txid).await? else {
            findings.push(Finding::TxNotFound { batch_index: index });
            batches.push(batch);
            funding_addresses.push(None);
            continue;
        };
        let parsed = match ParsedTx::parse(&fetched.raw) {
            Ok(parsed) if parsed.is_v5_or_later() => parsed,
            Ok(_) | Err(Unparseable) => {
                findings.push(Finding::TxUnparseable { batch_index: index });
                batches.push(batch);
                funding_addresses.push(None);
                continue;
            }
        };
        if parsed.txid() != *txid {
            // The source answered with a different transaction than the one asked for.
            return Err(VerifyError::Source(SourceError::Inconsistent));
        }
        batch.confirmations = confirmations(tip, fetched.mined_height);

        // Look up every spent output (once per funding transaction).
        let prevouts = parsed.prevouts();
        for prevout in &prevouts {
            let funding_txid = core_txid_from_wire(prevout.hash());
            if let Entry::Vacant(slot) = funding.entry(funding_txid) {
                slot.insert(load_funding(source, &funding_txid).await?);
            }
        }
        let resolve = |prevout: &crate::analyze::Prevout| -> Option<TxOut> {
            let funding_txid = core_txid_from_wire(prevout.hash());
            funding.get(&funding_txid)?.as_ref()?.output(prevout.n())
        };

        let per_input: Option<Vec<String>> = prevouts
            .iter()
            .map(|p| resolve(p).and_then(|coin| p2pkh_address(&coin, request.network)))
            .collect();
        funding_addresses.push(match common_address(per_input) {
            Ok(address) => address,
            Err(MixedInputs) => {
                findings.push(Finding::MixedFundingSources { batch_index: index });
                None
            }
        });

        let analysis = parsed.analyze(resolve, config.expected_pool);
        batch.funding_input = analysis.funding_input;
        batch.net_into_pool = analysis.net_into_pool;
        batch.fee = analysis.fee;
        batch.shielded_actions = analysis.shielded_actions;
        batch.pool = analysis.pool;
        for problem in analysis.problems {
            findings.push(match problem {
                Problem::PrevoutUnresolved => Finding::PrevoutUnresolved { batch_index: index },
                Problem::NegativeFee => Finding::NegativeFee { batch_index: index },
                Problem::BalanceMismatch => Finding::BalanceMismatch { batch_index: index },
                Problem::UnexpectedPool => Finding::UnexpectedPool { batch_index: index },
            });
        }
        batches.push(batch);
    }

    Ok(PublicReceipt::from_chain_facts_with_funding(
        ChainReceiptInputs {
            campaign_id: request.campaign_id.as_ref(),
            network: request.network,
            manifest_commitment: request.manifest_commitment,
            declared_total: request.declared_total,
            required_depth: config.required_depth,
            batches,
            findings,
        },
        &funding_addresses,
    )?)
}

/// A batch whose inputs spend from more than one address.
#[derive(Debug, PartialEq, Eq)]
struct MixedInputs;

/// The one address all of a batch's inputs spend from, given each input's address (`None` if
/// any input's address is unknown). Unknown when an input is unknown or there are no inputs.
fn common_address(per_input: Option<Vec<String>>) -> Result<Option<String>, MixedInputs> {
    let Some(mut addresses) = per_input else {
        return Ok(None);
    };
    addresses.dedup();
    match addresses.len() {
        0 => Ok(None),
        1 => Ok(addresses.pop()),
        _ => Err(MixedInputs),
    }
}

/// The transparent address a P2PKH output pays, encoded for `network` (`t1…` or `tm…`).
/// `None` for any other script. Key-less: it only re-encodes the 20-byte hash in the script.
pub fn p2pkh_address(coin: &TxOut, network: Network) -> Option<String> {
    // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    let script = &coin.script_pubkey().0 .0;
    let hash: [u8; 20] = match script.as_slice() {
        [0x76, 0xa9, 0x14, hash @ .., 0x88, 0xac] => hash.try_into().ok()?,
        _ => return None,
    };
    let net = match network {
        Network::Testnet => NetworkType::Test,
        Network::Mainnet => NetworkType::Main,
    };
    Some(ZcashAddress::from_transparent_p2pkh(net, hash).encode())
}

fn core_txid_from_wire(hash: &[u8; 32]) -> Txid {
    let mut display = *hash;
    display.reverse();
    Txid::from_bytes(display)
}

/// Fetches a funding transaction. An unknown or unreadable one yields `None`, which
/// leaves the spending input unresolved; a source that returns the wrong
/// transaction is an error.
async fn load_funding<S: ChainSource>(
    source: &S,
    txid: &Txid,
) -> Result<Option<ParsedTx>, VerifyError> {
    let Some(fetched) = source.transaction(txid).await? else {
        return Ok(None);
    };
    match ParsedTx::parse_any_version(&fetched.raw) {
        Ok(parsed) if parsed.txid() == *txid => Ok(Some(parsed)),
        Ok(_) => Err(VerifyError::Source(SourceError::Inconsistent)),
        Err(Unparseable) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::value::Zatoshis;

    fn owned(list: &[&str]) -> Option<Vec<String>> {
        Some(list.iter().map(|a| (*a).to_owned()).collect())
    }

    // covers: REQ-VER-004
    #[test]
    fn a_batch_has_one_funding_address_only_if_every_input_agrees() {
        let (a, b) = (
            "tmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "tmBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        );
        assert_eq!(common_address(owned(&[a])), Ok(Some(a.to_owned())));
        assert_eq!(common_address(owned(&[a, a, a])), Ok(Some(a.to_owned())));
        assert_eq!(common_address(owned(&[a, b])), Err(MixedInputs));
        // Not adjacent: still mixed.
        assert_eq!(common_address(owned(&[a, b, a])), Err(MixedInputs));
        assert_eq!(common_address(owned(&[])), Ok(None));
        assert_eq!(common_address(None), Ok(None));
    }

    // covers: REQ-VER-004
    #[test]
    fn only_a_p2pkh_script_names_an_address() {
        use zcash_transparent::address::{Script, TransparentAddress};
        let coin = |script: Script| TxOut::new(Zatoshis::const_from_u64(1), script);
        let p2pkh = || {
            coin(
                TransparentAddress::PublicKeyHash([0xc9; 20])
                    .script()
                    .into(),
            )
        };
        let p2sh = coin(TransparentAddress::ScriptHash([0xc9; 20]).script().into());

        let test = p2pkh_address(&p2pkh(), Network::Testnet).unwrap();
        let main = p2pkh_address(&p2pkh(), Network::Mainnet).unwrap();
        assert!(test.starts_with("tm"), "{test}");
        assert!(main.starts_with("t1"), "{main}");
        assert_eq!(p2pkh_address(&p2sh, Network::Testnet), None);
        assert_eq!(
            p2pkh_address(&coin(Script::default()), Network::Testnet),
            None
        );
    }
}
