//! `GET /v0/tokens`: the assets 1Click can swap, and finding native ZEC among them.

use serde::Deserialize;

use crate::error::NearError;

/// One entry of `GET /v0/tokens`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub asset_id: String,
    pub decimals: u8,
    pub blockchain: String,
    pub symbol: String,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub price_updated_at: Option<String>,
    #[serde(default)]
    pub contract_address: Option<String>,
}

pub fn parse_tokens(json: &str) -> Result<Vec<Token>, NearError> {
    serde_json::from_str(json).map_err(|e| NearError::Parse(e.to_string()))
}

/// Native ZEC: symbol `ZEC` on blockchain `zec`. The list also has bridged ZEC on other chains
/// (NEAR, Solana, Starknet, Aptos, all with symbol `ZEC`), which would pay out on those chains,
/// not to a Zcash address; matching the symbol alone would pick the wrong asset.
pub fn find_zec(tokens: &[Token]) -> Result<&Token, NearError> {
    let zec = tokens
        .iter()
        .find(|t| t.blockchain == "zec" && t.symbol == "ZEC")
        .ok_or(NearError::ZecNotListed)?;
    if zec.decimals != 8 {
        return Err(NearError::UnexpectedZecDecimals(zec.decimals));
    }
    Ok(zec)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const TOKENS: &str = include_str!("../testdata/tokens-excerpt.json");

    // covers: REQ-FUND-001
    #[test]
    fn native_zec_is_found_not_a_bridged_zec() {
        let tokens = parse_tokens(TOKENS).unwrap();
        assert!(
            tokens.iter().filter(|t| t.symbol == "ZEC").count() >= 3,
            "the excerpt has bridged ZECs too"
        );
        let zec = find_zec(&tokens).unwrap();
        assert_eq!(zec.asset_id, "nep141:zec.omft.near");
        assert_eq!((zec.blockchain.as_str(), zec.decimals), ("zec", 8));
    }

    #[test]
    fn missing_or_odd_zec_is_an_error() {
        let mut tokens = parse_tokens(TOKENS).unwrap();
        tokens.retain(|t| t.blockchain != "zec");
        assert_eq!(find_zec(&tokens), Err(NearError::ZecNotListed));
        let mut tokens = parse_tokens(TOKENS).unwrap();
        tokens
            .iter_mut()
            .filter(|t| t.blockchain == "zec")
            .for_each(|t| t.decimals = 6);
        assert_eq!(find_zec(&tokens), Err(NearError::UnexpectedZecDecimals(6)));
    }
}
