//! A payout's shielded deposit address: "the inbox" (docs/ADR/0006-shielded-inbox.md).
//!
//! The inbox is account 0 of a wallet seed of its own, which zcash-devtool holds; the operator derives that seed from its
//! own (drop-operator `inbox::keys`), so the operator's seed alone recovers every inbox. Because it is a different seed from
//! the payout's own account, the payout's viewing key (the auditor's key) never sees what reaches the inbox or leaves it.
//!
//! This module derives the inbox's *viewing* keys from the inbox wallet's BIP 39 seed: its address (an Orchard receiver
//! only, which Ironwood notes land on) and the incoming viewing key zcash-devtool caches, so the operator can check that the
//! wallet it set up is the one it meant. It never holds a spending key: zcash-devtool signs.
//!
//! It also checks, from the raw bytes alone, every transaction zcash-devtool builds for an inbox before the operator stores
//! or broadcasts it ([`InboxKeys::check_move`], [`InboxKeys::check_return`], REQ-FUND-006/007): its shape, its fee, and
//! that every zatoshi it spends from the inbox is accounted for.

use std::{collections::HashMap, fmt};

use drop_core::fee::FeePolicy;
use orchard::keys::Scope;
use thiserror::Error;
use zcash_keys::{
    address::Address,
    keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_primitives::transaction::{Transaction, TxVersion};
use zcash_protocol::consensus::Network;
use zcash_transparent::address::Script;
use zip32::AccountId;

use crate::{codec::orchard_receiver, inspect::candidate_ovks, keys::KeyError};

/// Whose `address` is: `None` when it has no Orchard receiver (a transparent or Sapling-only address, or not a Zcash address
/// at all); otherwise whether that receiver is one of `ufvk`'s own addresses (any diversifier, either scope).
pub fn orchard_receiver_owned_by(
    network: Network,
    address: &str,
    ufvk: &UnifiedFullViewingKey,
) -> Option<bool> {
    let receiver = orchard_receiver(network, address)?;
    let fvk = ufvk.orchard()?;
    Some(fvk.scope_for_address(&receiver).is_some())
}

/// How far past the chain tip an inbox transaction may expire: zcash-devtool sets its expiry 40 blocks after the height it
/// targets (its scanned tip, plus one), and the operator only builds with a wallet at most 2 blocks behind the node.
pub const EXPIRY_SLACK: u32 = 43;

/// What is wrong with a transaction built for an inbox. Says what, never which amounts or addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum InboxTxProblem {
    #[error("the transaction does not parse, or does not re-encode to the same bytes")]
    Unparseable,
    #[error("the transaction is not a V6 transaction for the chain's current upgrade")]
    WrongVersion,
    #[error("the transaction's expiry height is missing or out of range")]
    BadExpiry,
    #[error("the transaction spends a transparent coin")]
    TransparentInput,
    #[error("the transaction's transparent outputs are not exactly the one expected")]
    WrongTransparentOutputs,
    #[error("the transaction has a Sapling or Orchard part")]
    OtherPool,
    #[error("the transaction has no Ironwood part")]
    NoIronwood,
    #[error("the transaction's fee is not the ZIP 317 fee for its shape")]
    WrongFee,
    #[error("the transaction spends no note of this inbox")]
    NothingSpent,
    #[error("the transaction pays the wrong shielded address or amount")]
    WrongShieldedOutput,
    #[error("value the transaction spends from the inbox is not accounted for")]
    ValueNotConserved,
}

/// What every inbox transaction must agree with: the chain it is for, and what the inbox holds.
#[derive(Clone, Copy, Debug)]
pub struct InboxTxContext<'a> {
    /// The node's current consensus branch id.
    pub branch_id: u32,
    /// The node's current tip height.
    pub tip: u32,
    /// The inbox's unspent notes, as its wallet records them: (nullifier, value in zatoshi).
    pub notes: &'a [([u8; 32], u64)],
}

/// The facts of a checked inbox transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxTxFacts {
    /// Its id, display order (as explorers and zcash-devtool print it).
    pub txid: String,
    pub expiry_height: u32,
    pub fee: u64,
    /// What it spends from the inbox.
    pub spent: u64,
    /// What comes back to the inbox as change.
    pub change: u64,
}

/// The viewing keys of one inbox: account 0 of its wallet seed. `Debug` never prints key material.
pub struct InboxKeys {
    network: Network,
    ufvk: UnifiedFullViewingKey,
}

impl fmt::Debug for InboxKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "InboxKeys{{network: {:?}, keys: <redacted>}}",
            self.network
        )
    }
}

impl InboxKeys {
    /// Derives the inbox of the wallet whose BIP 39 seed is `wallet_seed` (64 bytes, from the wallet's phrase).
    pub fn derive(wallet_seed: &[u8], network: Network) -> Result<Self, KeyError> {
        // `UnifiedSpendingKey::from_seed` panics on short seeds; refuse them first.
        if wallet_seed.len() < 32 {
            return Err(KeyError::SeedTooShort);
        }
        // The spending key exists only for this derivation and is dropped here: the operator keeps viewing keys alone.
        let ufvk = UnifiedSpendingKey::from_seed(&network, wallet_seed, AccountId::ZERO)
            .map_err(|_| KeyError::Derivation)?
            .to_unified_full_viewing_key();
        Ok(InboxKeys { network, ufvk })
    }

    pub fn network(&self) -> Network {
        self.network
    }

    /// The inbox's address: a Unified Address with only an Orchard receiver, so whatever a wallet sends there arrives
    /// shielded (Ironwood notes go to the Orchard receiver).
    pub fn address(&self) -> String {
        let (ua, _) = self
            .ufvk
            .default_address(UnifiedAddressRequest::ORCHARD)
            .expect("an Orchard-only UA is always derivable");
        ua.encode(&self.network)
    }

    /// The account's external Orchard incoming viewing key, in the 64-byte form zcash-devtool's wallet database caches
    /// for the account (`accounts.orchard_ivk_item_cache`).
    pub fn orchard_ivk_bytes(&self) -> [u8; 64] {
        self.ufvk
            .orchard()
            .expect("orchard keys are always derived")
            .to_ivk(Scope::External)
            .to_bytes()
    }

    /// The inbox's full viewing key, for recovering what a move or a send-back pays (`inspect::recover_with_ufvk`).
    pub fn ufvk(&self) -> &UnifiedFullViewingKey {
        &self.ufvk
    }

    /// Checks a move (REQ-FUND-006): exactly `value` zatoshi to the payout's transparent funding address
    /// `funding_address`, from this inbox's Ironwood notes, any change back to this inbox, and nothing else.
    ///
    /// Shape: V6 for the node's branch, expiring within [`EXPIRY_SLACK`] blocks of its tip; no transparent input; exactly
    /// one transparent output, paying the funding address exactly `value`; no Sapling and no Orchard; an Ironwood part. Fee:
    /// exactly the ZIP 317 fee for that shape (what zcash-devtool pays). Value: the notes it spends from the inbox
    /// (matched by nullifier) are exactly `value` + fee + the change it pays back to the inbox, so no zatoshi goes anywhere
    /// unseen.
    pub fn check_move(
        &self,
        raw: &[u8],
        funding_address: &str,
        value: u64,
        context: &InboxTxContext<'_>,
    ) -> Result<InboxTxFacts, InboxTxProblem> {
        let script = match Address::decode(&self.network, funding_address) {
            Some(Address::Transparent(taddr)) => Script::from(taddr.script()),
            _ => return Err(InboxTxProblem::WrongTransparentOutputs),
        };
        let tx = self.common(raw, context)?;
        let outputs = tx
            .transparent_bundle()
            .map(|b| b.vout.as_slice())
            .unwrap_or_default();
        if outputs.len() != 1
            || outputs[0].value().into_u64() != value
            || *outputs[0].script_pubkey() != script
        {
            return Err(InboxTxProblem::WrongTransparentOutputs);
        }
        self.conserve(&tx, context, value)
    }

    /// Checks a send-back (REQ-FUND-007): everything it spends from this inbox's Ironwood notes goes, less the fee, to
    /// the shielded address `to` (its Orchard receiver), or back to this inbox; no transparent part at all.
    pub fn check_return(
        &self,
        raw: &[u8],
        to: &str,
        context: &InboxTxContext<'_>,
    ) -> Result<InboxTxFacts, InboxTxProblem> {
        let receiver =
            orchard_receiver(self.network, to).ok_or(InboxTxProblem::WrongShieldedOutput)?;
        let tx = self.common(raw, context)?;
        if tx.transparent_bundle().is_some_and(|b| !b.vout.is_empty()) {
            return Err(InboxTxProblem::WrongTransparentOutputs);
        }
        // What it sends, recovered with the inbox's own outgoing viewing keys: it must all go to `to`.
        let bundle = tx.ironwood_bundle().ok_or(InboxTxProblem::NoIronwood)?;
        let sent: u64 = bundle
            .recover_outputs_with_ovks(&candidate_ovks(&self.ufvk))
            .into_iter()
            .filter(|(_, _, _, addr, _)| !self.is_ours(addr))
            .map(|(_, _, note, addr, _)| {
                (addr == receiver)
                    .then(|| note.value().inner())
                    .ok_or(InboxTxProblem::WrongShieldedOutput)
            })
            .sum::<Result<u64, _>>()?;
        if sent == 0 {
            return Err(InboxTxProblem::WrongShieldedOutput);
        }
        self.conserve(&tx, context, sent)
    }

    /// What every inbox transaction must be, whatever it pays: parses and re-encodes to the same bytes; V6 for the node's
    /// branch; a near expiry; no transparent input; no Sapling or Orchard part; an Ironwood part.
    fn common(
        &self,
        raw: &[u8],
        context: &InboxTxContext<'_>,
    ) -> Result<Transaction, InboxTxProblem> {
        let tx = crate::inspect::parse(raw).map_err(|_| InboxTxProblem::Unparseable)?;
        let mut again = Vec::with_capacity(raw.len());
        tx.write(&mut again)
            .map_err(|_| InboxTxProblem::Unparseable)?;
        if again != raw {
            return Err(InboxTxProblem::Unparseable);
        }
        if tx.version() != TxVersion::V6 || u32::from(tx.consensus_branch_id()) != context.branch_id
        {
            return Err(InboxTxProblem::WrongVersion);
        }
        let expiry = u32::from(tx.expiry_height());
        if expiry <= context.tip || expiry > context.tip.saturating_add(EXPIRY_SLACK) {
            return Err(InboxTxProblem::BadExpiry);
        }
        if tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty()) {
            return Err(InboxTxProblem::TransparentInput);
        }
        let sapling = tx
            .sapling_bundle()
            .is_some_and(|b| !b.shielded_spends().is_empty() || !b.shielded_outputs().is_empty());
        if sapling || tx.orchard_bundle().is_some() {
            return Err(InboxTxProblem::OtherPool);
        }
        if tx.ironwood_bundle().is_none_or(|b| b.actions().is_empty()) {
            return Err(InboxTxProblem::NoIronwood);
        }
        Ok(tx)
    }

    /// The fee is exactly ZIP 317's for the shape, and the inbox's spent notes are exactly `paid` + fee + change.
    fn conserve(
        &self,
        tx: &Transaction,
        context: &InboxTxContext<'_>,
        paid: u64,
    ) -> Result<InboxTxFacts, InboxTxProblem> {
        let bundle = tx.ironwood_bundle().ok_or(InboxTxProblem::NoIronwood)?;
        let transparent_out: u64 = tx
            .transparent_bundle()
            .map(|b| b.vout.iter().map(|o| o.value().into_u64()).sum())
            .unwrap_or(0);
        // Value leaving the Ironwood pool pays the transparent outputs and the fee.
        let leaving = u64::try_from(i64::from(*bundle.value_balance()))
            .map_err(|_| InboxTxProblem::WrongFee)?;
        let fee = leaving
            .checked_sub(transparent_out)
            .ok_or(InboxTxProblem::WrongFee)?;
        let policy = FeePolicy::zip317_text();
        let actions =
            u64::try_from(bundle.actions().len()).map_err(|_| InboxTxProblem::WrongFee)?;
        let transparent_actions = u64::from(transparent_out > 0);
        if fee
            != policy.marginal_fee
                * (actions + transparent_actions).max(u64::from(policy.grace_actions))
        {
            return Err(InboxTxProblem::WrongFee);
        }
        let ours: HashMap<[u8; 32], u64> = context.notes.iter().copied().collect();
        let spent: u64 = bundle
            .actions()
            .iter()
            .filter_map(|a| ours.get(&a.nullifier().to_bytes()))
            .sum();
        if spent == 0 {
            return Err(InboxTxProblem::NothingSpent);
        }
        let fvk = self
            .ufvk
            .orchard()
            .expect("orchard keys are always derived");
        let ivks = [fvk.to_ivk(Scope::Internal), fvk.to_ivk(Scope::External)];
        let change: u64 = bundle
            .decrypt_outputs_with_keys(&ivks)
            .into_iter()
            .map(|(_, _, note, _, _)| note.value().inner())
            .sum();
        if spent
            != paid
                .checked_add(fee)
                .and_then(|v| v.checked_add(change))
                .ok_or(InboxTxProblem::ValueNotConserved)?
        {
            return Err(InboxTxProblem::ValueNotConserved);
        }
        Ok(InboxTxFacts {
            txid: tx.txid().to_string(),
            expiry_height: u32::from(tx.expiry_height()),
            fee,
            spent,
            change,
        })
    }

    /// Whether `addr` is one of this inbox's own addresses (where change goes).
    fn is_ours(&self, addr: &orchard::Address) -> bool {
        let fvk = self
            .ufvk
            .orchard()
            .expect("orchard keys are always derived");
        fvk.scope_for_address(addr).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::CampaignKeys;
    use zcash_protocol::consensus::Network::TestNetwork;

    /// TEST ONLY: a public, hard-coded wallet seed. Never fund its addresses.
    const TEST_ONLY_WALLET_SEED: [u8; 64] = [7u8; 64];

    #[test]
    fn the_inbox_is_an_orchard_only_address_of_its_own() {
        let inbox = InboxKeys::derive(&TEST_ONLY_WALLET_SEED, TestNetwork).unwrap();
        assert!(inbox.address().starts_with("utest1"));
        assert_eq!(
            inbox.address(),
            InboxKeys::derive(&TEST_ONLY_WALLET_SEED, TestNetwork)
                .unwrap()
                .address()
        );
        // Account 0 of the same seed, as a campaign would derive it, has the same address: the inbox is that account,
        // and nothing more (no transparent or Sapling receiver).
        assert_eq!(
            inbox.address(),
            CampaignKeys::derive(&TEST_ONLY_WALLET_SEED, TestNetwork, 0)
                .unwrap()
                .unified_address()
        );
        let other = InboxKeys::derive(&[8u8; 64], TestNetwork).unwrap();
        assert_ne!(inbox.address(), other.address());
        assert_ne!(inbox.orchard_ivk_bytes(), other.orchard_ivk_bytes());
    }

    #[test]
    fn short_seeds_are_refused_not_panicking() {
        assert_eq!(
            InboxKeys::derive(&[0u8; 31], TestNetwork).err(),
            Some(KeyError::SeedTooShort)
        );
    }

    /// The first real move from an inbox (fixtures/testnet-inbox-move): public chain data.
    const MOVE_TXID: &str = "543ae84065e8767db1c91eda188bc09e2ec5b692425e7842481fad4b99b95f23";
    const FUNDING_ADDRESS: &str = "tmHWPvYdJcXfuthNsHz4oUkTJVFUPdqbFma";
    const SPENT_NF: &str = "7b4dfbc865cbfe01e1254b8769f0e5a4b66500272a28aa3c58baddbf090f1e30";
    const BRANCH: u32 = 0x7719_0ad9;
    const TIP: u32 = 4_537_001;

    fn fixture(set: &str, name: &str) -> Vec<u8> {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures")
            .join(set);
        let batch = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.is_dir())
            .unwrap();
        hex::decode(std::fs::read_to_string(batch.join(name)).unwrap().trim()).unwrap()
    }

    fn real_move() -> Vec<u8> {
        fixture("testnet-inbox-move", "move-tx.hex")
    }

    fn spent_note(value: u64) -> Vec<([u8; 32], u64)> {
        vec![(
            <[u8; 32]>::try_from(hex::decode(SPENT_NF).unwrap()).unwrap(),
            value,
        )]
    }

    /// The move has no change, so any inbox's keys can check it: nothing of it decrypts as change.
    fn any_inbox() -> InboxKeys {
        InboxKeys::derive(&TEST_ONLY_WALLET_SEED, TestNetwork).unwrap()
    }

    // covers: REQ-FUND-006
    #[test]
    fn the_real_move_passes_and_says_what_it_did() {
        let notes = spent_note(130_000);
        let context = InboxTxContext {
            branch_id: BRANCH,
            tip: TIP,
            notes: &notes,
        };
        let facts = any_inbox()
            .check_move(&real_move(), FUNDING_ADDRESS, 115_000, &context)
            .unwrap();
        assert_eq!(
            facts,
            InboxTxFacts {
                txid: MOVE_TXID.into(),
                expiry_height: 4_537_042,
                fee: 15_000,
                spent: 130_000,
                change: 0
            }
        );
    }

    // covers: REQ-FUND-006
    #[test]
    fn a_move_that_pays_anything_else_or_spends_anything_unaccounted_for_is_refused() {
        let keys = any_inbox();
        let raw = real_move();
        let notes = spent_note(130_000);
        let ok = InboxTxContext {
            branch_id: BRANCH,
            tip: TIP,
            notes: &notes,
        };
        let check = |raw: &[u8], address: &str, value: u64, context: &InboxTxContext<'_>| {
            keys.check_move(raw, address, value, context)
        };
        // Not exactly the funding, or not to the payout's address.
        assert_eq!(
            check(&raw, FUNDING_ADDRESS, 114_999, &ok),
            Err(InboxTxProblem::WrongTransparentOutputs)
        );
        assert_eq!(
            check(&raw, "tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD", 115_000, &ok),
            Err(InboxTxProblem::WrongTransparentOutputs)
        );
        assert_eq!(
            check(&raw, "not an address", 115_000, &ok),
            Err(InboxTxProblem::WrongTransparentOutputs)
        );
        // Another chain upgrade, or an expiry the tip does not allow.
        assert_eq!(
            check(
                &raw,
                FUNDING_ADDRESS,
                115_000,
                &InboxTxContext {
                    branch_id: 0xc8e7_1055,
                    ..ok
                }
            ),
            Err(InboxTxProblem::WrongVersion)
        );
        assert_eq!(
            check(
                &raw,
                FUNDING_ADDRESS,
                115_000,
                &InboxTxContext {
                    tip: 4_537_042,
                    ..ok
                }
            ),
            Err(InboxTxProblem::BadExpiry)
        );
        assert_eq!(
            check(
                &raw,
                FUNDING_ADDRESS,
                115_000,
                &InboxTxContext {
                    tip: 4_536_990,
                    ..ok
                }
            ),
            Err(InboxTxProblem::BadExpiry)
        );
        // A note of the inbox's it does not spend; or a spent note worth more than it pays out: value went somewhere unseen.
        let other = vec![([9u8; 32], 130_000)];
        assert_eq!(
            check(
                &raw,
                FUNDING_ADDRESS,
                115_000,
                &InboxTxContext {
                    notes: &other,
                    ..ok
                }
            ),
            Err(InboxTxProblem::NothingSpent)
        );
        let bigger = spent_note(140_000);
        assert_eq!(
            check(
                &raw,
                FUNDING_ADDRESS,
                115_000,
                &InboxTxContext {
                    notes: &bigger,
                    ..ok
                }
            ),
            Err(InboxTxProblem::ValueNotConserved)
        );
        // Bytes that are not exactly one transaction.
        let mut longer = raw.clone();
        longer.push(0);
        assert_eq!(
            check(&longer, FUNDING_ADDRESS, 115_000, &ok),
            Err(InboxTxProblem::Unparseable)
        );
        assert_eq!(
            check(&raw[..raw.len() - 1], FUNDING_ADDRESS, 115_000, &ok),
            Err(InboxTxProblem::Unparseable)
        );
    }

    // covers: REQ-FUND-006, REQ-FUND-007
    #[test]
    fn transactions_of_other_shapes_are_refused() {
        let keys = any_inbox();
        let notes = spent_note(130_000);
        // ZecDrop's own batch spends a transparent coin.
        let batch = fixture("testnet-ironwood-batch-8", "tx.hex");
        let expiry = u32::from(crate::inspect::parse(&batch).unwrap().expiry_height());
        let at_batch = InboxTxContext {
            branch_id: BRANCH,
            tip: expiry - 1,
            notes: &notes,
        };
        assert_eq!(
            keys.check_move(&batch, FUNDING_ADDRESS, 115_000, &at_batch),
            Err(InboxTxProblem::TransparentInput)
        );
        // A send-back must have no transparent output at all: the real move has one.
        let ok = InboxTxContext {
            branch_id: BRANCH,
            tip: TIP,
            notes: &notes,
        };
        let to = keys.address();
        assert_eq!(
            keys.check_return(&real_move(), &to, &ok),
            Err(InboxTxProblem::WrongTransparentOutputs)
        );
        // And it must go to a shielded address with an Orchard receiver.
        assert_eq!(
            keys.check_return(&real_move(), FUNDING_ADDRESS, &ok),
            Err(InboxTxProblem::WrongShieldedOutput)
        );
    }

    #[test]
    fn whose_address_it_is() {
        let inbox = any_inbox();
        let other = InboxKeys::derive(&[8u8; 64], TestNetwork).unwrap();
        assert_eq!(
            orchard_receiver_owned_by(TestNetwork, &inbox.address(), inbox.ufvk()),
            Some(true)
        );
        assert_eq!(
            orchard_receiver_owned_by(TestNetwork, &other.address(), inbox.ufvk()),
            Some(false)
        );
        assert_eq!(
            orchard_receiver_owned_by(TestNetwork, FUNDING_ADDRESS, inbox.ufvk()),
            None,
            "transparent: no Orchard receiver"
        );
        assert_eq!(
            orchard_receiver_owned_by(TestNetwork, "nonsense", inbox.ufvk()),
            None
        );
    }

    #[test]
    fn debug_redacts_keys() {
        let inbox = InboxKeys::derive(&TEST_ONLY_WALLET_SEED, TestNetwork).unwrap();
        let dbg = format!("{inbox:?}");
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains(&inbox.address()));
    }
}
