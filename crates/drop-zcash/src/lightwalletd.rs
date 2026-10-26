//! [`ChainBackend`] over `drop-chain`'s key-less lightwalletd/Zaino client.
//!
//! `drop-chain` is async (tonic); [`drop_core::Distributor`] is synchronous. The backend owns a small
//! current-thread tokio runtime and blocks on each call, so it must be driven from a thread that
//! is not already inside a tokio runtime (in an async server, use `spawn_blocking`).
//!
//! The Ironwood anchor comes from `GetTreeState` (`LightwalletdSource::ironwood_tree_hex`):
//! [`ironwood_anchor_from_tree_hex`] turns `TreeState.ironwood_tree` into the tree root. It is
//! tested against a real testnet tree state, cross-checked with `zcash_client_backend`.

use drop_chain::{
    BroadcastError, BroadcastOutcome, ChainConfig, ChainError, ChainInfo, GrpcApi,
    LightwalletdSource, StreamerApi,
};
use drop_core::{OutPoint, Txid};
use drop_verify::{ChainSource, SourceError};
use orchard::tree::MerkleHashOrchard;
use thiserror::Error;
use tokio::runtime::{Builder, Runtime};
use zcash_primitives::merkle_tree::read_commitment_tree;
use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

use crate::builder::expected_branch_id;
use crate::chain::{ChainBackend, PrevOut, Submitted, TxStatus};
use crate::keys::CampaignKeys;
use crate::zcash_network;

/// Fixed-text errors (the server's own messages are not kept, except a rejection's reason).
#[derive(Debug, Error)]
pub enum BackendError {
    #[error(transparent)]
    Chain(#[from] ChainError),
    #[error(transparent)]
    Source(#[from] SourceError),
    /// The broadcast outcome is unknown; the message names the txid. Transient: re-send the same
    /// bytes, never rebuild.
    #[error(transparent)]
    Broadcast(#[from] BroadcastError),
    #[error("the Ironwood tree state does not parse")]
    BadTreeState,
    /// The server sent no Ironwood tree state for a height at which the tree is not empty, so it
    /// cannot supply the anchor a batch needs (an old lightwalletd that lacks the field looks
    /// exactly like this).
    #[error("the node returned no Ironwood tree state: it cannot be used to build batches")]
    IronwoodTreeMissing,
    /// The node is on a different network upgrade than the one this build stamps.
    #[error(
        "the node reports branch {node:08x} but this build expects {expected:08x} at height \
         {height}: this build does not know the network's current upgrade"
    )]
    BranchMismatch {
        node: u32,
        expected: u32,
        height: u32,
    },
    #[error("could not start the async runtime")]
    Runtime,
}

/// A [`ChainBackend`] for one campaign: it watches the campaign's funding and change addresses
/// when resolving funding outpoints.
pub struct LightwalletdBackend<A: StreamerApi = GrpcApi> {
    source: LightwalletdSource<A>,
    runtime: Runtime,
    watched: Vec<String>,
}

fn runtime() -> Result<Runtime, BackendError> {
    Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| BackendError::Runtime)
}

fn watched(keys: &CampaignKeys) -> Vec<String> {
    vec![keys.funding_address(), keys.change_address()]
}

impl LightwalletdBackend<GrpcApi> {
    /// Connects to a real server and checks it serves `config.network`, returning the live tip and
    /// branch id too. The gRPC channel is created on this backend's own runtime, which must
    /// outlive it; call from a thread that is not inside a tokio runtime.
    pub fn connect(
        config: &ChainConfig,
        keys: &CampaignKeys,
    ) -> Result<(Self, ChainInfo), BackendError> {
        let runtime = runtime()?;
        let (source, info) = runtime.block_on(LightwalletdSource::connect(config))?;
        Ok((
            LightwalletdBackend {
                source,
                runtime,
                watched: watched(keys),
            },
            info,
        ))
    }
}

impl<A: StreamerApi> LightwalletdBackend<A> {
    /// Wraps an existing source. For fakes and tests: a real tonic source must be created on the
    /// backend's own runtime, so use [`LightwalletdBackend::connect`] for servers.
    pub fn from_source(
        source: LightwalletdSource<A>,
        keys: &CampaignKeys,
    ) -> Result<Self, BackendError> {
        Ok(LightwalletdBackend {
            source,
            runtime: runtime()?,
            watched: watched(keys),
        })
    }
}

impl<A: StreamerApi> ChainBackend for LightwalletdBackend<A> {
    type Error = BackendError;

    fn tip_height(&mut self) -> Result<u32, BackendError> {
        // `chain_info` also re-checks the server's network on every call.
        Ok(self.runtime.block_on(self.source.chain_info())?.tip_height)
    }

    fn consensus_branch_id(&mut self) -> Result<Option<u32>, BackendError> {
        Ok(Some(
            self.runtime
                .block_on(self.source.chain_info())?
                .consensus_branch_id,
        ))
    }

    fn ironwood_anchor(&mut self, height: u32) -> Result<[u8; 32], BackendError> {
        let tree_hex = self
            .runtime
            .block_on(self.source.ironwood_tree_hex(height))?;
        ironwood_anchor_at(self.source.network(), height, &tree_hex)
    }

    fn prevout(&mut self, outpoint: &OutPoint) -> Result<Option<PrevOut>, BackendError> {
        for address in &self.watched {
            let utxos = self.runtime.block_on(self.source.utxos(address))?;
            if let Some(u) = utxos.into_iter().find(|u| u.outpoint == *outpoint) {
                return Ok(Some(PrevOut {
                    value: u.value.as_u64(),
                    script_pubkey: u.script_pubkey,
                }));
            }
        }
        Ok(None)
    }

    fn submit(&mut self, raw_tx: &[u8]) -> Result<Submitted, BackendError> {
        // drop-chain asks the node for the txid after any refusal or lost reply, so a re-send of
        // a transaction the node already has is `AlreadyKnown`, whatever its wording.
        Ok(
            match self.runtime.block_on(self.source.broadcast(raw_tx))? {
                BroadcastOutcome::Accepted { .. } => Submitted::Accepted,
                BroadcastOutcome::AlreadyKnown { .. } => Submitted::AlreadyKnown,
                BroadcastOutcome::Rejected { code, message, .. } => {
                    Submitted::Rejected(format!("code {code}: {message}"))
                }
            },
        )
    }

    fn status(&mut self, txid: &Txid) -> Result<TxStatus, BackendError> {
        Ok(
            match self.runtime.block_on(self.source.transaction(txid))? {
                None => TxStatus::Unknown,
                Some(fetched) => match fetched.mined_height {
                    None => TxStatus::Mempool,
                    Some(height) => TxStatus::Mined { height },
                },
            },
        )
    }
}

/// [`ironwood_anchor_from_tree_hex`] for a tree state fetched at `height` on `network`. An empty
/// string is the empty tree only up to the Ironwood activation height; above it the server is
/// not serving the field at all, and an empty-tree anchor would be a silent wrong answer.
pub fn ironwood_anchor_at(
    network: drop_core::Network,
    height: u32,
    ironwood_tree_hex: &str,
) -> Result<[u8; 32], BackendError> {
    if ironwood_tree_hex.is_empty() {
        let activation = zcash_network(network)
            .activation_height(NetworkUpgrade::Nu6_3)
            .map_or(0, u32::from);
        if height > activation {
            return Err(BackendError::IronwoodTreeMissing);
        }
    }
    ironwood_anchor_from_tree_hex(ironwood_tree_hex)
}

/// The check an operator makes once, at start-up, of a node that will be asked to build and send
/// batches (REQ-OPS-004): it serves the configured network, it is on the upgrade this build
/// stamps for the next block, and it serves the Ironwood tree state at its tip. Returns the live
/// chain info. A failure here means no address should be funded yet.
pub async fn preflight<A: StreamerApi>(
    source: &LightwalletdSource<A>,
) -> Result<ChainInfo, BackendError> {
    let info = source.chain_info().await?;
    let height = info.tip_height.saturating_add(1);
    let expected = expected_branch_id(&zcash_network(source.network()), height);
    if info.consensus_branch_id != expected {
        return Err(BackendError::BranchMismatch {
            node: info.consensus_branch_id,
            expected,
            height,
        });
    }
    let tree = source.ironwood_tree_hex(info.tip_height).await?;
    ironwood_anchor_at(source.network(), info.tip_height, &tree)?;
    Ok(info)
}

/// The Ironwood anchor (tree root, as `orchard::Anchor` bytes) from lightwalletd's
/// `TreeState.ironwood_tree` hex. An empty string is the empty tree, which is the Ironwood
/// tree state before NU6.3 activation; see [`ironwood_anchor_at`] for the height-aware version.
pub fn ironwood_anchor_from_tree_hex(ironwood_tree_hex: &str) -> Result<[u8; 32], BackendError> {
    if ironwood_tree_hex.is_empty() {
        return Ok(orchard::Anchor::empty_tree().to_bytes());
    }
    let bytes = hex::decode(ironwood_tree_hex).map_err(|_| BackendError::BadTreeState)?;
    let tree = read_commitment_tree::<
        MerkleHashOrchard,
        _,
        { orchard::NOTE_COMMITMENT_TREE_DEPTH as u8 },
    >(bytes.as_slice())
    .map_err(|_| BackendError::BadTreeState)?;
    Ok(orchard::Anchor::from(tree.root()).to_bytes())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use drop_chain::{ApiError, RawTx, SendResponse, ServerInfo, UtxoReply};
    use drop_core::Network;

    use super::*;
    use crate::keys::tests::test_keys;

    /// A scripted lightwalletd: testnet, tip 4,476,200, one UTXO at the campaign's funding
    /// address, and the real testnet Ironwood tree state at 4,476,194 for every height.
    struct FakeApi {
        funding_address: String,
        funding_script: Vec<u8>,
        send: SendResponse,
        tx: Option<RawTx>,
        sent: Mutex<Vec<Vec<u8>>>,
        asked_tree_height: Arc<Mutex<Option<u64>>>,
        /// The branch id the server reports, as lightwalletd prints it.
        branch_id: String,
        /// What the server returns for the Ironwood tree; `None` is the real tree state fixture.
        tree_hex: Option<String>,
    }

    /// Public chain data captured from testnet.zec.rocks (GetTreeState at 4,476,194); the
    /// `ironwood_root_hex` line was computed independently by zcash_client_backend's parser.
    const TREE_STATE_FIXTURE: &str =
        include_str!("../testdata/testnet-ironwood-treestate-4476194.txt");

    /// Public chain data captured from zec.rocks (mainnet, GetTreeState at 3,522,400 on
    /// 2026-10-18). The root line is what this crate's parser computes from the tree line: the
    /// same code path as the testnet fixture above, whose root was cross-checked independently.
    const MAINNET_TREE_STATE_FIXTURE: &str =
        include_str!("../testdata/mainnet-ironwood-treestate-3522400.txt");

    fn field_of(text: &str, name: &str) -> String {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .map(str::trim)
            .unwrap()
            .to_string()
    }

    fn fixture_field(name: &str) -> String {
        field_of(TREE_STATE_FIXTURE, name)
    }

    /// The UTXO's txid in wire (internal) order; drop-chain reverses it to display order.
    const WIRE_TXID: [u8; 32] = [0x22; 32];

    impl StreamerApi for FakeApi {
        async fn get_transaction(&self, _: [u8; 32]) -> Result<Option<RawTx>, ApiError> {
            Ok(self.tx.clone())
        }
        async fn latest_height(&self) -> Result<u64, ApiError> {
            Ok(4_476_200)
        }
        async fn send_transaction(&self, raw: Vec<u8>) -> Result<SendResponse, ApiError> {
            self.sent.lock().unwrap().push(raw);
            Ok(self.send.clone())
        }
        async fn address_utxos(&self, address: &str) -> Result<Vec<UtxoReply>, ApiError> {
            Ok(if address == self.funding_address {
                vec![UtxoReply {
                    txid: WIRE_TXID.to_vec(),
                    index: 1,
                    script: self.funding_script.clone(),
                    value_zat: 123_456,
                    height: 4_476_100,
                }]
            } else {
                vec![]
            })
        }
        async fn ironwood_tree(&self, height: u64) -> Result<String, ApiError> {
            *self.asked_tree_height.lock().unwrap() = Some(height);
            Ok(self
                .tree_hex
                .clone()
                .unwrap_or_else(|| fixture_field("ironwood_tree_hex ")))
        }
        async fn server_info(&self) -> Result<ServerInfo, ApiError> {
            Ok(ServerInfo {
                chain_name: "test".into(),
                block_height: 4_476_200,
                consensus_branch_id: self.branch_id.clone(),
            })
        }
    }

    fn backend(send: SendResponse, tx: Option<RawTx>) -> LightwalletdBackend<FakeApi> {
        backend_recording(send, tx, Arc::default())
    }

    fn backend_recording(
        send: SendResponse,
        tx: Option<RawTx>,
        asked_tree_height: Arc<Mutex<Option<u64>>>,
    ) -> LightwalletdBackend<FakeApi> {
        let keys = test_keys(0);
        LightwalletdBackend::from_source(
            LightwalletdSource::with_api(fake_api(send, tx, asked_tree_height), Network::Testnet),
            &keys,
        )
        .unwrap()
    }

    fn fake_api(
        send: SendResponse,
        tx: Option<RawTx>,
        asked_tree_height: Arc<Mutex<Option<u64>>>,
    ) -> FakeApi {
        let keys = test_keys(0);
        FakeApi {
            funding_address: keys.funding_address(),
            funding_script: keys.funding_script().0 .0.clone(),
            send,
            tx,
            sent: Mutex::new(vec![]),
            asked_tree_height,
            branch_id: "77190ad9".into(),
            tree_hex: None,
        }
    }

    /// A testnet server that reports `branch_id` and answers every tree-state request with
    /// `tree_hex` (`None`: the real fixture).
    fn api_saying(branch_id: &str, tree_hex: Option<&str>) -> FakeApi {
        FakeApi {
            branch_id: branch_id.into(),
            tree_hex: tree_hex.map(str::to_owned),
            ..fake_api(ok(), None, Arc::default())
        }
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn ok() -> SendResponse {
        SendResponse {
            error_code: 0,
            error_message: String::new(),
        }
    }

    #[test]
    fn tip_and_funding_prevout_come_from_the_server() {
        let mut b = backend(ok(), None);
        assert_eq!(b.tip_height().unwrap(), 4_476_200);
        let mut display = WIRE_TXID;
        display.reverse();
        let funding = OutPoint {
            txid: Txid::from_bytes(display),
            vout: 1,
        };
        let prev = b.prevout(&funding).unwrap().unwrap();
        assert_eq!(prev.value, 123_456);
        assert_eq!(prev.script_pubkey, test_keys(0).funding_script().0 .0);
        assert_eq!(b.prevout(&OutPoint { vout: 2, ..funding }).unwrap(), None);
    }

    #[test]
    fn broadcast_outcomes_map_to_submitted() {
        let raw = &crate::builder::tests::shared_batch().0.raw;
        assert_eq!(
            backend(ok(), None).submit(raw).unwrap(),
            Submitted::Accepted
        );
        let known = SendResponse {
            error_code: -27,
            error_message: "transaction already in block chain".into(),
        };
        assert_eq!(
            backend(known, None).submit(raw).unwrap(),
            Submitted::AlreadyKnown
        );
        // Unfamiliar wording, but the node has the tx: still a success, never a double pay.
        let odd = SendResponse {
            error_code: -25,
            error_message: "unfamiliar wording".into(),
        };
        let in_mempool = RawTx {
            data: raw.clone(),
            height: 0,
        };
        assert_eq!(
            backend(odd, Some(in_mempool)).submit(raw).unwrap(),
            Submitted::AlreadyKnown
        );
        let bad = SendResponse {
            error_code: -26,
            error_message: "bad-txns-orchard-value-balance".into(),
        };
        assert!(
            matches!(backend(bad, None).submit(raw).unwrap(), Submitted::Rejected(r) if r.contains("-26"))
        );
        // Bytes that are not a transaction are refused before sending, as an unknown outcome.
        assert!(matches!(
            backend(ok(), None).submit(b"tx"),
            Err(BackendError::Broadcast(_))
        ));
    }

    #[test]
    fn status_distinguishes_unknown_mempool_and_mined() {
        let txid = Txid::from_bytes([7; 32]);
        assert_eq!(
            backend(ok(), None).status(&txid).unwrap(),
            TxStatus::Unknown
        );
        let mempool = RawTx {
            data: vec![1],
            height: 0,
        };
        assert_eq!(
            backend(ok(), Some(mempool)).status(&txid).unwrap(),
            TxStatus::Mempool
        );
        let mined = RawTx {
            data: vec![1],
            height: 4_476_150,
        };
        assert_eq!(
            backend(ok(), Some(mined)).status(&txid).unwrap(),
            TxStatus::Mined { height: 4_476_150 }
        );
    }

    #[test]
    fn anchor_is_the_root_of_the_servers_ironwood_tree_at_that_height() {
        let asked = Arc::default();
        let mut b = backend_recording(ok(), None, Arc::clone(&asked));
        let anchor = b.ironwood_anchor(4_476_194).unwrap();
        assert_eq!(hex::encode(anchor), fixture_field("ironwood_root_hex "));
        assert_eq!(*asked.lock().unwrap(), Some(4_476_194));
    }

    #[test]
    fn ironwood_anchor_parses_a_real_testnet_tree_state() {
        let root = ironwood_anchor_from_tree_hex(&fixture_field("ironwood_tree_hex ")).unwrap();
        assert_eq!(hex::encode(root), fixture_field("ironwood_root_hex "));
        assert_eq!(
            ironwood_anchor_from_tree_hex("").unwrap(),
            orchard::Anchor::empty_tree().to_bytes()
        );
        assert!(matches!(
            ironwood_anchor_from_tree_hex("zz"),
            Err(BackendError::BadTreeState)
        ));
    }

    // covers: REQ-TX-004
    #[test]
    fn the_backend_reports_the_branch_id_the_node_says() {
        assert_eq!(
            backend(ok(), None).consensus_branch_id().unwrap(),
            Some(0x7719_0ad9)
        );
    }

    // covers: REQ-TX-004
    #[test]
    fn an_empty_tree_state_is_the_empty_tree_only_up_to_activation() {
        let empty = orchard::Anchor::empty_tree().to_bytes();
        // Ironwood activated at 4,134,000 on testnet and 3,428,143 on mainnet.
        assert_eq!(
            ironwood_anchor_at(Network::Testnet, 4_134_000, "").unwrap(),
            empty
        );
        assert_eq!(
            ironwood_anchor_at(Network::Mainnet, 3_428_143, "").unwrap(),
            empty
        );
        assert_eq!(
            ironwood_anchor_at(Network::Mainnet, 100, "").unwrap(),
            empty
        );
        for (network, above) in [(Network::Testnet, 4_134_001), (Network::Mainnet, 3_428_144)] {
            assert!(matches!(
                ironwood_anchor_at(network, above, ""),
                Err(BackendError::IronwoodTreeMissing)
            ));
        }
        // A server that omits the field (an old lightwalletd) is refused at the tip, not trusted.
        let source =
            LightwalletdSource::with_api(api_saying("77190ad9", Some("")), Network::Testnet);
        let mut b = LightwalletdBackend::from_source(source, &test_keys(0)).unwrap();
        assert!(matches!(
            b.ironwood_anchor(4_476_200),
            Err(BackendError::IronwoodTreeMissing)
        ));
    }

    // covers: REQ-OPS-004
    #[test]
    fn the_start_up_check_accepts_a_matching_node_and_refuses_what_a_batch_could_not_use() {
        let source = |api| LightwalletdSource::with_api(api, Network::Testnet);

        // Testnet tip 4,476,200 is on NU7 and serves a real Ironwood tree.
        let info = run(preflight(&source(api_saying("77190ad9", None)))).unwrap();
        assert_eq!(
            (info.tip_height, info.consensus_branch_id),
            (4_476_200, 0x7719_0ad9)
        );

        // A node on another upgrade than this build stamps.
        let err = run(preflight(&source(api_saying("37a5165b", None)))).unwrap_err();
        assert!(
            matches!(
                err,
                BackendError::BranchMismatch {
                    node: 0x37a5_165b,
                    expected: 0x7719_0ad9,
                    height: 4_476_201
                }
            ),
            "{err}"
        );
        assert!(err.to_string().contains("37a5165b"), "{err}");

        // A node that serves no Ironwood tree state.
        let err = run(preflight(&source(api_saying("77190ad9", Some(""))))).unwrap_err();
        assert!(matches!(err, BackendError::IronwoodTreeMissing), "{err}");

        // A node that serves the other network.
        let wrong = LightwalletdSource::with_api(api_saying("77190ad9", None), Network::Mainnet);
        let err = run(preflight(&wrong)).unwrap_err();
        assert!(matches!(err, BackendError::Chain(_)), "{err}");
    }

    // covers: REQ-TX-004
    #[test]
    fn a_real_mainnet_tree_state_parses_to_the_anchor_a_batch_needs() {
        let tree = field_of(MAINNET_TREE_STATE_FIXTURE, "ironwood_tree_hex ");
        let root = ironwood_anchor_at(Network::Mainnet, 3_522_400, &tree).unwrap();
        assert_eq!(
            hex::encode(root),
            field_of(MAINNET_TREE_STATE_FIXTURE, "ironwood_root_hex ")
        );
        // Mainnet's Ironwood tree has notes in it: the root is not the empty tree's.
        assert_ne!(root, orchard::Anchor::empty_tree().to_bytes());
        assert!(Option::<orchard::Anchor>::from(orchard::Anchor::from_bytes(root)).is_some());
    }

    /// Read-only calls against the public testnet endpoint. Run with `--ignored`.
    #[test]
    #[ignore = "network: talks to testnet.zec.rocks"]
    fn live_testnet_read_only() {
        let keys = test_keys(0);
        let config = ChainConfig::new("https://testnet.zec.rocks:443", Network::Testnet);
        let (mut b, info) = LightwalletdBackend::connect(&config, &keys).unwrap();
        assert_eq!(info.consensus_branch_id, 0x7719_0ad9, "testnet is on NU7");
        let tip = b.tip_height().unwrap();
        assert!(tip >= 4_465_026);
        b.ironwood_anchor(tip).unwrap();
        let nowhere = OutPoint {
            txid: Txid::from_bytes([0x5a; 32]),
            vout: 0,
        };
        assert_eq!(b.prevout(&nowhere).unwrap(), None);
        assert_eq!(b.status(&nowhere.txid).unwrap(), TxStatus::Unknown);
    }
}
