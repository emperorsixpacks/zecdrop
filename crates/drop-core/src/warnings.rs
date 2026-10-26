//! Privacy warnings for the review step (REQ-PRIV-003).
//!
//! A batch's public net value is the sum of its outputs, so some campaign shapes
//! let an observer (or a co-recipient) derive amounts. These warnings tell the
//! operator before they send. They carry only batch indices and counts, never
//! recipient data.

use std::fmt;

use serde::Serialize;

use crate::planner::Batch;

/// A campaign with fewer recipients than this has a small anonymity set.
pub const SMALL_CAMPAIGN_RECIPIENTS: u32 = 5;

/// One privacy concern about a plan.
///
/// JSON form: `{"code": "<snake_case_variant>", ...fields}`. Fields are batch
/// indices and counts only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PrivacyWarning {
    /// The campaign pays one recipient, so its public total is that recipient's amount.
    SingletonCampaign,
    /// Few recipients: the public total bounds every amount tightly.
    SmallCampaign {
        /// Number of recipients.
        recipients: u32,
    },
    /// Two recipients in a batch: each can infer the other's amount from the
    /// public total and their own.
    TwoRecipientBatch {
        /// Batch index.
        batch_index: u32,
    },
    /// Every recipient in a batch gets the same amount, so the public net value
    /// divided by the output count reveals it.
    UniformBatch {
        /// Batch index.
        batch_index: u32,
    },
}

impl PrivacyWarning {
    /// A sentence for people, suitable for the review step. Contains only the
    /// batch index or recipient count carried by the variant.
    pub fn message(&self) -> String {
        match self {
            PrivacyWarning::SingletonCampaign => {
                "This campaign pays one recipient, so the public total is that recipient's exact amount."
                    .to_owned()
            }
            PrivacyWarning::SmallCampaign { recipients } => format!(
                "Only {recipients} recipients: the public total narrows down every amount."
            ),
            PrivacyWarning::TwoRecipientBatch { batch_index } => format!(
                "Batch {batch_index} has two recipients; each can work out the other's amount from the public total and their own."
            ),
            PrivacyWarning::UniformBatch { batch_index } => format!(
                "Every recipient in batch {batch_index} gets the same amount, so the public total reveals each amount."
            ),
        }
    }
}

impl fmt::Display for PrivacyWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

/// Checks a plan and lists the concerns: campaign-level first, then per batch in
/// batch order. An empty list means none of the checks fired.
pub fn privacy_warnings(batches: &[Batch]) -> Vec<PrivacyWarning> {
    let recipients: usize = batches.iter().map(Batch::len).sum();
    let recipients = u32::try_from(recipients).unwrap_or(u32::MAX);
    let mut warnings = Vec::new();

    if recipients == 1 {
        warnings.push(PrivacyWarning::SingletonCampaign);
    } else if recipients > 1 && recipients < SMALL_CAMPAIGN_RECIPIENTS {
        warnings.push(PrivacyWarning::SmallCampaign { recipients });
    }

    for batch in batches {
        let count = batch.output_count();
        if count == 2 {
            warnings.push(PrivacyWarning::TwoRecipientBatch {
                batch_index: batch.index(),
            });
        }
        let mut amounts = batch.recipients().iter().map(|r| r.amount());
        if let Some(first) = amounts.next() {
            if count >= 2 && amounts.all(|a| a == first) {
                warnings.push(PrivacyWarning::UniformBatch {
                    batch_index: batch.index(),
                });
            }
        }
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amount::Zatoshi;
    use crate::planner::plan_batches;
    use crate::recipient::Recipient;

    fn plan(amounts: &[u64], max: usize) -> Vec<Batch> {
        let rows: Vec<Recipient> = amounts
            .iter()
            .enumerate()
            .map(|(i, a)| {
                Recipient::new(
                    format!("u1sentinelwarn{i:04}"),
                    Zatoshi::new(*a).unwrap(),
                    None,
                )
                .unwrap()
            })
            .collect();
        plan_batches(&rows, max).unwrap()
    }

    // covers: REQ-PRIV-003
    #[test]
    fn single_recipient_campaign() {
        assert_eq!(
            privacy_warnings(&plan(&[5], 10)),
            vec![PrivacyWarning::SingletonCampaign]
        );
    }

    // covers: REQ-PRIV-003
    #[test]
    fn campaigns_under_five_recipients() {
        assert_eq!(
            privacy_warnings(&plan(&[1, 2, 3], 10)),
            vec![PrivacyWarning::SmallCampaign { recipients: 3 }]
        );
        assert_eq!(
            privacy_warnings(&plan(&[1, 2, 3, 4], 10)),
            vec![PrivacyWarning::SmallCampaign { recipients: 4 }]
        );
        // Five is enough.
        assert!(privacy_warnings(&plan(&[1, 2, 3, 4, 5], 10)).is_empty());
    }

    // covers: REQ-PRIV-003
    #[test]
    fn two_recipient_batches() {
        // 7 recipients, max 3 -> batches of 3, 2, 2.
        let warnings = privacy_warnings(&plan(&[1, 2, 3, 4, 5, 6, 7], 3));
        assert_eq!(
            warnings,
            vec![
                PrivacyWarning::TwoRecipientBatch { batch_index: 1 },
                PrivacyWarning::TwoRecipientBatch { batch_index: 2 },
            ]
        );
        // A campaign of exactly two is both small and a two-recipient batch.
        assert_eq!(
            privacy_warnings(&plan(&[1, 2], 10)),
            vec![
                PrivacyWarning::SmallCampaign { recipients: 2 },
                PrivacyWarning::TwoRecipientBatch { batch_index: 0 },
            ]
        );
    }

    // covers: REQ-PRIV-003
    #[test]
    fn uniform_amount_batches() {
        // Batch 0 is uniform, batch 1 is not.
        let warnings = privacy_warnings(&plan(&[9, 9, 9, 1, 2, 3], 3));
        assert_eq!(
            warnings,
            vec![PrivacyWarning::UniformBatch { batch_index: 0 }]
        );
        assert!(privacy_warnings(&plan(&[1, 2, 3, 4, 5, 6], 3)).is_empty());
    }

    // covers: REQ-PRIV-003
    #[test]
    fn varied_amounts_in_large_batches_raise_nothing() {
        let amounts: Vec<u64> = (1..=30).collect();
        assert!(privacy_warnings(&plan(&amounts, 10)).is_empty());
    }

    // covers: REQ-PRIV-003, REQ-PRIV-002
    #[test]
    fn warnings_carry_only_indices_and_counts() {
        let warnings = privacy_warnings(&plan(&[7_777_001, 7_777_001], 10));
        assert!(warnings.len() >= 2);
        for w in &warnings {
            let texts = [
                w.to_string(),
                format!("{w:?}"),
                serde_json::to_string(w).unwrap(),
            ];
            for text in texts {
                for needle in ["sentinelwarn", "7777001", "0.07777001"] {
                    assert!(!text.contains(needle), "{needle} leaked: {text}");
                }
            }
        }
    }

    // covers: REQ-PRIV-003
    #[test]
    fn a_two_recipient_campaign_of_equal_amounts_raises_every_batch_level_warning() {
        assert_eq!(
            privacy_warnings(&plan(&[5, 5], 10)),
            vec![
                PrivacyWarning::SmallCampaign { recipients: 2 },
                PrivacyWarning::TwoRecipientBatch { batch_index: 0 },
                PrivacyWarning::UniformBatch { batch_index: 0 },
            ]
        );
        // A single recipient is only a singleton campaign, not also small or uniform.
        assert_eq!(
            privacy_warnings(&plan(&[5], 10)),
            vec![PrivacyWarning::SingletonCampaign]
        );
    }

    // covers: REQ-PRIV-003
    #[test]
    fn json_shape_and_user_messages() {
        let cases = [
            (
                PrivacyWarning::SingletonCampaign,
                serde_json::json!({"code": "singleton_campaign"}),
                "one recipient",
            ),
            (
                PrivacyWarning::SmallCampaign { recipients: 3 },
                serde_json::json!({"code": "small_campaign", "recipients": 3}),
                "Only 3 recipients",
            ),
            (
                PrivacyWarning::TwoRecipientBatch { batch_index: 2 },
                serde_json::json!({"code": "two_recipient_batch", "batch_index": 2}),
                "Batch 2 has two recipients",
            ),
            (
                PrivacyWarning::UniformBatch { batch_index: 4 },
                serde_json::json!({"code": "uniform_batch", "batch_index": 4}),
                "batch 4 gets the same amount",
            ),
        ];
        for (warning, json, phrase) in cases {
            assert_eq!(serde_json::to_value(warning).unwrap(), json);
            assert!(warning.message().contains(phrase), "{}", warning.message());
            assert_eq!(warning.to_string(), warning.message());
        }
    }
}
