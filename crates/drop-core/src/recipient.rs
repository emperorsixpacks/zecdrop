//! A single payout: address, amount and optional memo.
//!
//! Recipient data is the private part of a campaign. `Debug` and `Display`
//! therefore redact it (REQ-PRIV-002); the only way to read the fields is through
//! the explicit accessors.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::amount::Zatoshi;
use crate::error::{AmountError, RecipientError};

/// Maximum memo length in UTF-8 bytes (the size of the Zcash memo field).
pub const MAX_MEMO_BYTES: usize = 512;

/// Maximum address length in bytes. Generous for multi-receiver unified addresses.
pub const MAX_ADDRESS_BYTES: usize = 1024;

/// Checks a memo against [`MAX_MEMO_BYTES`].
pub fn check_memo(memo: &str) -> Result<(), RecipientError> {
    if memo.len() > MAX_MEMO_BYTES {
        return Err(RecipientError::MemoTooLong {
            bytes: memo.len(),
            max: MAX_MEMO_BYTES,
        });
    }
    Ok(())
}

/// One payout. Construct with [`Recipient::new`], which enforces the field limits.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Recipient {
    address: String,
    amount: Zatoshi,
    memo: Option<String>,
}

impl Recipient {
    /// Builds a recipient. The address must be non-empty and at most
    /// [`MAX_ADDRESS_BYTES`], the amount greater than zero, and the memo at most
    /// [`MAX_MEMO_BYTES`] (an empty memo is stored as no memo).
    ///
    /// Whether the address is a *valid Zcash address* is decided by
    /// [`crate::codec::AddressCodec`], not here.
    pub fn new(
        address: impl Into<String>,
        amount: Zatoshi,
        memo: Option<String>,
    ) -> Result<Self, RecipientError> {
        let address = address.into();
        if address.is_empty() {
            return Err(RecipientError::EmptyAddress);
        }
        if address.len() > MAX_ADDRESS_BYTES {
            return Err(RecipientError::AddressTooLong {
                max: MAX_ADDRESS_BYTES,
            });
        }
        if amount.is_zero() {
            return Err(RecipientError::ZeroAmount);
        }
        let memo = memo.filter(|m| !m.is_empty());
        if let Some(memo) = &memo {
            check_memo(memo)?;
        }
        Ok(Recipient {
            address,
            amount,
            memo,
        })
    }

    /// The recipient's address string.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The amount to pay.
    pub fn amount(&self) -> Zatoshi {
        self.amount
    }

    /// The memo, if any.
    pub fn memo(&self) -> Option<&str> {
        self.memo.as_deref()
    }
}

/// Sums recipient amounts with checked arithmetic.
pub fn total_amount(rows: &[Recipient]) -> Result<Zatoshi, AmountError> {
    Zatoshi::checked_sum(rows.iter().map(Recipient::amount))
}

impl fmt::Debug for Recipient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let memo = if self.memo.is_some() {
            "<redacted>"
        } else {
            "none"
        };
        // Nothing derived from the address is shown: not a head or a tail of it, not its length.
        write!(
            f,
            "Recipient{{addr: <redacted>, amount: <redacted>, memo: {memo}}}"
        )
    }
}

impl fmt::Display for Recipient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

/// Deserialization goes through [`Recipient::new`] so stored data obeys the same limits.
#[derive(Deserialize)]
struct RecipientWire {
    address: String,
    amount: Zatoshi,
    memo: Option<String>,
}

impl<'de> Deserialize<'de> for Recipient {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = RecipientWire::deserialize(deserializer)?;
        Recipient::new(wire.address, wire.amount, wire.memo).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "u1sentinelrecipientaddress0123456789xyz";
    const AMOUNT_ZAT: u64 = 7_777_001;
    const MEMO: &str = "sentinel-memo-secret";

    fn sentinel() -> Recipient {
        Recipient::new(
            ADDR,
            Zatoshi::new(AMOUNT_ZAT).unwrap(),
            Some(MEMO.to_owned()),
        )
        .unwrap()
    }

    // covers: REQ-PRIV-002
    #[test]
    fn debug_and_display_redact_address_amount_and_memo() {
        let r = sentinel();
        for text in [
            format!("{r:?}"),
            format!("{r}"),
            format!("{r:#?}"),
            format!("{:?}", vec![r.clone()]),
            format!("{:?}", Some(&r)),
        ] {
            assert!(!text.contains("sentinelrecipient"), "{text}");
            assert!(!text.contains(ADDR), "{text}");
            assert!(!text.contains("7777001"), "{text}");
            assert!(!text.contains("0.07777001"), "{text}");
            assert!(!text.contains(MEMO), "{text}");
            assert!(text.contains("<redacted>"), "{text}");
        }
        // Not even the start or the end of the address is shown: nothing is derived from it.
        let text = format!("{r:?}");
        assert_eq!(
            text,
            "Recipient{addr: <redacted>, amount: <redacted>, memo: <redacted>}"
        );
        for part in [&ADDR[..2], &ADDR[ADDR.len() - 4..]] {
            assert!(!text.contains(part), "{part} in {text}");
        }
    }

    // covers: REQ-PRIV-002
    #[test]
    fn two_addresses_of_different_kinds_and_lengths_debug_identically() {
        // So that neither the form nor the length of an address can be read from a log line.
        let one = Zatoshi::new(1).unwrap();
        let texts: Vec<String> = ["t1short", "u1medium0000000000000000", &"z".repeat(180)]
            .iter()
            .map(|a| format!("{:?}", Recipient::new(*a, one, None).unwrap()))
            .collect();
        assert!(texts.windows(2).all(|w| w[0] == w[1]), "{texts:?}");
    }

    // covers: REQ-PRIV-002
    #[test]
    fn short_addresses_show_nothing() {
        let r = Recipient::new("t1short", Zatoshi::new(1).unwrap(), None).unwrap();
        let text = format!("{r:?}");
        assert!(!text.contains("t1short"));
        assert!(!text.contains("short"));
        assert!(text.contains("memo: none"));
    }

    // covers: REQ-PRIV-002
    #[test]
    fn multibyte_addresses_do_not_panic_when_redacted() {
        let r = Recipient::new("ü".repeat(40), Zatoshi::new(1).unwrap(), None).unwrap();
        let text = format!("{r:?}");
        assert!(!text.contains(&"ü".repeat(10)));
    }

    // covers: REQ-IMP-001
    #[test]
    fn new_enforces_field_limits() {
        let one = Zatoshi::new(1).unwrap();
        assert_eq!(
            Recipient::new("", one, None),
            Err(RecipientError::EmptyAddress)
        );
        assert_eq!(
            Recipient::new("u1a", Zatoshi::ZERO, None),
            Err(RecipientError::ZeroAmount)
        );
        assert!(matches!(
            Recipient::new("a".repeat(MAX_ADDRESS_BYTES + 1), one, None),
            Err(RecipientError::AddressTooLong { .. })
        ));
        assert!(Recipient::new("u1a", one, Some("é".repeat(256))).is_ok());
        assert_eq!(
            Recipient::new("u1a", one, Some("a".repeat(513))),
            Err(RecipientError::MemoTooLong {
                bytes: 513,
                max: 512
            })
        );
        // 257 two-byte characters is 514 bytes: the limit is bytes, not characters.
        assert!(Recipient::new("u1a", one, Some("é".repeat(257))).is_err());
        // An empty memo is no memo.
        assert_eq!(
            Recipient::new("u1a", one, Some(String::new()))
                .unwrap()
                .memo(),
            None
        );
    }

    // covers: REQ-AMT-002
    #[test]
    fn total_amount_is_checked() {
        let big = Zatoshi::MAX;
        let rows = vec![
            Recipient::new("u1a", big, None).unwrap(),
            Recipient::new("u1b", Zatoshi::new(1).unwrap(), None).unwrap(),
        ];
        assert_eq!(total_amount(&rows), Err(AmountError::ExceedsMaxMoney));
        assert_eq!(total_amount(&rows[..1]), Ok(Zatoshi::MAX));
        assert_eq!(total_amount(&[]), Ok(Zatoshi::ZERO));
    }

    #[test]
    fn serde_round_trip_enforces_limits() {
        let r = sentinel();
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<Recipient>(&json).unwrap(), r);
        let bad = r#"{"address":"u1a","amount":"0","memo":null}"#;
        assert!(serde_json::from_str::<Recipient>(bad).is_err());
    }
}
