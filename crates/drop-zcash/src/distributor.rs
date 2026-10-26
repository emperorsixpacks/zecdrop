//! `drop_core::engine::Distributor` for Zcash: builds each batch as one transparent -> Ironwood
//! transaction ([`crate::builder`]) against live chain state from a [`ChainBackend`].
//!
//! Mainnet is opt-in twice over. The operator's own gate (`--allow-mainnet` plus a confirmation,
//! REQ-OPS-001) decides whether a mainnet run may start at all; below that,
//! [`ZcashDistributor::new`] still refuses mainnet keys, and only
//! [`ZcashDistributor::new_for_mainnet`], which needs a [`MainnetPermit`], accepts them.
//!
//! Before a batch is handed to the engine (which stores it and then sends it) it is checked twice
//! (REQ-TX-004): the node must be on the upgrade this build stamps, and the built bytes must pass
//! the proof and signature checks consensus runs, balance publicly, and carry no Orchard or
//! Sapling value. A build that fails either check never reaches the ledger or the network.

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

use crate::builder::{
    build_batch_tx, expected_branch_id, fee_rule, BuildError, BuiltTx, FundingCoin, PayoutLine,
};
use crate::chain::{ChainBackend, Submitted, TxStatus};
use crate::codec::orchard_receiver;
use crate::inspect;
use crate::keys::CampaignKeys;
use crate::memo::{encode_memo, MemoError};
use crate::txid;

/// Evidence that the caller has passed the operator's mainnet gate (`--allow-mainnet` plus
/// `ZECDROP_CONFIRM_MAINNET`, REQ-OPS-001). [`ZcashDistributor::new_for_mainnet`] needs one. It
/// keeps tests, examples and future callers from reaching mainnet by accident; it is a speed
/// bump for code, not a security boundary.
#[derive(Clone, Copy, Debug)]
pub struct MainnetPermit(());

impl MainnetPermit {
    /// Only the operator calls this, and only after its own mainnet gate has passed.
    pub fn after_operator_gate() -> Self {
        MainnetPermit(())
    }
}

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
    #[error(
        "the node reports branch {node:08x} but this build expects {expected:08x} at height \
         {height}: this build does not know the network's current upgrade"
    )]
    BranchMismatch {
        node: u32,
        expected: u32,
        height: u32,
    },
    #[error("the built transaction failed its own check ({0}); nothing was stored or sent")]
    SelfCheck(String),
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
    ///
    /// Refuses mainnet keys: a mainnet distributor comes from [`ZcashDistributor::new_for_mainnet`].
    pub fn new(keys: CampaignKeys, backend: B, fee_policy: &FeePolicy) -> Result<Self, ZcashError> {
        if keys.network() == Network::MainNetwork {
            return Err(ZcashError::MainnetDisabled);
        }
        Self::with_policy(keys, backend, fee_policy)
    }

    /// Like [`ZcashDistributor::new`], for keys of either network. The permit shows the caller
    /// passed the operator's mainnet gate.
    pub fn new_for_mainnet(
        keys: CampaignKeys,
        backend: B,
        fee_policy: &FeePolicy,
        _permit: MainnetPermit,
    ) -> Result<Self, ZcashError> {
        Self::with_policy(keys, backend, fee_policy)
    }

    fn with_policy(
        keys: CampaignKeys,
        backend: B,
        fee_policy: &FeePolicy,
    ) -> Result<Self, ZcashError> {
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

/// What must hold of a freshly built batch before anything stores or sends it (REQ-TX-004): every
/// proof and signature verifies the way consensus checks them, the branch id is the one this build
/// derived for the target height, the public totals balance, no value enters Orchard or Sapling
/// (invariant 1), and the public Ironwood amount is exactly what the payouts add up to. The
/// messages name counts and amounts of the campaign only, never a recipient.
fn self_check(
    built: &BuiltTx,
    coin: &FundingCoin,
    payouts: &[PayoutLine],
    expected_branch: u32,
) -> Result<(), ZcashError> {
    let fail = |what: &str| ZcashError::SelfCheck(what.to_owned());
    let resolve = |op: &zcash_transparent::bundle::OutPoint| {
        (op == &coin.outpoint).then(|| coin.coin.clone())
    };
    inspect::verify_proofs_and_signatures(&built.raw, resolve)
        .map_err(|e| ZcashError::SelfCheck(e.to_string()))?;
    let totals = inspect::public_totals(&built.raw, resolve)
        .map_err(|e| ZcashError::SelfCheck(e.to_string()))?;
    if u32::from(totals.branch_id) != expected_branch {
        return Err(fail("the branch id differs from the one expected"));
    }
    if !totals.balances() {
        return Err(fail("the public totals do not balance"));
    }
    if totals.orchard_actions != 0 || totals.orchard_value_balance != 0 || totals.sapling_io != 0 {
        return Err(fail("value would enter a pool other than Ironwood"));
    }
    let paid: u64 = payouts.iter().map(|p| u64::from(p.value)).sum();
    if i128::from(totals.net_into_ironwood) != i128::from(paid) {
        return Err(fail("the public Ironwood amount differs from the payouts"));
    }
    Ok(())
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
        let target = tip + 1;
        let expected = expected_branch_id(&self.keys.network(), target);
        if let Some(node) = Self::chain(self.backend.consensus_branch_id())? {
            if node != expected {
                return Err(ZcashError::BranchMismatch {
                    node,
                    expected,
                    height: target,
                });
            }
        }
        let anchor_bytes = Self::chain(self.backend.ironwood_anchor(tip))?;
        let anchor =
            Option::from(orchard::Anchor::from_bytes(anchor_bytes)).ok_or(ZcashError::BadAnchor)?;

        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| ZcashError::Chain(format!("OS randomness: {e}")))?;
        let built = build_batch_tx(
            &self.keys,
            BlockHeight::from_u32(target),
            anchor,
            std::slice::from_ref(&coin),
            &payouts,
            &self.fee_rule,
            &mut ChaCha20Rng::from_seed(seed),
        )?;
        self_check(&built, &coin, &payouts, expected)?;
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
        /// What the node says its consensus branch id is; `None` is a backend that cannot say.
        branch: Option<u32>,
    }

    impl ChainBackend for FakeChain {
        type Error = Down;
        fn tip_height(&mut self) -> Result<u32, Down> {
            Ok(self.tip)
        }
        fn consensus_branch_id(&mut self) -> Result<Option<u32>, Down> {
            Ok(self.branch)
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

    fn chain_at(tip: u32, value: u64, script: Vec<u8>) -> FakeChain {
        let mut utxos = HashMap::new();
        utxos.insert(
            funding_outpoint(),
            crate::chain::PrevOut {
                value,
                script_pubkey: script,
            },
        );
        FakeChain {
            tip,
            utxos,
            sent: vec![],
            mined: HashMap::new(),
            reject: None,
            branch: None,
        }
    }

    fn chain_with_funding(value: u64, script: Vec<u8>) -> FakeChain {
        chain_at(u32::from(nu7_height()), value, script)
    }

    fn batch(n: usize) -> Batch {
        batch_for(TestNetwork, n)
    }

    /// `n` payouts to accounts 20.. of the TEST ONLY seed on `network`.
    fn batch_for(network: Network, n: usize) -> Batch {
        let rows: Vec<Recipient> = (0..n)
            .map(|i| {
                let keys = CampaignKeys::derive(
                    &crate::keys::tests::TEST_ONLY_SEED,
                    network,
                    20 + i as u32,
                )
                .unwrap();
                Recipient::new(
                    keys.unified_address(),
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

    // covers: REQ-OPS-001
    #[test]
    fn mainnet_keys_are_refused_without_a_permit() {
        let keys =
            CampaignKeys::derive(&crate::keys::tests::TEST_ONLY_SEED, Network::MainNetwork, 0)
                .unwrap();
        let chain = chain_with_funding(0, vec![]);
        assert!(matches!(
            ZcashDistributor::new(keys, chain, &FeePolicy::default()),
            Err(ZcashError::MainnetDisabled)
        ));
    }

    // covers: REQ-TX-004
    #[test]
    fn a_node_on_another_upgrade_is_refused_before_anything_is_built() {
        let keys = test_keys(0);
        let policy = FeePolicy::zip317_text();
        let value = 100_000;
        let funding = FundingRef {
            outpoint: funding_outpoint(),
            value: Zatoshi::new(value).unwrap(),
        };

        // Testnet is on NU7 (0x77190ad9). A node that says NU6.3 is on a different branch.
        let mut chain = chain_with_funding(value, keys.funding_script().0 .0.clone());
        chain.branch = Some(0x37a5_165b);
        let mut d = ZcashDistributor::new(test_keys(0), chain, &policy).unwrap();
        let err = d.build_batch(&batch(2), &funding).unwrap_err();
        assert!(
            matches!(
                err,
                ZcashError::BranchMismatch {
                    node: 0x37a5_165b,
                    expected: 0x7719_0ad9,
                    ..
                }
            ),
            "{err}"
        );
        assert_eq!(d.classify(&err), FailureKind::Permanent);
        assert!(err.to_string().contains("37a5165b"), "{err}");
        assert!(d.backend().sent.is_empty());

        // The right branch passes the check, and so does a backend that cannot say.
        for branch in [Some(0x7719_0ad9), None] {
            let mut chain = chain_with_funding(value, keys.funding_script().0 .0.clone());
            chain.branch = branch;
            let mut d = ZcashDistributor::new(test_keys(0), chain, &policy).unwrap();
            let built = d.build_batch(&batch(2), &funding).unwrap();
            assert!(!built.raw_tx.is_empty());
        }
    }

    // covers: REQ-TX-004
    #[test]
    fn the_self_check_rejects_anything_that_consensus_or_the_plan_would_not() {
        let (tx, coin) = crate::builder::tests::shared_batch();
        let paid = crate::builder::tests::payouts(3);
        let nu7 = 0x7719_0ad9;
        self_check(tx, coin, &paid, nu7).unwrap();

        // A different branch id than the one expected.
        assert!(matches!(
            self_check(tx, coin, &paid, 0x37a5_165b),
            Err(ZcashError::SelfCheck(_))
        ));
        // A public amount that is not the sum of the payouts.
        assert!(matches!(
            self_check(tx, coin, &paid[..2], nu7),
            Err(ZcashError::SelfCheck(_))
        ));
        // A signature that does not verify: the last 256 bytes are spend-auth and binding
        // signatures, so flipping a bit 100 bytes from the end breaks one of them.
        let mut tampered = tx.clone();
        let at = tampered.raw.len() - 100;
        tampered.raw[at] ^= 1;
        assert!(matches!(
            self_check(&tampered, coin, &paid, nu7),
            Err(ZcashError::SelfCheck(_))
        ));
        // Bytes that are not a transaction.
        let mut junk = tx.clone();
        junk.raw = vec![1, 2, 3];
        assert!(matches!(
            self_check(&junk, coin, &paid, nu7),
            Err(ZcashError::SelfCheck(_))
        ));
        // None of the messages carries a recipient: they name no address, memo or amount.
        let message = self_check(tx, coin, &paid[..2], nu7)
            .unwrap_err()
            .to_string();
        assert!(!message.contains("TEST ONLY"), "{message}");
    }

    // covers: REQ-OPS-001, REQ-TX-001, REQ-TX-004
    #[test]
    fn a_mainnet_distributor_needs_the_permit_and_runs_a_batch_at_the_mainnet_branch() {
        use zcash_protocol::consensus::BranchId;
        let seed = &crate::keys::tests::TEST_ONLY_SEED;
        let keys = || CampaignKeys::derive(seed, Network::MainNetwork, 0).unwrap();
        let policy = FeePolicy::zip317_text();
        let b = batch_for(Network::MainNetwork, 2);
        let total = b.total().as_u64();
        let value = total + 15_000 + 1_000;
        // One block above the real mainnet tip seen on 2026-10-18 (NU6.3, no NU7 height known).
        let mut chain = chain_at(3_522_426, value, keys().funding_script().0 .0.clone());
        chain.branch = Some(0x37a5_165b);
        let distributor = ZcashDistributor::new_for_mainnet(
            keys(),
            chain,
            &policy,
            MainnetPermit::after_operator_gate(),
        )
        .unwrap();
        let funding = FundingRef {
            outpoint: funding_outpoint(),
            value: Zatoshi::new(value).unwrap(),
        };
        let mut engine = Engine::new(
            CampaignId::new("test-only-mainnet-campaign").unwrap(),
            vec![b],
            vec![funding],
            1,
            &policy,
            distributor,
            InMemoryLedger::default(),
        )
        .unwrap();
        let last = engine.run_to_completion(3, |_| {}).unwrap();
        assert!(
            matches!(last, ProgressEvent::Settled { batches: 1, .. }),
            "{last:?}"
        );

        let (d, _) = engine.into_parts();
        let raw = &d.backend().sent[0];
        let coin = TxOut::new(Zatoshis::from_u64(value).unwrap(), keys().funding_script());
        let op = txid::outpoint_from_core(&funding_outpoint());
        let v = inspect::public_totals(raw, |o| (o == &op).then(|| coin.clone())).unwrap();
        assert_eq!(v.branch_id, BranchId::Nu6_3);
        assert!(v.balances());
        assert_eq!(v.net_into_ironwood, total as i64);
        inspect::verify_proofs_and_signatures(raw, |o| (o == &op).then(|| coin.clone())).unwrap();
    }
}
