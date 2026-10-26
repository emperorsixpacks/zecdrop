//! Minimal lightwalletd / Zaino gRPC client for the live testnet batch (TESTNET ONLY).

use std::collections::HashMap;
use std::time::Duration;

use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, ChainSpec, Empty,
    GetAddressUtxosArg, LightdInfo, RawTransaction, TxFilter,
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::{consensus::BranchId, value::Zatoshis};
use zcash_transparent::{
    address::Script,
    bundle::{OutPoint, TxOut},
};

use crate::FundingCoin;

pub type Client = CompactTxStreamerClient<Channel>;

/// `RawTransaction.height` for a tx that is known but not in the main chain.
const NOT_IN_MAIN_CHAIN: u64 = u64::MAX;

pub async fn connect(url: &str) -> Result<Client, String> {
    let mut endpoint = Endpoint::from_shared(url.to_string())
        .map_err(|e| e.to_string())?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    if url.starts_with("https://") {
        endpoint = endpoint
            .tls_config(ClientTlsConfig::new().with_webpki_roots())
            .map_err(|e| e.to_string())?;
    }
    let channel = endpoint
        .connect()
        .await
        .map_err(|e| format!("connect {url}: {e:?}"))?;
    Ok(CompactTxStreamerClient::new(channel).max_decoding_message_size(32 * 1024 * 1024))
}

/// `GetLightdInfo`, refusing anything that is not testnet.
pub async fn testnet_info(client: &mut Client) -> Result<LightdInfo, String> {
    let info = client
        .get_lightd_info(Empty {})
        .await
        .map_err(|e| e.to_string())?
        .into_inner();
    match info.chain_name.as_str() {
        "test" | "testnet" => Ok(info),
        other => Err(format!(
            "refusing to talk to a '{other}' server: this tool is TESTNET ONLY"
        )),
    }
}

pub async fn tip_height(client: &mut Client) -> Result<u32, String> {
    let block = client
        .get_latest_block(ChainSpec {})
        .await
        .map_err(|e| e.to_string())?
        .into_inner();
    u32::try_from(block.height).map_err(|e| e.to_string())
}

/// The Ironwood note-commitment-tree root after block `height`.
pub async fn ironwood_anchor(client: &mut Client, height: u32) -> Result<orchard::Anchor, String> {
    let state = client
        .get_tree_state(BlockId {
            height: height.into(),
            hash: vec![],
        })
        .await
        .map_err(|e| e.to_string())?
        .into_inner();
    let tree = state.ironwood_tree().map_err(|e| e.to_string())?;
    Ok(orchard::Anchor::from(tree.root()))
}

/// Unspent coins at `addresses` (encoded t-addrs), with each coin's script as reported.
pub async fn utxos(client: &mut Client, addresses: &[String]) -> Result<Vec<FundingCoin>, String> {
    let reply = client
        .get_address_utxos(GetAddressUtxosArg {
            addresses: addresses.to_vec(),
            start_height: 0,
            max_entries: 0,
        })
        .await
        .map_err(|e| e.to_string())?
        .into_inner();
    reply
        .address_utxos
        .into_iter()
        .map(|u| {
            let txid: [u8; 32] = u
                .txid
                .as_slice()
                .try_into()
                .map_err(|_| "bad txid length")?;
            let index = u32::try_from(u.index).map_err(|_| "bad output index")?;
            let value =
                Zatoshis::from_u64(u64::try_from(u.value_zat).map_err(|_| "negative value")?)
                    .map_err(|e| format!("{e:?}"))?;
            Ok(FundingCoin {
                outpoint: OutPoint::new(txid, index),
                coin: TxOut::new(value, Script(zcash_script::script::Code(u.script))),
            })
        })
        .collect()
}

/// Broadcasts raw tx bytes; lightwalletd reports rejection through `error_code`.
pub async fn send(client: &mut Client, tx_bytes: &[u8]) -> Result<String, String> {
    let resp = client
        .send_transaction(RawTransaction {
            data: tx_bytes.to_vec(),
            height: 0,
        })
        .await
        .map_err(|e| e.to_string())?
        .into_inner();
    if resp.error_code == 0 {
        Ok(resp.error_message)
    } else {
        Err(format!(
            "SendTransaction rejected (code {}): {}",
            resp.error_code, resp.error_message
        ))
    }
}

/// A fetched transaction: raw bytes and mined height (`None` while in the mempool).
pub struct Fetched {
    pub bytes: Vec<u8>,
    pub mined_height: Option<u64>,
}

/// `GetTransaction` by txid. Tries internal byte order (as in `TxId::as_ref`, which lightwalletd
/// expects), then the reversed order. The returned bytes are re-parsed and their txid checked,
/// so a byte-order mistake cannot go unnoticed.
pub async fn get_tx(client: &mut Client, txid: &TxId) -> Result<Fetched, String> {
    match fetch(client, txid.as_ref().to_vec(), txid).await {
        Ok(f) => Ok(f),
        Err(first) => {
            let mut reversed = *txid.as_ref();
            reversed.reverse();
            fetch(client, reversed.to_vec(), txid)
                .await
                .map_err(|second| format!("{first} (reversed order: {second})"))
        }
    }
}

/// Fetches the first transaction of the tip's compact block by its compact-block txid, to show
/// which `TxFilter.hash` byte order the server expects.
pub async fn probe_txid_order(client: &mut Client, tip: u32) -> Result<String, String> {
    let block = client
        .get_block(BlockId {
            height: tip.into(),
            hash: vec![],
        })
        .await
        .map_err(|e| e.to_string())?
        .into_inner();
    let ctx = block
        .vtx
        .first()
        .ok_or("tip compact block has no transactions")?;
    let txid = TxId::from_bytes(
        ctx.txid
            .as_slice()
            .try_into()
            .map_err(|_| "bad compact txid")?,
    );
    if fetch(client, txid.as_ref().to_vec(), &txid).await.is_ok() {
        return Ok(format!(
            "{txid}: found with INTERNAL byte order (TxId::as_ref)"
        ));
    }
    let mut reversed = *txid.as_ref();
    reversed.reverse();
    fetch(client, reversed.to_vec(), &txid).await?;
    Ok(format!("{txid}: found with REVERSED (display) byte order"))
}

async fn fetch(client: &mut Client, hash: Vec<u8>, expect: &TxId) -> Result<Fetched, String> {
    let raw = client
        .get_transaction(TxFilter {
            block: None,
            index: 0,
            hash,
        })
        .await
        .map_err(|e| e.message().to_string())?
        .into_inner();
    let parsed =
        Transaction::read(raw.data.as_slice(), BranchId::Nu6_3).map_err(|e| e.to_string())?;
    if parsed.txid() != *expect {
        return Err(format!("server returned {} for {expect}", parsed.txid()));
    }
    let mined_height = match raw.height {
        0 | NOT_IN_MAIN_CHAIN => None,
        h => Some(h),
    };
    Ok(Fetched {
        bytes: raw.data,
        mined_height,
    })
}

/// Resolves every transparent prevout of `tx_bytes` by fetching the funding transactions.
pub async fn resolve_prevouts(
    client: &mut Client,
    tx_bytes: &[u8],
) -> Result<HashMap<OutPoint, TxOut>, String> {
    let tx = Transaction::read(tx_bytes, BranchId::Nu6_3).map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    if let Some(t) = tx.transparent_bundle() {
        for txin in &t.vin {
            let prevout = txin.prevout();
            let fetched = get_tx(client, prevout.txid()).await?;
            let prev = Transaction::read(fetched.bytes.as_slice(), BranchId::Nu6_3)
                .map_err(|e| e.to_string())?;
            let coin = prev
                .transparent_bundle()
                .and_then(|b| b.vout.get(prevout.n() as usize))
                .ok_or("prevout index out of range")?
                .clone();
            out.insert(prevout.clone(), coin);
        }
    }
    Ok(out)
}
