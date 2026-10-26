//! Campaign keys: one ZIP 32 account per campaign, so a campaign's UFVK discloses that campaign
//! and nothing else.
//!
//! A campaign funds itself at its account's first external P2PKH address and receives change at
//! its first internal (change) P2PKH address. Every payout carries the account's Orchard
//! external-scope OVK, which any holder of the campaign UFVK can derive (Ironwood uses the same
//! Orchard key tree).

use std::fmt;

use orchard::keys::{OutgoingViewingKey, Scope};
use thiserror::Error;
use zcash_keys::{
    address::Address,
    keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_protocol::consensus::Network;
use zcash_transparent::{
    address::{Script, TransparentAddress},
    keys::{IncomingViewingKey as _, NonHardenedChildIndex},
};
use zip32::AccountId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum KeyError {
    #[error("seed must be at least 32 bytes")]
    SeedTooShort,
    #[error("account index is out of the ZIP 32 range")]
    BadAccount,
    #[error("key derivation failed")]
    Derivation,
}

/// The keys of one campaign account. `Debug` never prints key material.
pub struct CampaignKeys {
    network: Network,
    account: u32,
    usk: UnifiedSpendingKey,
    ufvk: UnifiedFullViewingKey,
    funding_addr: TransparentAddress,
    funding_index: NonHardenedChildIndex,
    change_addr: TransparentAddress,
    change_index: NonHardenedChildIndex,
}

impl fmt::Debug for CampaignKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "CampaignKeys{{network: {:?}, account: {}, keys: <redacted>}}",
            self.network, self.account
        )
    }
}

impl CampaignKeys {
    /// Derives campaign account `account` of `seed` on `network`.
    pub fn derive(seed: &[u8], network: Network, account: u32) -> Result<Self, KeyError> {
        // `UnifiedSpendingKey::from_seed` panics on short seeds; refuse them first.
        if seed.len() < 32 {
            return Err(KeyError::SeedTooShort);
        }
        let account_id = AccountId::try_from(account).map_err(|_| KeyError::BadAccount)?;
        let usk = UnifiedSpendingKey::from_seed(&network, seed, account_id)
            .map_err(|_| KeyError::Derivation)?;
        let ufvk = usk.to_unified_full_viewing_key();
        let tpk = ufvk.p2pkh().ok_or(KeyError::Derivation)?;
        let (funding_addr, funding_index) = tpk
            .derive_external_ivk()
            .map_err(|_| KeyError::Derivation)?
            .default_address();
        let (change_addr, change_index) = tpk
            .derive_internal_ivk()
            .map_err(|_| KeyError::Derivation)?
            .default_address();
        Ok(CampaignKeys {
            network,
            account,
            usk,
            ufvk,
            funding_addr,
            funding_index,
            change_addr,
            change_index,
        })
    }

    pub fn network(&self) -> Network {
        self.network
    }

    pub fn account(&self) -> u32 {
        self.account
    }

    /// The transparent address the campaign is funded at.
    pub fn funding_address(&self) -> String {
        Address::from(self.funding_addr).encode(&self.network)
    }

    /// The transparent address batch change returns to.
    pub fn change_address(&self) -> String {
        Address::from(self.change_addr).encode(&self.network)
    }

    /// The account's Unified Address with only an Orchard receiver.
    pub fn unified_address(&self) -> String {
        let (ua, _) = self
            .ufvk
            .default_address(UnifiedAddressRequest::ORCHARD)
            .expect("an Orchard-only UA is always derivable");
        ua.encode(&self.network)
    }

    /// The campaign UFVK, encoded. This is the auditor's key: it discloses every output of this
    /// campaign account, so treat it as confidential.
    pub fn ufvk_encoded(&self) -> Result<String, KeyError> {
        self.ufvk
            .encode(&self.network)
            .map_err(|_| KeyError::Derivation)
    }

    pub fn ufvk(&self) -> &UnifiedFullViewingKey {
        &self.ufvk
    }

    /// The OVK attached to every payout (REQ-TX-002).
    pub(crate) fn payout_ovk(&self) -> OutgoingViewingKey {
        self.ufvk
            .orchard()
            .expect("orchard keys are always derived")
            .to_ovk(Scope::External)
    }

    pub(crate) fn funding_script(&self) -> Script {
        self.funding_addr.script().into()
    }

    pub(crate) fn change_script(&self) -> Script {
        self.change_addr.script().into()
    }

    pub(crate) fn change_taddr(&self) -> &TransparentAddress {
        &self.change_addr
    }

    pub(crate) fn funding_taddr(&self) -> &TransparentAddress {
        &self.funding_addr
    }

    /// The secp256k1 key for a coin locked to `script_pubkey`, if it is the campaign's.
    pub(crate) fn signing_key_for(&self, script_pubkey: &Script) -> Option<SigningKey> {
        let tsk = self.usk.transparent();
        let key = if *script_pubkey == self.funding_script() {
            tsk.derive_external_secret_key(self.funding_index).ok()
        } else if *script_pubkey == self.change_script() {
            tsk.derive_internal_secret_key(self.change_index).ok()
        } else {
            None
        };
        key.map(SigningKey)
    }
}

/// A derived transparent signing key, wiped when dropped.
///
/// `secp256k1::SecretKey` is `Copy`, and librustzcash's `TransparentSigningSet` keeps its own
/// copy, which this crate cannot wipe (library-limited). This guard wipes the copy this crate
/// owns.
pub(crate) struct SigningKey(secp256k1::SecretKey);

impl SigningKey {
    /// A copy for `TransparentSigningSet::add_key`, which takes the key by value.
    pub(crate) fn expose(&self) -> secp256k1::SecretKey {
        self.0
    }

    fn wipe(&mut self) {
        self.0.non_secure_erase();
    }
}

impl Drop for SigningKey {
    fn drop(&mut self) {
        self.wipe();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use zcash_protocol::consensus::Network::TestNetwork;

    /// TEST ONLY: a public, hard-coded seed. Never fund its addresses.
    pub(crate) const TEST_ONLY_SEED: [u8; 32] = *b"TEST-ONLY drop-zcash unit seed!!";

    pub(crate) fn test_keys(account: u32) -> CampaignKeys {
        CampaignKeys::derive(&TEST_ONLY_SEED, TestNetwork, account).unwrap()
    }

    #[test]
    fn each_campaign_is_its_own_account() {
        let (a, b) = (test_keys(0), test_keys(1));
        assert_ne!(a.funding_address(), b.funding_address());
        assert_ne!(a.ufvk_encoded().unwrap(), b.ufvk_encoded().unwrap());
        assert!(a.funding_address().starts_with("tm"));
        assert!(a.unified_address().starts_with("utest1"));
        assert!(a.ufvk_encoded().unwrap().starts_with("uview"));
    }

    #[test]
    fn short_seeds_are_refused_not_panicking() {
        assert_eq!(
            CampaignKeys::derive(&[0u8; 31], TestNetwork, 0).err(),
            Some(KeyError::SeedTooShort)
        );
    }

    #[test]
    fn debug_redacts_keys() {
        let k = test_keys(0);
        let dbg = format!("{k:?}");
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains(&k.ufvk_encoded().unwrap()));
        assert!(!dbg.contains(&k.funding_address()));
    }

    #[test]
    fn signing_keys_are_wiped() {
        let k = test_keys(0);
        let mut key = k.signing_key_for(&k.funding_script()).unwrap();
        let secret = key.expose().to_secret_bytes();
        assert_ne!(secret, [1u8; 32]);
        key.wipe(); // what `Drop` runs
        assert_eq!(
            key.0.to_secret_bytes(),
            [1u8; 32],
            "secp256k1's erase pattern"
        );
        assert!(test_keys(1).signing_key_for(&k.funding_script()).is_none());
    }
}
