//! Campaign phase, derived from the ledger and the funding state (REQ-PHASE-001).
//!
//! The phase is never stored; it is recomputed from facts, so it cannot drift from
//! them and survives restarts.

use serde::{Deserialize, Serialize};

use crate::ledger::BatchStatus;

/// What is known about the transparent funds a campaign needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FundingState {
    /// No funding address has been issued yet.
    NotRequested,
    /// A funding address was issued and the funds have not arrived (or are not deep enough).
    Awaiting,
    /// The funds arrived and are confirmed deep enough to spend.
    Funded,
}

/// Where a campaign is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum CampaignPhase {
    /// Being prepared; no funding requested yet.
    Draft,
    /// Waiting for the funding deposit.
    AwaitingFunding,
    /// Funded and ready to send.
    Funded,
    /// Payouts are under way: `done` of `total` batches have reached the required depth.
    Sending {
        /// Batches confirmed at the required depth.
        done: u32,
        /// Total batches in the campaign.
        total: u32,
    },
    /// Every batch is confirmed at the required depth.
    Settled,
    /// At least one batch failed and needs attention.
    Failed,
}

impl CampaignPhase {
    /// A short phrase for people, suitable for a status badge.
    pub fn label(&self) -> String {
        match self {
            CampaignPhase::Draft => "Draft".to_owned(),
            CampaignPhase::AwaitingFunding => "Waiting for funds".to_owned(),
            CampaignPhase::Funded => "Funded, ready to send".to_owned(),
            CampaignPhase::Sending { done, total } => {
                format!("Sending: {done} of {total} batches confirmed")
            }
            CampaignPhase::Settled => "Complete: all batches confirmed".to_owned(),
            CampaignPhase::Failed => "Needs attention: a batch failed".to_owned(),
        }
    }
}

/// Whether a batch has reached the required confirmation depth.
pub(crate) fn is_final(status: &BatchStatus, required_depth: u32) -> bool {
    matches!(status, BatchStatus::Confirmed { depth, .. } if *depth >= required_depth)
}

/// Derives the phase from per-batch statuses (in batch order) and the funding state.
///
/// In order of precedence:
/// 1. any `Failed` batch makes the campaign `Failed`;
/// 2. all batches confirmed at `required_depth` or more makes it `Settled`;
/// 3. any batch past `Planned` makes it `Sending { done, total }`;
/// 4. otherwise the funding state decides: `Draft`, `AwaitingFunding` or `Funded`.
///
/// An empty status list is never `Settled`.
pub fn derive_phase(
    funding: FundingState,
    statuses: &[BatchStatus],
    required_depth: u32,
) -> CampaignPhase {
    if statuses
        .iter()
        .any(|s| matches!(s, BatchStatus::Failed { .. }))
    {
        return CampaignPhase::Failed;
    }
    let total = u32::try_from(statuses.len()).unwrap_or(u32::MAX);
    let done = u32::try_from(
        statuses
            .iter()
            .filter(|s| is_final(s, required_depth))
            .count(),
    )
    .unwrap_or(u32::MAX);
    if total > 0 && done == total {
        return CampaignPhase::Settled;
    }
    if statuses.iter().any(|s| !matches!(s, BatchStatus::Planned)) {
        return CampaignPhase::Sending { done, total };
    }
    match funding {
        FundingState::NotRequested => CampaignPhase::Draft,
        FundingState::Awaiting => CampaignPhase::AwaitingFunding,
        FundingState::Funded => CampaignPhase::Funded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Txid;
    use BatchStatus::*;
    use FundingState::*;

    fn tx() -> Txid {
        Txid::from_bytes([1; 32])
    }
    fn built() -> BatchStatus {
        Built {
            txid: tx(),
            raw_tx: vec![1],
        }
    }
    fn broadcast() -> BatchStatus {
        Broadcast { txid: tx() }
    }
    fn confirmed(depth: u32) -> BatchStatus {
        Confirmed { txid: tx(), depth }
    }
    fn failed() -> BatchStatus {
        Failed {
            reason: "rejected".into(),
            txid: None,
        }
    }

    // covers: REQ-PHASE-001
    #[test]
    fn phase_table() {
        use CampaignPhase as P;
        let depth = 3;
        let table: Vec<(&str, FundingState, Vec<BatchStatus>, CampaignPhase)> = vec![
            ("no batches, not requested", NotRequested, vec![], P::Draft),
            ("no batches, awaiting", Awaiting, vec![], P::AwaitingFunding),
            ("no batches, funded", Funded, vec![], P::Funded),
            (
                "planned only, not requested",
                NotRequested,
                vec![Planned, Planned],
                P::Draft,
            ),
            (
                "planned only, awaiting",
                Awaiting,
                vec![Planned, Planned],
                P::AwaitingFunding,
            ),
            (
                "planned only, funded",
                Funded,
                vec![Planned, Planned],
                P::Funded,
            ),
            (
                "first built",
                Funded,
                vec![built(), Planned],
                P::Sending { done: 0, total: 2 },
            ),
            (
                "one broadcast",
                Funded,
                vec![broadcast(), Planned],
                P::Sending { done: 0, total: 2 },
            ),
            (
                "one confirmed deep enough",
                Funded,
                vec![confirmed(3), Planned],
                P::Sending { done: 1, total: 2 },
            ),
            (
                "confirmed but shallow does not count",
                Funded,
                vec![confirmed(2), broadcast()],
                P::Sending { done: 0, total: 2 },
            ),
            (
                "all confirmed but one shallow",
                Funded,
                vec![confirmed(3), confirmed(2)],
                P::Sending { done: 1, total: 2 },
            ),
            (
                "all confirmed deep enough",
                Funded,
                vec![confirmed(3), confirmed(9)],
                P::Settled,
            ),
            (
                "single batch settled",
                Funded,
                vec![confirmed(3)],
                P::Settled,
            ),
            (
                "any failed wins",
                Funded,
                vec![confirmed(3), failed()],
                P::Failed,
            ),
            (
                "failed before anything else",
                Funded,
                vec![failed(), Planned],
                P::Failed,
            ),
            (
                "failed beats settled-looking rest",
                Funded,
                vec![failed(), confirmed(9)],
                P::Failed,
            ),
            // Sending is decided by the ledger even if funding facts are stale.
            (
                "sending ignores funding state",
                NotRequested,
                vec![broadcast()],
                P::Sending { done: 0, total: 1 },
            ),
        ];
        for (name, funding, statuses, expected) in table {
            assert_eq!(derive_phase(funding, &statuses, depth), expected, "{name}");
        }
    }

    // covers: REQ-PHASE-001
    #[test]
    fn required_depth_one_settles_on_first_confirmation() {
        assert_eq!(
            derive_phase(Funded, &[confirmed(1), confirmed(1)], 1),
            CampaignPhase::Settled
        );
        assert_eq!(
            derive_phase(Funded, &[confirmed(1), broadcast()], 1),
            CampaignPhase::Sending { done: 1, total: 2 }
        );
    }

    // covers: REQ-PHASE-001
    #[test]
    fn labels_are_user_language() {
        use CampaignPhase as P;
        assert_eq!(P::Draft.label(), "Draft");
        assert_eq!(P::AwaitingFunding.label(), "Waiting for funds");
        assert_eq!(P::Funded.label(), "Funded, ready to send");
        assert_eq!(
            P::Sending { done: 2, total: 5 }.label(),
            "Sending: 2 of 5 batches confirmed"
        );
        assert_eq!(P::Settled.label(), "Complete: all batches confirmed");
        assert_eq!(P::Failed.label(), "Needs attention: a batch failed");
    }

    // covers: REQ-PHASE-001
    #[test]
    fn phase_serializes_with_a_phase_tag() {
        use CampaignPhase as P;
        let cases = [
            (P::Draft, r#"{"phase":"draft"}"#),
            (P::AwaitingFunding, r#"{"phase":"awaiting_funding"}"#),
            (P::Funded, r#"{"phase":"funded"}"#),
            (
                P::Sending { done: 1, total: 4 },
                r#"{"phase":"sending","done":1,"total":4}"#,
            ),
            (P::Settled, r#"{"phase":"settled"}"#),
            (P::Failed, r#"{"phase":"failed"}"#),
        ];
        for (phase, json) in cases {
            assert_eq!(serde_json::to_string(&phase).unwrap(), json);
            assert_eq!(serde_json::from_str::<P>(json).unwrap(), phase);
        }
    }
}
