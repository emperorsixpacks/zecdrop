//! The campaign's funding address as 1Click needs it: a MAINNET transparent address.
//!
//! NEAR Intents is mainnet-only (there is no testnet ZEC) and its chain-support page says Zcash
//! is supported for "transparent addresses only". A testnet address is refused with a clear
//! error rather than sent to the API.

use std::convert::Infallible;
use std::fmt;

use zcash_address::{ConversionError, TryFromAddress, ZcashAddress};
use zcash_protocol::consensus::NetworkType;

use crate::error::AddressError;

/// A validated mainnet transparent address (`t1…` P2PKH or `t3…` P2SH).
#[derive(Clone, PartialEq, Eq)]
pub struct CampaignTransparentAddress(String);

/// The network of an address `zcash_address` decoded as plain transparent (P2PKH or P2SH).
struct Transparent(NetworkType);

impl TryFromAddress for Transparent {
    type Error = Infallible;

    fn try_from_transparent_p2pkh(
        net: NetworkType,
        _: [u8; 20],
    ) -> Result<Self, ConversionError<Infallible>> {
        Ok(Transparent(net))
    }

    fn try_from_transparent_p2sh(
        net: NetworkType,
        _: [u8; 20],
    ) -> Result<Self, ConversionError<Infallible>> {
        Ok(Transparent(net))
    }
}

impl CampaignTransparentAddress {
    /// Accepts only a mainnet P2PKH/P2SH address. A UA (even one with a transparent receiver)
    /// and a TEX address are refused: the swap's recipient must be the plain address the
    /// operator watches for the funding UTXO.
    pub fn parse_mainnet(address: &str) -> Result<Self, AddressError> {
        let parsed =
            ZcashAddress::try_from_encoded(address).map_err(|_| AddressError::Malformed)?;
        match parsed.convert::<Transparent>() {
            Ok(Transparent(NetworkType::Main)) => {
                Ok(CampaignTransparentAddress(address.to_owned()))
            }
            Ok(Transparent(_)) => Err(AddressError::Testnet),
            Err(_) => Err(AddressError::NotTransparent),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CampaignTransparentAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for CampaignTransparentAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CampaignTransparentAddress({})", self.0)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use zcash_address::ToAddress;

    /// A syntactically valid mainnet P2PKH address over hash160 = 20 × 0x11 (no known key);
    /// the recipient of the captured dry quote.
    pub(crate) const DUMMY_T1: &str = "t1KRqwQhktLV4BjbNLiuH6pb3AMoszZKcQB";

    fn p2pkh(net: NetworkType) -> String {
        ZcashAddress::from_transparent_p2pkh(net, [0x11; 20]).encode()
    }

    // covers: REQ-FUND-001
    #[test]
    fn mainnet_t1_and_t3_are_accepted() {
        assert_eq!(
            p2pkh(NetworkType::Main),
            DUMMY_T1,
            "the captured quote's recipient"
        );
        assert!(CampaignTransparentAddress::parse_mainnet(DUMMY_T1).is_ok());
        let t3 = ZcashAddress::from_transparent_p2sh(NetworkType::Main, [0x11; 20]).encode();
        assert!(t3.starts_with("t3"));
        assert!(CampaignTransparentAddress::parse_mainnet(&t3).is_ok());
    }

    // covers: REQ-FUND-001
    #[test]
    fn testnet_addresses_are_refused_with_a_clear_error() {
        let tm = p2pkh(NetworkType::Test);
        assert!(tm.starts_with("tm"));
        let err = CampaignTransparentAddress::parse_mainnet(&tm).unwrap_err();
        assert_eq!(err, AddressError::Testnet);
        assert!(err.to_string().contains("mainnet-only"));
        // The demo campaign's real testnet funding address.
        assert_eq!(
            CampaignTransparentAddress::parse_mainnet("tmU6c1aXFGFsnpceD9rX7SaBCodB3nkZGkD"),
            Err(AddressError::Testnet)
        );
    }

    // covers: REQ-FUND-001
    #[test]
    fn shielded_unified_and_garbage_are_refused() {
        let ua = "utest1tj6xa4sex46t8zu6nyp27xsc2selj7ufeewrhldxvdwfuzj45hjndura2n493xd84uc47njh7ltfcxspq3l78nksjwscu6ekq56npe5q";
        assert_eq!(
            CampaignTransparentAddress::parse_mainnet(ua),
            Err(AddressError::NotTransparent)
        );
        assert_eq!(
            CampaignTransparentAddress::parse_mainnet("t1notanaddress"),
            Err(AddressError::Malformed)
        );
        assert_eq!(
            CampaignTransparentAddress::parse_mainnet(""),
            Err(AddressError::Malformed)
        );
    }
}
