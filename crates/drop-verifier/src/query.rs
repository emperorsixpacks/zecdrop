//! Strict parsing of the receipt query (REQ-VER-002).
//!
//! ```text
//! GET /v1/receipt?network=testnet&tx=<txid>&tx=<txid>&commitment=<hex>
//!                &declared_total=<zatoshi>[&campaign=<id>]
//! ```
//!
//! * Unknown parameters are refused, and so are repeated single-valued ones.
//! * Anything that looks like a viewing key is refused before anything else, in a
//!   parameter name or value, raw or percent-decoded. The offending text is never
//!   echoed or logged.
//! * Errors name only our own fixed parameter names, never caller-supplied text.

use drop_core::{CampaignId, ManifestCommitment, Network, Txid, Zatoshi};

/// Substrings (lowercase) that mark a Zcash viewing key: unified full and incoming
/// viewing keys (`uview…`, `uivk…`, `ufvk…`, with their `test`/`regtest` variants)
/// and the older Sapling forms. A hit anywhere in the query is a refusal.
const VIEWING_KEY_MARKERS: [&str; 6] = ["uview", "uivk", "ufvk", "zxview", "zviews", "zivk"];

/// Why a query was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryError {
    /// The query contains something shaped like a viewing key.
    ViewingKey,
    /// The query is longer than allowed.
    TooLong,
    /// A parameter we do not accept.
    UnknownParameter,
    /// A single-valued parameter appears more than once.
    DuplicateParameter(&'static str),
    /// A required parameter is missing.
    Missing(&'static str),
    /// A parameter has an invalid value.
    Invalid(&'static str),
    /// More `tx` values than allowed.
    TooManyTxids {
        /// The configured maximum.
        max: usize,
    },
}

/// A validated receipt query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptQuery {
    /// The network.
    pub network: Network,
    /// The transaction ids, in order, without duplicates.
    pub txids: Vec<Txid>,
    /// The manifest commitment.
    pub commitment: ManifestCommitment,
    /// The declared total, in zatoshi.
    pub declared_total: Zatoshi,
    /// The campaign id, if named.
    pub campaign: Option<CampaignId>,
}

/// Longest query string accepted, in bytes.
pub const MAX_QUERY_BYTES: usize = 8 * 1024;

fn looks_like_a_viewing_key(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    VIEWING_KEY_MARKERS.iter().any(|m| lower.contains(m))
}

/// Parses and validates `query` (the part after `?`, if any).
pub fn parse(query: Option<&str>, max_txids: usize) -> Result<ReceiptQuery, QueryError> {
    let raw = query.unwrap_or("");

    // Viewing keys first, on the raw text and on every decoded name and value, so no
    // other error can be the one that reveals (or fails to refuse) one.
    if looks_like_a_viewing_key(raw) {
        return Err(QueryError::ViewingKey);
    }
    let pairs: Vec<(String, String)> = form_urlencoded::parse(raw.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if pairs
        .iter()
        .any(|(k, v)| looks_like_a_viewing_key(k) || looks_like_a_viewing_key(v))
    {
        return Err(QueryError::ViewingKey);
    }
    if raw.len() > MAX_QUERY_BYTES {
        return Err(QueryError::TooLong);
    }

    let mut network = None;
    let mut commitment = None;
    let mut declared = None;
    let mut campaign = None;
    let mut txids: Vec<Txid> = Vec::new();

    for (key, value) in &pairs {
        match key.as_str() {
            "network" => set_once(&mut network, "network", value)?,
            "commitment" => set_once(&mut commitment, "commitment", value)?,
            "declared_total" => set_once(&mut declared, "declared_total", value)?,
            "campaign" => set_once(&mut campaign, "campaign", value)?,
            "tx" => {
                if txids.len() >= max_txids {
                    return Err(QueryError::TooManyTxids { max: max_txids });
                }
                let txid: Txid = value.parse().map_err(|_| QueryError::Invalid("tx"))?;
                if txids.contains(&txid) {
                    return Err(QueryError::Invalid("tx"));
                }
                txids.push(txid);
            }
            _ => return Err(QueryError::UnknownParameter),
        }
    }

    let network = match network.ok_or(QueryError::Missing("network"))?.as_str() {
        "testnet" => Network::Testnet,
        "mainnet" => Network::Mainnet,
        _ => return Err(QueryError::Invalid("network")),
    };
    if txids.is_empty() {
        return Err(QueryError::Missing("tx"));
    }
    let commitment = commitment
        .ok_or(QueryError::Missing("commitment"))?
        .parse()
        .map_err(|_| QueryError::Invalid("commitment"))?;
    let declared_text = declared.ok_or(QueryError::Missing("declared_total"))?;
    if declared_text.is_empty() || !declared_text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(QueryError::Invalid("declared_total"));
    }
    let declared_total = declared_text
        .parse::<u64>()
        .ok()
        .and_then(|v| Zatoshi::new(v).ok())
        .ok_or(QueryError::Invalid("declared_total"))?;
    let campaign = campaign
        .map(|c| CampaignId::new(&c).map_err(|_| QueryError::Invalid("campaign")))
        .transpose()?;

    Ok(ReceiptQuery {
        network,
        txids,
        commitment,
        declared_total,
        campaign,
    })
}

fn set_once(slot: &mut Option<String>, name: &'static str, value: &str) -> Result<(), QueryError> {
    if slot.is_some() {
        return Err(QueryError::DuplicateParameter(name));
    }
    *slot = Some(value.to_owned());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TX_A: &str = "996d2bc3bc2ef4055225a648a0b1c5f276233d7707f212dbed46fbaf030010ff";
    const TX_B: &str = "0a503d2bbb5d4b8498034bf1782c1f5ef7b76ffdd2f7fa67f721ea876378ddb3";
    const COMMIT: &str = "aade9fd18f7c48dc3b04ead6a7ee2211640d0fa5948dfd14b5a356463c841491";

    fn good() -> String {
        format!("network=testnet&tx={TX_A}&tx={TX_B}&commitment={COMMIT}&declared_total=12000006")
    }

    // covers: REQ-VER-002
    #[test]
    fn a_complete_query_parses() {
        let q = parse(Some(&good()), 64).unwrap();
        assert_eq!(q.network, Network::Testnet);
        assert_eq!(q.txids.len(), 2);
        assert_eq!(q.txids[0].to_string(), TX_A);
        assert_eq!(q.commitment.to_string(), COMMIT);
        assert_eq!(q.declared_total.as_u64(), 12_000_006);
        assert_eq!(q.campaign, None);
        let named = parse(Some(&format!("{}&campaign=spring-drop", good())), 64).unwrap();
        assert_eq!(named.campaign.unwrap().as_str(), "spring-drop");
    }

    // covers: REQ-VER-002
    #[test]
    fn unknown_parameters_are_refused() {
        for extra in ["foo=bar", "TX=1", "tx_extra=1", "network2=x", "=x", "x"] {
            let query = format!("{}&{extra}", good());
            assert_eq!(
                parse(Some(&query), 64),
                Err(QueryError::UnknownParameter),
                "{extra}"
            );
        }
    }

    // covers: REQ-VER-002
    #[test]
    fn viewing_keys_are_refused_wherever_they_hide() {
        let ufvk = "uviewtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
        let cases = [
            format!("{}&viewing_key={ufvk}", good()),
            format!("{}&{ufvk}=1", good()),
            format!("network=testnet&tx={ufvk}&commitment={COMMIT}&declared_total=1"),
            format!("{}&campaign={ufvk}", good()),
            format!("{}&x=uivk1abc", good()),
            format!("{}&x=UFVK1ABC", good()),
            format!("{}&x=%75view1abc", good()), // percent-encoded 'u'
            format!("{}&%75view1abc=1", good()), // ... in a name
            format!("{}&x=ZXVIEWS1abc", good()),
            ufvk.to_owned(),
            format!("{}#{ufvk}", good()),
        ];
        for query in cases {
            assert_eq!(
                parse(Some(&query), 64),
                Err(QueryError::ViewingKey),
                "{query}"
            );
        }
    }

    // covers: REQ-VER-002
    #[test]
    fn a_viewing_key_wins_over_every_other_error() {
        // Missing everything else, but the key is what gets reported.
        assert_eq!(parse(Some("k=ufvk1abc"), 64), Err(QueryError::ViewingKey));
        assert_eq!(
            parse(Some("foo=1&k=uview1abc&network=nope"), 64),
            Err(QueryError::ViewingKey)
        );
    }

    #[test]
    fn missing_duplicate_and_invalid_values_are_named_by_our_own_names() {
        assert_eq!(parse(None, 64), Err(QueryError::Missing("network")));
        assert_eq!(
            parse(Some("network=testnet"), 64),
            Err(QueryError::Missing("tx"))
        );
        assert_eq!(
            parse(
                Some(&format!("network=testnet&tx={TX_A}&declared_total=1")),
                64
            ),
            Err(QueryError::Missing("commitment"))
        );
        assert_eq!(
            parse(
                Some(&format!("network=testnet&tx={TX_A}&commitment={COMMIT}")),
                64
            ),
            Err(QueryError::Missing("declared_total"))
        );
        assert_eq!(
            parse(Some(&format!("{}&network=mainnet", good())), 64),
            Err(QueryError::DuplicateParameter("network"))
        );
        assert_eq!(
            parse(Some(&format!("{}&commitment={COMMIT}", good())), 64),
            Err(QueryError::DuplicateParameter("commitment"))
        );
        let bad = |query: String| parse(Some(&query), 64);
        assert_eq!(
            bad(good().replace("network=testnet", "network=regtest")),
            Err(QueryError::Invalid("network"))
        );
        assert_eq!(
            bad(good().replace(TX_A, "abc")),
            Err(QueryError::Invalid("tx"))
        );
        assert_eq!(
            bad(good().replace(COMMIT, "abc")),
            Err(QueryError::Invalid("commitment"))
        );
        for total in [
            "-1",
            "1.5",
            "1e3",
            "",
            "abc",
            "2100000000000001",
            "99999999999999999999999",
        ] {
            assert_eq!(
                bad(good().replace("12000006", total)),
                Err(QueryError::Invalid("declared_total")),
                "{total:?}"
            );
        }
        assert_eq!(
            bad(format!("{}&campaign=bad id", good())),
            Err(QueryError::Invalid("campaign"))
        );
        // The same txid twice would count its value twice.
        assert_eq!(
            bad(format!(
                "network=testnet&tx={TX_A}&tx={TX_A}&commitment={COMMIT}&declared_total=1"
            )),
            Err(QueryError::Invalid("tx"))
        );
    }

    // covers: REQ-VER-002
    #[test]
    fn the_number_of_transactions_and_the_query_length_are_bounded() {
        let many = |n: usize| {
            let txs: String = (0..n).map(|i| format!("&tx={i:064x}")).collect();
            format!("network=testnet{txs}&commitment={COMMIT}&declared_total=1")
        };
        assert!(parse(Some(&many(64)), 64).is_ok());
        assert_eq!(
            parse(Some(&many(65)), 64),
            Err(QueryError::TooManyTxids { max: 64 })
        );
        assert!(parse(Some(&many(2)), 1).is_err());
        let long = format!("{}&campaign={}", good(), "a".repeat(MAX_QUERY_BYTES));
        assert_eq!(parse(Some(&long), 64), Err(QueryError::TooLong));
    }
}
