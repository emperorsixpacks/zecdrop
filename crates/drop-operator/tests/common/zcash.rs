//! Real-shaped Zcash test material: genuine librustzcash transactions built with TEST-ONLY
//! keys, plus an in-memory chain. Nothing here touches a network.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use drop_core::{FeePolicy, OutPoint, Txid, Zatoshi};
use drop_operator::chain::{ChainError, UtxoSighting};
use drop_operator::real::{ZcashBackend, ZcashConnector};
use drop_operator::state::Options;
use drop_verify::{ChainSource, FetchedTx, SourceError};
use drop_zcash::builder::{build_batch_tx, fee_rule, FundingCoin, PayoutLine};
use drop_zcash::chain::{ChainBackend as ZcashChain, PrevOut, Submitted, TxStatus};
use drop_zcash::{encode_memo, CampaignKeys, MainnetPermit, ZcashAddressCodec};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use zcash_keys::address::Address;
use zcash_primitives::transaction::{Authorized, TransactionData, TxVersion};
use zcash_protocol::consensus::{
    BlockHeight, BranchId, Network as ZNetwork, NetworkUpgrade, Parameters,
};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::Script;
use zcash_transparent::bundle::{self as tbundle, OutPoint as ZOutPoint, TxIn, TxOut};

use super::{Builder, Harness};

pub const NETWORK: ZNetwork = ZNetwork::TestNetwork;

/// TEST ONLY. A public, hard-coded wallet seed. Never fund its addresses.
pub const TEST_SEED: [u8; 32] = *b"TEST-ONLY zecdrop operator seed!";

/// TEST ONLY. The seed the payout recipients' keys come from.
const RECIPIENT_SEED: [u8; 32] = *b"TEST-ONLY zecdrop recipients 123";

/// A real testnet unified address (Orchard receiver) for recipient `i`.
pub fn recipient_ua(i: u32) -> String {
    CampaignKeys::derive(&RECIPIENT_SEED, NETWORK, 1000 + i)
        .unwrap()
        .unified_address()
}

/// A real unified address (Orchard receiver) for recipient `i` on `network`.
pub fn recipient_ua_on(network: ZNetwork, i: u32) -> String {
    CampaignKeys::derive(&RECIPIENT_SEED, network, 1000 + i)
        .unwrap()
        .unified_address()
}

/// A harness running the real Zcash backend over `node` on MAINNET, with TEST-ONLY wallet keys:
/// campaigns, funding addresses and recipients are mainnet-shaped. Nothing is ever sent.
///
/// With `allow_mainnet` the backend is also given the mainnet permit, as the operator's start-up
/// does once `--allow-mainnet` and the confirmation have passed; without it the backend refuses
/// to run a mainnet campaign. The funding cap is lifted, because the NEAR tests use campaigns of
/// a few ZEC; use [`mainnet_harness_with_cap`] to run under the real default.
pub fn mainnet_harness(node: &SharedNode, required_depth: u32, allow_mainnet: bool) -> Harness {
    mainnet_harness_with_cap(node, required_depth, allow_mainnet, u64::MAX)
}

/// [`mainnet_harness`] with an explicit mainnet funding cap, in zatoshi (REQ-OPS-003).
pub fn mainnet_harness_with_cap(
    node: &SharedNode,
    required_depth: u32,
    allow_mainnet: bool,
    mainnet_max_funding_zat: u64,
) -> Harness {
    node.lock().mainnet = true;
    let backend = ZcashBackend::new(FakeConnector(node.clone()));
    let backend = if allow_mainnet {
        backend.allow_mainnet(MainnetPermit::after_operator_gate())
    } else {
        backend
    };
    Builder {
        seed: TEST_SEED,
        network: drop_core::Network::Mainnet,
        backend: Some(Arc::new(backend)),
        codec: Some(Arc::new(ZcashAddressCodec::new(ZNetwork::MainNetwork))),
        allow_mainnet,
        options: Options {
            required_depth,
            mainnet_max_funding_zat,
            ..Builder::default().options
        },
        ..Builder::default()
    }
    .build()
}

/// A height inside the Ironwood epoch.
pub fn ironwood_height() -> BlockHeight {
    NETWORK.activation_height(NetworkUpgrade::Nu6_3).unwrap() + 1_000
}

fn script_of_on(network: &ZNetwork, address: &str) -> Script {
    match Address::decode(network, address) {
        Some(Address::Transparent(t)) => Script::from(t.script()),
        _ => panic!("not a transparent address"),
    }
}

fn script_of(address: &str) -> Script {
    script_of_on(&NETWORK, address)
}

pub fn script_bytes(address: &str) -> Vec<u8> {
    script_of(address).0 .0
}

/// The mainnet tip seen on 2026-10-18 (NU6.3, branch `37a5165b`): a height at which mainnet
/// batches are built in the tests.
pub const MAINNET_TIP: u32 = 3_522_426;
/// What a mainnet node reports as its consensus branch id (NU6.3).
pub const MAINNET_BRANCH: u32 = 0x37a5_165b;

fn display_txid(id: zcash_primitives::transaction::TxId) -> Txid {
    id.to_string().parse().unwrap()
}

/// A V5 transaction with one transparent output of `value` to `address`: the funding
/// transaction a deposit would have. `salt` keeps different deposits' ids apart.
pub fn funding_tx(address: &str, value: u64, salt: u8) -> (Txid, Vec<u8>) {
    funding_tx_on(&NETWORK, address, value, salt)
}

/// [`funding_tx`] for an address of `network`.
pub fn funding_tx_on(network: &ZNetwork, address: &str, value: u64, salt: u8) -> (Txid, Vec<u8>) {
    let bundle = tbundle::Bundle {
        vin: vec![TxIn::from_parts(
            ZOutPoint::new([salt; 32], 0),
            Script::default(),
            0xffff_ffff,
        )],
        vout: vec![TxOut::new(
            Zatoshis::from_u64(value).unwrap(),
            script_of_on(network, address),
        )],
        authorization: tbundle::Authorized,
    };
    let tx = TransactionData::<Authorized>::from_parts(
        TxVersion::V5,
        BranchId::Nu6_2,
        0,
        BlockHeight::from_u32(0),
        Some(bundle),
        None,
        None,
        None,
    )
    .freeze()
    .unwrap();
    let mut raw = Vec::new();
    tx.write(&mut raw).unwrap();
    (display_txid(tx.txid()), raw)
}

/// One payout row.
#[derive(Clone)]
pub struct Row {
    pub address: String,
    pub zat: u64,
    pub memo: Option<String>,
}

fn payout(row: &Row) -> PayoutLine {
    let receiver = match Address::decode(&NETWORK, &row.address) {
        Some(Address::Unified(ua)) => *ua.orchard().unwrap(),
        _ => panic!("not a unified address"),
    };
    PayoutLine {
        receiver,
        value: Zatoshis::from_u64(row.zat).unwrap(),
        memo: encode_memo(row.memo.as_deref()).unwrap(),
    }
}

/// Builds and proves one batch for campaign `account`, spending output 0 of `funding`.
pub fn batch_tx(account: u32, rows: &[Row], funding: (&Txid, u64)) -> (Txid, Vec<u8>) {
    let keys = CampaignKeys::derive(&TEST_SEED, NETWORK, account).unwrap();
    let wire = {
        let mut bytes = *funding.0.as_bytes();
        bytes.reverse();
        bytes
    };
    let coin = FundingCoin {
        outpoint: ZOutPoint::new(wire, 0),
        coin: TxOut::new(
            Zatoshis::from_u64(funding.1).unwrap(),
            script_of(&keys.funding_address()),
        ),
    };
    let payouts: Vec<PayoutLine> = rows.iter().map(payout).collect();
    let built = build_batch_tx(
        &keys,
        ironwood_height(),
        orchard::Anchor::empty_tree(),
        std::slice::from_ref(&coin),
        &payouts,
        &fee_rule(&FeePolicy::zip317_text()).unwrap(),
        &mut ChaCha20Rng::seed_from_u64(7),
    )
    .unwrap();
    (display_txid(built.txid), built.raw)
}

// ---- a read-only chain for the audit ------------------------------------------------------

/// An in-memory `ChainSource`.
#[derive(Clone, Default)]
pub struct StaticChain {
    pub txs: HashMap<Txid, FetchedTx>,
    pub tip: u32,
}

impl ChainSource for StaticChain {
    async fn transaction(&self, txid: &Txid) -> Result<Option<FetchedTx>, SourceError> {
        Ok(self.txs.get(txid).cloned())
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        Ok(self.tip)
    }
}

// ---- a full fake node for the live operator path --------------------------------------------

/// One output sitting at a campaign's funding address.
#[derive(Clone)]
pub struct Deposit {
    pub address: String,
    pub outpoint: OutPoint,
    pub value: u64,
    /// The mining height, or `None` while in the mempool.
    pub height: Option<u32>,
}

#[derive(Default)]
pub struct FakeNode {
    pub tip: u32,
    pub deposits: Vec<Deposit>,
    pub submitted: Vec<Vec<u8>>,
    /// Transactions this node mined, by id, with their height.
    pub mined: HashMap<Txid, u32>,
    /// Once something was submitted, every tip query advances the chain by one block.
    pub advance_after_submit: bool,
    /// Whether the node's addresses are mainnet ones (`t1…`), which changes how deposits are
    /// resolved. Set by [`mainnet_harness`].
    pub mainnet: bool,
    /// The consensus branch id the node reports, if it reports one.
    pub branch: Option<u32>,
}

#[derive(Clone, Default)]
pub struct SharedNode(pub Arc<Mutex<FakeNode>>);

impl SharedNode {
    pub fn lock(&self) -> MutexGuard<'_, FakeNode> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("fake node: {0}")]
pub struct FakeNodeError(pub &'static str);

/// `drop_zcash::ChainBackend` over the fake node.
pub struct FakeZcashChain(pub SharedNode);

impl ZcashChain for FakeZcashChain {
    type Error = FakeNodeError;

    fn tip_height(&mut self) -> Result<u32, FakeNodeError> {
        let mut node = self.0.lock();
        if node.advance_after_submit && !node.submitted.is_empty() {
            node.tip += 1;
        }
        Ok(node.tip)
    }

    fn consensus_branch_id(&mut self) -> Result<Option<u32>, FakeNodeError> {
        Ok(self.0.lock().branch)
    }

    fn ironwood_anchor(&mut self, _height: u32) -> Result<[u8; 32], FakeNodeError> {
        Ok(orchard::Anchor::empty_tree().to_bytes())
    }

    fn prevout(&mut self, outpoint: &OutPoint) -> Result<Option<PrevOut>, FakeNodeError> {
        let node = self.0.lock();
        let network = if node.mainnet {
            ZNetwork::MainNetwork
        } else {
            NETWORK
        };
        Ok(node
            .deposits
            .iter()
            .find(|d| d.outpoint == *outpoint)
            .map(|d| PrevOut {
                value: d.value,
                script_pubkey: script_of_on(&network, &d.address).0 .0,
            }))
    }

    fn submit(&mut self, raw_tx: &[u8]) -> Result<Submitted, FakeNodeError> {
        let parsed = drop_verify::ParsedTx::parse(raw_tx).map_err(|_| FakeNodeError("bad tx"))?;
        let mut node = self.0.lock();
        let height = node.tip + 1;
        node.mined.insert(parsed.txid(), height);
        node.tip = height;
        node.submitted.push(raw_tx.to_vec());
        node.advance_after_submit = true;
        Ok(Submitted::Accepted)
    }

    fn status(&mut self, txid: &Txid) -> Result<TxStatus, FakeNodeError> {
        let node = self.0.lock();
        Ok(node
            .mined
            .get(txid)
            .map_or(TxStatus::Unknown, |height| TxStatus::Mined {
                height: *height,
            }))
    }
}

/// The operator's view of the fake node: the connector `ZcashBackend` is built over.
pub struct FakeConnector(pub SharedNode);

impl ZcashConnector for FakeConnector {
    type Backend = FakeZcashChain;

    fn connect(&self, _keys: &CampaignKeys) -> Result<FakeZcashChain, ChainError> {
        Ok(FakeZcashChain(self.0.clone()))
    }

    fn sightings(&self, address: &str) -> Result<Vec<UtxoSighting>, ChainError> {
        let node = self.0.lock();
        Ok(node
            .deposits
            .iter()
            .filter(|d| d.address == address)
            .map(|d| UtxoSighting {
                outpoint: d.outpoint,
                amount: Zatoshi::new(d.value).unwrap(),
                confirmations: d.height.map_or(0, |h| node.tip.saturating_sub(h) + 1),
            })
            .collect())
    }
}

/// A harness running the real Zcash backend over `node`, with TEST-ONLY wallet keys.
pub fn real_harness(node: &SharedNode, required_depth: u32) -> Harness {
    Builder {
        seed: TEST_SEED,
        backend: Some(Arc::new(ZcashBackend::new(FakeConnector(node.clone())))),
        codec: Some(Arc::new(ZcashAddressCodec::new(NETWORK))),
        options: Options {
            required_depth,
            ..Builder::default().options
        },
        ..Builder::default()
    }
    .build()
}

/// Puts a deposit of `value` at `address` on the node (`height` of `None` is the mempool) and
/// returns its outpoint and the funding transaction's bytes. `salt` keeps ids apart.
pub fn put_deposit(
    node: &SharedNode,
    address: &str,
    value: u64,
    height: Option<u32>,
    salt: u8,
) -> (OutPoint, Vec<u8>) {
    let network = if node.lock().mainnet {
        ZNetwork::MainNetwork
    } else {
        NETWORK
    };
    let (txid, raw) = funding_tx_on(&network, address, value, salt);
    let outpoint = OutPoint { txid, vout: 0 };
    node.lock().deposits.push(Deposit {
        address: address.to_owned(),
        outpoint,
        value,
        height,
    });
    (outpoint, raw)
}
