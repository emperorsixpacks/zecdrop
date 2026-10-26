//! Payslips: one recipient's proof that one output of a batch pays them a stated amount.
//!
//! A batch transaction publishes only totals; every recipient and amount is encrypted. A
//! [`Payslip`] is what one recipient can show a third party ("transaction T paid me X") without
//! revealing any other recipient. It holds the output's Orchard receiver, its value and the
//! note's `rseed`, and says where the output sits: the transaction id and the index of its action
//! in the transaction's Ironwood bundle.
//!
//! [`verify_payslip`] needs no key. It rebuilds the note from the payslip, using the action's own
//! `rho` (the nullifier that action reveals) and the note version of the bundle, and compares the
//! note's commitment with the `cmx` the transaction publishes for that action. A note commitment
//! is computationally binding, so a match shows that the output note of that action is exactly
//! (receiver, value). The transaction id commits to every `cmx` of the bundle, so the payslip is
//! bound to one transaction: the same recipients paid the same amounts in another transaction do
//! not open it.
//!
//! [`check_payslip`] adds the chain: it fetches the transaction through a [`ChainSource`] and
//! reports the confirmation depth with the same rule as the receipt (REQ-VER-003). Like the
//! receipt, it trusts the source for which transactions exist and how deep they are, and nothing
//! else: the bytes it gets must hash to the id it asked for.
//!
//! # What it does not prove
//!
//! See [`NOT_PROVEN`]; the hosted service and the receipt page quote that list.
//!
//! # What it costs the recipient
//!
//! A payslip is a bearer document. Whoever holds one learns the recipient's Orchard receiver and
//! the amount, and can present it as their own. The `rseed` also fixes the note's ephemeral key
//! (ZIP 212), so it lets its holder read that one output's memo (a test in `drop-zcash` shows
//! it). A service that checks a payslip receives all of that; check it locally when that
//! matters. No other output is revealed: the check reads one action's `rho` and `cmx` and never
//! decrypts anything.

use std::fmt;

use drop_core::{Network, Txid, Zatoshi};
use orchard::{
    note::{ExtractedNoteCommitment, RandomSeed},
    value::NoteValue,
    Address, Note,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::analyze::ParsedTx;
use crate::source::{confirmations, ChainSource, SourceError};

/// The payslip format version this crate reads and writes.
pub const PAYSLIP_VERSION: u8 = 1;

/// What a payslip that verifies still does not establish. Plain sentences, for the service's
/// answer and the receipt page.
pub const NOT_PROVEN: [&str; 5] = [
    "Who the recipient is, or that whoever presents the payslip controls the receiver. A payslip \
     is a bearer document: anyone who holds it can present it.",
    "The memo. The note commitment does not cover it.",
    "That the transaction is mined or final. That needs the chain: see the confirmations.",
    "That the funds are unspent, or that the transaction belongs to a given campaign. Compare \
     its id with the campaign's public receipt.",
    "Anything about any other output of the transaction.",
];

/// One recipient's proof of payment. See the [module docs](self).
///
/// In JSON the amount is a decimal string, as everywhere else in ZecDrop, and the two byte
/// strings are lowercase hexadecimal. Unknown fields are refused.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payslip {
    /// The format version: [`PAYSLIP_VERSION`].
    pub version: u8,
    /// The network of the transaction. It only tells a service which chain to ask: a
    /// transaction's bytes do not say.
    pub network: Network,
    /// The batch transaction, in display order.
    pub txid: Txid,
    /// The index of the output's action in the transaction's Ironwood bundle, in wire order.
    /// Builders shuffle actions, so it is unrelated to the position in the payout list.
    pub action: u32,
    /// The recipient's Orchard receiver: 11 bytes of diversifier, then 32 bytes of `pk_d`. This is
    /// the receiver inside a Unified Address, not the address string.
    #[serde(with = "hex_array")]
    pub receiver: [u8; 43],
    /// The output's value.
    pub value: Zatoshi,
    /// The note's `rseed`.
    #[serde(with = "hex_array")]
    pub rseed: [u8; 32],
}

impl Payslip {
    /// The payslip for `note`, the output at `action` of the Ironwood bundle of `txid`. `None`
    /// if the note's value is above the money supply, which no real note has.
    pub fn from_note(network: Network, txid: Txid, action: u32, note: &Note) -> Option<Payslip> {
        Some(Payslip {
            version: PAYSLIP_VERSION,
            network,
            txid,
            action,
            receiver: note.recipient().to_raw_address_bytes(),
            value: Zatoshi::new(note.value().inner()).ok()?,
            rseed: *note.rseed().as_bytes(),
        })
    }
}

/// `Debug` shows where the output is, never the receiver, the amount or the `rseed`
/// (REQ-PRIV-002).
impl fmt::Debug for Payslip {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Payslip{{network: {}, txid: {}, action: {}, <redacted>}}",
            self.network, self.txid, self.action
        )
    }
}

/// What a successful check established about the transaction: only public facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayslipProof {
    /// The transaction.
    pub txid: Txid,
    /// The action whose output note matches the payslip.
    pub action: u32,
    /// Actions in the transaction's Ironwood bundle (public).
    pub ironwood_actions: u32,
}

/// Why a payslip does not verify. Fixed text: nothing of the payslip or the transaction is
/// echoed, and the variants do not say which field was wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum PayslipError {
    /// The payslip has a version this verifier does not read.
    #[error("the payslip has a version this verifier does not read")]
    UnsupportedVersion,
    /// The bytes are not a transaction this verifier reads.
    #[error("the bytes are not a transaction this verifier reads")]
    TxUnparseable,
    /// The transaction is not the one the payslip names.
    #[error("the transaction is not the one the payslip names")]
    TxidMismatch,
    /// The transaction has no Ironwood bundle.
    #[error("the transaction has no Ironwood outputs")]
    NoIronwoodBundle,
    /// The transaction has no action with the payslip's index.
    #[error("the transaction has no such action")]
    ActionOutOfRange,
    /// The payslip does not describe a note: the receiver or the `rseed` is not valid.
    #[error("the payslip does not describe a valid note")]
    MalformedNote,
    /// The note the payslip describes is not the one the action creates.
    #[error("the payslip does not match the transaction's output")]
    CommitmentMismatch,
}

/// Checks a payslip against raw transaction bytes. See the [module docs](self); what a match
/// leaves open is listed in [`NOT_PROVEN`].
///
/// Success means: the bytes are the transaction the payslip names, and the output note of the
/// named Ironwood action has exactly the payslip's receiver and value.
pub fn verify_payslip(raw_tx: &[u8], payslip: &Payslip) -> Result<PayslipProof, PayslipError> {
    let tx = ParsedTx::parse(raw_tx).map_err(|_| PayslipError::TxUnparseable)?;
    verify_payslip_in(&tx, payslip)
}

/// As [`verify_payslip`], for a transaction that is already parsed.
pub fn verify_payslip_in(tx: &ParsedTx, payslip: &Payslip) -> Result<PayslipProof, PayslipError> {
    if payslip.version != PAYSLIP_VERSION {
        return Err(PayslipError::UnsupportedVersion);
    }
    if tx.txid() != payslip.txid {
        return Err(PayslipError::TxidMismatch);
    }
    let bundle = tx
        .transaction()
        .ironwood_bundle()
        .ok_or(PayslipError::NoIronwoodBundle)?;
    let action = usize::try_from(payslip.action)
        .ok()
        .and_then(|index| bundle.actions().get(index))
        .ok_or(PayslipError::ActionOutOfRange)?;

    let receiver = Option::<Address>::from(Address::from_raw_address_bytes(&payslip.receiver))
        .ok_or(PayslipError::MalformedNote)?;
    // `rho` is the nullifier the action reveals; the bundle says which note version its pool uses
    // (the payslip cannot choose either).
    let rho = action.rho();
    let rseed = Option::<RandomSeed>::from(RandomSeed::from_bytes(payslip.rseed, &rho))
        .ok_or(PayslipError::MalformedNote)?;
    let note = Option::<Note>::from(Note::from_parts(
        receiver,
        NoteValue::from_raw(payslip.value.as_u64()),
        rho,
        rseed,
        bundle.bundle_version().note_version(),
    ))
    .ok_or(PayslipError::MalformedNote)?;

    if ExtractedNoteCommitment::from(note.commitment()) != *action.cmx() {
        return Err(PayslipError::CommitmentMismatch);
    }
    Ok(PayslipProof {
        txid: payslip.txid,
        action: payslip.action,
        ironwood_actions: u32::try_from(bundle.actions().len()).unwrap_or(u32::MAX),
    })
}

/// A payslip that verifies, with the chain's view of its transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayslipCheck {
    /// What the commitment check established.
    pub proof: PayslipProof,
    /// Confirmations of the transaction at the source's tip; 0 if it is not mined.
    pub confirmations: u32,
    /// Whether `confirmations` reaches the required depth. Below it the payment is pending.
    pub is_final: bool,
}

/// Why a payslip could not be checked against the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CheckError {
    /// The chain source failed or contradicted itself; try again later.
    #[error(transparent)]
    Source(#[from] SourceError),
    /// The chain source does not know the transaction.
    #[error("the chain source does not know the transaction")]
    NotFound,
    /// The required confirmation depth must be at least one.
    #[error("the required confirmation depth must be at least 1")]
    ZeroDepth,
    /// The payslip does not verify.
    #[error(transparent)]
    Payslip(#[from] PayslipError),
}

/// Fetches the payslip's transaction through `source`, verifies the payslip against it and
/// reports whether the transaction is final at `required_depth` confirmations.
///
/// An outage is an error, never "not found" (as for receipts). A source that answers with a
/// different transaction than the one asked for is [`SourceError::Inconsistent`].
pub async fn check_payslip<S: ChainSource>(
    source: &S,
    payslip: &Payslip,
    required_depth: u32,
) -> Result<PayslipCheck, CheckError> {
    if required_depth == 0 {
        return Err(CheckError::ZeroDepth);
    }
    if payslip.version != PAYSLIP_VERSION {
        return Err(PayslipError::UnsupportedVersion.into());
    }
    let tip = source.tip_height().await?;
    let fetched = source
        .transaction(&payslip.txid)
        .await?
        .ok_or(CheckError::NotFound)?;
    let tx = ParsedTx::parse(&fetched.raw).map_err(|_| PayslipError::TxUnparseable)?;
    if tx.txid() != payslip.txid {
        return Err(SourceError::Inconsistent.into());
    }
    let proof = verify_payslip_in(&tx, payslip)?;
    let confirmations = confirmations(tip, fetched.mined_height);
    Ok(PayslipCheck {
        proof,
        confirmations,
        is_final: confirmations >= required_depth,
    })
}

/// `serde(with = ...)` for a fixed-size byte array written as lowercase hexadecimal.
mod hex_array {
    use serde::{de::Error as _, Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer, const N: usize>(
        bytes: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&hex::encode(bytes))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        let text = String::deserialize(deserializer)?;
        let mut bytes = [0u8; N];
        hex::decode_to_slice(&text, &mut bytes)
            .map_err(|_| D::Error::custom("expected hexadecimal of the right length"))?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use orchard::keys::{FullViewingKey, Scope, SpendingKey};
    use orchard::{NoteVersion, ValuePool};

    use super::*;

    /// The 8-recipient batch mined on public testnet (public chain data only).
    const MINED_BATCH_HEX: &str = include_str!(
        "../../../fixtures/testnet-ironwood-batch-8/6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955/tx.hex"
    );
    const MINED_BATCH_TXID: &str =
        "6e2359182d1dc77253ebe46aecdecd45d829a5b1baecf2750cb6a3736a877955";

    fn mined_batch() -> Vec<u8> {
        hex::decode(MINED_BATCH_HEX.trim()).unwrap()
    }

    // covers: REQ-PAY-001
    #[test]
    fn the_mined_testnet_batch_is_an_ironwood_bundle_of_v3_notes() {
        let tx = ParsedTx::parse(&mined_batch()).unwrap();
        assert_eq!(tx.txid().to_string(), MINED_BATCH_TXID);
        assert!(tx.transaction().orchard_bundle().is_none());
        let bundle = tx.transaction().ironwood_bundle().unwrap();
        assert_eq!(bundle.actions().len(), 8);
        // The note version a payslip is checked under comes from the bundle, not the payslip.
        let version = bundle.bundle_version();
        assert_eq!(version.value_pool(), ValuePool::Ironwood);
        assert_eq!(version.note_version(), NoteVersion::V3);
    }

    // covers: REQ-PAY-001
    #[test]
    fn nothing_made_up_opens_an_action_of_the_mined_batch() {
        // Without the key there is nothing true to say about this batch's outputs, so the check
        // must accept nothing: a valid receiver and amount with any seed, at every action.
        let raw = mined_batch();
        let txid: Txid = MINED_BATCH_TXID.parse().unwrap();
        let receiver = FullViewingKey::from(&SpendingKey::from_bytes([0x40; 32]).unwrap())
            .address_at(0u32, Scope::External)
            .to_raw_address_bytes();
        let guess = |action: u32, seed: u8| Payslip {
            version: PAYSLIP_VERSION,
            network: Network::Testnet,
            txid,
            action,
            receiver,
            value: Zatoshi::new(62_500).unwrap(),
            rseed: [seed; 32],
        };
        for action in 0..8 {
            for seed in [0u8, 1, 0x55, 0xff] {
                assert_eq!(
                    verify_payslip(&raw, &guess(action, seed)).unwrap_err(),
                    PayslipError::CommitmentMismatch,
                    "action {action}, seed {seed}"
                );
            }
        }
        assert_eq!(
            verify_payslip(&raw, &guess(8, 0)).unwrap_err(),
            PayslipError::ActionOutOfRange
        );
        let mut elsewhere = guess(0, 0);
        elsewhere.txid = Txid::from_bytes([1; 32]);
        assert_eq!(
            verify_payslip(&raw, &elsewhere).unwrap_err(),
            PayslipError::TxidMismatch
        );
    }

    // covers: REQ-PAY-001
    #[test]
    fn a_payslip_serialises_to_the_documented_json() {
        let payslip = Payslip {
            version: PAYSLIP_VERSION,
            network: Network::Testnet,
            txid: Txid::from_bytes([0xab; 32]),
            action: 3,
            receiver: [0x11; 43],
            value: Zatoshi::new(20_001).unwrap(),
            rseed: [0x22; 32],
        };
        let json = serde_json::to_string(&payslip).unwrap();
        assert_eq!(
            json,
            format!(
                r#"{{"version":1,"network":"testnet","txid":"{}","action":3,"receiver":"{}","value":"20001","rseed":"{}"}}"#,
                "ab".repeat(32),
                "11".repeat(43),
                "22".repeat(32)
            )
        );
        assert_eq!(serde_json::from_str::<Payslip>(&json).unwrap(), payslip);
        assert!(!format!("{payslip:?}").contains("20001"));
    }
}
