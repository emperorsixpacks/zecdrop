//! `drop_core::codec::AddressCodec` for Zcash.
//!
//! A batch pays Ironwood, which pays to a Unified Address's **Orchard receiver**. So:
//! - a UA with an Orchard receiver is `Unified`;
//! - a UA without one, and a standalone Sapling address, are `UnsupportedReceiver` (the batch
//!   transaction has no Sapling outputs);
//! - transparent and TEX addresses are `Transparent`, which core's policy refuses by default;
//! - an address for the other network is `WrongNetwork`.
//!
//! Errors never contain the address text.

use drop_core::codec::{AddressCodec, RecipientKind};
use drop_core::error::AddressError;
use zcash_address::{ConversionError, ZcashAddress};
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_protocol::consensus::{Network, Parameters};

#[derive(Clone, Copy, Debug)]
pub struct ZcashAddressCodec {
    network: Network,
}

impl ZcashAddressCodec {
    pub fn new(network: Network) -> Self {
        ZcashAddressCodec { network }
    }

    fn decode(&self, address: &str) -> Result<Address, AddressError> {
        if address.is_empty() {
            return Err(AddressError::Empty);
        }
        match self.decode_exact(address) {
            // Bech32/Bech32m may be written all-uppercase (e.g. in QR codes), which zcash_address
            // rejects; retry lowercase. Base58 (transparent) is case-sensitive, so a case-changed
            // spelling of one is a different string and is not accepted.
            Err(AddressError::Malformed { .. })
                if !address.bytes().any(|b| b.is_ascii_lowercase()) =>
            {
                match self.decode_exact(&address.to_ascii_lowercase())? {
                    Address::Transparent(_) => Err(AddressError::Malformed {
                        reason: "not a Zcash address",
                    }),
                    other => Ok(other),
                }
            }
            result => result,
        }
    }

    fn decode_exact(&self, address: &str) -> Result<Address, AddressError> {
        let parsed =
            ZcashAddress::try_from_encoded(address).map_err(|_| AddressError::Malformed {
                reason: "not a Zcash address",
            })?;
        parsed
            .convert_if_network::<Address>(self.network.network_type())
            .map_err(|e| match e {
                ConversionError::IncorrectNetwork { .. } => AddressError::WrongNetwork,
                ConversionError::Unsupported(_) => AddressError::UnsupportedReceiver,
                ConversionError::User(_) => AddressError::Malformed {
                    reason: "invalid receiver encoding",
                },
            })
    }
}

impl AddressCodec for ZcashAddressCodec {
    fn validate(&self, address: &str) -> Result<RecipientKind, AddressError> {
        match self.decode(address)? {
            Address::Unified(ua) if ua.orchard().is_some() => Ok(RecipientKind::Unified),
            Address::Unified(_) | Address::Sapling(_) => Err(AddressError::UnsupportedReceiver),
            Address::Transparent(_) | Address::Tex(_) => Ok(RecipientKind::Transparent),
        }
    }

    /// The payee identity for duplicate detection (REQ-IMP-001). A batch pays a UA's **Orchard
    /// receiver**, so two Unified Addresses carrying the same Orchard receiver (whatever other
    /// receivers they have, in any letter case) are one payee: the canonical form is the
    /// Orchard-only re-encoding. Other Bech32 addresses are lowercased; Base58 (transparent)
    /// addresses are case-sensitive and stay as written.
    fn canonical(&self, address: &str) -> String {
        match self.decode(address) {
            Ok(Address::Unified(ua)) => ua
                .orchard()
                .and_then(|o| UnifiedAddress::from_receivers(Some(*o), None, None, None, None))
                .map(|orchard_only| orchard_only.encode(&self.network))
                .unwrap_or_else(|| address.to_ascii_lowercase()),
            Ok(Address::Transparent(_)) | Err(_) => address.to_owned(),
            Ok(_) => address.to_ascii_lowercase(),
        }
    }
}

/// The Orchard receiver a payout goes to (the Ironwood output's recipient).
pub(crate) fn orchard_receiver(network: Network, address: &str) -> Option<orchard::Address> {
    match ZcashAddressCodec::new(network).decode(address).ok()? {
        Address::Unified(ua) => ua.orchard().copied(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::tests::test_keys;
    use zcash_protocol::consensus::Network::{MainNetwork, TestNetwork};

    fn testnet() -> ZcashAddressCodec {
        ZcashAddressCodec::new(TestNetwork)
    }

    #[test]
    fn orchard_unified_address_is_accepted() {
        let ua = test_keys(0).unified_address();
        assert_eq!(testnet().validate(&ua), Ok(RecipientKind::Unified));
        assert!(orchard_receiver(TestNetwork, &ua).is_some());
    }

    #[test]
    fn transparent_is_reported_as_transparent() {
        let t = test_keys(0).funding_address();
        assert_eq!(testnet().validate(&t), Ok(RecipientKind::Transparent));
        assert!(orchard_receiver(TestNetwork, &t).is_none());
    }

    #[test]
    fn other_network_is_refused() {
        let mainnet_ua =
            crate::keys::CampaignKeys::derive(&crate::keys::tests::TEST_ONLY_SEED, MainNetwork, 0)
                .unwrap()
                .unified_address();
        assert_eq!(
            testnet().validate(&mainnet_ua),
            Err(AddressError::WrongNetwork)
        );
    }

    #[test]
    fn sapling_only_addresses_cannot_be_paid_by_an_ironwood_batch() {
        let k = test_keys(0);
        let (sapling_ua, _) = k
            .ufvk()
            .default_address(zcash_keys::keys::UnifiedAddressRequest::SHIELDED)
            .unwrap();
        let zs = Address::Sapling(Box::new(*sapling_ua.sapling().unwrap())).encode(&TestNetwork);
        assert_eq!(
            testnet().validate(&zs),
            Err(AddressError::UnsupportedReceiver)
        );
    }

    #[test]
    fn unified_addresses_with_the_same_orchard_receiver_are_one_payee() {
        let k = test_keys(0);
        let orchard_only = k.unified_address();
        let orchard = orchard_receiver(TestNetwork, &orchard_only).unwrap();
        // The same Orchard receiver, bundled with Sapling and transparent receivers.
        let (shielded, _) = k
            .ufvk()
            .default_address(zcash_keys::keys::UnifiedAddressRequest::SHIELDED)
            .unwrap();
        let taddr = zcash_keys::address::Address::decode(&TestNetwork, &k.funding_address())
            .and_then(|a| a.to_transparent_address())
            .unwrap();
        let bundled = UnifiedAddress::from_receivers(
            Some(orchard),
            shielded.sapling().copied(),
            Some(taddr),
            None,
            None,
        )
        .unwrap()
        .encode(&TestNetwork);
        assert_ne!(bundled, orchard_only);
        let codec = testnet();
        assert_eq!(codec.canonical(&bundled), codec.canonical(&orchard_only));
        assert_eq!(codec.canonical(&orchard_only), orchard_only);
        // A different payee stays different.
        let other = test_keys(1).unified_address();
        assert_ne!(codec.canonical(&other), codec.canonical(&orchard_only));

        // End to end through core's importer: the bundled UA is flagged as a duplicate payee.
        let csv = format!("address,amount\n{orchard_only},0.001\n{bundled},0.002\n{other},0.003\n");
        let report = drop_core::import_csv_str(&csv, &codec, &drop_core::ImportOptions::default());
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(matches!(
            report.errors[0].kind,
            drop_core::RowErrorKind::DuplicateAddress { first_line: 2 }
        ));
    }

    #[test]
    fn garbage_is_malformed_and_errors_never_echo_the_input() {
        for bad in ["utest1notreally", "hello", "u1 abc"] {
            let err = testnet().validate(bad).unwrap_err();
            assert!(
                matches!(err, AddressError::Malformed { .. }),
                "{bad}: {err:?}"
            );
            assert!(!err.to_string().contains(bad));
        }
        assert_eq!(testnet().validate(""), Err(AddressError::Empty));
    }

    #[test]
    fn uppercase_bech32m_is_the_same_address_but_base58_case_matters() {
        let ua = test_keys(0).unified_address();
        let upper = ua.to_ascii_uppercase();
        assert_eq!(testnet().validate(&upper), Ok(RecipientKind::Unified));
        assert_eq!(testnet().canonical(&upper), ua);
        assert_eq!(
            orchard_receiver(TestNetwork, &upper),
            orchard_receiver(TestNetwork, &ua)
        );

        let t = test_keys(0).funding_address();
        assert_eq!(testnet().canonical(&t), t);
        assert!(testnet().validate(&t.to_ascii_uppercase()).is_err());
    }
}
