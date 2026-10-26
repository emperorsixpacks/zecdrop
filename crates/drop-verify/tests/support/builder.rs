//! TEST-ONLY transaction generator for fixtures.
//!
//! Every key here is a throwaway derived from a fixed public byte pattern; nothing
//! is ever funded or broadcast. The generator builds real librustzcash
//! transactions (real Halo2 proofs, real signatures), so the verifier is exercised
//! on genuinely well-formed bytes. It lives in dev code only and uses no
//! `zcash_keys`: addresses come straight from the `orchard` and `secp256k1` crates.

#![allow(dead_code)]

use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use sapling_crypto::prover::mock::{MockOutputProver, MockSpendProver};
use zcash_primitives::transaction::{
    builder::{BuildConfig, Builder, BundlePadding},
    fees::zip317,
    Authorized, TransactionData, TxVersion,
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, NetworkUpgrade, Parameters, TestNetwork, TEST_NETWORK},
    memo::MemoBytes,
    value::{Zatoshis, COIN},
};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    builder::{SpendInfo, TransparentInputInfo, TransparentSigningSet},
    bundle::{self as tbundle, OutPoint, TxIn, TxOut},
};

/// Which pool the payouts go to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayPool {
    Orchard,
    Ironwood,
}

/// A testnet height in the NU6.2 epoch (Orchard still accepts third-party outputs).
pub fn nu6_2_height() -> BlockHeight {
    TEST_NETWORK
        .activation_height(NetworkUpgrade::Nu6_2)
        .unwrap()
        + 1_000
}

/// A testnet height in the NU6.3 ("Ironwood") epoch.
pub fn nu6_3_height() -> BlockHeight {
    TEST_NETWORK
        .activation_height(NetworkUpgrade::Nu6_3)
        .unwrap()
        + 1_000
}

/// Value left over for the change output in every fabricated funding coin.
const CHANGE_CUSHION: u64 = COIN;

/// A built batch with the transaction it spends.
pub struct Generated {
    pub batch_raw: Vec<u8>,
    pub batch_txid_display: String,
    pub funding_raw: Vec<u8>,
    pub funding_txid_display: String,
    pub payout_total: u64,
    pub fee: u64,
    pub change: u64,
    pub height: u32,
}

fn payout_value(i: usize) -> u64 {
    1_000_000 * (i as u64 + 1) + i as u64
}

/// Builds a funding transaction and a batch of `n` shielded payouts spending it,
/// paying the standard ZIP-317 fee (5000 zatoshi per logical action).
pub fn generate(pool: PayPool, height: BlockHeight, n: usize, rng_seed: u64) -> Generated {
    generate_with_fee_rate(pool, height, n, rng_seed, 5_000)
}

/// As [`generate`], but with the given marginal fee per logical action (Zebra's
/// mempool minimum is 1000; the ZIP text says 5000).
pub fn generate_with_fee_rate(
    pool: PayPool,
    height: BlockHeight,
    n: usize,
    rng_seed: u64,
    marginal_fee: u64,
) -> Generated {
    generate_full(pool, height, n, rng_seed, marginal_fee, [0x11; 32])
}

/// As [`generate`], but funded from the transparent key `funding_key` (TEST ONLY), so the
/// batch spends from a different address than the other fixtures.
pub fn generate_with_funding_key(
    pool: PayPool,
    height: BlockHeight,
    n: usize,
    rng_seed: u64,
    funding_key: [u8; 32],
) -> Generated {
    generate_full(pool, height, n, rng_seed, 5_000, funding_key)
}

fn generate_full(
    pool: PayPool,
    height: BlockHeight,
    n: usize,
    rng_seed: u64,
    marginal_fee: u64,
    funding_key: [u8; 32],
) -> Generated {
    // Transparent keys: one funds the batch, another receives the change.
    let funding_sk = secp256k1::SecretKey::from_secret_bytes(funding_key).unwrap();
    let change_sk = secp256k1::SecretKey::from_secret_bytes([0x22; 32]).unwrap();
    #[allow(deprecated)]
    let funding_addr =
        TransparentAddress::from_pubkey(&secp256k1::PublicKey::from_secret_key(&funding_sk));
    #[allow(deprecated)]
    let change_addr =
        TransparentAddress::from_pubkey(&secp256k1::PublicKey::from_secret_key(&change_sk));

    // Payout recipients and the campaign OVK, all from fixed throwaway seeds.
    let sender_fvk = FullViewingKey::from(&SpendingKey::from_bytes([0x33; 32]).unwrap());
    let ovk = sender_fvk.to_ovk(Scope::External);
    let payouts: Vec<(orchard::Address, u64)> = (0..n)
        .map(|i| {
            let sk = SpendingKey::from_bytes([0x40 + i as u8; 32]).unwrap();
            let fvk = FullViewingKey::from(&sk);
            (fvk.address_at(0u32, Scope::External), payout_value(i))
        })
        .collect();
    let payout_total: u64 = payouts.iter().map(|(_, v)| *v).sum();

    // The funding transaction: one dummy input, one output holding payouts + cushion.
    let funding_value = Zatoshis::from_u64(payout_total + CHANGE_CUSHION).unwrap();
    let funding_coin = TxOut::new(funding_value, funding_addr.script().into());
    let funding_bundle = tbundle::Bundle {
        vin: vec![TxIn::from_parts(
            OutPoint::new([0xaa; 32], 0),
            Script::default(),
            0xffff_ffff,
        )],
        vout: vec![funding_coin.clone()],
        authorization: tbundle::Authorized,
    };
    let funding_tx = TransactionData::<Authorized>::from_parts(
        TxVersion::V5,
        BranchId::Nu6_2,
        0,
        BlockHeight::from_u32(0),
        Some(funding_bundle),
        None,
        None,
        None,
    )
    .freeze()
    .unwrap();
    let mut funding_raw = Vec::new();
    funding_tx.write(&mut funding_raw).unwrap();
    let funding_outpoint = OutPoint::new(*funding_tx.txid().as_ref(), 0);

    // The batch: that coin -> n shielded payouts + transparent change.
    let fee_rule = if marginal_fee == 5_000 {
        zip317::FeeRule::standard()
    } else {
        zip317::FeeRule::non_standard(Zatoshis::from_u64(marginal_fee).unwrap(), 2, 150, 34)
            .unwrap()
    };
    let mut signing_set = TransparentSigningSet::new();
    let pubkey = signing_set.add_key(funding_sk);
    let config = BuildConfig::Standard {
        sapling_anchor: None,
        orchard_anchor: (pool == PayPool::Orchard).then(orchard::Anchor::empty_tree),
        ironwood_anchor: (pool == PayPool::Ironwood).then(orchard::Anchor::empty_tree),
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    };
    let populate = |change: Zatoshis| -> Builder<TestNetwork, ()> {
        let mut b = Builder::new(TEST_NETWORK, height, config.clone());
        let input = TransparentInputInfo::from_parts(
            funding_outpoint.clone(),
            funding_coin.clone(),
            SpendInfo::P2pkh { pubkey },
        )
        .unwrap();
        b.add_transparent_input(input);
        for (address, value) in &payouts {
            let value = Zatoshis::from_u64(*value).unwrap();
            match pool {
                PayPool::Orchard => b.add_orchard_output::<zip317::FeeError>(
                    Some(ovk.clone()),
                    *address,
                    value,
                    MemoBytes::empty(),
                ),
                PayPool::Ironwood => b.add_ironwood_output::<zip317::FeeError>(
                    Some(ovk.clone()),
                    *address,
                    value,
                    MemoBytes::empty(),
                ),
            }
            .unwrap();
        }
        b.add_transparent_output(&change_addr, change).unwrap();
        b
    };
    let placeholder = Zatoshis::from_u64(CHANGE_CUSHION).unwrap();
    let fee = populate(placeholder).get_fee(&fee_rule).unwrap();
    let change = Zatoshis::from_u64(CHANGE_CUSHION - u64::from(fee)).unwrap();
    let mut rng = ChaCha20Rng::seed_from_u64(rng_seed);
    let built = populate(change)
        .build(
            &signing_set,
            &[],
            &[],
            &mut rng,
            &MockSpendProver,
            &MockOutputProver,
            &fee_rule,
        )
        .unwrap();
    let tx = built.transaction();
    let mut batch_raw = Vec::new();
    tx.write(&mut batch_raw).unwrap();

    Generated {
        batch_raw,
        batch_txid_display: tx.txid().to_string(),
        funding_raw,
        funding_txid_display: funding_tx.txid().to_string(),
        payout_total,
        fee: u64::from(fee),
        change: u64::from(change),
        height: u32::from(height),
    }
}
