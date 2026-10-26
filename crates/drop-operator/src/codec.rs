//! A placeholder address codec until the Zcash adapter supplies the real one.
//!
//! [`LooseAddressCodec`] checks only the *shape* of an address: ASCII
//! letters and digits, and a prefix that says what kind of receiver it is. It does
//! **not** verify checksums or the network, so a mistyped address can pass. The
//! operator takes the codec as a trait object precisely so the checked
//! implementation from `drop-zcash` replaces this one without other changes.

use drop_core::{AddressCodec, AddressError, RecipientKind};

/// Shape-only address validation. See the module docs for what it does not check.
#[derive(Clone, Copy, Debug, Default)]
pub struct LooseAddressCodec;

impl AddressCodec for LooseAddressCodec {
    fn validate(&self, address: &str) -> Result<RecipientKind, AddressError> {
        if address.is_empty() {
            return Err(AddressError::Empty);
        }
        if !address.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(AddressError::Malformed {
                reason: "unexpected character",
            });
        }
        match address.as_bytes().first().map(u8::to_ascii_lowercase) {
            Some(b'u') => Ok(RecipientKind::Unified),
            Some(b'z') => Ok(RecipientKind::Shielded),
            Some(b't') => Ok(RecipientKind::Transparent),
            _ => Err(AddressError::Malformed {
                reason: "unknown address prefix",
            }),
        }
    }

    /// Bech32 addresses (unified, shielded) are case-insensitive; base58 transparent ones are not.
    fn canonical(&self, address: &str) -> String {
        match address.as_bytes().first().map(u8::to_ascii_lowercase) {
            Some(b'u' | b'z') => address.to_ascii_lowercase(),
            _ => address.to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_prefix_and_rejects_junk() {
        let codec = LooseAddressCodec;
        assert_eq!(codec.validate("u1abc"), Ok(RecipientKind::Unified));
        assert_eq!(codec.validate("utest1abc"), Ok(RecipientKind::Unified));
        assert_eq!(codec.validate("zs1abc"), Ok(RecipientKind::Shielded));
        assert_eq!(codec.validate("t1abc"), Ok(RecipientKind::Transparent));
        assert_eq!(codec.validate(""), Err(AddressError::Empty));
        for bad in ["x1abc", "u1 abc", "u1abc!", "é1abc"] {
            assert!(codec.validate(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_bech32_addresses_are_case_folded() {
        let codec = LooseAddressCodec;
        assert_eq!(codec.canonical("U1ABC"), "u1abc");
        assert_eq!(codec.canonical("ZS1ABC"), "zs1abc");
        assert_eq!(codec.canonical("t1AbC"), "t1AbC");
    }
}
