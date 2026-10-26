//! Small identifier newtypes shared across the crate: campaign ids, transaction
//! ids, outpoints and the network selector.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::IdError;

/// Implements `Serialize`/`Deserialize` for a type as its `Display`/`FromStr` string form.
macro_rules! impl_serde_via_str {
    ($ty:ty) => {
        impl ::serde::Serialize for $ty {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(self)
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $ty {
            fn deserialize<D: ::serde::Deserializer<'de>>(
                deserializer: D,
            ) -> Result<Self, D::Error> {
                let text = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                text.parse()
                    .map_err(<D::Error as ::serde::de::Error>::custom)
            }
        }
    };
}
pub(crate) use impl_serde_via_str;

/// Maximum length of a [`CampaignId`] in bytes.
pub const MAX_CAMPAIGN_ID_BYTES: usize = 64;

/// Identifies one campaign. Restricted to `A-Z a-z 0-9 . _ -`, 1 to 64 bytes, so it
/// is safe in file names, URLs and log lines.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CampaignId(String);

impl CampaignId {
    /// Validates and wraps a campaign id.
    pub fn new(id: &str) -> Result<Self, IdError> {
        if id.is_empty() {
            return Err(IdError::EmptyCampaignId);
        }
        if id.len() > MAX_CAMPAIGN_ID_BYTES {
            return Err(IdError::CampaignIdTooLong {
                max: MAX_CAMPAIGN_ID_BYTES,
            });
        }
        if !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return Err(IdError::CampaignIdCharset);
        }
        Ok(CampaignId(id.to_owned()))
    }

    /// The id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CampaignId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for CampaignId {
    type Err = IdError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        CampaignId::new(s)
    }
}

impl_serde_via_str!(CampaignId);

/// A transaction id: 32 bytes, shown as 64 lowercase hex characters.
///
/// The bytes are kept in *display order* (the order block explorers print), so any
/// byte reversal the chain library applies is the adapter's concern, not this crate's.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Txid([u8; 32]);

impl Txid {
    /// Wraps 32 bytes in display order.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Txid(bytes)
    }

    /// The 32 bytes in display order.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for Txid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl fmt::Debug for Txid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Txid({self})")
    }
}

impl FromStr for Txid {
    type Err = IdError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut bytes = [0u8; 32];
        if s.len() != 64 {
            return Err(IdError::BadTxid);
        }
        hex::decode_to_slice(s, &mut bytes).map_err(|_| IdError::BadTxid)?;
        Ok(Txid(bytes))
    }
}

impl_serde_via_str!(Txid);

/// A reference to one transaction output: `<txid>:<index>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct OutPoint {
    /// The transaction holding the output.
    pub txid: Txid,
    /// Index of the output within that transaction.
    pub vout: u32,
}

impl fmt::Display for OutPoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.txid, self.vout)
    }
}

impl FromStr for OutPoint {
    type Err = IdError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (txid, vout) = s.split_once(':').ok_or(IdError::BadOutPoint)?;
        if vout.is_empty() || !vout.bytes().all(|b| b.is_ascii_digit()) {
            return Err(IdError::BadOutPoint);
        }
        Ok(OutPoint {
            txid: txid.parse().map_err(|_| IdError::BadOutPoint)?,
            vout: vout.parse().map_err(|_| IdError::BadOutPoint)?,
        })
    }
}

impl_serde_via_str!(OutPoint);

/// Which Zcash network a campaign runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    /// The public test network.
    Testnet,
    /// The production network.
    Mainnet,
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Network::Testnet => "testnet",
            Network::Mainnet => "mainnet",
        })
    }
}

impl Network {
    /// What the network's coin is called: `TAZ` on testnet, `ZEC` on mainnet. Amounts are the
    /// same numbers either way; the name tells a person which kind of money they are looking at.
    pub const fn coin(self) -> &'static str {
        match self {
            Network::Testnet => "TAZ",
            Network::Mainnet => "ZEC",
        }
    }
}

/// The shielded pool a batch pays into.
///
/// Both pools count the same way for fees; the receipt records which one a batch used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pool {
    /// The Ironwood pool.
    Ironwood,
    /// The Orchard pool.
    Orchard,
}

impl fmt::Display for Pool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Pool::Ironwood => "ironwood",
            Pool::Orchard => "orchard",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_coin_is_taz_on_testnet_and_zec_on_mainnet() {
        assert_eq!(Network::Testnet.coin(), "TAZ");
        assert_eq!(Network::Mainnet.coin(), "ZEC");
    }

    const HEX: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn campaign_id_accepts_safe_names_only() {
        assert!(CampaignId::new("spring-drop_2026.1").is_ok());
        assert_eq!(CampaignId::new(""), Err(IdError::EmptyCampaignId));
        assert_eq!(CampaignId::new("a b"), Err(IdError::CampaignIdCharset));
        assert_eq!(CampaignId::new("a/b"), Err(IdError::CampaignIdCharset));
        assert_eq!(CampaignId::new("é"), Err(IdError::CampaignIdCharset));
        assert!(matches!(
            CampaignId::new(&"a".repeat(65)),
            Err(IdError::CampaignIdTooLong { .. })
        ));
        assert!(CampaignId::new(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn txid_round_trips_through_hex_and_json() {
        let txid: Txid = HEX.parse().unwrap();
        assert_eq!(txid.to_string(), HEX);
        let json = serde_json::to_string(&txid).unwrap();
        assert_eq!(json, format!("\"{HEX}\""));
        assert_eq!(serde_json::from_str::<Txid>(&json).unwrap(), txid);
        assert!("zz".parse::<Txid>().is_err());
        assert!(HEX[..62].parse::<Txid>().is_err());
        assert!(format!("{}g", &HEX[..63]).parse::<Txid>().is_err());
    }

    #[test]
    fn outpoint_round_trips() {
        let op: OutPoint = format!("{HEX}:7").parse().unwrap();
        assert_eq!(op.vout, 7);
        assert_eq!(op.to_string(), format!("{HEX}:7"));
        let json = serde_json::to_string(&op).unwrap();
        assert_eq!(serde_json::from_str::<OutPoint>(&json).unwrap(), op);
        for bad in [
            HEX.to_owned(),
            format!("{HEX}:"),
            format!("{HEX}:-1"),
            ":1".to_owned(),
        ] {
            assert!(bad.parse::<OutPoint>().is_err(), "{bad}");
        }
    }

    #[test]
    fn pool_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Pool::Ironwood).unwrap(),
            "\"ironwood\""
        );
        assert_eq!(
            serde_json::to_string(&Pool::Orchard).unwrap(),
            "\"orchard\""
        );
        assert_eq!(
            serde_json::from_str::<Pool>("\"orchard\"").unwrap(),
            Pool::Orchard
        );
        assert!(serde_json::from_str::<Pool>("\"Ironwood\"").is_err());
        assert_eq!(Pool::Ironwood.to_string(), "ironwood");
    }

    #[test]
    fn network_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Network::Testnet).unwrap(),
            "\"testnet\""
        );
        assert_eq!(Network::Mainnet.to_string(), "mainnet");
    }
}
