//! Reading a built or mined batch.
//!
//! * [`public_totals`]: what anyone can compute from the raw tx plus the prevouts it spends
//!   (REQ-TX-001). Needs no keys.
//! * [`verify_proofs_and_signatures`]: the Halo2 proof, every RedPallas signature and each P2PKH
//!   ECDSA signature, as consensus checks them. Lets the operator self-check before broadcast.
//! * [`recover_with_ufvk`] / [`decrypt_with_ivk`]: what the campaign auditor and a recipient see
//!   (REQ-TX-002). Run locally; never in the hosted verifier.

use std::fmt;
use std::sync::OnceLock;

use orchard::{
    bundle::{Authorized as OrchardAuthorized, BatchValidator},
    circuit::{OrchardCircuitVersion, VerifyingKey},
    keys::{IncomingViewingKey, OutgoingViewingKey, Scope},
};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::{
    fees::zip317,
    sighash::{signature_hash, SignableInput},
    txid::TxIdDigester,
    Authorization, Transaction, TransactionData,
};
use zcash_protocol::{
    consensus::{BranchId, Network},
    value::{BalanceError, ZatBalance, Zatoshis},
};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    bundle::{self as tbundle, OutPoint, TxIn, TxOut},
    sighash::{
        SighashType, SignableInput as TransparentSignableInput, TransparentAuthorizingContext,
    },
};

use crate::memo::decode_memo;

/// Public totals of one transaction, in zatoshis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicTotals {
    pub size: usize,
    pub tx_version: String,
    pub branch_id: BranchId,
    pub t_in_count: usize,
    pub t_in_total: u64,
    pub t_out_count: usize,
    pub t_out_total: u64,
    pub sapling_io: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    /// `valueBalanceOrchard`; negative would mean value entering Orchard, which ZIP-258 forbids
    /// from NU6.3 (Zebra: `check::orchard_value_balance_non_negative`).
    pub orchard_value_balance: i64,
    /// `-valueBalanceIronwood`: the public amount paid into the Ironwood pool.
    pub net_into_ironwood: i64,
    /// Net value entering all shielded pools: `-(Sapling + Orchard + Ironwood valueBalance)`.
    pub net_into_shielded: i64,
    /// `t_in - t_out - net_into_shielded`.
    pub fee: i64,
    /// ZIP-317 logical actions recomputed from the public structure.
    pub zip317_logical_actions: usize,
}

impl PublicTotals {
    /// `t_in == t_out + net_into_shielded + fee` with `fee >= 0`.
    pub fn balances(&self) -> bool {
        self.fee >= 0
            && i128::from(self.t_in_total)
                == i128::from(self.t_out_total)
                    + i128::from(self.net_into_shielded)
                    + i128::from(self.fee)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InspectError {
    #[error("transaction does not parse: {0}")]
    Parse(String),
    #[error("a spent prevout could not be resolved")]
    UnresolvedPrevout,
    #[error("value arithmetic overflowed")]
    Balance,
    #[error("authorization check failed: {0}")]
    Authorization(String),
    #[error("viewing key does not decode for this network")]
    BadViewingKey,
}

pub(crate) fn parse(raw: &[u8]) -> Result<Transaction, InspectError> {
    // v5/v6 carry their consensus branch id in the header; the argument only matters for v4.
    Transaction::read(raw, BranchId::Nu6_3).map_err(|e| InspectError::Parse(e.to_string()))
}

fn serialized_len(write: impl FnOnce(&mut Vec<u8>) -> std::io::Result<()>) -> usize {
    let mut buf = Vec::new();
    write(&mut buf).expect("writing to a Vec cannot fail");
    buf.len()
}

/// Public totals from raw bytes; `resolve` supplies each spent prevout (from the chain).
pub fn public_totals(
    raw: &[u8],
    resolve: impl Fn(&OutPoint) -> Option<TxOut>,
) -> Result<PublicTotals, InspectError> {
    let tx = parse(raw)?;
    let (mut t_in_total, mut t_out_total, mut t_in_size, mut t_out_size) =
        (0u64, 0u64, 0usize, 0usize);
    let (mut t_in_count, mut t_out_count) = (0, 0);
    if let Some(t) = tx.transparent_bundle() {
        t_in_count = t.vin.len();
        t_out_count = t.vout.len();
        for txin in &t.vin {
            let coin = resolve(txin.prevout()).ok_or(InspectError::UnresolvedPrevout)?;
            t_in_total = t_in_total
                .checked_add(u64::from(coin.value()))
                .ok_or(InspectError::Balance)?;
            t_in_size += serialized_len(|w| txin.write(w));
        }
        for txout in &t.vout {
            t_out_total = t_out_total
                .checked_add(u64::from(txout.value()))
                .ok_or(InspectError::Balance)?;
            t_out_size += serialized_len(|w| txout.write(w));
        }
    }
    let sapling_vb = i64::from(tx.sapling_value_balance());
    let orchard_vb = tx
        .orchard_bundle()
        .map_or(0, |b| i64::from(*b.value_balance()));
    let ironwood_vb = tx
        .ironwood_bundle()
        .map_or(0, |b| i64::from(*b.value_balance()));
    let net_into_shielded = -(sapling_vb + orchard_vb + ironwood_vb);
    let fee = i64::try_from(t_in_total).map_err(|_| InspectError::Balance)?
        - i64::try_from(t_out_total).map_err(|_| InspectError::Balance)?
        - net_into_shielded;

    let orchard_actions = tx.orchard_bundle().map_or(0, |b| b.actions().len());
    let ironwood_actions = tx.ironwood_bundle().map_or(0, |b| b.actions().len());
    let (sapling_spends, sapling_outputs) = tx.sapling_bundle().map_or((0, 0), |b| {
        (b.shielded_spends().len(), b.shielded_outputs().len())
    });
    let zip317_logical_actions = t_in_size
        .div_ceil(zip317::P2PKH_STANDARD_INPUT_SIZE)
        .max(t_out_size.div_ceil(zip317::P2PKH_STANDARD_OUTPUT_SIZE))
        + sapling_spends.max(sapling_outputs)
        + orchard_actions
        + ironwood_actions;

    Ok(PublicTotals {
        size: raw.len(),
        tx_version: format!("{:?}", tx.version()),
        branch_id: tx.consensus_branch_id(),
        t_in_count,
        t_in_total,
        t_out_count,
        t_out_total,
        sapling_io: sapling_spends + sapling_outputs,
        orchard_actions,
        ironwood_actions,
        orchard_value_balance: orchard_vb,
        net_into_ironwood: -ironwood_vb,
        net_into_shielded,
        fee,
        zip317_logical_actions,
    })
}

// --- authorization -----------------------------------------------------------------------------

/// Transparent authorization carrying resolved prevouts, which ZIP 244 commits to in the
/// shielded sighash once a tx has transparent inputs.
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
    type OrchardAuth = OrchardAuthorized;
}

fn verifying_key(version: OrchardCircuitVersion) -> Result<&'static VerifyingKey, InspectError> {
    static FIXED_POST_NU6_2: OnceLock<VerifyingKey> = OnceLock::new();
    static POST_NU6_3: OnceLock<VerifyingKey> = OnceLock::new();
    let cell = match version {
        OrchardCircuitVersion::FixedPostNu6_2 => &FIXED_POST_NU6_2,
        OrchardCircuitVersion::PostNu6_3 => &POST_NU6_3,
        other => {
            return Err(InspectError::Authorization(format!(
                "unsupported circuit {other:?}"
            )))
        }
    };
    Ok(cell.get_or_init(|| VerifyingKey::build(version)))
}

/// Verifies every proof and signature the way consensus does (except script execution, which is
/// reduced to the P2PKH checks: HASH160(pubkey) matches the prevout, ECDSA over the ZIP-244 sighash).
pub fn verify_proofs_and_signatures(
    raw: &[u8],
    resolve: impl Fn(&OutPoint) -> Option<TxOut>,
) -> Result<(), InspectError> {
    let tx = parse(raw)?;
    let coins: Vec<TxOut> = tx.transparent_bundle().map_or(Ok(vec![]), |b| {
        b.vin
            .iter()
            .map(|i| resolve(i.prevout()).ok_or(InspectError::UnresolvedPrevout))
            .collect()
    })?;
    let data: TransactionData<VerifyAuth> = tx.into_data().map_bundles(
        |t| {
            t.map(|b| tbundle::Bundle {
                vin: b
                    .vin
                    .into_iter()
                    .map(|i| {
                        TxIn::from_parts(i.prevout().clone(), i.script_sig().clone(), i.sequence())
                    })
                    .collect(),
                vout: b.vout,
                authorization: ResolvedPrevouts(coins),
            })
        },
        |s| s,
        |o| o,
    );
    let txid_parts = data.digest(TxIdDigester);
    let shielded_sighash: [u8; 32] =
        *signature_hash(&data, &SignableInput::Shielded, &txid_parts).as_ref();

    for bundle in [data.orchard_bundle(), data.ironwood_bundle()]
        .into_iter()
        .flatten()
    {
        let mut validator =
            BatchValidator::new(verifying_key(bundle.bundle_version().circuit_version())?);
        validator
            .add_bundle(bundle, shielded_sighash)
            .map_err(|e| InspectError::Authorization(format!("{e:?}")))?;
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| InspectError::Authorization(e.to_string()))?;
        if !validator.validate(ChaCha20Rng::from_seed(seed)) {
            return Err(InspectError::Authorization(
                "shielded proof or signature is invalid".into(),
            ));
        }
    }

    if let Some(t) = data.transparent_bundle() {
        for (i, txin) in t.vin.iter().enumerate() {
            let coin = &t.authorization.0[i];
            let fail = |why: &str| InspectError::Authorization(format!("input {i}: {why}"));
            let (sig_with_type, pubkey_bytes) =
                split_p2pkh_script_sig(&txin.script_sig().0 .0).ok_or_else(|| fail("not P2PKH"))?;
            let (hash_type, der) = sig_with_type
                .split_last()
                .ok_or_else(|| fail("empty signature"))?;
            let pubkey =
                secp256k1::PublicKey::from_slice(pubkey_bytes).map_err(|_| fail("bad pubkey"))?;
            #[allow(deprecated)]
            let addr = TransparentAddress::from_pubkey(&pubkey);
            if Script::from(addr.script()) != *coin.script_pubkey() {
                return Err(fail("pubkey does not match prevout"));
            }
            let signable = TransparentSignableInput::from_parts(
                t,
                SighashType::parse(*hash_type).ok_or_else(|| fail("bad sighash type"))?,
                i,
                coin.script_pubkey(),
                coin.script_pubkey(),
                coin.value(),
            )
            .map_err(|_| fail("bad input index"))?;
            let sighash = signature_hash(&data, &SignableInput::Transparent(signable), &txid_parts);
            let sig = secp256k1::ecdsa::Signature::from_der(der).map_err(|_| fail("bad DER"))?;
            secp256k1::ecdsa::verify(
                &sig,
                secp256k1::Message::from_digest(*sighash.as_ref()),
                &pubkey,
            )
            .map_err(|_| fail("bad ECDSA signature"))?;
        }
    }
    Ok(())
}

/// `<push sig||hashtype> <push pubkey>`, both direct pushes.
fn split_p2pkh_script_sig(script: &[u8]) -> Option<(&[u8], &[u8])> {
    let (&sig_len, rest) = script.split_first()?;
    let (sig, rest) = rest.split_at_checked(sig_len as usize)?;
    let (&pk_len, rest) = rest.split_first()?;
    (rest.len() == pk_len as usize).then_some((sig, rest))
}

// --- key-holder recovery -----------------------------------------------------------------------

/// A decrypted output. `Debug` is redacted (REQ-PRIV-002): use the fields deliberately.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveredOutput {
    pub action_index: usize,
    pub value: u64,
    pub memo: Option<String>,
    pub recipient: orchard::Address,
}

impl fmt::Debug for RecoveredOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "RecoveredOutput{{action_index: {}, <redacted>}}",
            self.action_index
        )
    }
}

fn recovered(
    idx: usize,
    note: orchard::Note,
    addr: orchard::Address,
    memo: [u8; 512],
) -> RecoveredOutput {
    RecoveredOutput {
        action_index: idx,
        value: note.value().inner(),
        memo: decode_memo(&memo),
        recipient: addr,
    }
}

fn shielded_bundles(tx: &Transaction) -> Vec<&orchard::Bundle<OrchardAuthorized, ZatBalance>> {
    [tx.orchard_bundle(), tx.ironwood_bundle()]
        .into_iter()
        .flatten()
        .collect()
}

/// Every OVK derivable from a UFVK: Orchard external/internal, plus the transparent-derived pair
/// `UnifiedFullViewingKey::select_ovk` uses for transparent-input transactions.
pub(crate) fn candidate_ovks(ufvk: &UnifiedFullViewingKey) -> Vec<OutgoingViewingKey> {
    let mut ovks = Vec::new();
    if let Some(fvk) = ufvk.orchard() {
        ovks.push(fvk.to_ovk(Scope::External));
        ovks.push(fvk.to_ovk(Scope::Internal));
    }
    if let Some(t) = ufvk.p2pkh() {
        let pair = t.ovks_for_shielding();
        ovks.push(OutgoingViewingKey::from(pair.external().as_bytes()));
        ovks.push(OutgoingViewingKey::from(pair.internal().as_bytes()));
    }
    ovks
}

/// The auditor's view: every output the campaign created, recovered with its UFVK's OVKs.
pub fn recover_with_ufvk(
    raw: &[u8],
    network: Network,
    ufvk: &str,
) -> Result<Vec<RecoveredOutput>, InspectError> {
    let ufvk =
        UnifiedFullViewingKey::decode(&network, ufvk).map_err(|_| InspectError::BadViewingKey)?;
    let ovks = candidate_ovks(&ufvk);
    let tx = parse(raw)?;
    Ok(shielded_bundles(&tx)
        .into_iter()
        .flat_map(|b| b.recover_outputs_with_ovks(&ovks))
        .map(|(idx, _, note, addr, memo)| recovered(idx, note, addr, memo))
        .collect())
}

/// A recipient's view: outputs addressed to `ivk`.
pub fn decrypt_with_ivk(
    raw: &[u8],
    ivk: &IncomingViewingKey,
) -> Result<Vec<RecoveredOutput>, InspectError> {
    let tx = parse(raw)?;
    Ok(shielded_bundles(&tx)
        .into_iter()
        .flat_map(|b| b.decrypt_outputs_with_keys(std::slice::from_ref(ivk)))
        .map(|(idx, _, note, addr, memo)| recovered(idx, note, addr, memo))
        .collect())
}

/// `Transaction::fee_paid` from librustzcash, for cross-checking [`PublicTotals::fee`].
pub fn fee_paid(
    raw: &[u8],
    resolve: impl Fn(&OutPoint) -> Option<TxOut>,
) -> Result<Option<u64>, InspectError> {
    parse(raw)?
        .fee_paid(|op| Ok::<_, BalanceError>(resolve(op).map(|c| c.value())))
        .map(|f| f.map(u64::from))
        .map_err(|_| InspectError::Balance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::tests::shared_batch;

    // covers: REQ-TX-001
    #[test]
    fn tampering_with_the_public_value_balance_breaks_the_signatures() {
        let (tx, coin) = shared_batch();
        let resolve = |op: &OutPoint| (op == &coin.outpoint).then(|| coin.coin.clone());
        let v = public_totals(&tx.raw, resolve).unwrap();
        assert_eq!(fee_paid(&tx.raw, resolve).unwrap(), Some(v.fee as u64));
        let needle = (-v.net_into_ironwood).to_le_bytes();
        assert_eq!(tx.raw.windows(8).filter(|w| *w == needle).count(), 1);
        let pos = tx.raw.windows(8).position(|w| w == needle).unwrap();
        let mut tampered = tx.raw.clone();
        tampered[pos] ^= 1;
        assert!(verify_proofs_and_signatures(&tampered, resolve).is_err());
    }

    #[test]
    fn recovered_output_debug_is_redacted() {
        let (tx, _) = shared_batch();
        let ufvk = crate::keys::tests::test_keys(0).ufvk_encoded().unwrap();
        let out = &recover_with_ufvk(&tx.raw, Network::TestNetwork, &ufvk).unwrap()[0];
        let dbg = format!("{out:?}");
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains(&out.value.to_string()));
        assert!(!dbg.contains("TEST ONLY payout"));
    }
}
