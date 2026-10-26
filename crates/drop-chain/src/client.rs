//! The chain source and the broadcast / UTXO helpers, over any [`StreamerApi`].

use drop_core::{Network, OutPoint, Txid, Zatoshi};
use drop_verify::{ChainSource, FetchedTx, ParsedTx, SourceError};
use thiserror::Error;

use crate::api::{ApiError, GrpcApi, StreamerApi, UtxoReply};
use crate::config::ChainConfig;

/// Failures of the helpers that are not part of [`ChainSource`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ChainError {
    /// The endpoint URL is not usable.
    #[error("the endpoint must be an http or https URL with a host and no credentials")]
    BadEndpoint,
    /// The server could not be reached or refused the call.
    #[error("the lightwalletd server is unavailable")]
    Unavailable,
    /// The server returned data that makes no sense.
    #[error("the lightwalletd server returned an invalid response")]
    Invalid,
    /// The server serves a different chain than configured.
    #[error("the server serves a different network than the one configured")]
    WrongNetwork,
    /// The endpoint uses plain `http` to a host that is not loopback. (The message never
    /// contains the endpoint, so credentials in it cannot leak.)
    #[error("plain http is allowed only for a loopback host (localhost, 127.0.0.0/8, ::1); use an https endpoint")]
    InsecureEndpoint,
}

impl From<ApiError> for ChainError {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::Unavailable => ChainError::Unavailable,
            ApiError::Invalid => ChainError::Invalid,
        }
    }
}

impl From<ApiError> for SourceError {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::Unavailable => SourceError::Unavailable,
            ApiError::Invalid => SourceError::Inconsistent,
        }
    }
}

/// What a server reports about the chain it serves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainInfo {
    /// The network, as checked against the configuration.
    pub network: Network,
    /// The server's tip height.
    pub tip_height: u32,
    /// The consensus branch id of the current network upgrade (for example
    /// `0x77190ad9` for NU7 on testnet). A transaction builder needs it to stamp
    /// the right branch.
    pub consensus_branch_id: u32,
}

/// The result of submitting a transaction. Every variant carries the txid computed from the
/// submitted bytes, so a caller never loses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BroadcastOutcome {
    /// The server accepted it.
    Accepted {
        /// The transaction id of the submitted bytes.
        txid: Txid,
    },
    /// The server already has it, in the mempool or mined at `mined_height`. For a re-send of a
    /// stored transaction this is success. Decided by asking the node for the txid after a
    /// refusal or a lost reply (wording is only a fallback when the node cannot be asked).
    AlreadyKnown {
        /// The transaction id of the submitted bytes.
        txid: Txid,
        /// The block height, if the node reports it mined.
        mined_height: Option<u32>,
    },
    /// The server refused it and does not have it.
    Rejected {
        /// The transaction id of the submitted bytes.
        txid: Txid,
        /// The server's error code.
        code: i32,
        /// The server's error text; do not show it to untrusted viewers.
        message: String,
    },
}

impl BroadcastOutcome {
    /// The transaction id of the submitted bytes.
    pub fn txid(&self) -> Txid {
        match self {
            BroadcastOutcome::Accepted { txid }
            | BroadcastOutcome::AlreadyKnown { txid, .. }
            | BroadcastOutcome::Rejected { txid, .. } => *txid,
        }
    }

    /// Whether the node has the transaction (accepted now or already known).
    pub fn is_success(&self) -> bool {
        !matches!(self, BroadcastOutcome::Rejected { .. })
    }
}

/// A broadcast whose outcome is unknown (the node could not be reached or asked). It keeps the
/// txid, so the caller can poll it and must re-send the same bytes, never rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("{error}; transaction {}", txid.map_or("unparseable".to_owned(), |t| t.to_string()))]
pub struct BroadcastError {
    /// The txid of the submitted bytes, or `None` if they do not parse as a transaction.
    pub txid: Option<Txid>,
    /// Why the outcome is unknown.
    pub error: ChainError,
}

/// Whether a refusal's text says the node already has the transaction. Only a fallback: the
/// node is asked for the txid first.
///
/// Zebra (via lightwalletd v0.5.4, observed on testnet 2026-10-08 when re-sending a mined
/// batch) answers code -1 "any transaction with the same effects will be rejected from the
/// mempool until a chain reset: transaction was committed to the best chain". Only the last
/// clause means "known": the same prefix also wraps "best chain tip has reached transaction
/// expiry height", "transaction inputs were spent, or nullifiers were revealed, in the best
/// chain" and a ZIP-401 eviction (`zebrad/src/components/mempool/storage.rs`), none of which
/// mean the node has this transaction. Zebra's in-mempool wording is "transaction already
/// exists in mempool"; the others are zcashd's.
pub fn refusal_says_already_known(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    [
        // Zebra
        "transaction was committed to the best chain",
        "transaction already exists in mempool",
        // zcashd
        "already in block chain",
        "already in mempool",
        "already-in-mempool",
        "txn-already-known",
        "already known",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// An unspent transparent output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Utxo {
    /// Which output.
    pub outpoint: OutPoint,
    /// Its value.
    pub value: Zatoshi,
    /// Its script.
    pub script_pubkey: Vec<u8>,
    /// The mining height, `None` if unmined.
    pub height: Option<u32>,
}

/// Reads and writes the chain through a lightwalletd-compatible server.
#[derive(Clone, Debug)]
pub struct LightwalletdSource<A: StreamerApi = GrpcApi> {
    api: A,
    network: Network,
}

impl LightwalletdSource<GrpcApi> {
    /// Connects to the configured endpoint and checks, before returning, that it
    /// serves the configured network. Returns the source together with the live
    /// chain info. Fails fast: a wrong network is [`ChainError::WrongNetwork`], an
    /// unreachable server [`ChainError::Unavailable`].
    pub async fn connect(config: &ChainConfig) -> Result<(Self, ChainInfo), ChainError> {
        let source = Self::connect_lazy(config)?;
        let info = source.chain_info().await?;
        Ok((source, info))
    }

    /// Prepares a source for `config`; connects lazily on first use, without checking
    /// anything. Prefer [`LightwalletdSource::connect`].
    pub fn connect_lazy(config: &ChainConfig) -> Result<Self, ChainError> {
        Ok(LightwalletdSource::with_api(
            GrpcApi::connect_lazy(config)?,
            config.network,
        ))
    }
}

/// The chain name lightwalletd reports for a network.
fn chain_name(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "main",
        Network::Testnet => "test",
    }
}

impl<A: StreamerApi> LightwalletdSource<A> {
    /// A source over an arbitrary [`StreamerApi`].
    pub fn with_api(api: A, network: Network) -> Self {
        LightwalletdSource { api, network }
    }

    /// The configured network.
    pub fn network(&self) -> Network {
        self.network
    }

    /// Reads `GetLightdInfo` and returns the live tip height and consensus branch id,
    /// failing with [`ChainError::WrongNetwork`] if the server serves another chain.
    pub async fn chain_info(&self) -> Result<ChainInfo, ChainError> {
        let info = self.api.server_info().await?;
        if info.chain_name != chain_name(self.network) {
            return Err(ChainError::WrongNetwork);
        }
        Ok(ChainInfo {
            network: self.network,
            tip_height: u32::try_from(info.block_height).map_err(|_| ChainError::Invalid)?,
            consensus_branch_id: u32::from_str_radix(&info.consensus_branch_id, 16)
                .map_err(|_| ChainError::Invalid)?,
        })
    }

    /// Confirms the server serves the configured network.
    pub async fn check_network(&self) -> Result<(), ChainError> {
        self.chain_info().await.map(|_| ())
    }

    /// The Ironwood commitment tree state after block `height`, as lightwalletd's hex
    /// string (empty for the empty tree). A builder derives its anchor from it.
    pub async fn ironwood_tree_hex(&self, height: u32) -> Result<String, ChainError> {
        Ok(self.api.ironwood_tree(u64::from(height)).await?)
    }

    /// Submits a raw transaction, robustly against lost replies and unfamiliar refusal wording:
    /// after any refusal, and after a failed send, the node is asked for the txid; if it has the
    /// transaction (mempool or mined) the outcome is [`BroadcastOutcome::AlreadyKnown`]. Only a
    /// refusal for a transaction the node does not have is [`BroadcastOutcome::Rejected`].
    /// When the outcome cannot be determined the error keeps the txid.
    pub async fn broadcast(&self, raw_tx: &[u8]) -> Result<BroadcastOutcome, BroadcastError> {
        let txid = ParsedTx::parse_any_version(raw_tx)
            .map(|parsed| parsed.txid())
            .map_err(|_| BroadcastError {
                txid: None,
                error: ChainError::Invalid,
            })?;
        let unknown = |error: ChainError| BroadcastError {
            txid: Some(txid),
            error,
        };
        let known = |fetched: drop_verify::FetchedTx| BroadcastOutcome::AlreadyKnown {
            txid,
            mined_height: fetched.mined_height,
        };
        match self.api.send_transaction(raw_tx.to_vec()).await {
            Ok(response) if response.error_code == 0 => Ok(BroadcastOutcome::Accepted { txid }),
            Ok(response) => match self.transaction(&txid).await {
                Ok(Some(fetched)) => Ok(known(fetched)),
                // The node does not have it. Trust a refusal that says otherwise anyway: a
                // false "failed" could lead to a rebuild and a second payment, a false
                // "known" only to a batch that never confirms.
                Ok(None) if refusal_says_already_known(&response.error_message) => {
                    Ok(BroadcastOutcome::AlreadyKnown {
                        txid,
                        mined_height: None,
                    })
                }
                Ok(None) => Ok(BroadcastOutcome::Rejected {
                    txid,
                    code: response.error_code,
                    message: response.error_message,
                }),
                Err(_) if refusal_says_already_known(&response.error_message) => {
                    Ok(BroadcastOutcome::AlreadyKnown {
                        txid,
                        mined_height: None,
                    })
                }
                Err(_) => Err(unknown(ChainError::Unavailable)),
            },
            // The reply was lost (e.g. a timeout after the node accepted): ask before failing.
            Err(error) => match self.transaction(&txid).await {
                Ok(Some(fetched)) => Ok(known(fetched)),
                _ => Err(unknown(error.into())),
            },
        }
    }

    /// Lists the unspent outputs of a transparent address.
    pub async fn utxos(&self, address: &str) -> Result<Vec<Utxo>, ChainError> {
        self.api
            .address_utxos(address)
            .await?
            .into_iter()
            .map(utxo_from_reply)
            .collect()
    }
}

fn utxo_from_reply(reply: UtxoReply) -> Result<Utxo, ChainError> {
    let mut wire: [u8; 32] = reply.txid.try_into().map_err(|_| ChainError::Invalid)?;
    wire.reverse();
    Ok(Utxo {
        outpoint: OutPoint {
            txid: Txid::from_bytes(wire),
            vout: u32::try_from(reply.index).map_err(|_| ChainError::Invalid)?,
        },
        value: u64::try_from(reply.value_zat)
            .ok()
            .and_then(|v| Zatoshi::new(v).ok())
            .ok_or(ChainError::Invalid)?,
        script_pubkey: reply.script,
        height: match reply.height {
            0 => None,
            h => Some(u32::try_from(h).map_err(|_| ChainError::Invalid)?),
        },
    })
}

impl<A: StreamerApi> ChainSource for LightwalletdSource<A> {
    async fn transaction(&self, txid: &Txid) -> Result<Option<FetchedTx>, SourceError> {
        let mut wire = *txid.as_bytes();
        wire.reverse();
        let Some(raw) = self.api.get_transaction(wire).await? else {
            return Ok(None);
        };
        let mined_height = match raw.height {
            // The mempool, or mined on a fork that is not the main chain.
            0 | u64::MAX => None,
            h => Some(u32::try_from(h).map_err(|_| SourceError::Inconsistent)?),
        };
        Ok(Some(FetchedTx {
            raw: raw.data,
            mined_height,
        }))
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        let height = self.api.latest_height().await?;
        u32::try_from(height).map_err(|_| SourceError::Inconsistent)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::api::{RawTx, SendResponse, ServerInfo};

    /// A scripted server that records what it was asked.
    #[derive(Default)]
    struct FakeApi {
        tx: Option<Result<Option<RawTx>, ApiError>>,
        height: Option<Result<u64, ApiError>>,
        send: Option<Result<SendResponse, ApiError>>,
        utxos: Option<Result<Vec<UtxoReply>, ApiError>>,
        info: Option<Result<ServerInfo, ApiError>>,
        tree: Option<Result<String, ApiError>>,
        asked_tree_height: Mutex<Option<u64>>,
        asked_hash: Mutex<Option<[u8; 32]>>,
        sent: Mutex<Option<Vec<u8>>>,
        asked_address: Mutex<Option<String>>,
    }

    impl StreamerApi for FakeApi {
        async fn get_transaction(&self, wire_hash: [u8; 32]) -> Result<Option<RawTx>, ApiError> {
            *self.asked_hash.lock().unwrap() = Some(wire_hash);
            self.tx.clone().unwrap_or(Ok(None))
        }

        async fn latest_height(&self) -> Result<u64, ApiError> {
            self.height.unwrap_or(Err(ApiError::Unavailable))
        }

        async fn send_transaction(&self, raw: Vec<u8>) -> Result<SendResponse, ApiError> {
            *self.sent.lock().unwrap() = Some(raw);
            self.send.clone().unwrap_or(Err(ApiError::Unavailable))
        }

        async fn address_utxos(&self, address: &str) -> Result<Vec<UtxoReply>, ApiError> {
            *self.asked_address.lock().unwrap() = Some(address.to_owned());
            self.utxos.clone().unwrap_or(Err(ApiError::Unavailable))
        }

        async fn server_info(&self) -> Result<ServerInfo, ApiError> {
            self.info.clone().unwrap_or(Err(ApiError::Unavailable))
        }

        async fn ironwood_tree(&self, height: u64) -> Result<String, ApiError> {
            *self.asked_tree_height.lock().unwrap() = Some(height);
            self.tree.clone().unwrap_or(Err(ApiError::Unavailable))
        }
    }

    fn source(api: FakeApi) -> LightwalletdSource<FakeApi> {
        LightwalletdSource::with_api(api, Network::Testnet)
    }

    fn display_txid() -> Txid {
        // Display order 00 01 02 ... 1f.
        Txid::from_bytes(std::array::from_fn(|i| u8::try_from(i).unwrap()))
    }

    fn raw(height: u64) -> RawTx {
        RawTx {
            data: vec![1, 2, 3],
            height,
        }
    }

    // covers: REQ-VER-001
    #[tokio::test]
    async fn transactions_are_requested_in_wire_byte_order() {
        let s = source(FakeApi {
            tx: Some(Ok(Some(raw(10)))),
            ..FakeApi::default()
        });
        s.transaction(&display_txid()).await.unwrap();
        let asked = s.api.asked_hash.lock().unwrap().unwrap();
        let expected: [u8; 32] = std::array::from_fn(|i| u8::try_from(31 - i).unwrap());
        assert_eq!(
            asked, expected,
            "the hash on the wire is the display order reversed"
        );
    }

    // covers: REQ-VER-003
    #[tokio::test]
    async fn heights_map_to_mined_height_or_none() {
        for (height, expected) in [
            (4_135_000u64, Some(4_135_000u32)),
            (1, Some(1)),
            (0, None),        // mempool
            (u64::MAX, None), // mined on a fork
        ] {
            let s = source(FakeApi {
                tx: Some(Ok(Some(raw(height)))),
                ..FakeApi::default()
            });
            let fetched = s.transaction(&display_txid()).await.unwrap().unwrap();
            assert_eq!(fetched.mined_height, expected, "height {height}");
            assert_eq!(fetched.raw, vec![1, 2, 3]);
        }
        // A height that does not fit a block height is inconsistent, not truncated.
        let s = source(FakeApi {
            tx: Some(Ok(Some(raw(u64::from(u32::MAX) + 1)))),
            ..FakeApi::default()
        });
        assert_eq!(
            s.transaction(&display_txid()).await.unwrap_err(),
            SourceError::Inconsistent
        );
    }

    // covers: REQ-VER-001
    #[tokio::test]
    async fn absence_and_outage_stay_distinct() {
        let missing = source(FakeApi {
            tx: Some(Ok(None)),
            ..FakeApi::default()
        });
        assert_eq!(missing.transaction(&display_txid()).await.unwrap(), None);
        let down = source(FakeApi {
            tx: Some(Err(ApiError::Unavailable)),
            ..FakeApi::default()
        });
        assert_eq!(
            down.transaction(&display_txid()).await.unwrap_err(),
            SourceError::Unavailable
        );
        let odd = source(FakeApi {
            tx: Some(Err(ApiError::Invalid)),
            ..FakeApi::default()
        });
        assert_eq!(
            odd.transaction(&display_txid()).await.unwrap_err(),
            SourceError::Inconsistent
        );
    }

    #[tokio::test]
    async fn the_tip_height_maps_and_checks_range() {
        let s = source(FakeApi {
            height: Some(Ok(4_200_000)),
            ..FakeApi::default()
        });
        assert_eq!(s.tip_height().await.unwrap(), 4_200_000);
        let huge = source(FakeApi {
            height: Some(Ok(u64::MAX)),
            ..FakeApi::default()
        });
        assert_eq!(
            huge.tip_height().await.unwrap_err(),
            SourceError::Inconsistent
        );
        let down = source(FakeApi::default());
        assert_eq!(
            down.tip_height().await.unwrap_err(),
            SourceError::Unavailable
        );
    }

    /// A real (TEST-ONLY) V5 transaction from drop-verify's fixture, so the txid is computed.
    const TX_HEX: &str = "050000800a27a72630f33754000000000000000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000ffffffff01836e5106000000001976a914fc7250a211deddc70ee5a2738de5f07817351cef88ac000000";
    const TX_ID: &str = "8f32a681a5713d46fbdbe26d069ef69cb2d9c2540616ffa788de476d4a54bae1";

    fn tx_bytes() -> Vec<u8> {
        (0..TX_HEX.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&TX_HEX[i..i + 2], 16).unwrap())
            .collect()
    }

    fn node(
        send: Result<SendResponse, ApiError>,
        tx: Result<Option<RawTx>, ApiError>,
    ) -> LightwalletdSource<FakeApi> {
        source(FakeApi {
            send: Some(send),
            tx: Some(tx),
            ..FakeApi::default()
        })
    }

    fn refusal(code: i32, message: &str) -> Result<SendResponse, ApiError> {
        Ok(SendResponse {
            error_code: code,
            error_message: message.into(),
        })
    }

    #[tokio::test]
    async fn broadcast_accepted_carries_the_txid() {
        let s = node(refusal(0, ""), Ok(None));
        let txid: Txid = TX_ID.parse().unwrap();
        assert_eq!(
            s.broadcast(&tx_bytes()).await.unwrap(),
            BroadcastOutcome::Accepted { txid }
        );
        assert_eq!(s.api.sent.lock().unwrap().clone(), Some(tx_bytes()));
    }

    #[tokio::test]
    async fn broadcast_refused_but_already_in_the_mempool_or_mined_is_success() {
        let txid: Txid = TX_ID.parse().unwrap();
        let mempool = node(refusal(-26, "txn-already-in-mempool"), Ok(Some(raw(0))));
        assert_eq!(
            mempool.broadcast(&tx_bytes()).await.unwrap(),
            BroadcastOutcome::AlreadyKnown {
                txid,
                mined_height: None
            }
        );
        let mined = node(
            refusal(-27, "transaction already in block chain"),
            Ok(Some(raw(4_476_300))),
        );
        let outcome = mined.broadcast(&tx_bytes()).await.unwrap();
        assert_eq!(
            outcome,
            BroadcastOutcome::AlreadyKnown {
                txid,
                mined_height: Some(4_476_300)
            }
        );
        assert!(outcome.is_success());
    }

    #[tokio::test]
    async fn an_unfamiliar_refusal_for_a_known_tx_is_still_success() {
        // The node's wording is not trusted either way: it is asked for the txid.
        let s = node(
            refusal(-25, "some wording no list has seen"),
            Ok(Some(raw(0))),
        );
        assert!(matches!(
            s.broadcast(&tx_bytes()).await.unwrap(),
            BroadcastOutcome::AlreadyKnown { .. }
        ));
    }

    #[tokio::test]
    async fn a_genuinely_invalid_tx_is_rejected_with_its_txid() {
        let s = node(refusal(-26, "bad-txns-inputs-missingorspent"), Ok(None));
        let outcome = s.broadcast(&tx_bytes()).await.unwrap();
        assert_eq!(
            outcome,
            BroadcastOutcome::Rejected {
                txid: TX_ID.parse().unwrap(),
                code: -26,
                message: "bad-txns-inputs-missingorspent".into()
            }
        );
        assert!(!outcome.is_success());
    }

    #[tokio::test]
    async fn a_lost_reply_after_acceptance_is_success_and_an_unknown_outcome_keeps_the_txid() {
        let txid: Txid = TX_ID.parse().unwrap();
        // The send timed out, but the node had accepted it.
        let accepted = node(Err(ApiError::Unavailable), Ok(Some(raw(0))));
        assert_eq!(
            accepted.broadcast(&tx_bytes()).await.unwrap(),
            BroadcastOutcome::AlreadyKnown {
                txid,
                mined_height: None
            }
        );
        // The send failed and the node does not know it (or cannot be asked).
        for tx in [Ok(None), Err(ApiError::Unavailable)] {
            let down = node(Err(ApiError::Unavailable), tx);
            let err = down.broadcast(&tx_bytes()).await.unwrap_err();
            assert_eq!(
                err,
                BroadcastError {
                    txid: Some(txid),
                    error: ChainError::Unavailable
                }
            );
            assert!(err.to_string().contains(TX_ID));
        }
        // A refusal while the node cannot be asked: unknown, unless the wording says known.
        let unaskable = node(refusal(-26, "bad-txns"), Err(ApiError::Unavailable));
        assert!(unaskable.broadcast(&tx_bytes()).await.is_err());
        let worded = node(
            refusal(-27, "already in block chain"),
            Err(ApiError::Unavailable),
        );
        assert!(worded.broadcast(&tx_bytes()).await.unwrap().is_success());
    }

    #[tokio::test]
    async fn unparseable_bytes_are_never_sent() {
        let s = node(refusal(0, ""), Ok(None));
        assert_eq!(
            s.broadcast(&[1, 2, 3]).await.unwrap_err(),
            BroadcastError {
                txid: None,
                error: ChainError::Invalid
            }
        );
        assert_eq!(s.api.sent.lock().unwrap().clone(), None);
    }

    #[test]
    fn refusal_wordings_that_mean_already_known() {
        for message in [
            "transaction already in block chain",
            "18: txn-already-in-mempool",
            "txn-already-known",
            "Transaction already in mempool",
        ] {
            assert!(refusal_says_already_known(message), "{message}");
        }
        for message in ["bad-txns-inputs-missingorspent", "tx-size-too-large", ""] {
            assert!(!refusal_says_already_known(message), "{message}");
        }
    }

    #[test]
    fn zebras_real_wordings_are_classified_exactly() {
        const PREFIX: &str =
            "any transaction with the same effects will be rejected from the mempool until a chain reset: ";
        // Captured verbatim from testnet.zec.rocks (lightwalletd v0.5.4 / Zebra) on 2026-10-08,
        // re-sending batch 50fb88e0…a3e3 after it was mined.
        let mined = format!("{PREFIX}transaction was committed to the best chain");
        assert!(refusal_says_already_known(&mined));
        assert!(refusal_says_already_known(
            "transaction already exists in mempool"
        ));
        // Same prefix, but the node does NOT have this transaction.
        for reason in [
            "best chain tip has reached transaction expiry height",
            "transaction inputs were spent, or nullifiers were revealed, in the best chain",
            "transaction evicted from the mempool due to ZIP-401 denial of service limits",
        ] {
            let message = format!("{PREFIX}{reason}");
            assert!(!refusal_says_already_known(&message), "{message}");
        }
    }

    #[tokio::test]
    async fn utxos_map_to_display_order_outpoints_and_checked_values() {
        let wire: Vec<u8> = (0..32u8).rev().collect(); // display order 00..1f
        let reply = |value: i64, index: i32, height: u64, txid: Vec<u8>| UtxoReply {
            txid,
            index,
            script: vec![0x76, 0xa9],
            value_zat: value,
            height,
        };
        let s = source(FakeApi {
            utxos: Some(Ok(vec![
                reply(150_000_000, 2, 4_100_000, wire.clone()),
                reply(1, 0, 0, wire.clone()),
            ])),
            ..FakeApi::default()
        });
        let utxos = s.utxos("tmTestAddress").await.unwrap();
        assert_eq!(
            s.api.asked_address.lock().unwrap().clone().as_deref(),
            Some("tmTestAddress")
        );
        assert_eq!(utxos.len(), 2);
        assert_eq!(utxos[0].outpoint.txid, display_txid());
        assert_eq!(
            (
                utxos[0].outpoint.vout,
                utxos[0].value.as_u64(),
                utxos[0].height
            ),
            (2, 150_000_000, Some(4_100_000))
        );
        assert_eq!(utxos[1].height, None, "unmined");
        assert_eq!(utxos[0].script_pubkey, vec![0x76, 0xa9]);
    }

    #[tokio::test]
    async fn malformed_utxo_replies_are_errors_not_clamped_values() {
        let good_txid: Vec<u8> = vec![7; 32];
        let cases: Vec<UtxoReply> = vec![
            UtxoReply {
                txid: vec![1; 31],
                index: 0,
                script: vec![],
                value_zat: 1,
                height: 1,
            },
            UtxoReply {
                txid: good_txid.clone(),
                index: -1,
                script: vec![],
                value_zat: 1,
                height: 1,
            },
            UtxoReply {
                txid: good_txid.clone(),
                index: 0,
                script: vec![],
                value_zat: -5,
                height: 1,
            },
            UtxoReply {
                txid: good_txid.clone(),
                index: 0,
                script: vec![],
                value_zat: i64::MAX,
                height: 1,
            },
            UtxoReply {
                txid: good_txid,
                index: 0,
                script: vec![],
                value_zat: 1,
                height: u64::MAX,
            },
        ];
        for reply in cases {
            let s = source(FakeApi {
                utxos: Some(Ok(vec![reply.clone()])),
                ..FakeApi::default()
            });
            assert_eq!(
                s.utxos("t").await.unwrap_err(),
                ChainError::Invalid,
                "{reply:?}"
            );
        }
    }

    // covers: REQ-VER-003
    #[tokio::test]
    async fn chain_info_exposes_the_live_tip_and_the_consensus_branch() {
        let info = |height: u64, branch: &str| ServerInfo {
            chain_name: "test".into(),
            block_height: height,
            consensus_branch_id: branch.into(),
        };
        let s = source(FakeApi {
            info: Some(Ok(info(4_465_100, "77190ad9"))),
            ..FakeApi::default()
        });
        assert_eq!(
            s.chain_info().await.unwrap(),
            ChainInfo {
                network: Network::Testnet,
                tip_height: 4_465_100,
                consensus_branch_id: 0x7719_0ad9
            }
        );
        let mainnet = LightwalletdSource::with_api(
            FakeApi {
                info: Some(Ok(ServerInfo {
                    chain_name: "main".into(),
                    block_height: 3_428_200,
                    consensus_branch_id: "37a5165b".into(),
                })),
                ..FakeApi::default()
            },
            Network::Mainnet,
        );
        assert_eq!(
            mainnet.chain_info().await.unwrap().consensus_branch_id,
            0x37a5_165b
        );
        // Garbage from the server is an error, never a guess.
        for bad in ["", "zzzz", "123456789", "0x77190ad9"] {
            let s = source(FakeApi {
                info: Some(Ok(info(1, bad))),
                ..FakeApi::default()
            });
            assert_eq!(
                s.chain_info().await.unwrap_err(),
                ChainError::Invalid,
                "{bad:?}"
            );
        }
        let huge = source(FakeApi {
            info: Some(Ok(info(u64::MAX, "77190ad9"))),
            ..FakeApi::default()
        });
        assert_eq!(huge.chain_info().await.unwrap_err(), ChainError::Invalid);
        // The wrong network is reported before any branch parsing.
        let wrong = LightwalletdSource::with_api(
            FakeApi {
                info: Some(Ok(info(1, "zzzz"))),
                ..FakeApi::default()
            },
            Network::Mainnet,
        );
        assert_eq!(
            wrong.chain_info().await.unwrap_err(),
            ChainError::WrongNetwork
        );
    }

    #[tokio::test]
    async fn the_ironwood_tree_state_is_requested_by_height_and_passed_through() {
        let s = source(FakeApi {
            tree: Some(Ok("01abcdef".into())),
            ..FakeApi::default()
        });
        assert_eq!(s.ironwood_tree_hex(4_465_100).await.unwrap(), "01abcdef");
        assert_eq!(*s.api.asked_tree_height.lock().unwrap(), Some(4_465_100));
        // The empty tree is the empty string, and is a valid answer.
        let empty = source(FakeApi {
            tree: Some(Ok(String::new())),
            ..FakeApi::default()
        });
        assert_eq!(empty.ironwood_tree_hex(1).await.unwrap(), "");
        let down = source(FakeApi::default());
        assert_eq!(
            down.ironwood_tree_hex(1).await.unwrap_err(),
            ChainError::Unavailable
        );
    }

    #[tokio::test]
    async fn a_fake_without_tree_support_reports_an_invalid_response() {
        /// Written before `ironwood_tree` existed: relies on the trait default.
        struct Old;
        impl StreamerApi for Old {
            async fn get_transaction(&self, _: [u8; 32]) -> Result<Option<RawTx>, ApiError> {
                Ok(None)
            }
            async fn latest_height(&self) -> Result<u64, ApiError> {
                Ok(1)
            }
            async fn send_transaction(&self, _: Vec<u8>) -> Result<SendResponse, ApiError> {
                Err(ApiError::Unavailable)
            }
            async fn address_utxos(&self, _: &str) -> Result<Vec<UtxoReply>, ApiError> {
                Ok(vec![])
            }
            async fn server_info(&self) -> Result<ServerInfo, ApiError> {
                Err(ApiError::Unavailable)
            }
        }
        let s = LightwalletdSource::with_api(Old, Network::Testnet);
        assert_eq!(
            s.ironwood_tree_hex(1).await.unwrap_err(),
            ChainError::Invalid
        );
    }

    #[tokio::test]
    async fn the_network_check_catches_a_mainnet_testnet_mix_up() {
        let info = |name: &str| ServerInfo {
            chain_name: name.into(),
            block_height: 1,
            consensus_branch_id: "77190ad9".into(),
        };
        let testnet_on_test = source(FakeApi {
            info: Some(Ok(info("test"))),
            ..FakeApi::default()
        });
        assert!(testnet_on_test.check_network().await.is_ok());
        let testnet_on_main = source(FakeApi {
            info: Some(Ok(info("main"))),
            ..FakeApi::default()
        });
        assert_eq!(
            testnet_on_main.check_network().await.unwrap_err(),
            ChainError::WrongNetwork
        );
        let mainnet = LightwalletdSource::with_api(
            FakeApi {
                info: Some(Ok(info("main"))),
                ..FakeApi::default()
            },
            Network::Mainnet,
        );
        assert!(mainnet.check_network().await.is_ok());
        let weird = source(FakeApi {
            info: Some(Ok(info("regtest"))),
            ..FakeApi::default()
        });
        assert_eq!(
            weird.check_network().await.unwrap_err(),
            ChainError::WrongNetwork
        );
        let down = source(FakeApi::default());
        assert_eq!(
            down.check_network().await.unwrap_err(),
            ChainError::Unavailable
        );
    }

    /// Re-sends the first mined ZecDrop batch (public testnet data in `fixtures/`) and checks the
    /// node's refusal is classified as already known, at its mined height. Re-sending a mined
    /// transaction changes nothing. Skipped unless `ZECDROP_TEST_LIGHTWALLETD` names a testnet
    /// endpoint.
    #[tokio::test]
    #[ignore = "needs network access and a testnet endpoint in ZECDROP_TEST_LIGHTWALLETD"]
    async fn re_sending_a_mined_batch_is_already_known_live() {
        let Ok(endpoint) = std::env::var("ZECDROP_TEST_LIGHTWALLETD") else {
            return;
        };
        const TXID: &str = "50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3";
        let hex = include_str!(
            "../../../fixtures/testnet-ironwood-batch/50fb88e02e7f4b0f3b3b658f50b09b12ea973d8c3697f8bad4c59e41075ea3e3/tx.hex"
        )
        .trim();
        let raw: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let source =
            LightwalletdSource::connect_lazy(&ChainConfig::new(endpoint, Network::Testnet))
                .unwrap();
        let outcome = source.broadcast(&raw).await.unwrap();
        assert_eq!(
            outcome,
            BroadcastOutcome::AlreadyKnown {
                txid: TXID.parse().unwrap(),
                mined_height: Some(4_478_065)
            }
        );
    }

    /// Talks to a real server. Skipped unless `ZECDROP_TEST_LIGHTWALLETD` names an
    /// endpoint (and `ZECDROP_TEST_NETWORK` is `mainnet`; default `testnet`).
    #[tokio::test]
    #[ignore = "needs network access and an endpoint in ZECDROP_TEST_LIGHTWALLETD"]
    async fn a_live_server_reports_its_network_and_a_tip() {
        let Ok(endpoint) = std::env::var("ZECDROP_TEST_LIGHTWALLETD") else {
            return;
        };
        let network = if std::env::var("ZECDROP_TEST_NETWORK").as_deref() == Ok("mainnet") {
            Network::Mainnet
        } else {
            Network::Testnet
        };
        let source =
            LightwalletdSource::connect_lazy(&ChainConfig::new(endpoint, network)).unwrap();
        source.check_network().await.unwrap();
        assert!(source.tip_height().await.unwrap() > 0);
    }
}
