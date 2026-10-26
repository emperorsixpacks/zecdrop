//! The salted manifest commitment (REQ-MAN-001).
//!
//! A [`Manifest`] is the full private payout list: ordered rows (address, amount,
//! memo), the campaign id and a 32-byte [`Salt`]. Its [`commitment`](Manifest::commitment)
//! is published on the receipt so that anyone holding the manifest can later prove
//! it is the list the campaign was run against, without the receipt revealing it.
//!
//! **Why salted.** Addresses and amounts come from small, guessable sets. A bare
//! hash of the rows would let anyone with a candidate list (a token-holder
//! snapshot, say) confirm or refute guesses offline. The random 32-byte salt makes
//! the commitment hiding; SHA-256 collision resistance keeps it binding. The salt
//! stays with the operator and is shared only with whoever must verify the manifest.
//!
//! **Encoding.** SHA-256 over, in order:
//!
//! ```text
//! b"zecdrop/manifest/v1\0"                       domain separation
//! salt                                           32 bytes
//! u32be len || campaign id (UTF-8)
//! u64be row count
//! for each row, in order:
//!     u32be len || address (UTF-8)
//!     u64be amount in zatoshi
//!     u8 0                                       no memo
//!     u8 1 || u32be len || memo (UTF-8)          memo present
//! ```
//!
//! Every variable-length field is length-prefixed, so shifting bytes between
//! neighbouring fields (`"ab","c"` versus `"a","bc"`) changes the digest.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::amount::Zatoshi;
use crate::error::ManifestError;
use crate::ids::{impl_serde_via_str, CampaignId};
use crate::recipient::{total_amount, Recipient};

/// Domain-separation tag hashed first.
const DOMAIN_TAG: &[u8] = b"zecdrop/manifest/v1\0";

/// A 32-byte random salt. Zeroized on drop and never shown by `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct Salt([u8; 32]);

impl Salt {
    /// Draws a fresh salt from operating-system randomness.
    pub fn generate() -> Result<Self, ManifestError> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| ManifestError::Randomness)?;
        Ok(Salt(bytes))
    }

    /// Wraps exactly 32 bytes.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Salt(bytes)
    }

    /// Wraps a byte slice, which must be exactly 32 bytes long.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, ManifestError> {
        let array: [u8; 32] = bytes
            .try_into()
            .map_err(|_| ManifestError::BadSaltLength { got: bytes.len() })?;
        Ok(Salt(array))
    }

    /// The salt bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The salt as 64 lowercase hex characters. Treat the result as a secret.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl FromStr for Salt {
    type Err = ManifestError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut bytes = [0u8; 32];
        if s.len() != 64 {
            return Err(ManifestError::BadHex);
        }
        hex::decode_to_slice(s, &mut bytes).map_err(|_| ManifestError::BadHex)?;
        Ok(Salt(bytes))
    }
}

impl Drop for Salt {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for Salt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Salt(<redacted>)")
    }
}

impl Serialize for Salt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Salt {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

/// The SHA-256 commitment to a [`Manifest`], shown as 64 lowercase hex characters.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ManifestCommitment([u8; 32]);

impl ManifestCommitment {
    /// Wraps a raw digest.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        ManifestCommitment(bytes)
    }

    /// The raw digest.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for ManifestCommitment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl fmt::Debug for ManifestCommitment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ManifestCommitment({self})")
    }
}

impl FromStr for ManifestCommitment {
    type Err = ManifestError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut bytes = [0u8; 32];
        if s.len() != 64 {
            return Err(ManifestError::BadHex);
        }
        hex::decode_to_slice(s, &mut bytes).map_err(|_| ManifestError::BadHex)?;
        Ok(ManifestCommitment(bytes))
    }
}

impl_serde_via_str!(ManifestCommitment);

/// The private payout list a campaign commits to.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Manifest {
    campaign_id: CampaignId,
    salt: Salt,
    rows: Vec<Recipient>,
}

impl Manifest {
    /// Builds a manifest. There must be at least one row, and the amounts must add
    /// up to no more than the maximum supply.
    pub fn new(
        campaign_id: CampaignId,
        salt: Salt,
        rows: Vec<Recipient>,
    ) -> Result<Self, ManifestError> {
        if rows.is_empty() {
            return Err(ManifestError::NoRecipients);
        }
        total_amount(&rows)?;
        Ok(Manifest {
            campaign_id,
            salt,
            rows,
        })
    }

    /// The campaign this manifest belongs to.
    pub fn campaign_id(&self) -> &CampaignId {
        &self.campaign_id
    }

    /// The salt. Treat as a secret.
    pub fn salt(&self) -> &Salt {
        &self.salt
    }

    /// The rows, in payout order.
    pub fn rows(&self) -> &[Recipient] {
        &self.rows
    }

    /// The sum of all row amounts.
    pub fn total(&self) -> Result<Zatoshi, crate::error::AmountError> {
        total_amount(&self.rows)
    }

    /// The commitment: SHA-256 over the canonical encoding in the module docs.
    pub fn commitment(&self) -> ManifestCommitment {
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN_TAG);
        hasher.update(self.salt.as_bytes());
        put_bytes(&mut hasher, self.campaign_id.as_str().as_bytes());
        hasher.update((self.rows.len() as u64).to_be_bytes());
        for row in &self.rows {
            put_bytes(&mut hasher, row.address().as_bytes());
            hasher.update(row.amount().as_u64().to_be_bytes());
            match row.memo() {
                None => hasher.update([0u8]),
                Some(memo) => {
                    hasher.update([1u8]);
                    put_bytes(&mut hasher, memo.as_bytes());
                }
            }
        }
        ManifestCommitment(hasher.finalize().into())
    }

    /// Checks that this manifest hashes to `expected`.
    pub fn verify_commitment(&self, expected: &ManifestCommitment) -> Result<(), ManifestError> {
        if self.commitment() == *expected {
            Ok(())
        } else {
            Err(ManifestError::CommitmentMismatch)
        }
    }
}

/// Hashes a `u32` big-endian length followed by the bytes.
///
/// Every field passed here is bounded by its constructor (campaign id at most 64
/// bytes, address at most 1024, memo at most 512), so the length fits a `u32`.
fn put_bytes(hasher: &mut Sha256, bytes: &[u8]) {
    let len = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
    hasher.update(len.to_be_bytes());
    hasher.update(bytes);
}

impl fmt::Debug for Manifest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Manifest{{campaign_id: {}, rows: {}, salt: <redacted>}}",
            self.campaign_id,
            self.rows.len()
        )
    }
}

/// Deserialization goes through [`Manifest::new`] so stored manifests obey its rules.
#[derive(Deserialize)]
struct ManifestWire {
    campaign_id: CampaignId,
    salt: Salt,
    rows: Vec<Recipient>,
}

impl<'de> Deserialize<'de> for Manifest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = ManifestWire::deserialize(deserializer)?;
        Manifest::new(wire.campaign_id, wire.salt, wire.rows).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(addr: &str, zat: u64, memo: Option<&str>) -> Recipient {
        Recipient::new(addr, Zatoshi::new(zat).unwrap(), memo.map(str::to_owned)).unwrap()
    }

    fn salt(byte: u8) -> Salt {
        Salt::from_bytes([byte; 32])
    }

    fn rows() -> Vec<Recipient> {
        vec![
            row("u1alice", 150_000_000, Some("thanks")),
            row("u1bob", 25_000_000, None),
            row("zs1carol", 1, Some("")),
        ]
    }

    fn manifest() -> Manifest {
        Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), rows()).unwrap()
    }

    // covers: REQ-MAN-001
    #[test]
    fn commitment_is_deterministic() {
        assert_eq!(manifest().commitment(), manifest().commitment());
        assert_eq!(manifest().commitment().to_string().len(), 64);
    }

    // covers: REQ-MAN-001
    #[test]
    fn known_answer_vector() {
        // Independently computed with Python's hashlib from the encoding in the module docs
        // (the empty memo on the third row normalizes to no memo).
        let commitment = manifest().commitment().to_string();
        assert_eq!(
            commitment,
            "aade9fd18f7c48dc3b04ead6a7ee2211640d0fa5948dfd14b5a356463c841491"
        );
    }

    // covers: REQ-MAN-001
    #[test]
    fn changing_row_order_changes_commitment() {
        let mut r = rows();
        r.swap(0, 1);
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn changing_an_amount_changes_commitment() {
        let mut r = rows();
        r[1] = row("u1bob", 25_000_001, None);
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn changing_a_memo_changes_commitment() {
        let mut r = rows();
        r[0] = row("u1alice", 150_000_000, Some("thanks!"));
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());

        // Adding or removing a memo also changes it.
        let mut r = rows();
        r[1] = row("u1bob", 25_000_000, Some("x"));
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
        let mut r = rows();
        r[0] = row("u1alice", 150_000_000, None);
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn changing_an_address_changes_commitment() {
        let mut r = rows();
        r[2] = row("zs1carol2", 1, Some(""));
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn changing_the_salt_changes_commitment() {
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(8), rows()).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
        // A single flipped bit is enough.
        let mut bytes = [7u8; 32];
        bytes[31] ^= 1;
        let m = Manifest::new(
            CampaignId::new("spring-drop").unwrap(),
            Salt::from_bytes(bytes),
            rows(),
        )
        .unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn changing_the_campaign_id_changes_commitment() {
        let m = Manifest::new(CampaignId::new("spring-drop2").unwrap(), salt(7), rows()).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn adding_or_dropping_a_row_changes_commitment() {
        let mut r = rows();
        r.pop();
        let m = Manifest::new(CampaignId::new("spring-drop").unwrap(), salt(7), r).unwrap();
        assert_ne!(m.commitment(), manifest().commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn length_prefixes_stop_boundary_shifting() {
        let id = || CampaignId::new("c").unwrap();
        let a = Manifest::new(id(), salt(1), vec![row("ab", 5, Some("c"))]).unwrap();
        let b = Manifest::new(id(), salt(1), vec![row("a", 5, Some("bc"))]).unwrap();
        assert_ne!(a.commitment(), b.commitment());

        // Campaign id versus address boundary.
        let a = Manifest::new(
            CampaignId::new("ab").unwrap(),
            salt(1),
            vec![row("c", 5, None)],
        )
        .unwrap();
        let b = Manifest::new(
            CampaignId::new("a").unwrap(),
            salt(1),
            vec![row("bc", 5, None)],
        )
        .unwrap();
        assert_ne!(a.commitment(), b.commitment());
    }

    // covers: REQ-MAN-001
    #[test]
    fn salt_must_be_exactly_32_bytes() {
        assert!(Salt::from_slice(&[0u8; 32]).is_ok());
        for len in [0usize, 1, 31, 33, 64] {
            assert_eq!(
                Salt::from_slice(&vec![0u8; len]),
                Err(ManifestError::BadSaltLength { got: len })
            );
        }
        assert!("00".repeat(32).parse::<Salt>().is_ok());
        assert_eq!("00".repeat(31).parse::<Salt>(), Err(ManifestError::BadHex));
        assert_eq!("zz".repeat(32).parse::<Salt>(), Err(ManifestError::BadHex));
    }

    // covers: REQ-MAN-001
    #[test]
    fn generated_salts_are_random_and_never_shown() {
        let a = Salt::generate().unwrap();
        let b = Salt::generate().unwrap();
        assert_ne!(a, b);
        assert_ne!(a.as_bytes(), &[0u8; 32]);
        let text = format!("{a:?} {:?}", manifest());
        assert!(!text.contains(&a.to_hex()));
        assert!(text.contains("<redacted>"));
        assert!(!format!("{:?}", manifest()).contains(&"07".repeat(32)));
    }

    // covers: REQ-MAN-001
    #[test]
    fn verify_commitment_accepts_match_and_rejects_mismatch() {
        let m = manifest();
        let good = m.commitment();
        assert_eq!(m.verify_commitment(&good), Ok(()));

        let mut other = *good.as_bytes();
        other[0] ^= 0xff;
        assert_eq!(
            m.verify_commitment(&ManifestCommitment::from_bytes(other)),
            Err(ManifestError::CommitmentMismatch)
        );

        // Hex round trip of the published form.
        let parsed: ManifestCommitment = good.to_string().parse().unwrap();
        assert_eq!(m.verify_commitment(&parsed), Ok(()));
        assert!("abc".parse::<ManifestCommitment>().is_err());
    }

    // covers: REQ-MAN-001
    #[test]
    fn manifest_requires_rows_and_a_valid_total() {
        let id = CampaignId::new("c").unwrap();
        assert_eq!(
            Manifest::new(id.clone(), salt(1), vec![]),
            Err(ManifestError::NoRecipients)
        );
        let over = vec![
            row("u1a", crate::amount::MAX_MONEY, None),
            row("u1b", 1, None),
        ];
        assert!(matches!(
            Manifest::new(id, salt(1), over),
            Err(ManifestError::Amount(_))
        ));
    }

    // covers: REQ-MAN-001
    #[test]
    fn serde_round_trip_keeps_the_commitment() {
        let m = manifest();
        let json = serde_json::to_string(&m).unwrap();
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.commitment(), m.commitment());
        assert_eq!(back, m);
    }
}
