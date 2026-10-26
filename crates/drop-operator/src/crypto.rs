//! Encryption at rest (REQ-SEC-002).
//!
//! * The store key comes from the passphrase with **Argon2id** and a random
//!   16-byte salt kept in the store header.
//! * Each record is sealed with **XChaCha20-Poly1305** under a fresh random
//!   24-byte nonce.
//! * The associated data names the record's place (kind, campaign, index), so a
//!   valid record copied to another row fails authentication.
//!
//! Sealed record layout: `format byte (1) || nonce (24) || ciphertext || tag (16)`.

use std::fmt;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::CryptoError;

/// Length of the Argon2 salt in bytes.
pub const SALT_LEN: usize = 16;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const RECORD_FORMAT: u8 = 1;

/// Argon2id cost parameters, stored in the clear in the store header.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub memory_kib: u32,
    /// Number of passes.
    pub iterations: u32,
    /// Degree of parallelism.
    pub parallelism: u32,
}

impl KdfParams {
    /// Parameters for real use: 64 MiB, 3 passes, 1 lane.
    pub const PRODUCTION: KdfParams = KdfParams {
        memory_kib: 64 * 1024,
        iterations: 3,
        parallelism: 1,
    };

    /// Deliberately weak parameters so tests run fast. Never use for real data.
    pub const TESTING: KdfParams = KdfParams {
        memory_kib: 64,
        iterations: 1,
        parallelism: 1,
    };

    /// Whether the parameters are inside the range this program accepts. The
    /// upper bounds stop a tampered header from requesting absurd amounts of memory.
    pub fn is_acceptable(&self) -> bool {
        (8..=1024 * 1024).contains(&self.memory_kib)
            && (1..=32).contains(&self.iterations)
            && (1..=16).contains(&self.parallelism)
            && self.memory_kib >= 8 * self.parallelism
    }
}

/// The 32-byte key that seals every record. Wiped on drop; never printed.
pub struct StoreKey(Zeroizing<[u8; KEY_LEN]>);

impl fmt::Debug for StoreKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoreKey(<redacted>)")
    }
}

/// Fills `buf` from operating-system randomness.
pub fn random_bytes(buf: &mut [u8]) -> Result<(), CryptoError> {
    getrandom::fill(buf).map_err(|_| CryptoError::Randomness)
}

/// The shortest passphrase a new store accepts, counted in characters. A short passphrase is
/// the weakest part of an encrypted store whose file may be copied.
pub const MIN_PASSPHRASE_CHARS: usize = 12;

/// Derives the store key from `passphrase` with Argon2id.
pub fn derive_key(
    passphrase: &str,
    salt: &[u8; SALT_LEN],
    params: &KdfParams,
) -> Result<StoreKey, CryptoError> {
    if !params.is_acceptable() {
        return Err(CryptoError::Kdf);
    }
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|_| CryptoError::Kdf)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|_| CryptoError::Kdf)?;
    Ok(StoreKey(key))
}

fn cipher(key: &StoreKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&Key::from(*key.0))
}

/// Seals `plaintext` for the place named by `aad`.
pub fn seal(key: &StoreKey, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    random_bytes(&mut nonce_bytes)?;
    let ciphertext = cipher(key)
        .encrypt(
            &XNonce::from(nonce_bytes),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;
    let mut record = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    record.push(RECORD_FORMAT);
    record.extend_from_slice(&nonce_bytes);
    record.extend_from_slice(&ciphertext);
    Ok(record)
}

/// Opens a sealed record. Fails if it was altered, moved to another place, or
/// sealed under another key.
pub fn open(key: &StoreKey, aad: &[u8], record: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if record.len() < 1 + NONCE_LEN + TAG_LEN || record[0] != RECORD_FORMAT {
        return Err(CryptoError::BadFormat);
    }
    let (nonce, ciphertext) = record[1..].split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| CryptoError::BadFormat)?;
    cipher(key)
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Decrypt)
}

/// The associated data that binds a row tag to one table and to every column of the row.
/// Each field is length-prefixed and told apart from "absent", so no two different rows
/// encode alike.
fn row_aad(table: &str, fields: &[Option<&[u8]>]) -> Vec<u8> {
    let mut aad = Vec::new();
    aad.extend_from_slice(b"zecdrop-row-tag-v1\0");
    aad.extend_from_slice(&(table.len() as u32).to_be_bytes());
    aad.extend_from_slice(table.as_bytes());
    for field in fields {
        match field {
            None => aad.push(0),
            Some(bytes) => {
                aad.push(1);
                aad.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                aad.extend_from_slice(bytes);
            }
        }
    }
    aad
}

/// Authenticates a row of columns that are stored in the clear: an AEAD seal of nothing, whose
/// associated data is the whole row. Changing any column, or moving the tag to another row,
/// makes [`check_row_tag`] fail.
pub fn row_tag(
    key: &StoreKey,
    table: &str,
    fields: &[Option<&[u8]>],
) -> Result<Vec<u8>, CryptoError> {
    seal(key, &row_aad(table, fields), &[])
}

/// Checks a tag made by [`row_tag`] against the row as it is now.
pub fn check_row_tag(
    key: &StoreKey,
    table: &str,
    fields: &[Option<&[u8]>],
    tag: &[u8],
) -> Result<(), CryptoError> {
    open(key, &row_aad(table, fields), tag).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; SALT_LEN] = [7; SALT_LEN];

    fn key(pass: &str) -> StoreKey {
        derive_key(pass, &SALT, &KdfParams::TESTING).unwrap()
    }

    // covers: REQ-SEC-002
    #[test]
    fn seal_then_open_round_trips() {
        let k = key("correct horse");
        let sealed = seal(&k, b"place-1", b"hello records").unwrap();
        assert_eq!(
            &open(&k, b"place-1", &sealed).unwrap()[..],
            b"hello records"
        );
        // Empty plaintext is fine too.
        let sealed = seal(&k, b"p", b"").unwrap();
        assert!(open(&k, b"p", &sealed).unwrap().is_empty());
    }

    // covers: REQ-SEC-002
    #[test]
    fn every_seal_uses_a_fresh_nonce() {
        let k = key("pass");
        let a = seal(&k, b"p", b"same plaintext").unwrap();
        let b = seal(&k, b"p", b"same plaintext").unwrap();
        assert_ne!(a, b, "identical plaintexts must not give identical records");
        assert_ne!(a[1..1 + NONCE_LEN], b[1..1 + NONCE_LEN], "nonces differ");
        assert_eq!(a.len(), 1 + NONCE_LEN + b"same plaintext".len() + TAG_LEN);
    }

    // covers: REQ-SEC-002
    #[test]
    fn the_plaintext_is_not_visible_in_the_record() {
        let k = key("pass");
        let sealed = seal(&k, b"p", b"sentinel-plaintext-0123456789").unwrap();
        assert!(!sealed.windows(b"sentinel".len()).any(|w| w == b"sentinel"));
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_wrong_key_or_wrong_place_fails_authentication() {
        let k = key("right");
        let sealed = seal(&k, b"campaign-a", b"secret").unwrap();
        assert_eq!(
            open(&key("wrong"), b"campaign-a", &sealed).unwrap_err(),
            CryptoError::Decrypt
        );
        assert_eq!(
            open(&k, b"campaign-b", &sealed).unwrap_err(),
            CryptoError::Decrypt
        );
    }

    // covers: REQ-SEC-002
    #[test]
    fn any_flipped_byte_is_detected() {
        let k = key("pass");
        let sealed = seal(&k, b"p", b"a reasonably long secret payload").unwrap();
        for i in 0..sealed.len() {
            let mut bad = sealed.clone();
            bad[i] ^= 0x01;
            let err = open(&k, b"p", &bad).unwrap_err();
            assert!(
                matches!(err, CryptoError::Decrypt | CryptoError::BadFormat),
                "byte {i}: {err}"
            );
        }
    }

    // covers: REQ-SEC-002
    #[test]
    fn truncated_or_foreign_records_are_rejected_not_misread() {
        let k = key("pass");
        let sealed = seal(&k, b"p", b"payload").unwrap();
        assert_eq!(open(&k, b"p", &[]).unwrap_err(), CryptoError::BadFormat);
        assert_eq!(
            open(&k, b"p", &sealed[..20]).unwrap_err(),
            CryptoError::BadFormat
        );
        assert!(open(&k, b"p", &sealed[..sealed.len() - 1]).is_err());
        let mut other_format = sealed.clone();
        other_format[0] = 9;
        assert_eq!(
            open(&k, b"p", &other_format).unwrap_err(),
            CryptoError::BadFormat
        );
    }

    // covers: REQ-SEC-002
    #[test]
    fn key_derivation_depends_on_passphrase_salt_and_params() {
        let base = key("pass");
        let same = key("pass");
        assert_eq!(base.0.as_ref(), same.0.as_ref(), "deterministic");
        assert_ne!(base.0.as_ref(), key("pass2").0.as_ref());
        let other_salt = derive_key("pass", &[8; SALT_LEN], &KdfParams::TESTING).unwrap();
        assert_ne!(base.0.as_ref(), other_salt.0.as_ref());
        let other_params = derive_key(
            "pass",
            &SALT,
            &KdfParams {
                iterations: 2,
                ..KdfParams::TESTING
            },
        )
        .unwrap();
        assert_ne!(base.0.as_ref(), other_params.0.as_ref());
    }

    // covers: REQ-SEC-002
    #[test]
    fn unacceptable_parameters_are_refused() {
        let bad = [
            KdfParams {
                memory_kib: 0,
                iterations: 1,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 4,
                iterations: 1,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 64,
                iterations: 0,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 64,
                iterations: 1,
                parallelism: 0,
            },
            KdfParams {
                memory_kib: u32::MAX,
                iterations: 1,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 64,
                iterations: 1000,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 64,
                iterations: 1,
                parallelism: 100,
            },
        ];
        for params in bad {
            assert!(!params.is_acceptable(), "{params:?}");
            assert_eq!(
                derive_key("p", &SALT, &params).unwrap_err(),
                CryptoError::Kdf
            );
        }
        assert!(KdfParams::PRODUCTION.is_acceptable());
        assert!(KdfParams::TESTING.is_acceptable());
    }

    // covers: REQ-SEC-002
    #[test]
    fn the_key_never_prints() {
        let text = format!("{:?}", key("pass"));
        assert_eq!(text, "StoreKey(<redacted>)");
    }
}
