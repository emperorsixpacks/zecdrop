//! The address port. The real implementation lives in `drop-zcash`; this crate only
//! sees the verdict, which keeps it free of chain dependencies.

use crate::error::AddressError;

/// What kind of receiver an address pays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RecipientKind {
    /// A standalone shielded address (Sapling).
    Shielded,
    /// A unified address, which may carry an Orchard receiver.
    Unified,
    /// A transparent address. Rejected by default; see [`check_policy`].
    Transparent,
}

/// Validates address strings for a particular network.
pub trait AddressCodec {
    /// Decodes `address` and reports what kind of receiver it is.
    ///
    /// Implementations must not put the address text into the returned error.
    fn validate(&self, address: &str) -> Result<RecipientKind, AddressError>;

    /// A form of `address` that is equal for two spellings of the same address,
    /// used to catch duplicates. The default is the text unchanged.
    ///
    /// Adapters should override this where spellings differ (for example Bech32
    /// strings are valid in all-lowercase or all-uppercase). Base58 transparent
    /// addresses are case-sensitive and must not be case-folded.
    fn canonical(&self, address: &str) -> String {
        address.to_owned()
    }
}

impl<C: AddressCodec + ?Sized> AddressCodec for &C {
    fn validate(&self, address: &str) -> Result<RecipientKind, AddressError> {
        (**self).validate(address)
    }

    fn canonical(&self, address: &str) -> String {
        (**self).canonical(address)
    }
}

/// Applies the product policy to a validated recipient kind: transparent
/// recipients are refused unless `allow_transparent` is set, because paying one
/// publishes the recipient and amount on-chain.
pub fn check_policy(kind: RecipientKind, allow_transparent: bool) -> Result<(), AddressError> {
    match kind {
        RecipientKind::Transparent if !allow_transparent => {
            Err(AddressError::TransparentNotAllowed)
        }
        _ => Ok(()),
    }
}

/// A shape-only codec for tests. It checks no checksums and no network: it accepts
/// any non-empty ASCII-alphanumeric string that starts with `t` (transparent),
/// `u` (unified) or `z` (shielded), and rejects everything else.
#[cfg(any(test, feature = "test-util"))]
#[derive(Clone, Copy, Debug, Default)]
pub struct PermissiveCodec;

#[cfg(any(test, feature = "test-util"))]
impl AddressCodec for PermissiveCodec {
    fn validate(&self, address: &str) -> Result<RecipientKind, AddressError> {
        if address.is_empty() {
            return Err(AddressError::Empty);
        }
        if !address.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(AddressError::Malformed {
                reason: "unexpected character",
            });
        }
        match address.as_bytes()[0] {
            b't' => Ok(RecipientKind::Transparent),
            b'u' => Ok(RecipientKind::Unified),
            b'z' => Ok(RecipientKind::Shielded),
            _ => Err(AddressError::Malformed {
                reason: "unknown prefix",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-IMP-001
    #[test]
    fn permissive_codec_classifies_by_prefix() {
        let codec = PermissiveCodec;
        assert_eq!(codec.validate("u1abc"), Ok(RecipientKind::Unified));
        assert_eq!(codec.validate("zs1abc"), Ok(RecipientKind::Shielded));
        assert_eq!(codec.validate("t1abc"), Ok(RecipientKind::Transparent));
        assert_eq!(codec.validate(""), Err(AddressError::Empty));
        assert!(codec.validate("x1abc").is_err());
        assert!(codec.validate("u1 abc").is_err());
        assert!(codec.validate("u1abc!").is_err());
    }

    // covers: REQ-IMP-001
    #[test]
    fn policy_rejects_transparent_unless_allowed() {
        assert_eq!(
            check_policy(RecipientKind::Transparent, false),
            Err(AddressError::TransparentNotAllowed)
        );
        assert_eq!(check_policy(RecipientKind::Transparent, true), Ok(()));
        assert_eq!(check_policy(RecipientKind::Unified, false), Ok(()));
        assert_eq!(check_policy(RecipientKind::Shielded, false), Ok(()));
    }
}
