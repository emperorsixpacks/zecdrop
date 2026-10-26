//! What a key-less verifier can establish about one batch transaction (REQ-VER-001).
//!
//! From the raw transaction and the transparent outputs it spends, with no keys:
//!
//! ```text
//! T_in  = sum of the values of the outputs the inputs spend
//! T_out = sum of the transparent output values
//! VB    = sum of the shielded value balances           (signed, as encoded)
//! NET   = -VB of the paying pool                       value that entered the pool
//! FEE   = T_in - T_out - NET                           consensus guarantees FEE >= 0
//! ```
//!
//! The fee is *reported*, never compared with a fixed per-action rate: librustzcash
//! pays 5000 per action while Zebra's mempool accepts 1000.
//!
//! `NET` is only as trustworthy as the transaction's own consistency, so the
//! binding signature of each Orchard-family bundle is verified against the
//! shielded sighash (which commits to the resolved prevouts). A tampered value
//! balance fails that check. Spend-authorization signatures and Halo2 proofs are
//! not re-verified: for a transaction already mined, consensus did that, and this
//! check exists to make the *published numbers* internally unforgeable.
//!
//! What this cannot establish, by design: where the shielded value went, who
//! received it, or whether any action is a hidden spend. That is the auditor's job.

use std::io::Cursor;

use drop_core::{OutPoint, Pool, Txid, Zatoshi};
use zcash_primitives::transaction::{
    sighash::{signature_hash, SignableInput},
    txid::TxIdDigester,
    Authorization, Transaction, TransactionData, TxId, TxVersion,
};
use zcash_protocol::{consensus::BranchId, value::Zatoshis};
use zcash_transparent::{
    address::Script,
    bundle::{self as tbundle, OutPoint as ZOutPoint, TxIn, TxOut},
    sighash::TransparentAuthorizingContext,
};

/// Why the bytes are not a transaction this verifier reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unparseable;

/// A fact-level problem found in one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    /// An input's value could not be looked up.
    PrevoutUnresolved,
    /// Inputs are worth less than outputs plus shielded value.
    NegativeFee,
    /// A bundle's value balance fails its own binding signature.
    BalanceMismatch,
    /// The transaction does not move value into the expected pool.
    UnexpectedPool,
}

/// The facts about one transaction. `None` means the fact was not established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxAnalysis {
    /// The first transparent input's previous output, if the transaction has inputs.
    pub funding_input: Option<OutPoint>,
    /// Value that entered the shielded pool.
    pub net_into_pool: Option<Zatoshi>,
    /// The fee paid.
    pub fee: Option<Zatoshi>,
    /// Shielded actions in the paying pool's bundle.
    pub shielded_actions: Option<u32>,
    /// The pool paid into.
    pub pool: Option<Pool>,
    /// Problems found; empty if the transaction checks out.
    pub problems: Vec<Problem>,
}

/// A transaction parsed from bytes.
pub struct ParsedTx {
    tx: Transaction,
    txid: Txid,
}

/// A transparent input's previous output reference, in the chain's own types.
pub type Prevout = ZOutPoint;

/// Converts a librustzcash txid (wire order) to the display-order [`Txid`].
pub fn core_txid(id: TxId) -> Txid {
    let mut bytes = *id.as_ref();
    bytes.reverse();
    Txid::from_bytes(bytes)
}

/// Converts a display-order [`Txid`] to the 32 bytes the chain uses on the wire.
pub fn wire_txid_bytes(txid: &Txid) -> [u8; 32] {
    let mut bytes = *txid.as_bytes();
    bytes.reverse();
    bytes
}

/// The display-order outpoint for a transparent previous-output reference.
pub fn core_outpoint(prevout: &Prevout) -> OutPoint {
    let mut hash = *prevout.hash();
    hash.reverse();
    OutPoint {
        txid: Txid::from_bytes(hash),
        vout: prevout.n(),
    }
}

impl ParsedTx {
    /// Parses a V5 or V6 transaction, requiring that the bytes are exactly one.
    pub fn parse(raw: &[u8]) -> Result<ParsedTx, Unparseable> {
        let mut cursor = Cursor::new(raw);
        // The branch id argument only matters for pre-V5 formats; V5 and V6 carry theirs.
        let tx = Transaction::read(&mut cursor, BranchId::Nu6_3).map_err(|_| Unparseable)?;
        if usize::try_from(cursor.position()).ok() != Some(raw.len()) {
            return Err(Unparseable);
        }
        Ok(ParsedTx {
            txid: core_txid(tx.txid()),
            tx,
        })
    }

    /// Parses any transaction version. Used for funding transactions, whose
    /// outputs are needed but whose version can be old.
    pub fn parse_any_version(raw: &[u8]) -> Result<ParsedTx, Unparseable> {
        let mut cursor = Cursor::new(raw);
        let tx = Transaction::read(&mut cursor, BranchId::Nu6_3).map_err(|_| Unparseable)?;
        if usize::try_from(cursor.position()).ok() != Some(raw.len()) {
            return Err(Unparseable);
        }
        Ok(ParsedTx {
            txid: core_txid(tx.txid()),
            tx,
        })
    }

    /// Whether this is a V5 or V6 transaction, the only formats a batch can use.
    pub fn is_v5_or_later(&self) -> bool {
        matches!(self.tx.version(), TxVersion::V5 | TxVersion::V6)
    }

    /// The transaction id computed from the bytes.
    pub fn txid(&self) -> Txid {
        self.txid
    }

    /// The parsed transaction, for modules of this crate that read more than the totals.
    pub(crate) fn transaction(&self) -> &Transaction {
        &self.tx
    }

    /// The previous outputs this transaction's transparent inputs spend, in order.
    pub fn prevouts(&self) -> Vec<Prevout> {
        self.tx
            .transparent_bundle()
            .map(|bundle| bundle.vin.iter().map(|i| i.prevout().clone()).collect())
            .unwrap_or_default()
    }

    /// The transparent output at `index`, for use as someone else's prevout.
    pub fn output(&self, index: u32) -> Option<TxOut> {
        let index = usize::try_from(index).ok()?;
        self.tx.transparent_bundle()?.vout.get(index).cloned()
    }

    /// Establishes the public facts, given a way to look up spent outputs and the
    /// pool the campaign is expected to pay into.
    pub fn analyze(
        &self,
        resolve: impl Fn(&Prevout) -> Option<TxOut>,
        expected_pool: Pool,
    ) -> TxAnalysis {
        let mut problems = Vec::new();
        let tx = &self.tx;

        // ---- which pool, how much, how many actions --------------------------------
        let sapling_used = tx
            .sapling_bundle()
            .is_some_and(|b| !b.shielded_spends().is_empty() || !b.shielded_outputs().is_empty());
        let orchard_actions = tx.orchard_bundle().map_or(0, |b| b.actions().len());
        let ironwood_actions = tx.ironwood_bundle().map_or(0, |b| b.actions().len());

        let pool = match (sapling_used, orchard_actions > 0, ironwood_actions > 0) {
            (false, false, true) => Some(Pool::Ironwood),
            (false, true, false) => Some(Pool::Orchard),
            _ => None,
        };
        let shielded_actions = match pool {
            Some(Pool::Ironwood) => u32::try_from(ironwood_actions).ok(),
            Some(Pool::Orchard) => u32::try_from(orchard_actions).ok(),
            None => None,
        };
        let pool_balance = match pool {
            Some(Pool::Ironwood) => tx.ironwood_bundle().map(|b| i64::from(*b.value_balance())),
            Some(Pool::Orchard) => tx.orchard_bundle().map(|b| i64::from(*b.value_balance())),
            None => None,
        };
        // Value entering the pool is the negated value balance, and must be positive.
        let net_into_pool = pool_balance.and_then(net_into_pool_from);
        if pool != Some(expected_pool) || net_into_pool.is_none() {
            problems.push(Problem::UnexpectedPool);
        }

        // ---- transparent side -------------------------------------------------------
        let bundle = tx.transparent_bundle();
        let funding_input = bundle
            .and_then(|b| b.vin.first())
            .map(|input| core_outpoint(input.prevout()));
        let t_out: i128 = bundle.map_or(0, |b| {
            b.vout
                .iter()
                .map(|o| i128::from(u64::from(o.value())))
                .sum()
        });

        let resolved: Option<Vec<TxOut>> = match bundle {
            Some(b) => b.vin.iter().map(|i| resolve(i.prevout())).collect(),
            None => Some(Vec::new()),
        };

        // ---- fee and binding signatures (need every prevout) ------------------------
        let mut fee = None;
        match resolved {
            None => problems.push(Problem::PrevoutUnresolved),
            Some(coins) => {
                let t_in: i128 = coins.iter().map(|c| i128::from(u64::from(c.value()))).sum();
                let value_balance: i128 = [
                    i64::from(tx.sapling_value_balance()),
                    tx.orchard_bundle()
                        .map_or(0, |b| i64::from(*b.value_balance())),
                    tx.ironwood_bundle()
                        .map_or(0, |b| i64::from(*b.value_balance())),
                ]
                .iter()
                .map(|v| i128::from(*v))
                .sum();
                let implied = t_in - t_out + value_balance;
                match u64::try_from(implied)
                    .ok()
                    .and_then(|f| Zatoshi::new(f).ok())
                {
                    Some(f) => fee = Some(f),
                    None => problems.push(Problem::NegativeFee),
                }
                if !self.binding_signatures_verify(coins) {
                    problems.push(Problem::BalanceMismatch);
                }
            }
        }

        TxAnalysis {
            funding_input,
            net_into_pool,
            fee,
            shielded_actions,
            pool,
            problems,
        }
    }

    /// Verifies the RedPallas binding signature of the Orchard and Ironwood bundles
    /// against the shielded sighash, which commits to the resolved prevouts.
    fn binding_signatures_verify(&self, coins: Vec<TxOut>) -> bool {
        let data: TransactionData<VerifyAuth> = self.tx.clone().into_data().map_bundles(
            |transparent| {
                transparent.map(|b| tbundle::Bundle {
                    vin: b
                        .vin
                        .into_iter()
                        .map(|i| {
                            TxIn::from_parts(
                                i.prevout().clone(),
                                i.script_sig().clone(),
                                i.sequence(),
                            )
                        })
                        .collect(),
                    vout: b.vout,
                    authorization: ResolvedPrevouts(coins),
                })
            },
            |sapling| sapling,
            |orchard| orchard,
        );
        let txid_parts = data.digest(TxIdDigester);
        let sighash: [u8; 32] =
            *signature_hash(&data, &SignableInput::Shielded, &txid_parts).as_ref();

        let verified = [data.orchard_bundle(), data.ironwood_bundle()]
            .into_iter()
            .flatten()
            .all(|bundle| {
                bundle
                    .binding_validating_key()
                    .verify(&sighash, bundle.authorization().binding_signature())
                    .is_ok()
            });
        verified
    }
}

/// The value that entered a pool, from its signed value balance: the negation, which
/// must be strictly positive and within the money supply. A zero or positive balance
/// (nothing entered, or value left the pool) is not a payout.
pub(crate) fn net_into_pool_from(value_balance: i64) -> Option<Zatoshi> {
    value_balance
        .checked_neg()
        .filter(|net| *net > 0)
        .and_then(|net| u64::try_from(net).ok())
        .and_then(|net| Zatoshi::new(net).ok())
}

/// Transparent authorization carrying the resolved prevouts, which the shielded
/// sighash commits to once a transaction has transparent inputs.
#[derive(Debug)]
struct ResolvedPrevouts(Vec<TxOut>);

impl tbundle::Authorization for ResolvedPrevouts {
    type ScriptSig = Script;
}

impl TransparentAuthorizingContext for ResolvedPrevouts {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        self.0.iter().map(|c| c.value()).collect()
    }

    fn input_scriptpubkeys(&self) -> Vec<Script> {
        self.0.iter().map(|c| c.script_pubkey().clone()).collect()
    }
}

struct VerifyAuth;

impl Authorization for VerifyAuth {
    type TransparentAuth = ResolvedPrevouts;
    type SaplingAuth = sapling_crypto::bundle::Authorized;
    type OrchardAuth = orchard::bundle::Authorized;
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-VER-001
    #[test]
    fn only_a_negative_value_balance_inside_the_supply_is_value_entering_the_pool() {
        assert_eq!(
            net_into_pool_from(-6_000_003),
            Some(Zatoshi::new(6_000_003).unwrap())
        );
        assert_eq!(net_into_pool_from(-1), Some(Zatoshi::new(1).unwrap()));
        assert_eq!(
            net_into_pool_from(-(drop_core::MAX_MONEY as i64)),
            Some(Zatoshi::MAX)
        );
        // Nothing entered, value left the pool, or a number that cannot be a balance.
        assert_eq!(net_into_pool_from(0), None);
        assert_eq!(net_into_pool_from(1), None);
        assert_eq!(net_into_pool_from(i64::MAX), None);
        assert_eq!(
            net_into_pool_from(i64::MIN),
            None,
            "negating i64::MIN overflows"
        );
        assert_eq!(net_into_pool_from(-(drop_core::MAX_MONEY as i64) - 1), None);
    }
}
