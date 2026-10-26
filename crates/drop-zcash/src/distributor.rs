//! `drop_core::engine::Distributor` for Zcash: builds each batch as one transparent -> Ironwood
//! transaction ([`crate::builder`]) against live chain state from a [`ChainBackend`].
//!
//! Testnet only for now: [`ZcashDistributor::new`] refuses mainnet keys (REQ-OPS-001 puts the
//! mainnet opt-in in the operator, which does not exist yet).

use drop_core::engine::{BuiltBatch, Distributor, FailureKind, FundingRef};
use drop_core::fee::FeePolicy;
use drop_core::planner::Batch;
use drop_core::Txid;
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use thiserror::Error;
use zcash_primitives::transaction::fees::zip317;
use zcash_protocol::{
    consensus::{BlockHeight, Network},
    value::Zatoshis,
};
use zcash_transparent::bundle::TxOut;

use crate::builder::{build_batch_tx, fee_rule, BuildError, FundingCoin, PayoutLine};
use crate::chain::{ChainBackend, Submitted, TxStatus};
use crate::codec::orchard_receiver;
use crate::keys::CampaignKeys;
use crate::memo::{encode_memo, MemoError};
use crate::txid;

/// Distributor errors. Recipients are identified by their position in the batch only.
#[derive(Debug, Error)]
pub enum ZcashError {
    #[error("mainnet is disabled in this build")]
    MainnetDisabled,
    #[error("recipient #{index} has no Orchard receiver on this network")]
    UnpayableRecipient { index: usize },
    #[error("recipient #{index}: {source}")]
    Memo { index: usize, source: MemoError },
    #[error("recipient #{index}: amount is not a valid Zcash amount")]
    Amount { index: usize },
    #[error("funding outpoint is not a known unspent output")]
    FundingNotFound,
    #[error("funding value on chain ({on_chain} zat) differs from the plan ({planned} zat)")]
    FundingValueMismatch { on_chain: u64, planned: u64 },
    #[error("the chain backend returned an invalid Ironwood anchor")]
    BadAnchor,
    #[error(transparent)]
    Build(#[from] BuildError),
    #[error("node rejected the transaction: {0}")]
    Rejected(String),
    #[error("chain backend: {0}")]
    Chain(String),
}

pub struct ZcashDistributor<B: ChainBackend> {
    keys: CampaignKeys,
    backend: B,
    fee_rule: zip317::FeeRule,
}

impl<B: ChainBackend> ZcashDistributor<B> {
    /// `fee_policy` must be the one given to `drop_core::engine::Engine::new`, so the engine's
    /// funding check and the built transaction agree on the fee.
    pub fn new(keys: CampaignKeys, backend: B, fee_policy: &FeePolicy) -> Result<Self, ZcashError> {
        if keys.network() == Network::MainNetwork {
            return Err(ZcashError::MainnetDisabled);
        }
        Ok(ZcashDistributor {
            fee_rule: fee_rule(fee_policy)?,
            keys,
            backend,
        })
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    fn chain<T>(r: Result<T, B::Error>) -> Result<T, ZcashError> {
        r.map_err(|e| ZcashError::Chain(e.to_string()))
    }

    fn payouts(&self, batch: &Batch) -> Result<Vec<PayoutLine>, ZcashError> {
        let network = self.keys.network();
        batch
            .recipients()
            .iter()
            .enumerate()
            .map(|(index, r)| {
                Ok(PayoutLine {
                    receiver: orchard_receiver(network, r.address())
                        .ok_or(ZcashError::UnpayableRecipient { index })?,
                    value: Zatoshis::from_u64(r.amount().as_u64())
                        .map_err(|_| ZcashError::Amount { index })?,
                    memo: encode_memo(r.memo())
                        .map_err(|source| ZcashError::Memo { index, source })?,
                })
            })
            .collect()
    }

    fn funding_coin(&mut self, funding: &FundingRef) -> Result<FundingCoin, ZcashError> {
        let prev = Self::chain(self.backend.prevout(&funding.outpoint))?
            .ok_or(ZcashError::FundingNotFound)?;
        if prev.value != funding.value.as_u64() {
            return Err(ZcashError::FundingValueMismatch {
                on_chain: prev.value,
                planned: funding.value.as_u64(),
            });
        }
        // Only coins at the campaign's own addresses can be signed for.
        let script = [self.keys.funding_script(), self.keys.change_script()]
            .into_iter()
            .find(|s| s.0 .0 == prev.script_pubkey)
            .ok_or(BuildError::ForeignCoin)?;
        let value = Zatoshis::from_u64(prev.value).map_err(|_| ZcashError::FundingNotFound)?;
        Ok(FundingCoin {
            outpoint: txid::outpoint_from_core(&funding.outpoint),
            coin: TxOut::new(value, script),
        })
    }
}

impl<B: ChainBackend> Distributor for ZcashDistributor<B> {
    type Error = ZcashError;

    fn build_batch(
        &mut self,
        batch: &Batch,
        funding: &FundingRef,
    ) -> Result<BuiltBatch, ZcashError> {
        let payouts = self.payouts(batch)?;
        let coin = self.funding_coin(funding)?;
        let tip = Self::chain(self.backend.tip_height())?;
        let anchor_bytes = Self::chain(self.backend.ironwood_anchor(tip))?;
        let anchor =
            Option::from(orchard::Anchor::from_bytes(anchor_bytes)).ok_or(ZcashError::BadAnchor)?;

        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| ZcashError::Chain(format!("OS randomness: {e}")))?;
        let built = build_batch_tx(
            &self.keys,
            BlockHeight::from_u32(tip + 1),
            anchor,
            std::slice::from_ref(&coin),
            &payouts,
            &self.fee_rule,
            &mut ChaCha20Rng::from_seed(seed),
        )?;
        Ok(BuiltBatch {
            txid: txid::to_core(&built.txid),
            raw_tx: built.raw,
        })
    }

    fn broadcast(&mut self, built: &BuiltBatch) -> Result<(), ZcashError> {
        match Self::chain(self.backend.submit(&built.raw_tx))? {
            Submitted::Accepted | Submitted::AlreadyKnown => Ok(()),
            Submitted::Rejected(reason) => Err(ZcashError::Rejected(reason)),
        }
    }

    fn confirmations(&mut self, txid: &Txid) -> Result<Option<u32>, ZcashError> {
        match Self::chain(self.backend.status(txid))? {
            TxStatus::Unknown => Ok(None),
            TxStatus::Mempool => Ok(Some(0)),
            TxStatus::Mined { height } => {
                let tip = Self::chain(self.backend.tip_height())?;
                Ok(Some(tip.saturating_sub(height) + 1))
            }
        }
    }

    fn classify(&self, error: &ZcashError) -> FailureKind {
        match error {
            // Network trouble, or a funding coin not visible yet: retry later.
            ZcashError::Chain(_) | ZcashError::FundingNotFound => FailureKind::Transient,
            _ => FailureKind::Permanent,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use drop_core::engine::{Engine, ProgressEvent};
    use drop_core::{plan_batches, CampaignId, InMemoryLedger, OutPoint, Recipient, Zatoshi};
    use zcash_protocol::consensus::Network::TestNetwork;

    use super::*;
    use crate::builder::tests::nu7_height;
    use crate::inspect;
    use crate::keys::tests::test_keys;

    #[derive(Debug, thiserror::Error)]
    #[error("fake chain is down")]
    struct Down;

    /// An in-memory chain that mines every accepted tx in a new block at once.
    struct FakeChain {
        tip: u32,
        utxos: HashMap<OutPoint, crate::chain::PrevOut>,
        sent: Vec<Vec<u8>>,
        mined: HashMap<Txid, u32>,
        reject: Option<String>,
    }

    impl ChainBackend for FakeChain {
        type Error = Down;
        fn tip_height(&mut self) -> Result<u32, Down> {
            Ok(self.tip)
        }
        fn ironwood_anchor(&mut self, _: u32) -> Result<[u8; 32], Down> {
            Ok(orchard::Anchor::empty_tree().to_bytes())
        }
        fn prevout(&mut self, op: &OutPoint) -> Result<Option<crate::chain::PrevOut>, Down> {
            Ok(self.utxos.get(op).cloned())
        }
        fn submit(&mut self, raw: &[u8]) -> Result<Submitted, Down> {
            if let Some(r) = &self.reject {
                return Ok(Submitted::Rejected(r.clone()));
            }
            let id = txid::to_core(&inspect::parse(raw).unwrap().txid());
            if self.mined.contains_key(&id) {
                return Ok(Submitted::AlreadyKnown);
            }
            self.tip += 1;
            self.mined.insert(id, self.tip);
            self.sent.push(raw.to_vec());
            Ok(Submitted::Accepted)
        }
        fn status(&mut self, txid: &Txid) -> Result<TxStatus, Down> {
            Ok(self
                .mined
                .get(txid)
                .map_or(TxStatus::Unknown, |h| TxStatus::Mined { height: *h }))
        }
    }

    fn funding_outpoint() -> OutPoint {
        "11".repeat(32)
            .parse::<Txid>()
            .map(|txid| OutPoint { txid, vout: 0 })
            .unwrap()
    }

    fn chain_with_funding(value: u64, script: Vec<u8>) -> FakeChain {
        let mut utxos = HashMap::new();
        utxos.insert(
            funding_outpoint(),
            crate::chain::PrevOut {
                value,
                script_pubkey: script,
            },
        );
        FakeChain {
            tip: u32::from(nu7_height()),
            utxos,
            sent: vec![],
            mined: HashMap::new(),
            reject: None,
        }
    }

    fn batch(n: usize) -> Batch {
        let rows: Vec<Recipient> = (0..n)
            .map(|i| {
                Recipient::new(
                    test_keys(20 + i as u32).unified_address(),
                    Zatoshi::new(10_000 * (i as u64 + 1)).unwrap(),
                    Some(format!("TEST ONLY engine payout {}", i + 1)),
                )
                .unwrap()
            })
            .collect();
        plan_batches(&rows, 330).unwrap().remove(0)
    }

    // covers: REQ-TX-001
    #[test]
    fn engine_runs_a_batch_end_to_end_through_the_zcash_distributor() {
        let keys = test_keys(0);
        let policy = FeePolicy::zip317_text();
        let b = batch(2);
        let total = b.total().as_u64();
        let value = total + 15_000 + 1_000; // payouts + fee (1 t-in, 1 t-out, 2 actions) + change
        let chain = chain_with_funding(value, keys.funding_script().0 .0.clone());
        let distributor = ZcashDistributor::new(keys, chain, &policy).unwrap();
        let funding = FundingRef {
            outpoint: funding_outpoint(),
            value: Zatoshi::new(value).unwrap(),
        };
        let mut engine = Engine::new(
            CampaignId::new("test-only-campaign").unwrap(),
            vec![b],
            vec![funding],
            1,
            &policy,
            distributor,
            InMemoryLedger::default(),
        )
        .unwrap();

        let mut events = vec![];
        let last = engine
            .run_to_completion(3, |e| events.push(e.clone()))
            .unwrap();
        assert!(
            matches!(events[0], ProgressEvent::Built { outputs: 2, .. }),
            "{events:?}"
        );
        assert!(
            matches!(events[1], ProgressEvent::Broadcast { .. }),
            "{events:?}"
        );
        assert!(
            matches!(last, ProgressEvent::Settled { batches: 1, .. }),
            "{events:?}"
        );

        // What the node received balances from public data: payouts in, change back, fee paid.
        let (d, _) = engine.into_parts();
        let raw = &d.backend().sent[0];
        let coin = TxOut::new(
            Zatoshis::from_u64(value).unwrap(),
            test_keys(0).funding_script(),
        );
        let op = txid::outpoint_from_core(&funding_outpoint());
        let v = inspect::public_totals(raw, |o| (o == &op).then(|| coin.clone())).unwrap();
        assert!(v.balances());
        assert_eq!(v.net_into_ironwood, total as i64);
        assert_eq!((v.t_out_total, v.fee), (1_000, 15_000));
        assert_eq!(v.orchard_value_balance, 0);
        inspect::verify_proofs_and_signatures(raw, |o| (o == &op).then(|| coin.clone())).unwrap();
    }

    // covers: REQ-TX-001
    #[test]
    fn refusals_are_classified_for_the_engine() {
        let keys = test_keys(0);
        let policy = FeePolicy::zip317_text();
        let mut d =
            ZcashDistributor::new(keys, chain_with_funding(100_000, vec![0x51]), &policy).unwrap();
        let funding = FundingRef {
            outpoint: funding_outpoint(),
            value: Zatoshi::new(100_000).unwrap(),
        };

        // A coin we cannot sign for.
        let err = d.build_batch(&batch(2), &funding).unwrap_err();
        assert!(
            matches!(err, ZcashError::Build(BuildError::ForeignCoin)),
            "{err}"
        );
        assert_eq!(d.classify(&err), FailureKind::Permanent);

        // A funding coin the node does not know yet: retry later.
        let unknown = FundingRef {
            outpoint: OutPoint {
                vout: 9,
                ..funding_outpoint()
            },
            value: funding.value,
        };
        let err = d.build_batch(&batch(2), &unknown).unwrap_err();
        assert!(matches!(err, ZcashError::FundingNotFound));
        assert_eq!(d.classify(&err), FailureKind::Transient);

        // Plan and chain disagree on the funding value.
        let wrong = FundingRef {
            value: Zatoshi::new(99_999).unwrap(),
            ..funding
        };
        assert!(matches!(
            d.build_batch(&batch(2), &wrong).unwrap_err(),
            ZcashError::FundingValueMismatch { .. }
        ));

        // The node refuses the bytes.
        d.backend_mut().reject = Some("bad-txns".into());
        let err = d
            .broadcast(&BuiltBatch {
                txid: funding_outpoint().txid,
                raw_tx: vec![],
            })
            .unwrap_err();
        assert_eq!(d.classify(&err), FailureKind::Permanent);
    }

    #[test]
    fn unpayable_recipients_are_named_by_position_only() {
        let keys = test_keys(0);
        let t_addr = keys.funding_address();
        let mut d = ZcashDistributor::new(
            keys,
            chain_with_funding(100_000, vec![]),
            &FeePolicy::default(),
        )
        .unwrap();
        let rows = vec![
            Recipient::new(
                test_keys(30).unified_address(),
                Zatoshi::new(10_000).unwrap(),
                None,
            )
            .unwrap(),
            Recipient::new(t_addr.clone(), Zatoshi::new(10_000).unwrap(), None).unwrap(),
        ];
        let b = plan_batches(&rows, 330).unwrap().remove(0);
        let funding = FundingRef {
            outpoint: funding_outpoint(),
            value: Zatoshi::new(100_000).unwrap(),
        };
        let err = d.build_batch(&b, &funding).unwrap_err();
        assert!(matches!(err, ZcashError::UnpayableRecipient { index: 1 }));
        assert!(!err.to_string().contains(&t_addr));
    }

    #[test]
    fn mainnet_keys_are_refused() {
        let keys =
            CampaignKeys::derive(&crate::keys::tests::TEST_ONLY_SEED, Network::MainNetwork, 0)
                .unwrap();
        let chain = chain_with_funding(0, vec![]);
        assert!(matches!(
            ZcashDistributor::new(keys, chain, &FeePolicy::default()),
            Err(ZcashError::MainnetDisabled)
        ));
        let _ = TestNetwork;
    }
}
