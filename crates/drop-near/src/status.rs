//! `GET /v0/status`: what the swap service reports, and what the operator should do next.
//!
//! Nothing here says "funded". Even `SUCCESS` maps to [`NextStep::VerifyOnChain`]: the campaign
//! is funded only when the operator sees the UTXO at its transparent address on chain at the
//! required depth (REQ-FUND-002, the operator's job). An undocumented status maps to
//! [`SwapStatus::Unknown`] and [`NextStep::Investigate`], never to success.

use serde::{Deserialize, Deserializer};

use crate::error::NearError;

/// The documented 1Click statuses, plus `Unknown` for anything else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapStatus {
    PendingDeposit,
    KnownDepositTx,
    Processing,
    /// The service reports delivery. Not proof of funding: see [`NextStep::VerifyOnChain`].
    Success,
    IncompleteDeposit,
    Refunded,
    Failed,
    /// A status the docs do not list; carries the raw value.
    Unknown(String),
}

impl SwapStatus {
    pub fn parse(raw: &str) -> SwapStatus {
        match raw {
            "PENDING_DEPOSIT" => SwapStatus::PendingDeposit,
            "KNOWN_DEPOSIT_TX" => SwapStatus::KnownDepositTx,
            "PROCESSING" => SwapStatus::Processing,
            "SUCCESS" => SwapStatus::Success,
            "INCOMPLETE_DEPOSIT" => SwapStatus::IncompleteDeposit,
            "REFUNDED" => SwapStatus::Refunded,
            "FAILED" => SwapStatus::Failed,
            other => SwapStatus::Unknown(other.to_owned()),
        }
    }
}

impl<'de> Deserialize<'de> for SwapStatus {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(SwapStatus::parse(&String::deserialize(d)?))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainTxHash {
    pub hash: String,
    #[serde(default)]
    pub explorer_url: Option<String>,
}

/// The parts of `swapDetails` the operator uses. Amounts are smallest-unit integers as strings.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SwapDetails {
    pub amount_in: Option<String>,
    pub amount_out: Option<String>,
    pub deposited_amount: Option<String>,
    pub refunded_amount: Option<String>,
    pub refund_reason: Option<String>,
    pub origin_chain_tx_hashes: Vec<ChainTxHash>,
    /// For a ZEC payout: the Zcash transaction(s) that paid the campaign address.
    pub destination_chain_tx_hashes: Vec<ChainTxHash>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    #[serde(default)]
    pub correlation_id: Option<String>,
    pub status: SwapStatus,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub swap_details: Option<SwapDetails>,
}

/// What to do after a status poll. There is deliberately no "funded" variant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NextStep {
    /// No deposit yet (`PENDING_DEPOSIT`): keep polling until the quote's deadline.
    AwaitDeposit,
    /// Deposit seen or swap running (`KNOWN_DEPOSIT_TX`, `PROCESSING`): keep polling.
    AwaitSwap,
    /// The service reports delivery (`SUCCESS`). NOT funded yet: check the chain for the UTXO
    /// at the campaign's transparent address; `zec_txids` are the service's claimed payouts.
    VerifyOnChain { zec_txids: Vec<String> },
    /// The deposit was smaller than quoted (`INCOMPLETE_DEPOSIT`): top up or expect a refund.
    TopUpOrAwaitRefund,
    /// The swap ended without paying the campaign (`REFUNDED`, `FAILED`).
    Ended { refunded: bool },
    /// An undocumented status: stop and investigate. Never treated as success.
    Investigate { status: String },
}

impl StatusResponse {
    pub fn next_step(&self) -> NextStep {
        match &self.status {
            SwapStatus::PendingDeposit => NextStep::AwaitDeposit,
            SwapStatus::KnownDepositTx | SwapStatus::Processing => NextStep::AwaitSwap,
            SwapStatus::Success => NextStep::VerifyOnChain {
                zec_txids: self
                    .swap_details
                    .as_ref()
                    .map(|d| {
                        d.destination_chain_tx_hashes
                            .iter()
                            .map(|h| h.hash.clone())
                            .collect()
                    })
                    .unwrap_or_default(),
            },
            SwapStatus::IncompleteDeposit => NextStep::TopUpOrAwaitRefund,
            SwapStatus::Refunded => NextStep::Ended { refunded: true },
            SwapStatus::Failed => NextStep::Ended { refunded: false },
            SwapStatus::Unknown(raw) => NextStep::Investigate {
                status: raw.clone(),
            },
        }
    }
}

pub fn parse_status_response(json: &str) -> Result<StatusResponse, NearError> {
    serde_json::from_str(json).map_err(|e| NearError::Parse(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> StatusResponse {
        let json = match name {
            "pending-deposit" => include_str!("../testdata/status-pending-deposit.from-docs.json"),
            "known-deposit-tx" => {
                include_str!("../testdata/status-known-deposit-tx.from-docs.json")
            }
            "processing" => include_str!("../testdata/status-processing.from-docs.json"),
            "success" => include_str!("../testdata/status-success.from-docs.json"),
            "incomplete-deposit" => {
                include_str!("../testdata/status-incomplete-deposit.from-docs.json")
            }
            "refunded" => include_str!("../testdata/status-refunded.from-docs.json"),
            "failed" => include_str!("../testdata/status-failed.from-docs.json"),
            "mystery-state" => include_str!("../testdata/status-mystery-state.from-docs.json"),
            other => panic!("no fixture {other}"),
        };
        parse_status_response(json).unwrap()
    }

    // covers: REQ-FUND-001
    #[test]
    fn every_documented_status_maps_to_a_next_step() {
        let cases = [
            (
                "pending-deposit",
                SwapStatus::PendingDeposit,
                NextStep::AwaitDeposit,
            ),
            (
                "known-deposit-tx",
                SwapStatus::KnownDepositTx,
                NextStep::AwaitSwap,
            ),
            ("processing", SwapStatus::Processing, NextStep::AwaitSwap),
            (
                "incomplete-deposit",
                SwapStatus::IncompleteDeposit,
                NextStep::TopUpOrAwaitRefund,
            ),
            (
                "refunded",
                SwapStatus::Refunded,
                NextStep::Ended { refunded: true },
            ),
            (
                "failed",
                SwapStatus::Failed,
                NextStep::Ended { refunded: false },
            ),
        ];
        for (name, status, step) in cases {
            let r = fixture(name);
            assert_eq!(r.status, status, "{name}");
            assert_eq!(r.next_step(), step, "{name}");
        }
        let refunded = fixture("refunded").swap_details.unwrap();
        assert_eq!(refunded.refund_reason.as_deref(), Some("PARTIAL_DEPOSIT"));
    }

    // covers: REQ-FUND-001
    #[test]
    fn success_means_verify_on_chain_not_funded() {
        let r = fixture("success");
        assert_eq!(r.status, SwapStatus::Success);
        assert_eq!(
            r.next_step(),
            NextStep::VerifyOnChain {
                zec_txids: vec![
                    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90".into()
                ]
            }
        );
    }

    // covers: REQ-FUND-001
    #[test]
    fn an_undocumented_status_is_unknown_never_success() {
        let r = fixture("mystery-state");
        assert_eq!(r.status, SwapStatus::Unknown("MYSTERY_STATE".into()));
        assert_eq!(
            r.next_step(),
            NextStep::Investigate {
                status: "MYSTERY_STATE".into()
            }
        );
        // Case and spacing variants of SUCCESS are not success either.
        for raw in ["success", "Success", " SUCCESS", "SUCCESS "] {
            assert_eq!(
                SwapStatus::parse(raw),
                SwapStatus::Unknown(raw.into()),
                "{raw:?}"
            );
        }
    }
}
