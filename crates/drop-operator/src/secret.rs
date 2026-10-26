//! The wallet seed (REQ-SEC-001).
//!
//! [`SecretSeed`] holds 32 bytes of key material. It deliberately has no
//! `Serialize`, no `Clone`, and a `Debug`/`Display` that print `<redacted>`. The
//! bytes are wiped when the value is dropped. The only way to read them is the
//! explicit [`SecretSeed::expose_secret`], which a signing backend calls.

use std::fmt;

use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::CryptoError;

/// A 32-byte wallet seed that never prints, serializes or outlives its owner in memory.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SecretSeed([u8; 32]);

impl SecretSeed {
    /// Wraps existing seed bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        SecretSeed(bytes)
    }

    /// Draws a fresh seed from operating-system randomness.
    pub fn generate() -> Result<Self, CryptoError> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| CryptoError::Randomness)?;
        let seed = SecretSeed(bytes);
        bytes.zeroize();
        Ok(seed)
    }

    /// A short, non-reversible tag for telling seeds apart: eight bytes of a domain-separated
    /// SHA-256, as hex. It reveals nothing useful about the seed, and lets a campaign notice
    /// that it is being run with a different wallet than the one that created it.
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(b"zecdrop-seed-fingerprint\0");
        hasher.update(self.0);
        hex::encode(&hasher.finalize()[..8])
    }

    /// The raw seed bytes. Handle with care: never log, serialize or send them.
    pub fn expose_secret(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for SecretSeed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretSeed(<redacted>)")
    }
}

impl fmt::Display for SecretSeed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use static_assertions::{assert_impl_all, assert_not_impl_any};

    // covers: REQ-SEC-001
    #[test]
    fn the_seed_type_cannot_be_serialized_or_copied() {
        assert_not_impl_any!(SecretSeed: serde::Serialize, Clone, Copy);
        assert_impl_all!(SecretSeed: ZeroizeOnDrop, Zeroize);
    }

    // covers: REQ-SEC-001
    #[test]
    fn debug_and_display_never_show_the_bytes() {
        let seed = SecretSeed::from_bytes([0xAB; 32]);
        let texts = [
            format!("{seed:?}"),
            format!("{seed}"),
            format!("{seed:#?}"),
            format!("{:?}", Some(&seed)),
            format!("{:?}", vec![&seed]),
        ];
        for text in texts {
            assert!(text.contains("<redacted>"), "{text}");
            assert!(!text.to_lowercase().contains("ab"), "{text}");
            assert!(!text.contains("171"), "{text}"); // 0xAB in decimal
        }
    }

    // covers: REQ-SEC-001
    #[test]
    fn zeroize_wipes_the_bytes() {
        let mut seed = SecretSeed::from_bytes([0x5A; 32]);
        assert_eq!(seed.expose_secret(), &[0x5A; 32]);
        seed.zeroize();
        assert_eq!(seed.expose_secret(), &[0u8; 32]);
    }

    // covers: REQ-SEC-001
    #[test]
    fn the_fingerprint_tells_seeds_apart_without_revealing_them() {
        let a = SecretSeed::from_bytes([0x11; 32]);
        let b = SecretSeed::from_bytes([0x12; 32]);
        assert_eq!(
            a.fingerprint(),
            SecretSeed::from_bytes([0x11; 32]).fingerprint()
        );
        assert_ne!(a.fingerprint(), b.fingerprint());
        assert_eq!(a.fingerprint().len(), 16);
        assert!(!a.fingerprint().contains("1111"), "not the seed bytes");
    }

    // covers: REQ-SEC-001
    #[test]
    fn generated_seeds_differ() {
        let a = SecretSeed::generate().unwrap();
        let b = SecretSeed::generate().unwrap();
        assert_ne!(a.expose_secret(), b.expose_secret());
        assert_ne!(a.expose_secret(), &[0u8; 32]);
    }
}
