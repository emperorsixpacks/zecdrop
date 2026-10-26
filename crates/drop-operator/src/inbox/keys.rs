//! The secrets of a payout's shielded deposit address (docs/ADR/0006-shielded-inbox.md), derived from the operator's seed.
//!
//! Each payout's inbox is a zcash-devtool wallet set up from a BIP 39 phrase of its own:
//!
//! ```text
//! entropy  = SHA-256("zecdrop-inbox-phrase-v1\0" ‖ network ‖ seed ‖ account as u32 big-endian)
//! identity = Bech32("age-secret-key-", SHA-256("zecdrop-inbox-age-v1\0" ‖ network ‖ seed)), upper case
//! ```
//!
//! `account` is the payout's own ZIP 32 account number, which the registry keeps unique per seed, and `network` is the four
//! bytes `test` or `main`. zcash-devtool keeps the phrase encrypted to the age identity. So nothing new is stored: the
//! operator's seed recovers every inbox, and whatever guards the seed guards them. Both go to zcash-devtool on stdin (and,
//! for `init` alone, a short-lived 0600 file), never in argv and never in a log.

use std::fmt;

use bech32::{Bech32, Hrp};
use bip0039::{English, Mnemonic};
use drop_core::Network;
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::secret::SecretSeed;

/// An inbox secret could not be derived. Cannot happen for a 32-byte seed; kept as a value, never a panic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("the inbox's keys could not be derived")]
pub struct InboxKeyError;

const PHRASE_DOMAIN: &[u8] = b"zecdrop-inbox-phrase-v1\0";
const IDENTITY_DOMAIN: &[u8] = b"zecdrop-inbox-age-v1\0";

fn network_label(network: Network) -> &'static [u8; 4] {
    match network {
        Network::Testnet => b"test",
        Network::Mainnet => b"main",
    }
}

/// One inbox wallet's phrase, and the BIP 39 seed it gives (what zcash-devtool derives its accounts from). Wiped on drop;
/// `Debug` prints neither.
pub struct InboxPhrase {
    phrase: Zeroizing<String>,
    wallet_seed: Zeroizing<[u8; 64]>,
}

impl fmt::Debug for InboxPhrase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("InboxPhrase(<redacted>)")
    }
}

impl InboxPhrase {
    /// The phrase of payout account `account`'s inbox.
    pub fn derive(
        seed: &SecretSeed,
        network: Network,
        account: u32,
    ) -> Result<InboxPhrase, InboxKeyError> {
        let mut hasher = Sha256::new();
        hasher.update(PHRASE_DOMAIN);
        hasher.update(network_label(network));
        hasher.update(seed.expose_secret());
        hasher.update(account.to_be_bytes());
        let entropy = Zeroizing::new(<[u8; 32]>::from(hasher.finalize()));
        let mnemonic =
            <Mnemonic<English>>::from_entropy(entropy.to_vec()).map_err(|_| InboxKeyError)?;
        let wallet_seed = Zeroizing::new(mnemonic.to_seed(""));
        Ok(InboxPhrase {
            phrase: Zeroizing::new(mnemonic.into_phrase()),
            wallet_seed,
        })
    }

    /// The 24 words, for zcash-devtool's `init` on stdin. Never log or display them.
    pub fn expose_phrase(&self) -> &str {
        &self.phrase
    }

    /// The BIP 39 seed (empty passphrase), from which [`drop_zcash::InboxKeys`] derives the inbox's viewing keys.
    pub fn wallet_seed(&self) -> &[u8; 64] {
        &self.wallet_seed
    }
}

/// The age identity the inbox wallets of one seed and network encrypt their phrases to: `AGE-SECRET-KEY-1…`. Wiped on drop.
pub fn age_identity(
    seed: &SecretSeed,
    network: Network,
) -> Result<Zeroizing<String>, InboxKeyError> {
    let mut hasher = Sha256::new();
    hasher.update(IDENTITY_DOMAIN);
    hasher.update(network_label(network));
    hasher.update(seed.expose_secret());
    let key = Zeroizing::new(<[u8; 32]>::from(hasher.finalize()));
    let hrp = Hrp::parse("age-secret-key-").map_err(|_| InboxKeyError)?;
    bech32::encode_upper::<Bech32>(hrp, key.as_slice())
        .map(Zeroizing::new)
        .map_err(|_| InboxKeyError)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TEST ONLY: a public, hard-coded seed. Never fund anything derived from it.
    fn test_seed() -> SecretSeed {
        SecretSeed::from_bytes(*b"TEST-ONLY drop-operator inbox!!!")
    }

    #[test]
    fn each_payout_and_network_has_a_phrase_of_its_own() {
        let seed = test_seed();
        let a = InboxPhrase::derive(&seed, Network::Testnet, 0).unwrap();
        assert_eq!(a.expose_phrase().split(' ').count(), 24);
        assert_eq!(
            a.expose_phrase(),
            InboxPhrase::derive(&seed, Network::Testnet, 0)
                .unwrap()
                .expose_phrase()
        );
        assert_ne!(
            a.expose_phrase(),
            InboxPhrase::derive(&seed, Network::Testnet, 1)
                .unwrap()
                .expose_phrase()
        );
        assert_ne!(
            a.expose_phrase(),
            InboxPhrase::derive(&seed, Network::Mainnet, 0)
                .unwrap()
                .expose_phrase()
        );
        let other = SecretSeed::from_bytes(*b"TEST-ONLY another seed, unused!!");
        assert_ne!(
            a.expose_phrase(),
            InboxPhrase::derive(&other, Network::Testnet, 0)
                .unwrap()
                .expose_phrase()
        );
        // The phrase is a valid BIP 39 phrase, and its seed is the one zcash-devtool will compute from it.
        let parsed = <Mnemonic<English>>::from_phrase(a.expose_phrase()).unwrap();
        assert_eq!(&parsed.to_seed(""), a.wallet_seed());
    }

    #[test]
    fn the_derivation_is_pinned() {
        // If these change, every existing inbox wallet would be set up from a different phrase: never change them.
        let phrase = InboxPhrase::derive(&test_seed(), Network::Testnet, 7).unwrap();
        let words: Vec<&str> = phrase.expose_phrase().split(' ').collect();
        assert_eq!(PINNED_FIRST_WORDS, &words[..3]);
        let identity = age_identity(&test_seed(), Network::Testnet).unwrap();
        assert_eq!(PINNED_IDENTITY_PREFIX, &identity[..24]);
    }

    const PINNED_FIRST_WORDS: &[&str] = &["garlic", "nasty", "sudden"];
    const PINNED_IDENTITY_PREFIX: &str = "AGE-SECRET-KEY-1TS7T4R0Z";

    #[test]
    fn the_identity_is_an_age_secret_key() {
        let identity = age_identity(&test_seed(), Network::Testnet).unwrap();
        assert!(identity.starts_with("AGE-SECRET-KEY-1"));
        assert_eq!(identity.len(), 74, "age secret keys are 74 characters");
        let (hrp, data) = bech32::decode(&identity).unwrap();
        assert!(hrp.as_str().eq_ignore_ascii_case("age-secret-key-"));
        assert_eq!(data.len(), 32);
        assert_ne!(
            *identity,
            *age_identity(&test_seed(), Network::Mainnet).unwrap()
        );
    }

    #[test]
    fn debug_prints_no_secret() {
        let phrase = InboxPhrase::derive(&test_seed(), Network::Testnet, 0).unwrap();
        let dbg = format!("{phrase:?}");
        assert!(dbg.contains("redacted"));
        assert!(!dbg.contains(phrase.expose_phrase().split(' ').next().unwrap()));
    }
}
