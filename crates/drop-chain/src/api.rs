//! The few gRPC calls the project needs, as a trait, and the tonic implementation.

use std::future::Future;

use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Code, Status};

use crate::client::ChainError;
use crate::config::ChainConfig;
use crate::proto::compact_tx_streamer_client::CompactTxStreamerClient;
use crate::proto::{BlockId, ChainSpec, Empty, GetAddressUtxosArg, RawTransaction, TxFilter};

/// Why a gRPC call failed. Fixed text only: the server's own messages are not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// The server could not be reached or refused the call.
    #[error("the lightwalletd server is unavailable")]
    Unavailable,
    /// The server answered with data that makes no sense.
    #[error("the lightwalletd server returned an invalid response")]
    Invalid,
}

/// A transaction as the server returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawTx {
    /// The serialized transaction.
    pub data: Vec<u8>,
    /// `0` for the mempool, `u64::MAX` for a fork, otherwise the mining height.
    pub height: u64,
}

/// The server's answer to a broadcast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendResponse {
    /// Zero on success.
    pub error_code: i32,
    /// The server's text; not for display to untrusted viewers.
    pub error_message: String,
}

/// What the server says about itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    /// `main` or `test`.
    pub chain_name: String,
    /// The server's tip height.
    pub block_height: u64,
    /// The consensus branch id of the current network upgrade, as lowercase hex
    /// (for example `77190ad9`).
    pub consensus_branch_id: String,
}

/// One unspent output of an address, as the server reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UtxoReply {
    /// The transaction id, in wire byte order.
    pub txid: Vec<u8>,
    /// Output index.
    pub index: i32,
    /// The output script.
    pub script: Vec<u8>,
    /// The value in zatoshi.
    pub value_zat: i64,
    /// Mining height, `0` if unmined.
    pub height: u64,
}

/// The calls `drop-chain` makes. Implemented over tonic by [`GrpcApi`], and by
/// fakes in tests.
pub trait StreamerApi: Send + Sync {
    /// The transaction with this wire-order hash, or `None` if the server has no such one.
    fn get_transaction(
        &self,
        wire_hash: [u8; 32],
    ) -> impl Future<Output = Result<Option<RawTx>, ApiError>> + Send;

    /// The height of the server's latest block.
    fn latest_height(&self) -> impl Future<Output = Result<u64, ApiError>> + Send;

    /// Submits a raw transaction.
    fn send_transaction(
        &self,
        raw: Vec<u8>,
    ) -> impl Future<Output = Result<SendResponse, ApiError>> + Send;

    /// The unspent outputs of one transparent address.
    fn address_utxos(
        &self,
        address: &str,
    ) -> impl Future<Output = Result<Vec<UtxoReply>, ApiError>> + Send;

    /// Which chain the server serves.
    fn server_info(&self) -> impl Future<Output = Result<ServerInfo, ApiError>> + Send;

    /// The Ironwood commitment tree state after block `height`, as the hex string lightwalletd
    /// reports (empty for the empty tree). A transaction builder derives its anchor from it.
    ///
    /// The default reports an invalid response, so fakes written before this call existed
    /// keep compiling; real servers override it.
    fn ironwood_tree(&self, height: u64) -> impl Future<Output = Result<String, ApiError>> + Send {
        let _ = height;
        async { Err(ApiError::Invalid) }
    }
}

/// How a gRPC failure is treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StatusClass {
    /// The server says it has no such transaction.
    NotFound,
    /// Anything else: treat the server as unavailable.
    Unavailable,
}

/// Classifies a failed `GetTransaction`. Only an explicit "not found" counts as
/// absence; every other failure is an outage, so an outage can never be mistaken for
/// "the transaction does not exist".
pub(crate) fn classify(status: &Status) -> StatusClass {
    let says_missing = status
        .message()
        .to_ascii_lowercase()
        .contains("no such mempool or blockchain transaction");
    if status.code() == Code::NotFound
        || (matches!(status.code(), Code::Unknown | Code::InvalidArgument) && says_missing)
    {
        StatusClass::NotFound
    } else {
        StatusClass::Unavailable
    }
}

/// The tonic implementation of [`StreamerApi`].
#[derive(Clone, Debug)]
pub struct GrpcApi {
    client: CompactTxStreamerClient<Channel>,
}

impl GrpcApi {
    /// Prepares a client. No connection is made until the first call.
    pub fn connect_lazy(config: &ChainConfig) -> Result<Self, ChainError> {
        let uri = config.uri()?;
        let mut endpoint =
            Endpoint::from_shared(uri.to_string()).map_err(|_| ChainError::BadEndpoint)?;
        if config.uses_tls() {
            endpoint = endpoint
                .tls_config(ClientTlsConfig::new().with_webpki_roots())
                .map_err(|_| ChainError::BadEndpoint)?;
        }
        let channel = endpoint
            .connect_timeout(config.connect_timeout)
            .timeout(config.request_timeout)
            .connect_lazy();
        Ok(GrpcApi {
            client: CompactTxStreamerClient::new(channel),
        })
    }
}

impl StreamerApi for GrpcApi {
    async fn get_transaction(&self, wire_hash: [u8; 32]) -> Result<Option<RawTx>, ApiError> {
        let filter = TxFilter {
            block: None,
            index: 0,
            hash: wire_hash.to_vec(),
        };
        match self.client.clone().get_transaction(filter).await {
            Ok(response) => {
                let RawTransaction { data, height } = response.into_inner();
                Ok((!data.is_empty()).then_some(RawTx { data, height }))
            }
            Err(status) => match classify(&status) {
                StatusClass::NotFound => Ok(None),
                StatusClass::Unavailable => Err(ApiError::Unavailable),
            },
        }
    }

    async fn latest_height(&self) -> Result<u64, ApiError> {
        let block = self
            .client
            .clone()
            .get_latest_block(ChainSpec {})
            .await
            .map_err(|_| ApiError::Unavailable)?;
        Ok(block.into_inner().height)
    }

    async fn send_transaction(&self, raw: Vec<u8>) -> Result<SendResponse, ApiError> {
        let response = self
            .client
            .clone()
            .send_transaction(RawTransaction {
                data: raw,
                height: 0,
            })
            .await
            .map_err(|_| ApiError::Unavailable)?
            .into_inner();
        Ok(SendResponse {
            error_code: response.error_code,
            error_message: response.error_message,
        })
    }

    async fn address_utxos(&self, address: &str) -> Result<Vec<UtxoReply>, ApiError> {
        let reply = self
            .client
            .clone()
            .get_address_utxos(GetAddressUtxosArg {
                addresses: vec![address.to_owned()],
                start_height: 0,
                max_entries: 0,
            })
            .await
            .map_err(|_| ApiError::Unavailable)?
            .into_inner();
        Ok(reply
            .address_utxos
            .into_iter()
            .map(|u| UtxoReply {
                txid: u.txid,
                index: u.index,
                script: u.script,
                value_zat: u.value_zat,
                height: u.height,
            })
            .collect())
    }

    async fn ironwood_tree(&self, height: u64) -> Result<String, ApiError> {
        let state = self
            .client
            .clone()
            .get_tree_state(BlockId {
                height,
                hash: Vec::new(),
            })
            .await
            .map_err(|_| ApiError::Unavailable)?
            .into_inner();
        Ok(state.ironwood_tree)
    }

    async fn server_info(&self) -> Result<ServerInfo, ApiError> {
        let info = self
            .client
            .clone()
            .get_lightd_info(Empty {})
            .await
            .map_err(|_| ApiError::Unavailable)?
            .into_inner();
        Ok(ServerInfo {
            chain_name: info.chain_name,
            block_height: info.block_height,
            consensus_branch_id: info.consensus_branch_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(code: Code, message: &str) -> Status {
        Status::new(code, message)
    }

    #[test]
    fn only_an_explicit_not_found_is_absence() {
        assert_eq!(classify(&status(Code::NotFound, "")), StatusClass::NotFound);
        assert_eq!(
            classify(&status(
                Code::Unknown,
                "-5: No such mempool or blockchain transaction. Use gettransaction for wallet transactions."
            )),
            StatusClass::NotFound
        );
        assert_eq!(
            classify(&status(
                Code::InvalidArgument,
                "no such mempool or blockchain transaction"
            )),
            StatusClass::NotFound
        );
    }

    #[test]
    fn every_other_failure_is_an_outage_never_absence() {
        for code in [
            Code::Unavailable,
            Code::DeadlineExceeded,
            Code::Internal,
            Code::Unauthenticated,
            Code::ResourceExhausted,
            Code::Cancelled,
            Code::Unknown,
            Code::InvalidArgument,
        ] {
            assert_eq!(
                classify(&status(code, "connection reset")),
                StatusClass::Unavailable,
                "{code:?}"
            );
        }
        // The phrase under a code that cannot mean "missing" is not trusted either.
        assert_eq!(
            classify(&status(
                Code::Unavailable,
                "no such mempool or blockchain transaction"
            )),
            StatusClass::Unavailable
        );
    }

    #[tokio::test]
    async fn a_lazy_client_builds_without_touching_the_network() {
        let config = ChainConfig::new(
            "https://does-not-exist.invalid:443",
            drop_core::Network::Testnet,
        );
        let api = GrpcApi::connect_lazy(&config).unwrap();
        // The first call fails (no such host) as an outage, not a panic or a "not found".
        let mut quick = config.clone();
        quick.connect_timeout = std::time::Duration::from_millis(200);
        quick.request_timeout = std::time::Duration::from_millis(500);
        let api2 = GrpcApi::connect_lazy(&quick).unwrap();
        assert_eq!(
            api2.get_transaction([0; 32]).await.unwrap_err(),
            ApiError::Unavailable
        );
        drop(api);
        assert!(
            GrpcApi::connect_lazy(&ChainConfig::new("nonsense", drop_core::Network::Testnet))
                .is_err()
        );
    }
}
