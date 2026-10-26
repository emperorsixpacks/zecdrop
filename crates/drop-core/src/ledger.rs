//! The ledger port and an in-memory implementation (REQ-LED-001).
//!
//! The ledger is the durable record of what has been done for each batch. It is
//! what stops a crash or a retry from paying a batch twice: once a transaction is
//! recorded for a batch, no *different* transaction can be recorded for it.
//!
//! Allowed status changes (anything else is [`LedgerError::IllegalTransition`]):
//!
//! ```text
//! (absent) -> Planned -> Built -> Broadcast -> Confirmed (depth may be updated)
//!                |         |          |
//!                +---------+----------+---------> Failed   (terminal)
//! ```
//!
//! Recording the same status again is a no-op, and re-recording the same built
//! transaction after the batch has moved on is also a no-op (the later status
//! wins). Recording a *different* transaction id, or the same id with different
//! raw bytes, once a batch is Built, Broadcast or Confirmed is a
//! [`LedgerError::Conflict`]. `Failed` is terminal because a failed batch may
//! still have a transaction in flight; a human must decide what happens next.
//!
//! A batch that fails after a transaction was built **keeps that transaction's id**: the
//! ledger fills it in from the first built transaction when `Failed` is recorded, so a
//! transaction that was in flight, and may yet be mined, is never forgotten by the record that
//! says the batch failed.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::LedgerError;
use crate::ids::{CampaignId, Txid};

/// Where one batch stands.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BatchStatus {
    /// Planned but no transaction built yet.
    Planned,
    /// A transaction was built and stored; it may or may not have been broadcast.
    Built {
        /// The transaction id.
        txid: Txid,
        /// The full serialized transaction, rebroadcast as-is on resume.
        #[serde(with = "hex_bytes")]
        raw_tx: Vec<u8>,
    },
    /// The stored transaction was submitted to the network.
    Broadcast {
        /// The transaction id.
        txid: Txid,
    },
    /// The transaction is in a block with `depth` confirmations (at least 1).
    Confirmed {
        /// The transaction id.
        txid: Txid,
        /// Number of confirmations, counting the block that contains it.
        depth: u32,
    },
    /// The batch failed permanently and needs human attention.
    Failed {
        /// Why. Must not contain recipient data.
        reason: String,
        /// The transaction that was built for the batch, if one was: it may still be in
        /// flight or already mined. The ledger sets it from the batch's own history, so
        /// whoever records the failure need not (and cannot name a different one).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        txid: Option<Txid>,
    },
}

impl BatchStatus {
    /// A short stable name, used in errors and logs.
    pub fn name(&self) -> &'static str {
        match self {
            BatchStatus::Planned => "planned",
            BatchStatus::Built { .. } => "built",
            BatchStatus::Broadcast { .. } => "broadcast",
            BatchStatus::Confirmed { .. } => "confirmed",
            BatchStatus::Failed { .. } => "failed",
        }
    }

    /// The transaction id, once one exists. A failed batch still has the id of the transaction
    /// that was built for it, if there was one.
    pub fn txid(&self) -> Option<Txid> {
        match self {
            BatchStatus::Built { txid, .. }
            | BatchStatus::Broadcast { txid }
            | BatchStatus::Confirmed { txid, .. } => Some(*txid),
            BatchStatus::Failed { txid, .. } => *txid,
            BatchStatus::Planned => None,
        }
    }
}

impl fmt::Debug for BatchStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BatchStatus::Planned => f.write_str("Planned"),
            BatchStatus::Built { txid, raw_tx } => {
                write!(f, "Built{{txid: {txid}, raw_tx: <{} bytes>}}", raw_tx.len())
            }
            BatchStatus::Broadcast { txid } => write!(f, "Broadcast{{txid: {txid}}}"),
            BatchStatus::Confirmed { txid, depth } => {
                write!(f, "Confirmed{{txid: {txid}, depth: {depth}}}")
            }
            BatchStatus::Failed {
                reason,
                txid: Some(txid),
            } => write!(f, "Failed{{reason: {reason:?}, txid: {txid}}}"),
            BatchStatus::Failed { reason, txid: None } => {
                write!(f, "Failed{{reason: {reason:?}}}")
            }
        }
    }
}

/// Serde helper: raw bytes as a lowercase hex string.
mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        hex::decode(text).map_err(serde::de::Error::custom)
    }
}

/// Durable per-batch state, keyed by `(campaign, batch_index)`.
pub trait Ledger {
    /// The current status of a batch, or `None` if it was never recorded.
    fn get(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<BatchStatus>, LedgerError>;

    /// Records a status for a batch, applying the transition rules in the module docs.
    ///
    /// Implementations must make the check-and-write atomic: two writers racing to
    /// record different transactions for one batch must not both succeed.
    fn record(
        &mut self,
        campaign: &CampaignId,
        batch_index: u32,
        status: BatchStatus,
    ) -> Result<(), LedgerError>;

    /// The transaction first built for a batch, with its bytes, whatever state the batch has
    /// moved on to since (broadcast, confirmed, failed). This is what is sent again if the node
    /// stops reporting a broadcast transaction; it is never built a second time.
    ///
    /// The default knows only a batch that is still `Built`; a ledger that keeps the bytes
    /// after the batch moves on should override it.
    fn built_tx(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<(Txid, Vec<u8>)>, LedgerError> {
        Ok(match self.get(campaign, batch_index)? {
            Some(BatchStatus::Built { txid, raw_tx }) => Some((txid, raw_tx)),
            _ => None,
        })
    }

    /// The status of batches `0..count`; a batch never recorded counts as `Planned`.
    fn statuses(&self, campaign: &CampaignId, count: u32) -> Result<Vec<BatchStatus>, LedgerError> {
        (0..count)
            .map(|i| Ok(self.get(campaign, i)?.unwrap_or(BatchStatus::Planned)))
            .collect()
    }
}

impl<L: Ledger + ?Sized> Ledger for &mut L {
    fn get(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<BatchStatus>, LedgerError> {
        (**self).get(campaign, batch_index)
    }

    fn record(
        &mut self,
        campaign: &CampaignId,
        batch_index: u32,
        status: BatchStatus,
    ) -> Result<(), LedgerError> {
        (**self).record(campaign, batch_index, status)
    }

    fn built_tx(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<(Txid, Vec<u8>)>, LedgerError> {
        (**self).built_tx(campaign, batch_index)
    }
}

/// One batch's entry in the in-memory ledger.
#[derive(Clone, Debug)]
struct Entry {
    status: BatchStatus,
    /// The transaction first built for this batch; every later record must match it.
    built: Option<(Txid, Vec<u8>)>,
}

/// A [`Ledger`] held in memory: for tests, demos and single-process runs.
#[derive(Clone, Debug, Default)]
pub struct InMemoryLedger {
    entries: HashMap<(CampaignId, u32), Entry>,
}

/// What `record` decided to do.
enum Decision {
    /// Nothing to change.
    NoOp,
    /// Store this status (and, for `Built`, remember the transaction).
    Apply,
}

impl InMemoryLedger {
    /// An empty ledger.
    pub fn new() -> Self {
        Self::default()
    }

    fn decide(
        batch_index: u32,
        current: Option<&Entry>,
        new: &BatchStatus,
    ) -> Result<Decision, LedgerError> {
        use BatchStatus::*;

        if let Confirmed { depth: 0, .. } = new {
            return Err(LedgerError::InvalidStatus {
                batch_index,
                reason: "confirmed depth must be at least 1",
            });
        }
        let illegal = |from: &'static str| LedgerError::IllegalTransition {
            batch_index,
            from,
            to: new.name(),
        };
        let Some(entry) = current else {
            return match new {
                Planned => Ok(Decision::Apply),
                _ => Err(illegal("none")),
            };
        };
        let conflict = |existing: &Txid| LedgerError::Conflict {
            batch_index,
            existing_txid: *existing,
        };

        // Once a transaction exists, its identity is the first built (txid, raw bytes).
        let anchor = entry.built.as_ref();
        let same_built = |txid: &Txid, raw: &[u8]| match anchor {
            Some((t, r)) if t == txid && r == raw => Ok(Decision::NoOp),
            Some((t, _)) => Err(conflict(t)),
            None => Err(illegal(entry.status.name())),
        };
        let same_txid = |txid: &Txid, ok: Decision| match anchor {
            Some((t, _)) if t == txid => Ok(ok),
            Some((t, _)) => Err(conflict(t)),
            None => Err(illegal(entry.status.name())),
        };

        match (&entry.status, new) {
            (Planned, Planned) => Ok(Decision::NoOp),
            (Planned, Built { .. } | Failed { .. }) => Ok(Decision::Apply),

            (Built { .. }, Built { txid, raw_tx }) => same_built(txid, raw_tx),
            (Built { .. }, Broadcast { txid }) => same_txid(txid, Decision::Apply),
            (Built { .. } | Broadcast { .. }, Failed { .. }) => Ok(Decision::Apply),

            // Re-recording the built transaction after the batch moved on changes nothing.
            (Broadcast { .. } | Confirmed { .. }, Built { txid, raw_tx }) => {
                same_built(txid, raw_tx)
            }
            (Broadcast { .. } | Confirmed { .. }, Broadcast { txid }) => {
                same_txid(txid, Decision::NoOp)
            }
            (Broadcast { .. }, Confirmed { txid, .. }) => same_txid(txid, Decision::Apply),
            (Confirmed { depth: old, .. }, Confirmed { txid, depth }) => same_txid(
                txid,
                if old == depth {
                    Decision::NoOp
                } else {
                    Decision::Apply
                },
            ),

            // `record` has already given a failure the id of the transaction built for the
            // batch, so the same reason is the same failure.
            (Failed { reason: old, .. }, Failed { reason, .. }) if old == reason => {
                Ok(Decision::NoOp)
            }

            (from, _) => Err(illegal(from.name())),
        }
    }
}

impl Ledger for InMemoryLedger {
    fn get(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<BatchStatus>, LedgerError> {
        Ok(self
            .entries
            .get(&(campaign.clone(), batch_index))
            .map(|entry| entry.status.clone()))
    }

    fn built_tx(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<(Txid, Vec<u8>)>, LedgerError> {
        Ok(self
            .entries
            .get(&(campaign.clone(), batch_index))
            .and_then(|entry| entry.built.clone()))
    }

    fn record(
        &mut self,
        campaign: &CampaignId,
        batch_index: u32,
        status: BatchStatus,
    ) -> Result<(), LedgerError> {
        let key = (campaign.clone(), batch_index);
        // A failure keeps the id of the transaction built for the batch, taken from the
        // batch's own history; naming another one is a conflict, naming one that was never
        // built is nonsense.
        let status = match status {
            BatchStatus::Failed { reason, txid } => {
                let anchor = self
                    .entries
                    .get(&key)
                    .and_then(|entry| entry.built.as_ref())
                    .map(|(built, _)| *built);
                match (txid, anchor) {
                    (Some(given), Some(built)) if given != built => {
                        return Err(LedgerError::Conflict {
                            batch_index,
                            existing_txid: built,
                        });
                    }
                    (Some(_), None) => {
                        return Err(LedgerError::InvalidStatus {
                            batch_index,
                            reason: "a failed batch can only name a transaction that was built",
                        });
                    }
                    _ => BatchStatus::Failed {
                        reason,
                        txid: anchor,
                    },
                }
            }
            other => other,
        };
        match Self::decide(batch_index, self.entries.get(&key), &status)? {
            Decision::NoOp => Ok(()),
            Decision::Apply => {
                let built = match (&status, self.entries.get(&key)) {
                    (BatchStatus::Built { txid, raw_tx }, _) => Some((*txid, raw_tx.clone())),
                    (_, Some(entry)) => entry.built.clone(),
                    (_, None) => None,
                };
                self.entries.insert(key, Entry { status, built });
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use BatchStatus::*;

    fn id() -> CampaignId {
        CampaignId::new("camp").unwrap()
    }

    fn txid(n: u8) -> Txid {
        Txid::from_bytes([n; 32])
    }

    fn built(n: u8) -> BatchStatus {
        Built {
            txid: txid(n),
            raw_tx: vec![n, n, n],
        }
    }

    fn ledger_at(status: BatchStatus) -> InMemoryLedger {
        let mut l = InMemoryLedger::new();
        l.record(&id(), 0, Planned).unwrap();
        match &status {
            Planned => {}
            Built { .. } | Failed { .. } => l.record(&id(), 0, status.clone()).unwrap(),
            Broadcast { txid } => {
                l.record(&id(), 0, built(txid.as_bytes()[0])).unwrap();
                l.record(&id(), 0, status.clone()).unwrap();
            }
            Confirmed { txid, .. } => {
                l.record(&id(), 0, built(txid.as_bytes()[0])).unwrap();
                l.record(&id(), 0, Broadcast { txid: *txid }).unwrap();
                l.record(&id(), 0, status.clone()).unwrap();
            }
        }
        l
    }

    // covers: REQ-LED-001
    #[test]
    fn happy_path_walks_through_every_status() {
        let mut l = InMemoryLedger::new();
        assert_eq!(l.get(&id(), 0).unwrap(), None);
        l.record(&id(), 0, Planned).unwrap();
        l.record(&id(), 0, built(1)).unwrap();
        l.record(&id(), 0, Broadcast { txid: txid(1) }).unwrap();
        l.record(
            &id(),
            0,
            Confirmed {
                txid: txid(1),
                depth: 1,
            },
        )
        .unwrap();
        l.record(
            &id(),
            0,
            Confirmed {
                txid: txid(1),
                depth: 5,
            },
        )
        .unwrap();
        assert_eq!(
            l.get(&id(), 0).unwrap(),
            Some(Confirmed {
                txid: txid(1),
                depth: 5
            })
        );
    }

    // covers: REQ-LED-001
    #[test]
    fn recording_the_same_built_tx_twice_is_a_no_op() {
        let mut l = ledger_at(built(1));
        l.record(&id(), 0, built(1)).unwrap();
        assert_eq!(l.get(&id(), 0).unwrap(), Some(built(1)));
        // Also after the batch has moved on: the later status wins.
        l.record(&id(), 0, Broadcast { txid: txid(1) }).unwrap();
        l.record(&id(), 0, built(1)).unwrap();
        assert_eq!(l.get(&id(), 0).unwrap(), Some(Broadcast { txid: txid(1) }));
        l.record(
            &id(),
            0,
            Confirmed {
                txid: txid(1),
                depth: 2,
            },
        )
        .unwrap();
        l.record(&id(), 0, built(1)).unwrap();
        l.record(&id(), 0, Broadcast { txid: txid(1) }).unwrap();
        assert_eq!(
            l.get(&id(), 0).unwrap(),
            Some(Confirmed {
                txid: txid(1),
                depth: 2
            })
        );
    }

    // covers: REQ-LED-001
    #[test]
    fn a_different_tx_for_a_built_batch_is_a_conflict() {
        let mut l = ledger_at(built(1));
        let err = l.record(&id(), 0, built(2)).unwrap_err();
        assert_eq!(
            err,
            LedgerError::Conflict {
                batch_index: 0,
                existing_txid: txid(1)
            }
        );
        // Same txid, different raw bytes (malleated signatures) is also a conflict.
        let err = l
            .record(
                &id(),
                0,
                Built {
                    txid: txid(1),
                    raw_tx: vec![9, 9],
                },
            )
            .unwrap_err();
        assert!(matches!(err, LedgerError::Conflict { .. }));
        assert_eq!(l.get(&id(), 0).unwrap(), Some(built(1)), "state unchanged");
    }

    // covers: REQ-LED-001
    #[test]
    fn a_different_tx_for_a_broadcast_or_confirmed_batch_is_a_conflict() {
        for start in [
            Broadcast { txid: txid(1) },
            Confirmed {
                txid: txid(1),
                depth: 3,
            },
        ] {
            let mut l = ledger_at(start.clone());
            for attempt in [
                built(2),
                Broadcast { txid: txid(2) },
                Confirmed {
                    txid: txid(2),
                    depth: 9,
                },
                Built {
                    txid: txid(1),
                    raw_tx: vec![0],
                },
            ] {
                let err = l.record(&id(), 0, attempt.clone()).unwrap_err();
                assert!(
                    matches!(err, LedgerError::Conflict { existing_txid, .. } if existing_txid == txid(1)),
                    "{start:?} <- {attempt:?}: {err}"
                );
            }
            assert_eq!(l.get(&id(), 0).unwrap(), Some(start));
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn illegal_transitions_are_rejected() {
        // Cannot go back to Planned, skip steps, or leave a terminal state.
        let cases: Vec<(BatchStatus, BatchStatus)> = vec![
            (built(1), Planned),
            (Broadcast { txid: txid(1) }, Planned),
            (
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
                Planned,
            ),
            (
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
            ),
            (Planned, Broadcast { txid: txid(1) }),
            (
                Planned,
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
            ),
            (
                built(1),
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
            ),
            (
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
                Planned,
            ),
            (
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
                built(1),
            ),
            (
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
                Failed {
                    reason: "y".into(),
                    txid: None,
                },
            ),
        ];
        for (from, to) in cases {
            let mut l = ledger_at(from.clone());
            let err = l.record(&id(), 0, to.clone()).unwrap_err();
            assert!(
                matches!(err, LedgerError::IllegalTransition { .. }),
                "{from:?} -> {to:?} gave {err}"
            );
            assert_eq!(l.get(&id(), 0).unwrap(), Some(from), "state unchanged");
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn first_record_must_be_planned_and_depth_must_be_positive() {
        let mut l = InMemoryLedger::new();
        for s in [
            built(1),
            Broadcast { txid: txid(1) },
            Failed {
                reason: "x".into(),
                txid: None,
            },
        ] {
            assert!(matches!(
                l.record(&id(), 0, s),
                Err(LedgerError::IllegalTransition { from: "none", .. })
            ));
        }
        assert!(matches!(
            l.record(
                &id(),
                0,
                Confirmed {
                    txid: txid(1),
                    depth: 0
                }
            ),
            Err(LedgerError::InvalidStatus { .. })
        ));
        assert_eq!(l.get(&id(), 0).unwrap(), None);
    }

    // covers: REQ-LED-001
    #[test]
    fn failed_is_idempotent_for_the_same_reason_and_reachable_from_every_active_state() {
        for start in [Planned, built(1), Broadcast { txid: txid(1) }] {
            let mut l = ledger_at(start.clone());
            l.record(
                &id(),
                0,
                Failed {
                    reason: "rejected".into(),
                    txid: None,
                },
            )
            .unwrap();
            l.record(
                &id(),
                0,
                Failed {
                    reason: "rejected".into(),
                    txid: None,
                },
            )
            .unwrap();
            assert_eq!(
                l.get(&id(), 0).unwrap(),
                Some(Failed {
                    reason: "rejected".into(),
                    txid: start.txid()
                })
            );
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn a_failed_batch_keeps_the_id_of_the_transaction_built_for_it() {
        for start in [built(1), Broadcast { txid: txid(1) }] {
            let mut l = ledger_at(start);
            // The caller need not name the transaction: the ledger knows which one it is.
            l.record(
                &id(),
                0,
                Failed {
                    reason: "mislabelled".into(),
                    txid: None,
                },
            )
            .unwrap();
            let failed = l.get(&id(), 0).unwrap().unwrap();
            assert_eq!(
                failed,
                Failed {
                    reason: "mislabelled".into(),
                    txid: Some(txid(1))
                }
            );
            assert_eq!(
                failed.txid(),
                Some(txid(1)),
                "a batch that may be mined is not forgotten"
            );
            assert!(format!("{failed:?}").contains(&txid(1).to_string()));
            // The bytes are still there, and the same record again changes nothing.
            assert_eq!(
                l.built_tx(&id(), 0).unwrap(),
                Some((txid(1), vec![1, 1, 1]))
            );
            l.record(
                &id(),
                0,
                Failed {
                    reason: "mislabelled".into(),
                    txid: None,
                },
            )
            .unwrap();
            l.record(
                &id(),
                0,
                Failed {
                    reason: "mislabelled".into(),
                    txid: Some(txid(1)),
                },
            )
            .unwrap();
            assert_eq!(l.get(&id(), 0).unwrap().unwrap(), failed);
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn a_failure_cannot_name_another_transaction_or_one_that_was_never_built() {
        let mut l = ledger_at(built(1));
        assert!(matches!(
            l.record(&id(), 0, Failed { reason: "x".into(), txid: Some(txid(2)) }),
            Err(LedgerError::Conflict { existing_txid, .. }) if existing_txid == txid(1)
        ));
        assert_eq!(l.get(&id(), 0).unwrap(), Some(built(1)), "unchanged");

        let mut l = ledger_at(Planned);
        assert!(matches!(
            l.record(
                &id(),
                0,
                Failed {
                    reason: "x".into(),
                    txid: Some(txid(1))
                }
            ),
            Err(LedgerError::InvalidStatus { .. })
        ));
        // Without one, a batch that failed before anything was built has no id.
        l.record(
            &id(),
            0,
            Failed {
                reason: "build rejected".into(),
                txid: None,
            },
        )
        .unwrap();
        let failed = l.get(&id(), 0).unwrap().unwrap();
        assert_eq!(failed.txid(), None);
        assert_eq!(l.built_tx(&id(), 0).unwrap(), None);
    }

    // covers: REQ-LED-001
    #[test]
    fn the_built_transaction_is_available_whatever_the_batch_has_become() {
        let mut l = InMemoryLedger::new();
        assert_eq!(l.built_tx(&id(), 0).unwrap(), None, "unknown batch");
        l.record(&id(), 0, Planned).unwrap();
        assert_eq!(l.built_tx(&id(), 0).unwrap(), None, "nothing built yet");
        l.record(&id(), 0, built(3)).unwrap();
        let anchor = Some((txid(3), vec![3, 3, 3]));
        assert_eq!(l.built_tx(&id(), 0).unwrap(), anchor);
        l.record(&id(), 0, Broadcast { txid: txid(3) }).unwrap();
        assert_eq!(l.built_tx(&id(), 0).unwrap(), anchor);
        l.record(
            &id(),
            0,
            Confirmed {
                txid: txid(3),
                depth: 2,
            },
        )
        .unwrap();
        assert_eq!(l.built_tx(&id(), 0).unwrap(), anchor);
        // Through a mutable reference too.
        let by_ref: &mut InMemoryLedger = &mut l;
        assert_eq!(Ledger::built_tx(&by_ref, &id(), 0).unwrap(), anchor);
    }

    // covers: REQ-LED-001
    #[test]
    fn the_default_built_tx_knows_only_a_batch_that_is_still_built() {
        /// A ledger with nothing but `get` and `record`.
        struct Plain(InMemoryLedger);
        impl Ledger for Plain {
            fn get(&self, c: &CampaignId, i: u32) -> Result<Option<BatchStatus>, LedgerError> {
                self.0.get(c, i)
            }
            fn record(
                &mut self,
                c: &CampaignId,
                i: u32,
                s: BatchStatus,
            ) -> Result<(), LedgerError> {
                self.0.record(c, i, s)
            }
        }
        let mut plain = Plain(InMemoryLedger::new());
        plain.record(&id(), 0, Planned).unwrap();
        plain.record(&id(), 0, built(4)).unwrap();
        assert_eq!(
            plain.built_tx(&id(), 0).unwrap(),
            Some((txid(4), vec![4, 4, 4]))
        );
        plain.record(&id(), 0, Broadcast { txid: txid(4) }).unwrap();
        assert_eq!(plain.built_tx(&id(), 0).unwrap(), None);
    }

    // covers: REQ-LED-001
    #[test]
    fn a_failure_recorded_before_ids_were_kept_still_reads() {
        // The form an earlier build wrote has no txid; it reads back as "no transaction".
        let old: BatchStatus =
            serde_json::from_str(r#"{"state":"failed","reason":"rejected"}"#).unwrap();
        assert_eq!(
            old,
            Failed {
                reason: "rejected".into(),
                txid: None
            }
        );
        let json = serde_json::to_string(&old).unwrap();
        assert!(!json.contains("txid"), "{json}");
        let with = Failed {
            reason: "r".into(),
            txid: Some(txid(5)),
        };
        assert!(serde_json::to_string(&with)
            .unwrap()
            .contains(&txid(5).to_string()));
    }

    // covers: REQ-LED-001
    #[test]
    fn batches_and_campaigns_are_independent() {
        let mut l = InMemoryLedger::new();
        let other = CampaignId::new("other").unwrap();
        for c in [&id(), &other] {
            for i in 0..2 {
                l.record(c, i, Planned).unwrap();
            }
        }
        l.record(&id(), 0, built(1)).unwrap();
        // The same txid or a different one on another batch/campaign is not a conflict.
        l.record(&id(), 1, built(2)).unwrap();
        l.record(&other, 0, built(3)).unwrap();
        assert_eq!(l.get(&other, 1).unwrap(), Some(Planned));
        let all = l.statuses(&id(), 3).unwrap();
        assert_eq!(
            all,
            vec![built(1), built(2), Planned],
            "unrecorded counts as planned"
        );
    }

    // covers: REQ-LED-001
    #[test]
    fn status_serde_round_trips_with_hex_raw_tx() {
        let s = Built {
            txid: txid(0xab),
            raw_tx: vec![1, 2, 255],
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"state\":\"built\""), "{json}");
        assert!(json.contains("\"raw_tx\":\"0102ff\""), "{json}");
        assert_eq!(serde_json::from_str::<BatchStatus>(&json).unwrap(), s);
        for s in [
            Planned,
            Broadcast { txid: txid(1) },
            Confirmed {
                txid: txid(1),
                depth: 4,
            },
            Failed {
                reason: "no".into(),
                txid: None,
            },
            Failed {
                reason: "no".into(),
                txid: Some(txid(7)),
            },
        ] {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(serde_json::from_str::<BatchStatus>(&json).unwrap(), s);
        }
    }

    // covers: REQ-PRIV-002
    #[test]
    fn status_debug_does_not_dump_raw_bytes() {
        let text = format!(
            "{:?}",
            Built {
                txid: txid(1),
                raw_tx: vec![0xde; 4000]
            }
        );
        assert!(text.contains("<4000 bytes>"));
        assert!(text.len() < 200);
    }
}
