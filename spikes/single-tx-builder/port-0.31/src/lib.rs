//! # SPIKE: one transaction = transparent input(s) -> N shielded payouts (+ transparent change)
//!
//! **PORT** of `../../src/lib.rs` to the NU7-aware 0.31 pre-release train; see `../Cargo.toml`.
//!
//! **Every key in this crate is a TEST-ONLY throwaway derived from a public, hard-coded seed.**
//! Nothing here talks to the network: the funding UTXO is fabricated and the transactions are
//! never broadcast.
//!
//! The pieces map onto the spike's tasks:
//! - [`Campaign`] / [`Recipient`]: TEST-ONLY testnet keys (task 2).
//! - [`build_batch`]: the payout tx, built with `zcash_primitives`' low-level `Builder` (task 2).
//! - [`public_view`]: what a key-less verifier recomputes from tx bytes + resolved prevouts (task 3).
//! - [`verify_authorization`]: Halo2 proof, RedPallas and ECDSA checks, so we know the tx we
//!   measure is actually well-formed (sanity for task 2).
//! - [`decrypt_as_recipient`] / [`recover_as_auditor`]: IVK and UFVK->OVK decryption (task 4).
//!
//! ## The NU6.3 / Ironwood twist (see RESULTS.md)
//! From NU6.3 ("Ironwood") onward, consensus requires `enableCrossAddress = 0` for Orchard-pool
//! bundles, so the Orchard pool can no longer receive third-party payments; new shielded
//! payments go to the Ironwood pool, which shares the Orchard receiver and address format.
//! [`Pool`] lets every function run against either pool so both behaviours can be shown.

pub mod devseed;
pub mod lwd;

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use orchard::{
    bundle::{Authorized as OrchardAuthorized, BatchValidator},
    circuit::{OrchardCircuitVersion, VerifyingKey},
    keys::{FullViewingKey, IncomingViewingKey, OutgoingViewingKey, Scope, SpendingKey},
};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use sapling_crypto::prover::mock::{MockOutputProver, MockSpendProver};
use zcash_keys::{
    address::{Address, UnifiedAddress},
    keys::{UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_primitives::transaction::{
    builder::{cached_orchard_proving_key, BuildConfig, Builder, BundlePadding},
    components::orchard::bundle_version_for_branch,
    fees::zip317,
    sighash::{signature_hash, SignableInput},
    txid::TxIdDigester,
    Authorization, Transaction, TransactionData, TxId,
};
use zcash_protocol::{
    consensus::{
        BlockHeight, BranchId, NetworkConstants, NetworkUpgrade, Parameters, TestNetwork,
        TEST_NETWORK,
    },
    memo::{Memo, MemoBytes},
    value::{BalanceError, ZatBalance, Zatoshis, COIN},
};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    builder::{SpendInfo, TransparentInputInfo, TransparentSigningSet},
    bundle::{self as tbundle, OutPoint, TxIn, TxOut},
    keys::{IncomingViewingKey as _, NonHardenedChildIndex},
    sighash::{
        SighashType, SignableInput as TransparentSignableInput, TransparentAuthorizingContext,
    },
};
use zip32::AccountId;

/// TEST ONLY. Public, hard-coded seed for the campaign (sender) account. Never fund it.
pub const TEST_ONLY_CAMPAIGN_SEED: [u8; 32] = *b"TEST-ONLY zecdrop campaign seed!";

/// TEST ONLY. Prefix for per-recipient throwaway seeds; the last 4 bytes are the index (LE).
const TEST_ONLY_RECIPIENT_SEED_PREFIX: &[u8; 28] = b"TEST-ONLY zecdrop recipient ";

/// Value left over for transparent change in every fabricated funding UTXO.
const CHANGE_CUSHION: u64 = COIN;

/// The believed standard-tx relay limit (zcashd `MAX_STANDARD_TX_SIZE`); see RESULTS.md for
/// what Zebra actually enforces.
pub const STANDARD_TX_SIZE_LIMIT: usize = 100_000;

/// The value pool receiving the payouts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pool {
    Orchard,
    Ironwood,
}

/// A testnet height inside the NU6.2 epoch (Orchard still accepts third-party outputs).
pub fn testnet_nu6_2_height() -> BlockHeight {
    TEST_NETWORK
        .activation_height(NetworkUpgrade::Nu6_2)
        .unwrap()
        + 1_000
}

/// A testnet height inside the NU6.3 ("Ironwood") epoch -- the current epoch per the crates.
pub fn testnet_nu6_3_height() -> BlockHeight {
    TEST_NETWORK
        .activation_height(NetworkUpgrade::Nu6_3)
        .unwrap()
        + 1_000
}

/// A campaign (sender) account on TESTNET: one ZIP 32 account per campaign.
pub struct Campaign {
    pub usk: UnifiedSpendingKey,
    pub ufvk: UnifiedFullViewingKey,
    /// External (receiving) P2PKH address holding the campaign's funds.
    pub funding_addr: TransparentAddress,
    funding_index: NonHardenedChildIndex,
    /// Internal (change) P2PKH address.
    pub change_addr: TransparentAddress,
    change_index: NonHardenedChildIndex,
}

impl Campaign {
    /// TEST ONLY: account 0 of the public hard-coded seed.
    pub fn test_only() -> Self {
        Self::from_seed(&TEST_ONLY_CAMPAIGN_SEED, AccountId::ZERO)
    }

    /// The campaign account `account` of `seed`, always with testnet parameters.
    pub fn from_seed(seed: &[u8], account: AccountId) -> Self {
        let usk = UnifiedSpendingKey::from_seed(&TEST_NETWORK, seed, account)
            .expect("seed derives a USK");
        let ufvk = usk.to_unified_full_viewing_key();
        let tpk = ufvk.p2pkh().expect("transparent-inputs is enabled");
        let (funding_addr, funding_index) = tpk.derive_external_ivk().unwrap().default_address();
        let (change_addr, change_index) = tpk.derive_internal_ivk().unwrap().default_address();
        Campaign {
            usk,
            ufvk,
            funding_addr,
            funding_index,
            change_addr,
            change_index,
        }
    }

    /// The campaign's Unified Address (Orchard receiver only), e.g. for shielded receipts.
    pub fn unified_address(&self) -> String {
        let (ua, _) = self
            .ufvk
            .default_address(zcash_keys::keys::UnifiedAddressRequest::ORCHARD)
            .expect("an Orchard-only UA is always derivable");
        ua.encode(&TEST_NETWORK)
    }

    /// The secp256k1 key controlling a coin locked to `script_pubkey`, if it is one of ours.
    fn signing_key_for(&self, script_pubkey: &Script) -> Result<secp256k1::SecretKey, String> {
        let tsk = self.usk.transparent();
        let key = if *script_pubkey == Script::from(self.funding_addr.script()) {
            tsk.derive_external_secret_key(self.funding_index)
        } else if *script_pubkey == Script::from(self.change_addr.script()) {
            tsk.derive_internal_secret_key(self.change_index)
        } else {
            return Err("coin is not locked to the campaign's funding or change address".into());
        };
        key.map_err(|e| format!("{e:?}"))
    }

    /// The campaign-scoped UFVK as handed to an auditor (`uviewtest1...`).
    pub fn ufvk_encoded(&self) -> String {
        self.ufvk.encode(&TEST_NETWORK).expect("UFVK encodes")
    }

    /// The OVK attached to every payout: the UFVK's Orchard external-scope OVK, which an auditor
    /// holding the UFVK can derive. (Ironwood uses the same Orchard key tree.)
    pub fn payout_ovk(&self) -> OutgoingViewingKey {
        self.ufvk
            .orchard()
            .expect("orchard is enabled")
            .to_ovk(Scope::External)
    }
}

/// A payout recipient with its own TEST-ONLY seed. Only `unified_address` would be known to the
/// campaign in practice; the keys are kept so the tests can play the recipient.
pub struct Recipient {
    pub fvk: FullViewingKey,
    pub unified_address: String,
}

impl Recipient {
    pub fn test_only(index: u32) -> Self {
        let mut seed = [0u8; 32];
        seed[..28].copy_from_slice(TEST_ONLY_RECIPIENT_SEED_PREFIX);
        seed[28..].copy_from_slice(&index.to_le_bytes());
        Self::from_seed(&seed, AccountId::ZERO)
    }

    /// The recipient holding ZIP 32 account `account` of `seed` (testnet).
    pub fn from_seed(seed: &[u8], account: AccountId) -> Self {
        let sk = SpendingKey::from_zip32_seed(seed, TEST_NETWORK.coin_type(), account)
            .expect("seed derives an Orchard key");
        let fvk = FullViewingKey::from(&sk);
        let ua = UnifiedAddress::from_receivers(
            Some(fvk.address_at(0u32, Scope::External)),
            None,
            None,
            None,
            None,
        )
        .expect("an Orchard receiver makes a valid UA");
        Recipient {
            fvk,
            unified_address: ua.encode(&TEST_NETWORK),
        }
    }

    pub fn ivk(&self) -> IncomingViewingKey {
        self.fvk.to_ivk(Scope::External)
    }
}

/// Parses a payout UA the way the operator would from a CSV row, keeping the Orchard receiver.
/// Ironwood has no receiver type of its own: it pays to the Orchard receiver.
pub fn orchard_receiver(ua: &str) -> Result<orchard::Address, String> {
    match Address::decode(&TEST_NETWORK, ua) {
        Some(Address::Unified(ua)) => ua
            .orchard()
            .copied()
            .ok_or_else(|| "UA has no Orchard receiver".into()),
        _ => Err(format!("not a testnet unified address: {ua}")),
    }
}

/// One planned payout.
pub struct Payout {
    pub address: orchard::Address,
    pub value: Zatoshis,
    pub memo: MemoBytes,
}

/// Distinct, deterministic payout amounts: 0.01 ZEC * (i + 1) + i zatoshis.
pub fn payout_value(i: usize) -> Zatoshis {
    Zatoshis::from_u64(1_000_000 * (i as u64 + 1) + i as u64).unwrap()
}

pub fn payout_memo(i: usize, n: usize) -> MemoBytes {
    let text = format!(
        "ZecDrop TEST-ONLY campaign #0001 | payout {} of {n} | not real funds",
        i + 1
    );
    MemoBytes::from(&text.parse::<Memo>().unwrap())
}

/// Whether payouts carry the campaign OVK (auditable) or none (sender cannot recover them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OvkPolicy {
    Campaign,
    None,
}

pub struct BatchSpec {
    pub pool: Pool,
    pub target_height: BlockHeight,
    pub n: usize,
    pub ovk: OvkPolicy,
    pub rng_seed: u64,
}

pub struct BuiltBatch {
    pub tx_bytes: Vec<u8>,
    pub txid: TxId,
    /// The fabricated funding coin; on chain the verifier would resolve this prevout itself.
    pub funding_outpoint: OutPoint,
    pub funding_coin: TxOut,
    pub recipients: Vec<Recipient>,
    pub payout_values: Vec<Zatoshis>,
    pub change: Zatoshis,
    pub fee: Zatoshis,
    /// Wall time of `Builder::build` (signing + Halo2 proving), proving key already cached.
    pub build_time: Duration,
}

impl BuiltBatch {
    pub fn resolver(&self) -> impl Fn(&OutPoint) -> Option<TxOut> + '_ {
        move |op| (op == &self.funding_outpoint).then(|| self.funding_coin.clone())
    }
}

fn build_config(pool: Pool, anchor: orchard::Anchor) -> BuildConfig {
    BuildConfig::Standard {
        sapling_anchor: None,
        orchard_anchor: (pool == Pool::Orchard).then_some(anchor),
        ironwood_anchor: (pool == Pool::Ironwood).then_some(anchor),
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    }
}

/// Zebra's dust threshold for a P2PKH output (`zebra-chain/src/transparent.rs::is_dust`:
/// `3 * (100 * (34 + 148) / 1000)`). A smaller change output would be rejected by the mempool.
pub const P2PKH_DUST_THRESHOLD: u64 = 54;

/// A transparent coin owned by the campaign: resolved from the chain, or fabricated offline.
#[derive(Clone, Debug)]
pub struct FundingCoin {
    pub outpoint: OutPoint,
    pub coin: TxOut,
}

/// Everything `build_payout_tx` needs besides keys.
pub struct TxPlan<'a> {
    pub pool: Pool,
    pub target_height: BlockHeight,
    /// A note-commitment-tree root of `pool` at a past height. Output-only bundles contain only
    /// zero-value dummy spends, whose Merkle paths the circuit does not check, but consensus
    /// still requires the anchor to be a known root.
    pub anchor: orchard::Anchor,
    pub inputs: &'a [FundingCoin],
    pub payouts: &'a [Payout],
    pub ovk: Option<OutgoingViewingKey>,
}

pub struct PayoutTx {
    pub tx_bytes: Vec<u8>,
    pub txid: TxId,
    pub fee: Zatoshis,
    pub change: Zatoshis,
    /// Wall time of `Builder::build` (signing + Halo2 proving).
    pub build_time: Duration,
}

/// Builds, signs and proves ONE transaction: the campaign's transparent coins -> one shielded
/// output per payout in `plan.pool` + one transparent change output to the campaign's change
/// address. The fee is the builder's ZIP 317 conventional fee.
pub fn build_payout_tx(
    campaign: &Campaign,
    plan: &TxPlan<'_>,
    rng: &mut ChaCha20Rng,
) -> Result<PayoutTx, String> {
    if plan.inputs.is_empty() {
        return Err("no funding coins".into());
    }
    let fee_rule = zip317::FeeRule::standard();

    let mut signing_set = TransparentSigningSet::new();
    let mut inputs = Vec::with_capacity(plan.inputs.len());
    for c in plan.inputs {
        let pubkey = signing_set.add_key(campaign.signing_key_for(c.coin.script_pubkey())?);
        inputs.push(
            TransparentInputInfo::from_parts(
                c.outpoint.clone(),
                c.coin.clone(),
                SpendInfo::P2pkh { pubkey },
            )
            .map_err(|e| format!("{e:?}"))?,
        );
    }
    let total_in: u64 = plan.inputs.iter().map(|c| u64::from(c.coin.value())).sum();
    let total_out: u64 = plan.payouts.iter().map(|p| u64::from(p.value)).sum();

    // The builder has no "set change" API, so populate it twice: once to ask it for the ZIP 317
    // fee (which depends only on the tx shape), then for real with change = in - out - fee.
    let populate = |change: Zatoshis| -> Result<Builder<TestNetwork, ()>, String> {
        let mut b = Builder::new(
            TEST_NETWORK,
            plan.target_height,
            build_config(plan.pool, plan.anchor),
        );
        for input in &inputs {
            b.add_transparent_input(input.clone());
        }
        for p in plan.payouts {
            match plan.pool {
                Pool::Orchard => b.add_orchard_output::<zip317::FeeError>(
                    plan.ovk.clone(),
                    p.address,
                    p.value,
                    p.memo.clone(),
                ),
                Pool::Ironwood => b.add_ironwood_output::<zip317::FeeError>(
                    plan.ovk.clone(),
                    p.address,
                    p.value,
                    p.memo.clone(),
                ),
            }
            .map_err(|e| e.to_string())?;
        }
        b.add_transparent_output(&campaign.change_addr, change)
            .map_err(|e| format!("{e:?}"))?;
        Ok(b)
    };

    let fee = populate(Zatoshis::const_from_u64(P2PKH_DUST_THRESHOLD))?
        .get_fee(&fee_rule)
        .map_err(|e| e.to_string())?;
    let change = total_in
        .checked_sub(total_out + u64::from(fee))
        .ok_or_else(|| {
            format!(
                "insufficient funds: have {total_in} zat, need {} zat",
                total_out + u64::from(fee)
            )
        })?;
    if change < P2PKH_DUST_THRESHOLD {
        return Err(format!(
            "change of {change} zat would be dust (< {P2PKH_DUST_THRESHOLD}); adjust the payouts"
        ));
    }
    let change = Zatoshis::from_u64(change).map_err(|e| format!("{e:?}"))?;
    let builder = populate(change)?;

    let start = Instant::now();
    let result = builder
        .build(
            &signing_set,
            &[],
            &[],
            rng,
            &MockSpendProver,
            &MockOutputProver,
            &fee_rule,
        )
        .map_err(|e| e.to_string())?;
    let build_time = start.elapsed();

    let tx = result.transaction();
    let mut tx_bytes = Vec::new();
    tx.write(&mut tx_bytes).map_err(|e| e.to_string())?;
    Ok(PayoutTx {
        tx_bytes,
        txid: tx.txid(),
        fee,
        change,
        build_time,
    })
}

/// Builds the Orchard proving key for the circuit used at `height` (cached process-wide by
/// `zcash_primitives`), returning how long that took so it can be excluded from per-tx timings.
pub fn warm_proving_key(height: BlockHeight) -> Duration {
    let start = Instant::now();
    cached_orchard_proving_key(circuit_version_at(height));
    start.elapsed()
}

fn circuit_version_at(height: BlockHeight) -> OrchardCircuitVersion {
    let branch = BranchId::for_height(&TEST_NETWORK, height);
    bundle_version_for_branch(branch, orchard::ValuePool::Orchard)
        .expect("NU5+ height")
        .circuit_version()
}

/// Offline spike batch: a fabricated P2PKH coin at the campaign's funding address -> `spec.n`
/// shielded payouts to TEST-ONLY recipients in `spec.pool` + one transparent change output.
pub fn build_batch(campaign: &Campaign, spec: &BatchSpec) -> Result<BuiltBatch, String> {
    let recipients: Vec<Recipient> = (0..spec.n as u32).map(Recipient::test_only).collect();
    let mut payouts = Vec::with_capacity(spec.n);
    for (i, r) in recipients.iter().enumerate() {
        payouts.push(Payout {
            address: orchard_receiver(&r.unified_address)?,
            value: payout_value(i),
            memo: payout_memo(i, spec.n),
        });
    }
    let payouts_total: u64 = payouts.iter().map(|p| u64::from(p.value)).sum();

    // Fabricated funding coin (TEST ONLY; this outpoint does not exist on any chain).
    let funding = FundingCoin {
        outpoint: OutPoint::new([0xfe; 32], spec.n as u32),
        coin: TxOut::new(
            Zatoshis::from_u64(payouts_total + CHANGE_CUSHION).unwrap(),
            campaign.funding_addr.script().into(),
        ),
    };
    let ovk = match spec.ovk {
        OvkPolicy::Campaign => Some(campaign.payout_ovk()),
        OvkPolicy::None => None,
    };
    let plan = TxPlan {
        pool: spec.pool,
        target_height: spec.target_height,
        anchor: orchard::Anchor::empty_tree(),
        inputs: std::slice::from_ref(&funding),
        payouts: &payouts,
        ovk,
    };
    let tx = build_payout_tx(
        campaign,
        &plan,
        &mut ChaCha20Rng::seed_from_u64(spec.rng_seed),
    )?;

    Ok(BuiltBatch {
        tx_bytes: tx.tx_bytes,
        txid: tx.txid,
        funding_outpoint: funding.outpoint,
        funding_coin: funding.coin,
        recipients,
        payout_values: payouts.iter().map(|p| p.value).collect(),
        change: tx.change,
        fee: tx.fee,
        build_time: tx.build_time,
    })
}

// ---------------------------------------------------------------------------------------------
// Task 3: public-side recomputation (no keys)
// ---------------------------------------------------------------------------------------------

/// Everything a key-less verifier can compute from the serialized tx plus prevouts it resolved
/// from the chain. Values are zatoshis.
#[derive(Debug)]
pub struct PublicView {
    pub size: usize,
    pub tx_version: String,
    pub branch_id: BranchId,
    pub t_in_count: usize,
    pub t_in_total: u64,
    pub t_out_count: usize,
    pub t_out_total: u64,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    /// `valueBalanceOrchard` as encoded; negative means value entering the Orchard pool, which
    /// ZIP-258 forbids from NU6.3 (Zebra: `check::orchard_value_balance_non_negative`).
    pub orchard_value_balance: i64,
    /// `valueBalanceIronwood` as encoded; for a ZecDrop batch, `-ironwood_value_balance` is the
    /// public amount paid into the Ironwood pool.
    pub ironwood_value_balance: i64,
    /// Sum of Sapling, Orchard and Ironwood valueBalance (positive = value leaving the pools).
    pub shielded_value_balance: i64,
    /// `-shielded_value_balance`: the public amount that entered the shielded pool(s).
    pub net_into_shielded: i64,
    /// `t_in - t_out - net_into_shielded`.
    pub fee_implied: i64,
    /// `Transaction::fee_paid` from librustzcash, as a cross-check.
    pub fee_paid_lib: Option<u64>,
    /// ZIP 317 logical actions recomputed from public structure only.
    pub zip317_logical_actions: usize,
    pub zip317_conventional_fee: u64,
}

impl PublicView {
    /// The verifier's balance equation: `t_in = t_out + net_into_shielded + fee`.
    pub fn balances(&self) -> bool {
        self.t_in_total as i128
            == self.t_out_total as i128 + self.net_into_shielded as i128 + self.fee_implied as i128
            && self.fee_implied >= 0
    }
}

fn parse(tx_bytes: &[u8]) -> Result<Transaction, String> {
    // For v5/v6 the consensus branch id is read from the tx header; the argument only matters
    // for pre-v5 formats.
    Transaction::read(tx_bytes, BranchId::Nu6_3).map_err(|e| e.to_string())
}

fn serialized_len(write: impl FnOnce(&mut Vec<u8>) -> std::io::Result<()>) -> usize {
    let mut buf = Vec::new();
    write(&mut buf).expect("writing to a Vec cannot fail");
    buf.len()
}

pub fn public_view(
    tx_bytes: &[u8],
    resolve: impl Fn(&OutPoint) -> Option<TxOut>,
) -> Result<PublicView, String> {
    let tx = parse(tx_bytes)?;

    let (mut t_in_total, mut t_out_total, mut t_in_size, mut t_out_size) =
        (0u64, 0u64, 0usize, 0usize);
    let (mut t_in_count, mut t_out_count) = (0, 0);
    if let Some(t) = tx.transparent_bundle() {
        t_in_count = t.vin.len();
        t_out_count = t.vout.len();
        for txin in &t.vin {
            let coin = resolve(txin.prevout()).ok_or("unresolvable prevout")?;
            t_in_total += u64::from(coin.value());
            t_in_size += serialized_len(|w| txin.write(w));
        }
        for txout in &t.vout {
            t_out_total += u64::from(txout.value());
            t_out_size += serialized_len(|w| txout.write(w));
        }
    }

    let sapling_vb = i64::from(tx.sapling_value_balance());
    let orchard_vb = tx
        .orchard_bundle()
        .map_or(0, |b| i64::from(*b.value_balance()));
    let ironwood_vb = tx
        .ironwood_bundle()
        .map_or(0, |b| i64::from(*b.value_balance()));
    let shielded_value_balance = sapling_vb + orchard_vb + ironwood_vb;
    let net_into_shielded = -shielded_value_balance;
    let fee_implied = t_in_total as i64 - t_out_total as i64 - net_into_shielded;

    let orchard_actions = tx.orchard_bundle().map_or(0, |b| b.actions().len());
    let ironwood_actions = tx.ironwood_bundle().map_or(0, |b| b.actions().len());
    let (sapling_spends, sapling_outputs) = tx.sapling_bundle().map_or((0, 0), |b| {
        (b.shielded_spends().len(), b.shielded_outputs().len())
    });

    // ZIP 317, recomputed from public structure only.
    let logical = t_in_size
        .div_ceil(zip317::P2PKH_STANDARD_INPUT_SIZE)
        .max(t_out_size.div_ceil(zip317::P2PKH_STANDARD_OUTPUT_SIZE))
        + sapling_spends.max(sapling_outputs)
        + orchard_actions
        + ironwood_actions;
    let conventional = u64::from(zip317::MARGINAL_FEE) * logical.max(zip317::GRACE_ACTIONS) as u64;

    let fee_paid_lib = tx
        .fee_paid(|op| Ok::<_, BalanceError>(resolve(op).map(|c| c.value())))
        .map_err(|e| format!("{e:?}"))?
        .map(u64::from);

    Ok(PublicView {
        size: tx_bytes.len(),
        tx_version: format!("{:?}", tx.version()),
        branch_id: tx.consensus_branch_id(),
        t_in_count,
        t_in_total,
        t_out_count,
        t_out_total,
        orchard_actions,
        ironwood_actions,
        orchard_value_balance: orchard_vb,
        ironwood_value_balance: ironwood_vb,
        shielded_value_balance,
        net_into_shielded,
        fee_implied,
        fee_paid_lib,
        zip317_logical_actions: logical,
        zip317_conventional_fee: conventional,
    })
}

// ---------------------------------------------------------------------------------------------
// Sanity: proofs and signatures verify (what consensus would check)
// ---------------------------------------------------------------------------------------------

/// Transparent authorization carrying resolved prevouts, which ZIP 244 commits to in the
/// shielded sighash once the tx has transparent inputs.
#[derive(Debug)]
struct ResolvedPrevouts(Vec<TxOut>);

impl tbundle::Authorization for ResolvedPrevouts {
    type ScriptSig = Script;
}

impl TransparentAuthorizingContext for ResolvedPrevouts {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        self.0.iter().map(|c| c.value()).collect()
    }
    fn input_scriptpubkeys(&self) -> Vec<Script> {
        self.0.iter().map(|c| c.script_pubkey().clone()).collect()
    }
}

struct VerifyAuth;

impl Authorization for VerifyAuth {
    type TransparentAuth = ResolvedPrevouts;
    type SaplingAuth = sapling_crypto::bundle::Authorized;
    type OrchardAuth = OrchardAuthorized;
}

fn verifying_key(version: OrchardCircuitVersion) -> &'static VerifyingKey {
    static FIXED_POST_NU6_2: OnceLock<VerifyingKey> = OnceLock::new();
    static POST_NU6_3: OnceLock<VerifyingKey> = OnceLock::new();
    let cell = match version {
        OrchardCircuitVersion::FixedPostNu6_2 => &FIXED_POST_NU6_2,
        OrchardCircuitVersion::PostNu6_3 => &POST_NU6_3,
        other => panic!("spike does not verify {other:?} bundles"),
    };
    cell.get_or_init(|| VerifyingKey::build(version))
}

/// Verifies the Halo2 proof, every RedPallas spend-auth signature and the binding signature of
/// each Orchard/Ironwood bundle, plus each P2PKH input's ECDSA signature against its prevout.
pub fn verify_authorization(
    tx_bytes: &[u8],
    resolve: impl Fn(&OutPoint) -> Option<TxOut>,
) -> Result<(), String> {
    let tx = parse(tx_bytes)?;
    let data: TransactionData<VerifyAuth> = tx.into_data().map_bundles(
        |t| {
            t.map(|b| {
                let coins = b
                    .vin
                    .iter()
                    .map(|i| resolve(i.prevout()).expect("resolvable"))
                    .collect();
                tbundle::Bundle {
                    vin: b
                        .vin
                        .into_iter()
                        .map(|i| {
                            TxIn::from_parts(
                                i.prevout().clone(),
                                i.script_sig().clone(),
                                i.sequence(),
                            )
                        })
                        .collect(),
                    vout: b.vout,
                    authorization: ResolvedPrevouts(coins),
                }
            })
        },
        |s| s,
        |o| o,
    );
    let txid_parts = data.digest(TxIdDigester);
    let shielded_sighash: [u8; 32] =
        *signature_hash(&data, &SignableInput::Shielded, &txid_parts).as_ref();

    for bundle in [data.orchard_bundle(), data.ironwood_bundle()]
        .into_iter()
        .flatten()
    {
        let vk = verifying_key(bundle.bundle_version().circuit_version());
        let mut validator = BatchValidator::new(vk);
        validator
            .add_bundle(bundle, shielded_sighash)
            .map_err(|e| format!("{e:?}"))?;
        if !validator.validate(ChaCha20Rng::seed_from_u64(7)) {
            return Err("orchard-family bundle proof/signature batch failed".into());
        }
    }

    if let Some(t) = data.transparent_bundle() {
        for (i, txin) in t.vin.iter().enumerate() {
            let coin = &t.authorization.0[i];
            let (sig_with_type, pubkey_bytes) = split_p2pkh_script_sig(&txin.script_sig().0 .0)?;
            let (hash_type, der) = sig_with_type.split_last().ok_or("empty signature")?;
            let pubkey =
                secp256k1::PublicKey::from_slice(pubkey_bytes).map_err(|e| e.to_string())?;
            #[allow(deprecated)]
            let addr = TransparentAddress::from_pubkey(&pubkey);
            if Script::from(addr.script()) != *coin.script_pubkey() {
                return Err(format!("input {i}: pubkey does not match prevout script"));
            }
            let signable = TransparentSignableInput::from_parts(
                t,
                SighashType::parse(*hash_type).ok_or("bad sighash type")?,
                i,
                coin.script_pubkey(),
                coin.script_pubkey(),
                coin.value(),
            )
            .map_err(|e| e.to_string())?;
            let sighash = signature_hash(&data, &SignableInput::Transparent(signable), &txid_parts);
            let msg = secp256k1::Message::from_digest(*sighash.as_ref());
            let sig = secp256k1::ecdsa::Signature::from_der(der).map_err(|e| e.to_string())?;
            secp256k1::ecdsa::verify(&sig, msg, &pubkey).map_err(|e| format!("input {i}: {e}"))?;
        }
    }
    Ok(())
}

/// A P2PKH scriptSig is `<push sig||hashtype> <push pubkey>`, both direct pushes (< 76 bytes).
fn split_p2pkh_script_sig(script: &[u8]) -> Result<(&[u8], &[u8]), String> {
    let err = || "not a P2PKH scriptSig".to_string();
    let (&sig_len, rest) = script.split_first().ok_or_else(err)?;
    let (sig, rest) = rest.split_at_checked(sig_len as usize).ok_or_else(err)?;
    let (&pk_len, rest) = rest.split_first().ok_or_else(err)?;
    if rest.len() != pk_len as usize {
        return Err(err());
    }
    Ok((sig, rest))
}

// ---------------------------------------------------------------------------------------------
// Task 4: decryption
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovered {
    pub action_index: usize,
    pub value: u64,
    pub memo_text: Option<String>,
    pub recipient: orchard::Address,
}

fn recovered(
    idx: usize,
    note: orchard::Note,
    addr: orchard::Address,
    memo: [u8; 512],
) -> Recovered {
    let memo_text = MemoBytes::from_bytes(&memo)
        .ok()
        .and_then(|m| match Memo::try_from(m) {
            Ok(Memo::Text(t)) => Some(t.to_string()),
            _ => None,
        });
    Recovered {
        action_index: idx,
        value: note.value().inner(),
        memo_text,
        recipient: addr,
    }
}

fn shielded_bundles(tx: &Transaction) -> Vec<&orchard::Bundle<OrchardAuthorized, ZatBalance>> {
    [tx.orchard_bundle(), tx.ironwood_bundle()]
        .into_iter()
        .flatten()
        .collect()
}

/// What a recipient sees by trial-decrypting with their incoming viewing key.
pub fn decrypt_as_recipient(
    tx_bytes: &[u8],
    ivk: &IncomingViewingKey,
) -> Result<Vec<Recovered>, String> {
    let tx = parse(tx_bytes)?;
    Ok(shielded_bundles(&tx)
        .into_iter()
        .flat_map(|b| b.decrypt_outputs_with_keys(std::slice::from_ref(ivk)))
        .map(|(idx, _, note, addr, memo)| recovered(idx, note, addr, memo))
        .collect())
}

/// Every OVK an auditor can derive from a UFVK: Orchard external/internal, and the two
/// transparent-derived OVKs that `UnifiedFullViewingKey::select_ovk` uses for transparent-input
/// transactions. Trying all of them makes the OVK=None negative test meaningful.
pub fn candidate_ovks(ufvk: &UnifiedFullViewingKey) -> Vec<OutgoingViewingKey> {
    let mut ovks = Vec::new();
    if let Some(fvk) = ufvk.orchard() {
        ovks.push(fvk.to_ovk(Scope::External));
        ovks.push(fvk.to_ovk(Scope::Internal));
    }
    if let Some(t) = ufvk.p2pkh() {
        let ovks_ = t.ovks_for_shielding();
        ovks.push(OutgoingViewingKey::from(ovks_.external().as_bytes()));
        ovks.push(OutgoingViewingKey::from(ovks_.internal().as_bytes()));
    }
    ovks
}

/// The auditor's view: decode the campaign UFVK string, derive its OVKs, recover outputs.
pub fn recover_as_auditor(tx_bytes: &[u8], ufvk_encoded: &str) -> Result<Vec<Recovered>, String> {
    let ufvk =
        UnifiedFullViewingKey::decode(&TEST_NETWORK, ufvk_encoded).map_err(|e| format!("{e:?}"))?;
    let ovks = candidate_ovks(&ufvk);
    let tx = parse(tx_bytes)?;
    Ok(shielded_bundles(&tx)
        .into_iter()
        .flat_map(|b| b.recover_outputs_with_ovks(&ovks))
        .map(|(idx, _, note, addr, memo)| recovered(idx, note, addr, memo))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(pool: Pool, height: BlockHeight, n: usize, ovk: OvkPolicy) -> BuiltBatch {
        build_batch(
            &Campaign::test_only(),
            &BatchSpec {
                pool,
                target_height: height,
                n,
                ovk,
                rng_seed: 42,
            },
        )
        .expect("build")
    }

    #[test]
    fn ironwood_batch_balances_from_public_data_only() {
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            3,
            OvkPolicy::Campaign,
        );
        let v = public_view(&b.tx_bytes, b.resolver()).unwrap();
        assert_eq!(v.tx_version, "V6");
        assert_eq!(v.branch_id, BranchId::Nu6_3);
        assert_eq!((v.orchard_actions, v.ironwood_actions), (0, 3));
        let payouts: u64 = b.payout_values.iter().copied().map(u64::from).sum();
        assert_eq!(v.net_into_shielded, payouts as i64);
        assert_eq!(v.t_out_total, u64::from(b.change));
        assert!(v.balances());
        assert_eq!(v.fee_implied as u64, u64::from(b.fee));
        assert_eq!(v.fee_paid_lib, Some(u64::from(b.fee)));
        // 1 P2PKH in + 1 P2PKH out = 1 logical action, + 3 Ironwood actions.
        assert_eq!(v.zip317_logical_actions, 4);
        assert_eq!(v.zip317_conventional_fee, u64::from(b.fee));
    }

    #[test]
    fn proofs_and_signatures_verify() {
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            2,
            OvkPolicy::Campaign,
        );
        verify_authorization(&b.tx_bytes, b.resolver()).unwrap();
    }

    #[test]
    fn tampered_value_balance_is_rejected() {
        // Flip a bit in the 8-byte Ironwood valueBalance field. The binding signature (and, since
        // valueBalance is in the sighash, every other signature) must then fail -- this is what
        // makes the public net-into-pool number trustworthy without keys.
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            2,
            OvkPolicy::Campaign,
        );
        let vb = public_view(&b.tx_bytes, b.resolver())
            .unwrap()
            .shielded_value_balance;
        let needle = vb.to_le_bytes();
        let pos = b
            .tx_bytes
            .windows(8)
            .position(|w| w == needle)
            .expect("valueBalance bytes present");
        assert_eq!(b.tx_bytes.windows(8).filter(|w| *w == needle).count(), 1);
        let mut tampered = b.tx_bytes.clone();
        tampered[pos] ^= 1;
        let err = verify_authorization(&tampered, b.resolver()).unwrap_err();
        assert!(err.contains("bundle proof/signature batch failed"), "{err}");
    }

    #[test]
    fn recipients_decrypt_exactly_their_own_output() {
        let n = 3;
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            n,
            OvkPolicy::Campaign,
        );
        for (i, r) in b.recipients.iter().enumerate() {
            let got = decrypt_as_recipient(&b.tx_bytes, &r.ivk()).unwrap();
            assert_eq!(got.len(), 1, "recipient {i}");
            assert_eq!(got[0].value, u64::from(b.payout_values[i]));
            let memo = got[0].memo_text.as_deref().unwrap();
            assert!(memo.contains(&format!("payout {} of {n}", i + 1)), "{memo}");
        }
    }

    #[test]
    fn unrelated_ivk_learns_nothing() {
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            3,
            OvkPolicy::Campaign,
        );
        let stranger = Recipient::test_only(9_999);
        assert!(decrypt_as_recipient(&b.tx_bytes, &stranger.ivk())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn auditor_ufvk_recovers_all_outputs_and_sum_matches_pool_delta() {
        let campaign = Campaign::test_only();
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            4,
            OvkPolicy::Campaign,
        );
        let got = recover_as_auditor(&b.tx_bytes, &campaign.ufvk_encoded()).unwrap();
        assert_eq!(got.len(), 4);
        let sum: u64 = got.iter().map(|r| r.value).sum();
        let v = public_view(&b.tx_bytes, b.resolver()).unwrap();
        assert_eq!(sum as i64, v.net_into_shielded);
        for (i, r) in b.recipients.iter().enumerate() {
            let addr = orchard_receiver(&r.unified_address).unwrap();
            assert!(got
                .iter()
                .any(|g| g.recipient == addr && g.value == u64::from(b.payout_values[i])));
        }
    }

    #[test]
    fn ovk_none_hides_outputs_from_sender_ufvk() {
        let campaign = Campaign::test_only();
        let b = build(Pool::Ironwood, testnet_nu6_3_height(), 3, OvkPolicy::None);
        assert!(recover_as_auditor(&b.tx_bytes, &campaign.ufvk_encoded())
            .unwrap()
            .is_empty());
        // ...while the recipients can still decrypt, and the public totals are unchanged.
        assert_eq!(
            decrypt_as_recipient(&b.tx_bytes, &b.recipients[0].ivk())
                .unwrap()
                .len(),
            1
        );
        assert!(public_view(&b.tx_bytes, b.resolver()).unwrap().balances());
    }

    #[test]
    fn orchard_payouts_are_rejected_from_nu6_3() {
        let err = build_batch(
            &Campaign::test_only(),
            &BatchSpec {
                pool: Pool::Orchard,
                target_height: testnet_nu6_3_height(),
                n: 2,
                ovk: OvkPolicy::Campaign,
                rng_seed: 1,
            },
        )
        .err()
        .expect("Orchard third-party output must fail post-NU6.3");
        assert!(
            err.contains("Cross-address transfers are disabled"),
            "{err}"
        );
    }

    #[test]
    fn orchard_payouts_still_build_in_nu6_2_epoch() {
        let b = build(
            Pool::Orchard,
            testnet_nu6_2_height(),
            2,
            OvkPolicy::Campaign,
        );
        let v = public_view(&b.tx_bytes, b.resolver()).unwrap();
        assert_eq!(
            (v.tx_version.as_str(), v.branch_id),
            ("V5", BranchId::Nu6_2)
        );
        assert_eq!((v.orchard_actions, v.ironwood_actions), (2, 0));
        assert!(v.balances());
        verify_authorization(&b.tx_bytes, b.resolver()).unwrap();
    }

    #[test]
    fn ironwood_batch_works_after_nu7_on_0_31_train() {
        let h = TEST_NETWORK.activation_height(NetworkUpgrade::Nu7).unwrap() + 1_000;
        let b = build(Pool::Ironwood, h, 3, OvkPolicy::Campaign);
        let v = public_view(&b.tx_bytes, b.resolver()).unwrap();
        assert_eq!((v.tx_version.as_str(), v.branch_id), ("V6", BranchId::Nu7));
        assert!(v.balances());
        verify_authorization(&b.tx_bytes, b.resolver()).unwrap();
        let got = recover_as_auditor(&b.tx_bytes, &Campaign::test_only().ufvk_encoded()).unwrap();
        assert_eq!(
            got.iter().map(|r| r.value as i64).sum::<i64>(),
            v.net_into_shielded
        );
    }

    #[test]
    fn build_is_deterministic_for_a_fixed_rng_seed() {
        let a = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            2,
            OvkPolicy::Campaign,
        );
        let b = build(
            Pool::Ironwood,
            testnet_nu6_3_height(),
            2,
            OvkPolicy::Campaign,
        );
        assert_eq!(a.tx_bytes, b.tx_bytes);
    }
}
