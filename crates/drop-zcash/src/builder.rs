//! The batch transaction (REQ-TX-001, REQ-TX-002): the campaign's transparent coins -> one
//! Ironwood output per payout, each carrying the campaign OVK -> transparent change, if any.
//! No shielded spends and no Orchard bundle, so `t_in = t_out + net_into_pool + fee` holds and
//! anyone can check it from chain data.
//!
//! Change: with `remainder = inputs - payouts`,
//! * `remainder >= fee(with change) + 54` → a change output of `remainder - fee(with change)`;
//! * otherwise, if `remainder >= fee(without change)` → **no** change output, and the whole
//!   remainder is the fee. Exact funding (`remainder == fee`) lands here, and so does a sliver of
//!   1–53 zat that would be a dust output (Zebra rejects P2PKH outputs below 54 zat): it is paid
//!   as extra fee instead of stranding the coin. Paying above the conventional fee is accepted.
//!   The reported fee is always `inputs - outputs - pool value`, so the public check balances.

use std::time::{Duration, Instant};

use drop_core::fee::FeePolicy;
use rand_chacha::ChaCha20Rng;
use sapling_crypto::prover::mock::{MockOutputProver, MockSpendProver};
use thiserror::Error;
use zcash_primitives::transaction::{
    builder::{BuildConfig, Builder, BundlePadding},
    fees::{transparent::InputSize, zip317, FeeRule},
    TxId,
};
use zcash_protocol::{
    consensus::{self, BlockHeight, BranchId, Network},
    memo::MemoBytes,
    value::Zatoshis,
};
use zcash_transparent::{
    builder::{SpendInfo, TransparentInputInfo, TransparentSigningSet},
    bundle::{OutPoint, TxOut},
};

use crate::keys::CampaignKeys;

/// ZIP-218 (NU7): at most 330 Ironwood actions per transaction and per block. A batch has one
/// action per payout (two for a single payout), so this is also the payout limit.
pub const MAX_IRONWOOD_ACTIONS_PER_TX: usize = 330;

/// Zebra's dust threshold for a P2PKH output (`zebra-chain/src/transparent.rs::is_dust`):
/// change below this is paid as fee instead of becoming an output.
pub const P2PKH_DUST_THRESHOLD: u64 = 54;

/// A fee rule that asks for exactly one amount: used when a sub-dust remainder is folded into the
/// fee, because `Builder::build` requires `inputs = outputs + fee_rule(shape)` exactly.
struct FixedFee(Zatoshis);

impl FeeRule for FixedFee {
    type Error = std::convert::Infallible;

    fn fee_required<P: consensus::Parameters>(
        &self,
        _: &P,
        _: BlockHeight,
        _: impl IntoIterator<Item = InputSize>,
        _: impl IntoIterator<Item = usize>,
        _: usize,
        _: usize,
        _: usize,
        _: usize,
    ) -> Result<Zatoshis, Self::Error> {
        Ok(self.0)
    }
}

/// A transparent coin the campaign controls.
#[derive(Clone, Debug)]
pub struct FundingCoin {
    pub outpoint: OutPoint,
    pub coin: TxOut,
}

/// One payout. `Debug` is redacted: it would otherwise print the receiver and amount.
#[derive(Clone)]
pub struct PayoutLine {
    pub receiver: orchard::Address,
    pub value: Zatoshis,
    pub memo: MemoBytes,
}

impl std::fmt::Debug for PayoutLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PayoutLine{<redacted>}")
    }
}

#[derive(Clone, Debug)]
pub struct BuiltTx {
    pub txid: TxId,
    pub raw: Vec<u8>,
    /// `inputs - payouts - change`: the conventional ZIP-317 fee, plus any sub-dust remainder.
    pub fee: Zatoshis,
    /// Zero when the transaction has no change output.
    pub change: Zatoshis,
    /// Wall time of signing + Halo2 proving.
    pub build_time: Duration,
}

/// Build failures. Messages carry counts and campaign-side amounts only, never recipient data.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BuildError {
    #[error("a batch needs at least one funding coin")]
    NoInputs,
    #[error("a batch needs at least one payout")]
    NoPayouts,
    #[error("{n} payouts exceed the {max}-action Ironwood limit per transaction (ZIP-218)")]
    TooManyPayouts { n: usize, max: usize },
    #[error("the Ironwood pool is not active at height {height} on this network")]
    IronwoodInactive { height: u32 },
    #[error("a funding coin is not locked to this campaign's funding or change address")]
    ForeignCoin,
    #[error("insufficient funds: have {have} zat, need {need} zat")]
    Insufficient { have: u64, need: u64 },
    #[error("this operation is disabled on mainnet")]
    MainnetDisabled,
    #[error("invalid fee policy")]
    FeePolicy,
    #[error("transaction builder: {0}")]
    Builder(String),
}

/// The ZIP-317 fee rule matching drop-core's `FeePolicy`, so the funding check and the built
/// transaction agree on the fee.
pub fn fee_rule(policy: &FeePolicy) -> Result<zip317::FeeRule, BuildError> {
    let marginal = Zatoshis::from_u64(policy.marginal_fee).map_err(|_| BuildError::FeePolicy)?;
    zip317::FeeRule::non_standard(
        marginal,
        policy.grace_actions as usize,
        zip317::P2PKH_STANDARD_INPUT_SIZE,
        zip317::P2PKH_STANDARD_OUTPUT_SIZE,
    )
    .ok_or(BuildError::FeePolicy)
}

/// Whether payouts at `height` can go to the Ironwood pool (NU6.3 onward).
pub fn ironwood_active(network: &Network, height: BlockHeight) -> bool {
    matches!(
        BranchId::for_height(network, height),
        BranchId::Nu6_3 | BranchId::Nu7
    )
}

/// Builds, signs and proves one batch. `anchor` must be a known Ironwood note-commitment-tree
/// root at or below the tip (output-only bundles have only zero-value dummy spends, whose Merkle
/// paths the circuit does not check, but consensus still checks the anchor).
pub fn build_batch_tx(
    keys: &CampaignKeys,
    target_height: BlockHeight,
    anchor: orchard::Anchor,
    inputs: &[FundingCoin],
    payouts: &[PayoutLine],
    fee_rule: &zip317::FeeRule,
    rng: &mut ChaCha20Rng,
) -> Result<BuiltTx, BuildError> {
    if inputs.is_empty() {
        return Err(BuildError::NoInputs);
    }
    if payouts.is_empty() {
        return Err(BuildError::NoPayouts);
    }
    if payouts.len() > MAX_IRONWOOD_ACTIONS_PER_TX {
        return Err(BuildError::TooManyPayouts {
            n: payouts.len(),
            max: MAX_IRONWOOD_ACTIONS_PER_TX,
        });
    }
    let network = keys.network();
    if !ironwood_active(&network, target_height) {
        return Err(BuildError::IronwoodInactive {
            height: target_height.into(),
        });
    }

    let (signing_set, tx_inputs) = signing_inputs(keys, inputs)?;
    let total_in: u64 = inputs.iter().map(|c| u64::from(c.coin.value())).sum();
    let total_out: u64 = payouts.iter().map(|p| u64::from(p.value)).sum();
    let ovk = Some(keys.payout_ovk());

    let config = BuildConfig::Standard {
        sapling_anchor: None,
        orchard_anchor: None,
        ironwood_anchor: Some(anchor),
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    };
    // `Builder` has no "set change" API: populate once per shape to ask for the fee (it depends
    // only on the shape), then again with the real change, if any.
    let populate = |change: Option<Zatoshis>| -> Result<Builder<Network, ()>, BuildError> {
        let mut b = Builder::new(network, target_height, config.clone());
        for input in &tx_inputs {
            b.add_transparent_input(input.clone());
        }
        for p in payouts {
            b.add_ironwood_output::<zip317::FeeError>(
                ovk.clone(),
                p.receiver,
                p.value,
                p.memo.clone(),
            )
            .map_err(|e| BuildError::Builder(e.to_string()))?;
        }
        if let Some(change) = change {
            b.add_transparent_output(keys.change_taddr(), change)
                .map_err(|e| BuildError::Builder(format!("{e:?}")))?;
        }
        Ok(b)
    };
    let conventional_fee = |with_change: bool| -> Result<u64, BuildError> {
        let placeholder = with_change.then_some(Zatoshis::const_from_u64(P2PKH_DUST_THRESHOLD));
        populate(placeholder)?
            .get_fee(fee_rule)
            .map(u64::from)
            .map_err(|e| BuildError::Builder(e.to_string()))
    };

    let fee_without_change = conventional_fee(false)?;
    let fee_with_change = conventional_fee(true)?;
    let insufficient = BuildError::Insufficient {
        have: total_in,
        need: total_out.saturating_add(fee_without_change),
    };
    let remainder = total_in
        .checked_sub(total_out)
        .ok_or(insufficient.clone())?;
    if remainder < fee_without_change {
        return Err(insufficient);
    }
    let to_zat = |v: u64| Zatoshis::from_u64(v).map_err(|e| BuildError::Builder(format!("{e:?}")));
    let change = remainder
        .checked_sub(fee_with_change)
        .filter(|c| *c >= P2PKH_DUST_THRESHOLD);

    let start = Instant::now();
    let result = match change {
        Some(change) => populate(Some(to_zat(change)?))?
            .build(
                &signing_set,
                &[],
                &[],
                rng,
                &MockSpendProver,
                &MockOutputProver,
                fee_rule,
            )
            .map_err(|e| BuildError::Builder(e.to_string()))?,
        // Exact funding, or a sub-dust sliver: no change output, the remainder is the fee.
        None => populate(None)?
            .build(
                &signing_set,
                &[],
                &[],
                rng,
                &MockSpendProver,
                &MockOutputProver,
                &FixedFee(to_zat(remainder)?),
            )
            .map_err(|e| BuildError::Builder(e.to_string()))?,
    };
    let build_time = start.elapsed();
    let change = change.unwrap_or(0);
    let fee = to_zat(remainder - change)?;
    let change = to_zat(change)?;

    let tx = result.transaction();
    let mut raw = Vec::new();
    tx.write(&mut raw)
        .map_err(|e| BuildError::Builder(e.to_string()))?;
    Ok(BuiltTx {
        txid: tx.txid(),
        raw,
        fee,
        change,
        build_time,
    })
}

/// Signing keys and builder inputs for the campaign's own coins; refuses any other coin.
fn signing_inputs(
    keys: &CampaignKeys,
    inputs: &[FundingCoin],
) -> Result<(TransparentSigningSet, Vec<TransparentInputInfo>), BuildError> {
    let mut signing_set = TransparentSigningSet::new();
    let mut tx_inputs = Vec::with_capacity(inputs.len());
    for c in inputs {
        let sk = keys
            .signing_key_for(c.coin.script_pubkey())
            .ok_or(BuildError::ForeignCoin)?;
        // The signing set keeps its own copy (library-limited); `sk` wipes ours when dropped.
        let pubkey = signing_set.add_key(sk.expose());
        tx_inputs.push(
            TransparentInputInfo::from_parts(
                c.outpoint.clone(),
                c.coin.clone(),
                SpendInfo::P2pkh { pubkey },
            )
            .map_err(|e| BuildError::Builder(format!("{e:?}")))?,
        );
    }
    Ok((signing_set, tx_inputs))
}

/// Reclaims leftover funds: spends every coin in `inputs` (coins at the campaign's funding or
/// change address, e.g. batch change) into ONE transparent output at the campaign's **funding
/// address**, worth `inputs - fee`. Transparent only. The operator watches the funding address
/// for deposits, so swept funds can fund the next batch.
///
/// The destination is fixed to the campaign's own funding address, so this cannot pay anyone
/// else. The fee is `fee_rule`'s conventional fee (1 input + 1 output = 2 logical actions = the
/// grace minimum). A result below Zebra's 54-zat dust threshold is refused. Testnet only for now.
/// In the returned [`BuiltTx`], `change` is the swept amount.
pub fn build_sweep(
    keys: &CampaignKeys,
    target_height: BlockHeight,
    inputs: &[FundingCoin],
    fee_rule: &zip317::FeeRule,
    rng: &mut ChaCha20Rng,
) -> Result<BuiltTx, BuildError> {
    let network = keys.network();
    if network == Network::MainNetwork {
        return Err(BuildError::MainnetDisabled);
    }
    if inputs.is_empty() {
        return Err(BuildError::NoInputs);
    }
    let (signing_set, tx_inputs) = signing_inputs(keys, inputs)?;
    let total_in: u64 = inputs.iter().map(|c| u64::from(c.coin.value())).sum();
    let config = BuildConfig::Standard {
        sapling_anchor: None,
        orchard_anchor: None,
        ironwood_anchor: None,
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    };
    let populate = |value: Zatoshis| -> Result<Builder<Network, ()>, BuildError> {
        let mut b = Builder::new(network, target_height, config.clone());
        for input in &tx_inputs {
            b.add_transparent_input(input.clone());
        }
        b.add_transparent_output(keys.funding_taddr(), value)
            .map_err(|e| BuildError::Builder(format!("{e:?}")))?;
        Ok(b)
    };
    let fee = u64::from(
        populate(Zatoshis::const_from_u64(P2PKH_DUST_THRESHOLD))?
            .get_fee(fee_rule)
            .map_err(|e| BuildError::Builder(e.to_string()))?,
    );
    let swept = total_in
        .checked_sub(fee)
        .filter(|v| *v >= P2PKH_DUST_THRESHOLD)
        .ok_or(BuildError::Insufficient {
            have: total_in,
            need: fee + P2PKH_DUST_THRESHOLD,
        })?;
    let to_zat = |v: u64| Zatoshis::from_u64(v).map_err(|e| BuildError::Builder(format!("{e:?}")));

    let start = Instant::now();
    let result = populate(to_zat(swept)?)?
        .build(
            &signing_set,
            &[],
            &[],
            rng,
            &MockSpendProver,
            &MockOutputProver,
            fee_rule,
        )
        .map_err(|e| BuildError::Builder(e.to_string()))?;
    let build_time = start.elapsed();
    let tx = result.transaction();
    let mut raw = Vec::new();
    tx.write(&mut raw)
        .map_err(|e| BuildError::Builder(e.to_string()))?;
    Ok(BuiltTx {
        txid: tx.txid(),
        raw,
        fee: to_zat(fee)?,
        change: to_zat(swept)?,
        build_time,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::OnceLock;

    use rand_core::SeedableRng;
    use zcash_protocol::consensus::{Network::TestNetwork, NetworkUpgrade, Parameters};

    use super::*;
    use crate::{codec::orchard_receiver, inspect, keys::tests::test_keys, memo::encode_memo};

    /// A testnet height in the NU7 epoch (testnet's current epoch).
    pub(crate) fn nu7_height() -> BlockHeight {
        TestNetwork.activation_height(NetworkUpgrade::Nu7).unwrap() + 100
    }

    pub(crate) fn fake_coin(keys: &CampaignKeys, value: u64) -> FundingCoin {
        FundingCoin {
            outpoint: OutPoint::new([0xfe; 32], 0),
            coin: TxOut::new(Zatoshis::from_u64(value).unwrap(), keys.funding_script()),
        }
    }

    /// Recipients are other accounts of the TEST ONLY seed.
    pub(crate) fn payouts(n: usize) -> Vec<PayoutLine> {
        (0..n)
            .map(|i| PayoutLine {
                receiver: orchard_receiver(
                    TestNetwork,
                    &test_keys(10 + i as u32).unified_address(),
                )
                .unwrap(),
                value: Zatoshis::from_u64(10_000 * (i as u64 + 1) + i as u64).unwrap(),
                memo: encode_memo(Some(&format!("TEST ONLY payout {}", i + 1))).unwrap(),
            })
            .collect()
    }

    /// One proven 3-payout batch shared by the tests (Halo2 proving is slow).
    pub(crate) fn shared_batch() -> &'static (BuiltTx, FundingCoin) {
        static BATCH: OnceLock<(BuiltTx, FundingCoin)> = OnceLock::new();
        BATCH.get_or_init(|| {
            let keys = test_keys(0);
            let coin = fake_coin(&keys, 1_000_000);
            let rule = fee_rule(&FeePolicy::zip317_text()).unwrap();
            let tx = build_batch_tx(
                &keys,
                nu7_height(),
                orchard::Anchor::empty_tree(),
                std::slice::from_ref(&coin),
                &payouts(3),
                &rule,
                &mut ChaCha20Rng::seed_from_u64(7),
            )
            .unwrap();
            (tx, coin)
        })
    }

    // covers: REQ-TX-001
    #[test]
    fn batch_is_transparent_in_ironwood_out_and_balances_publicly() {
        let (tx, coin) = shared_batch();
        let resolve = |op: &OutPoint| (op == &coin.outpoint).then(|| coin.coin.clone());
        let v = inspect::public_totals(&tx.raw, resolve).unwrap();
        assert_eq!(v.tx_version, "V6");
        assert_eq!(v.branch_id, BranchId::Nu7);
        assert_eq!(
            (v.orchard_actions, v.ironwood_actions, v.sapling_io),
            (0, 3, 0)
        );
        assert_eq!(
            v.orchard_value_balance, 0,
            "no value may enter Orchard (ZIP-258)"
        );
        let paid: u64 = payouts(3).iter().map(|p| u64::from(p.value)).sum();
        assert_eq!(v.net_into_ironwood, paid as i64);
        assert_eq!(v.t_out_total, u64::from(tx.change));
        assert!(v.balances());
        assert_eq!(v.fee as u64, u64::from(tx.fee));
        // 1 P2PKH in + 1 P2PKH out = 1 logical action, + 3 Ironwood actions, at 5,000 zat.
        assert_eq!(u64::from(tx.fee), 20_000);
        inspect::verify_proofs_and_signatures(&tx.raw, resolve).unwrap();
    }

    // covers: REQ-TX-002
    #[test]
    fn every_output_is_recoverable_with_the_campaign_ufvk() {
        let (tx, coin) = shared_batch();
        let resolve = |op: &OutPoint| (op == &coin.outpoint).then(|| coin.coin.clone());
        let v = inspect::public_totals(&tx.raw, resolve).unwrap();
        let ufvk = test_keys(0).ufvk_encoded().unwrap();
        let got = inspect::recover_with_ufvk(&tx.raw, TestNetwork, &ufvk).unwrap();
        assert_eq!(got.len(), v.ironwood_actions);
        assert_eq!(
            got.iter().map(|o| o.value).sum::<u64>() as i64,
            v.net_into_ironwood
        );
        assert!(got.iter().all(|o| o
            .memo
            .as_deref()
            .is_some_and(|m| m.starts_with("TEST ONLY payout"))));
    }

    // covers: REQ-TX-001
    #[test]
    fn mainnet_nu6_3_height_builds_the_same_shape_offline() {
        // ADR 0005: testnet is on NU7, mainnet on NU6.3; the builder picks the branch from the
        // height. Offline only: TEST ONLY keys, fabricated coin, never broadcast.
        use zcash_protocol::consensus::Network::MainNetwork;
        let keys =
            CampaignKeys::derive(&crate::keys::tests::TEST_ONLY_SEED, MainNetwork, 0).unwrap();
        let receiver = |i: u32| {
            let k = CampaignKeys::derive(&crate::keys::tests::TEST_ONLY_SEED, MainNetwork, 40 + i)
                .unwrap();
            orchard_receiver(MainNetwork, &k.unified_address()).unwrap()
        };
        let payouts: Vec<PayoutLine> = (0..2)
            .map(|i| PayoutLine {
                receiver: receiver(i),
                value: Zatoshis::const_from_u64(10_000),
                memo: encode_memo(None).unwrap(),
            })
            .collect();
        let coin = fake_coin(&keys, 100_000);
        let height = MainNetwork
            .activation_height(NetworkUpgrade::Nu6_3)
            .unwrap()
            + 100_000;
        let tx = build_batch_tx(
            &keys,
            height,
            orchard::Anchor::empty_tree(),
            std::slice::from_ref(&coin),
            &payouts,
            &fee_rule(&FeePolicy::zip317_text()).unwrap(),
            &mut ChaCha20Rng::seed_from_u64(3),
        )
        .unwrap();
        let v = inspect::public_totals(&tx.raw, |op| {
            (op == &coin.outpoint).then(|| coin.coin.clone())
        })
        .unwrap();
        assert_eq!(
            (v.tx_version.as_str(), v.branch_id),
            ("V6", BranchId::Nu6_3)
        );
        assert_eq!(
            (v.orchard_actions, v.ironwood_actions, v.net_into_ironwood),
            (0, 2, 20_000)
        );
        assert!(v.balances());
    }

    // covers: REQ-TX-002
    #[test]
    fn another_campaigns_ufvk_recovers_nothing() {
        let (tx, _) = shared_batch();
        let other = test_keys(1).ufvk_encoded().unwrap();
        assert!(inspect::recover_with_ufvk(&tx.raw, TestNetwork, &other)
            .unwrap()
            .is_empty());
    }

    // covers: REQ-TX-003
    #[test]
    fn recipients_read_their_zip302_memo() {
        let (tx, _) = shared_batch();
        let ivk = test_keys(11)
            .ufvk()
            .orchard()
            .unwrap()
            .to_ivk(orchard::keys::Scope::External);
        let got = inspect::decrypt_with_ivk(&tx.raw, &ivk).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value, 20_001);
        assert_eq!(got[0].memo.as_deref(), Some("TEST ONLY payout 2"));
    }

    // covers: REQ-TX-001
    #[test]
    fn refusals_happen_before_any_proving() {
        let keys = test_keys(0);
        let rule = fee_rule(&FeePolicy::zip317_text()).unwrap();
        let rng = &mut ChaCha20Rng::seed_from_u64(1);
        let coin = fake_coin(&keys, 1_000_000);
        let anchor = orchard::Anchor::empty_tree();
        let build = |inputs: &[FundingCoin],
                     payouts: &[PayoutLine],
                     h: BlockHeight,
                     rng: &mut ChaCha20Rng| {
            build_batch_tx(&keys, h, anchor, inputs, payouts, &rule, rng)
        };

        let too_many = vec![payouts(1)[0].clone(); MAX_IRONWOOD_ACTIONS_PER_TX + 1];
        assert_eq!(
            build(std::slice::from_ref(&coin), &too_many, nu7_height(), rng).unwrap_err(),
            BuildError::TooManyPayouts { n: 331, max: 330 }
        );
        let pre_ironwood = TestNetwork
            .activation_height(NetworkUpgrade::Nu6_2)
            .unwrap()
            + 1;
        assert_eq!(
            build(std::slice::from_ref(&coin), &payouts(2), pre_ironwood, rng).unwrap_err(),
            BuildError::IronwoodInactive {
                height: pre_ironwood.into()
            }
        );
        let foreign = fake_coin(&test_keys(5), 1_000_000);
        assert_eq!(
            build(&[foreign], &payouts(2), nu7_height(), rng).unwrap_err(),
            BuildError::ForeignCoin
        );
        let poor = fake_coin(&keys, 1_000);
        assert!(matches!(
            build(&[poor], &payouts(2), nu7_height(), rng).unwrap_err(),
            BuildError::Insufficient { have: 1_000, .. }
        ));
        // 2 payouts (10,000 + 20,001) + fee 15,000 = 45,001: one zat short is refused.
        let short = fake_coin(&keys, 45_000);
        assert_eq!(
            build(&[short], &payouts(2), nu7_height(), rng).unwrap_err(),
            BuildError::Insufficient {
                have: 45_000,
                need: 45_001
            }
        );
        assert_eq!(
            build(&[], &payouts(2), nu7_height(), rng).unwrap_err(),
            BuildError::NoInputs
        );
        assert_eq!(
            build(std::slice::from_ref(&coin), &[], nu7_height(), rng).unwrap_err(),
            BuildError::NoPayouts
        );
    }

    /// Builds 2 payouts (10,000 + 20,001 zat; conventional fee 15,000) from one coin of
    /// `payouts + 15,000 + extra` zat and checks the public totals reconcile.
    fn build_with_extra(extra: u64) -> (BuiltTx, inspect::PublicTotals) {
        let keys = test_keys(0);
        let paid: u64 = payouts(2).iter().map(|p| u64::from(p.value)).sum();
        let coin = fake_coin(&keys, paid + 15_000 + extra);
        let tx = build_batch_tx(
            &keys,
            nu7_height(),
            orchard::Anchor::empty_tree(),
            std::slice::from_ref(&coin),
            &payouts(2),
            &fee_rule(&FeePolicy::zip317_text()).unwrap(),
            &mut ChaCha20Rng::seed_from_u64(extra),
        )
        .unwrap();
        let resolve = |op: &OutPoint| (op == &coin.outpoint).then(|| coin.coin.clone());
        let v = inspect::public_totals(&tx.raw, resolve).unwrap();
        assert!(v.balances());
        assert_eq!(v.fee as u64, u64::from(tx.fee), "reported fee = public fee");
        assert_eq!(
            inspect::fee_paid(&tx.raw, resolve).unwrap(),
            Some(u64::from(tx.fee))
        );
        assert_eq!(v.net_into_ironwood as u64, paid);
        assert_eq!(v.t_out_total, u64::from(tx.change));
        (tx, v)
    }

    // covers: REQ-TX-001
    #[test]
    fn exact_funding_builds_without_a_change_output() {
        let (tx, v) = build_with_extra(0);
        assert_eq!(
            (v.t_out_count, u64::from(tx.change), u64::from(tx.fee)),
            (0, 0, 15_000)
        );
        // The engine's funding check asks for exactly this much (1 t-in, 1 t-out, 2 actions).
        let needed = drop_core::fee::standard_funding_required(
            &FeePolicy::zip317_text(),
            drop_core::Zatoshi::new(30_001).unwrap(),
            2,
        )
        .unwrap();
        assert_eq!(needed.as_u64(), 30_001 + 15_000);
        let (tx, coin) = (tx, fake_coin(&test_keys(0), 45_001));
        inspect::verify_proofs_and_signatures(&tx.raw, |op| {
            (op == &coin.outpoint).then(|| coin.coin.clone())
        })
        .unwrap();
    }

    // covers: REQ-TX-001
    #[test]
    fn sub_dust_remainders_are_paid_as_fee_not_stranded() {
        for extra in [1, 53] {
            let (tx, v) = build_with_extra(extra);
            assert_eq!(v.t_out_count, 0, "extra {extra}: no dust output");
            assert_eq!(u64::from(tx.change), 0);
            assert_eq!(
                u64::from(tx.fee),
                15_000 + extra,
                "extra {extra}: folded into the fee"
            );
        }
    }

    // covers: REQ-TX-001
    #[test]
    fn change_of_54_zat_or_more_gets_an_output() {
        let (tx, v) = build_with_extra(P2PKH_DUST_THRESHOLD);
        assert_eq!(v.t_out_count, 1);
        assert_eq!((u64::from(tx.change), u64::from(tx.fee)), (54, 15_000));
    }

    fn change_coin(keys: &CampaignKeys, value: u64, n: u32) -> FundingCoin {
        FundingCoin {
            outpoint: OutPoint::new([0xcc; 32], n),
            coin: TxOut::new(Zatoshis::from_u64(value).unwrap(), keys.change_script()),
        }
    }

    fn sweep(keys: &CampaignKeys, inputs: &[FundingCoin]) -> Result<BuiltTx, BuildError> {
        build_sweep(
            keys,
            nu7_height(),
            inputs,
            &fee_rule(&FeePolicy::zip317_text()).unwrap(),
            &mut ChaCha20Rng::seed_from_u64(9),
        )
    }

    #[test]
    fn sweep_moves_the_change_back_to_the_funding_address_minus_the_fee() {
        let keys = test_keys(0);
        let coin = change_coin(&keys, 12_420_000, 0);
        let tx = sweep(&keys, std::slice::from_ref(&coin)).unwrap();
        // 1 P2PKH input + 1 P2PKH output = 1 logical action, raised to the 2-action grace minimum.
        assert_eq!(
            (u64::from(tx.fee), u64::from(tx.change)),
            (10_000, 12_410_000)
        );

        let resolve = |op: &OutPoint| (op == &coin.outpoint).then(|| coin.coin.clone());
        let v = inspect::public_totals(&tx.raw, resolve).unwrap();
        assert_eq!((v.tx_version.as_str(), v.branch_id), ("V6", BranchId::Nu7));
        assert_eq!(
            (v.t_in_total, v.t_out_total, v.fee),
            (12_420_000, 12_410_000, 10_000)
        );
        assert_eq!(
            (v.net_into_shielded, v.ironwood_actions, v.orchard_actions),
            (0, 0, 0)
        );
        assert!(v.balances());
        inspect::verify_proofs_and_signatures(&tx.raw, resolve).unwrap();

        let parsed = inspect::parse(&tx.raw).unwrap();
        let outputs = &parsed.transparent_bundle().unwrap().vout;
        assert_eq!(outputs.len(), 1);
        assert_eq!(
            *outputs[0].script_pubkey(),
            keys.funding_script(),
            "to the funding address only"
        );
    }

    #[test]
    fn sweep_spends_every_input_and_the_fee_grows_with_them() {
        let keys = test_keys(0);
        let inputs = [
            change_coin(&keys, 100_000, 0),
            change_coin(&keys, 200_000, 1),
            fake_coin(&keys, 300_000), // a funding-address coin is ours too
        ];
        let tx = sweep(&keys, &inputs).unwrap();
        // 3 P2PKH inputs = 3 logical actions.
        assert_eq!((u64::from(tx.fee), u64::from(tx.change)), (15_000, 585_000));
        let parsed = inspect::parse(&tx.raw).unwrap();
        assert_eq!(parsed.transparent_bundle().unwrap().vin.len(), 3);
    }

    #[test]
    fn sweep_refuses_dust_foreign_coins_and_mainnet() {
        let keys = test_keys(0);
        assert_eq!(
            sweep(&keys, &[change_coin(&keys, 10_053, 0)]).unwrap_err(),
            BuildError::Insufficient {
                have: 10_053,
                need: 10_054
            }
        );
        let tx = sweep(&keys, &[change_coin(&keys, 10_054, 0)]).unwrap();
        assert_eq!(
            u64::from(tx.change),
            54,
            "exactly the dust threshold is allowed"
        );
        assert_eq!(
            sweep(&keys, &[change_coin(&test_keys(1), 50_000, 0)]).unwrap_err(),
            BuildError::ForeignCoin
        );
        assert_eq!(sweep(&keys, &[]).unwrap_err(), BuildError::NoInputs);

        use zcash_protocol::consensus::Network::MainNetwork;
        let mainnet =
            CampaignKeys::derive(&crate::keys::tests::TEST_ONLY_SEED, MainNetwork, 0).unwrap();
        let coin = change_coin(&mainnet, 50_000, 0);
        assert_eq!(
            build_sweep(
                &mainnet,
                MainNetwork
                    .activation_height(NetworkUpgrade::Nu6_3)
                    .unwrap()
                    + 1,
                &[coin],
                &fee_rule(&FeePolicy::zip317_text()).unwrap(),
                &mut ChaCha20Rng::seed_from_u64(1),
            )
            .unwrap_err(),
            BuildError::MainnetDisabled
        );
    }

    #[test]
    fn fee_rule_follows_the_core_fee_policy() {
        for (policy, expected) in [
            (FeePolicy::zip317_text(), 20_000u64),
            (FeePolicy::zebra_main(), 4_000),
        ] {
            let rule = fee_rule(&policy).unwrap();
            let fee = zcash_primitives::transaction::fees::FeeRule::fee_required(
                &rule,
                &TestNetwork,
                nu7_height(),
                [zcash_primitives::transaction::fees::transparent::InputSize::Known(150)],
                [34usize],
                0,
                0,
                0,
                3,
            )
            .unwrap();
            assert_eq!(u64::from(fee), expected);
            let core_fee = drop_core::fee::standard_batch_fee(&policy, 3).unwrap();
            assert_eq!(core_fee.as_u64(), expected, "core and adapter agree");
        }
    }

    #[test]
    fn payout_debug_is_redacted() {
        assert_eq!(format!("{:?}", payouts(1)[0]), "PayoutLine{<redacted>}");
    }
}
