//! # drop-zcash
//!
//! The Zcash adapter for `drop-core`. Each batch is ONE transaction: the campaign's transparent
//! coins in, one **Ironwood** output per recipient (with a ZIP-302 memo and the campaign OVK),
//! plus transparent change. Ironwood, not Orchard: from NU6.3 no new value may enter the Orchard
//! pool (ZIP-258), and payments to a Unified Address's Orchard receiver go to Ironwood instead.
//! Measured shape and limits: `spikes/single-tx-builder/RESULTS.md`, ADR 0001 and ADR 0005.
//!
//! | Module | Port / role | Requirements |
//! |---|---|---|
//! | [`keys`] | one ZIP 32 account per campaign | REQ-TX-002 |
//! | [`memo`] | ZIP-302 text memos | REQ-TX-003 |
//! | [`codec`] | `drop_core::codec::AddressCodec` | REQ-IMP-001 (core) |
//! | [`builder`] | the batch transaction | REQ-TX-001, REQ-TX-002 |
//! | [`inspect`] | public totals and key-holder recovery of a built/mined tx | REQ-TX-001, REQ-TX-002 |
//! | [`payslip`] | one recipient's proof of payment, issued locally from a viewing key | |
//! | [`chain`] | the small chain port the distributor needs (tip, anchor, prevout, send, status) | |
//! | [`lightwalletd`] | [`ChainBackend`] over `drop-chain`'s key-less client | |
//! | [`distributor`] | `drop_core::engine::Distributor` | REQ-TX-001 |
//!
//! ## Using drop-zcash from the operator
//!
//! The examples below use testnet. [`ZcashDistributor::new`] refuses mainnet keys; a mainnet
//! distributor comes from [`ZcashDistributor::new_for_mainnet`], which needs a [`MainnetPermit`]
//! that only the operator creates, after its own `--allow-mainnet` and confirmation gate.
//!
//! **1. Campaign keys and addresses** (one ZIP 32 account per campaign index):
//!
//! ```rust,no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let seed: &[u8] = &[0u8; 32]; // the operator's decrypted seed (>= 32 bytes)
//! # let campaign_index: u32 = 0;
//! let network = drop_zcash::zcash_network(drop_core::Network::Testnet);
//! let keys = drop_zcash::CampaignKeys::derive(seed, network, campaign_index)?;
//! let funding: String = keys.funding_address(); // tm…: where the funder sends the campaign's ZEC
//! let change: String = keys.change_address(); // tm…: where batch change returns
//! let ufvk: String = keys.ufvk_encoded()?; // uviewtest1…: the auditor key; confidential, never logged
//! # let _ = (funding, change, ufvk);
//! # Ok(())
//! # }
//! ```
//!
//! **2. Build + broadcast batches**, one funding outpoint per batch (the drop-core `Engine` does
//! the order, ledger and resume; this crate builds, sends and polls):
//!
//! ```rust,no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let network = drop_zcash::zcash_network(drop_core::Network::Testnet);
//! # let keys = drop_zcash::CampaignKeys::derive(&[0u8; 32], network, 0)?;
//! # let campaign_id = drop_core::CampaignId::new("example-campaign")?;
//! # let batches: Vec<drop_core::Batch> = Vec::new(); // from drop_core::plan_batches
//! # let fundings: Vec<drop_core::FundingRef> = Vec::new();
//! # let ledger = drop_core::InMemoryLedger::default();
//! use drop_zcash::{lightwalletd::LightwalletdBackend, ZcashDistributor};
//!
//! let config =
//!     drop_chain::ChainConfig::new("https://testnet.zec.rocks:443", drop_core::Network::Testnet);
//! // Blocks on the backend's own runtime: call from a plain thread / `spawn_blocking`.
//! let (backend, _chain_info) = LightwalletdBackend::connect(&config, &keys)?;
//! let policy = drop_core::FeePolicy::zip317_text(); // must equal the engine's policy
//! let distributor = ZcashDistributor::new(keys, backend, &policy)?;
//! // fundings[i] = FundingRef { outpoint, value } of a UTXO at the campaign's funding or change
//! // address (list them with drop_chain's `LightwalletdSource::utxos`).
//! let mut engine =
//!     drop_core::Engine::new(campaign_id, batches, fundings, 1, &policy, distributor, ledger)?;
//! let last_event = engine.run_to_completion(10, |event| {
//!     let _ = event; // stream to the UI
//! })?;
//! # let _ = last_event;
//! # Ok(())
//! # }
//! ```
//!
//! Each batch spends exactly its funding outpoint; `value - batch total - fee` returns as
//! transparent change to `keys.change_address()`; a remainder of 0–53 zat (exact funding, or
//! less than Zebra's 54-zat dust threshold) gets no change output and is paid as fee instead.
//! The backend blocks on its own tokio runtime: run the engine on a plain thread (in an async
//! server, `tokio::task::spawn_blocking`), never directly inside an async task.
//!
//! The anchor is the root of the server's Ironwood tree at the tip (`GetTreeState`), and the
//! transaction targets `tip + 1`, so the branch id follows the live chain (NU7 on testnet today).
//!
//! **3. Auditor recovery** from a UFVK and a raw transaction (local only, never in the hosted
//! verifier):
//!
//! ```rust,no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let raw_tx: &[u8] = &[]; // the mined batch transaction
//! # let ufvk = "uviewtest1…"; // the campaign UFVK
//! # // Spent prevouts, resolved from the chain (e.g. drop-chain's ChainSource + parsing).
//! # let resolve_prevout = |_: &zcash_transparent::bundle::OutPoint| -> Option<zcash_transparent::bundle::TxOut> { None };
//! let network = drop_zcash::zcash_network(drop_core::Network::Testnet);
//! let outputs = drop_zcash::inspect::recover_with_ufvk(raw_tx, network, ufvk)?; // Vec<RecoveredOutput>
//! let public = drop_zcash::inspect::public_totals(raw_tx, resolve_prevout)?;
//! // REQ-AUD-001: report any difference instead of hiding it.
//! let count_matches = outputs.len() == public.ironwood_actions; // for batches of 2+
//! let sum_matches =
//!     outputs.iter().map(|o| o.value).sum::<u64>() as i64 == public.net_into_ironwood;
//! # let _ = (count_matches, sum_matches);
//! # Ok(())
//! # }
//! ```

pub mod builder;
pub mod chain;
pub mod codec;
pub mod distributor;
pub mod inbox;
pub mod inspect;
pub mod keys;
pub mod lightwalletd;
pub mod memo;
pub mod payslip;

mod txid;

pub use builder::{
    build_batch_tx, build_sweep, expected_branch_id, BuildError, BuiltTx, FundingCoin, PayoutLine,
    MAX_IRONWOOD_ACTIONS_PER_TX,
};
pub use chain::{ChainBackend, PrevOut, Submitted, TxStatus};
pub use codec::ZcashAddressCodec;
pub use distributor::{MainnetPermit, ZcashDistributor, ZcashError};
pub use inbox::InboxKeys;
pub use keys::{CampaignKeys, KeyError};
pub use memo::{decode_memo, encode_memo, MemoError};

/// The librustzcash network parameters for a `drop-core` network.
pub fn zcash_network(network: drop_core::Network) -> zcash_protocol::consensus::Network {
    match network {
        drop_core::Network::Testnet => zcash_protocol::consensus::Network::TestNetwork,
        drop_core::Network::Mainnet => zcash_protocol::consensus::Network::MainNetwork,
    }
}
