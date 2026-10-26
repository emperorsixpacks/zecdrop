//! The real-chain backend: campaigns are funded and paid on Zcash through a lightwalletd /
//! Zaino server.
//!
//! * Each campaign has its own ZIP-32 account, so its own funding address and its own
//!   viewing key (REQ-AUD-002).
//! * Funding is detected by listing the unspent outputs of that address; the operator
//!   marks a campaign funded only for an output at the required depth (REQ-FUND-002).
//! * Batches are built and sent by [`drop_zcash::ZcashDistributor`].
//!
//! The server connection sits behind [`ZcashConnector`] so the whole path can be tested with
//! an in-memory chain. [`LightwalletdConnector`] is the real one.
//!
//! **Scope.** One batch per campaign: the deposit is the batch's funding input and the change
//! returns to the campaign's change address. A campaign with several batches would need a
//! funding-split transaction (one exact output per batch), which is not implemented, so
//! such campaigns are refused with `needs_funding_split` when created.

use std::sync::{Mutex, MutexGuard, PoisonError};

use drop_chain::{ChainConfig, ChainError as LwdError, ChainInfo, LightwalletdSource};
use drop_core::{FailureKind, OutPoint, Zatoshi};
use drop_zcash::lightwalletd::{preflight, BackendError, LightwalletdBackend};
use drop_zcash::{zcash_network, CampaignKeys, MainnetPermit, ZcashDistributor};
use tokio::runtime::{Builder, Runtime};

use crate::chain::{ChainBackend, ChainError, ChainPort, FundingLayout, RunContext, UtxoSighting};
use crate::secret::SecretSeed;

fn permanent(message: impl ToString) -> ChainError {
    ChainError {
        message: message.to_string(),
        kind: FailureKind::Permanent,
    }
}

fn transient(message: impl ToString) -> ChainError {
    ChainError {
        message: message.to_string(),
        kind: FailureKind::Transient,
    }
}

fn from_lwd(error: LwdError) -> ChainError {
    match error {
        LwdError::Unavailable => transient(error),
        other => permanent(other),
    }
}

fn from_backend(error: BackendError) -> ChainError {
    match error {
        BackendError::Chain(LwdError::Unavailable) | BackendError::Source(_) => transient(error),
        other => permanent(other),
    }
}

/// The connection to a Zcash node, and the view of what has arrived at an address.
pub trait ZcashConnector: Send + Sync + 'static {
    /// The chain port `drop-zcash`'s distributor drives.
    type Backend: drop_zcash::ChainBackend + Send + 'static;

    /// A backend for one campaign's keys. Called on a blocking thread outside any runtime.
    fn connect(&self, keys: &CampaignKeys) -> Result<Self::Backend, ChainError>;

    /// The unspent outputs at `address` with their confirmations.
    fn sightings(&self, address: &str) -> Result<Vec<UtxoSighting>, ChainError>;
}

/// The operator's [`ChainBackend`] over a [`ZcashConnector`].
pub struct ZcashBackend<C: ZcashConnector> {
    connector: C,
    mainnet: Option<MainnetPermit>,
}

impl<C: ZcashConnector> ZcashBackend<C> {
    /// Wraps a connector. The backend refuses mainnet campaigns until
    /// [`ZcashBackend::allow_mainnet`] is called.
    pub fn new(connector: C) -> Self {
        ZcashBackend {
            connector,
            mainnet: None,
        }
    }

    /// Lets this backend run mainnet campaigns. Only start-up calls this, and only after
    /// `--allow-mainnet` and the confirmation variable have both passed (REQ-OPS-001).
    #[must_use]
    pub fn allow_mainnet(mut self, permit: MainnetPermit) -> Self {
        self.mainnet = Some(permit);
        self
    }
}

impl<C: ZcashConnector> ChainBackend for ZcashBackend<C> {
    fn is_mock(&self) -> bool {
        false
    }

    fn funding_layout(&self) -> FundingLayout {
        FundingLayout::SingleDeposit
    }

    fn distributor(&self, run: &RunContext<'_>) -> Result<Box<dyn ChainPort>, ChainError> {
        let keys = CampaignKeys::derive(
            run.seed.expose_secret(),
            zcash_network(run.network),
            run.account,
        )
        .map_err(permanent)?;
        let backend = self.connector.connect(&keys)?;
        let distributor = match (run.network, self.mainnet) {
            (drop_core::Network::Mainnet, Some(permit)) => {
                ZcashDistributor::new_for_mainnet(keys, backend, &run.fee_policy, permit)
            }
            _ => ZcashDistributor::new(keys, backend, &run.fee_policy),
        }
        .map_err(permanent)?;
        Ok(Box::new(distributor))
    }

    fn funding_address(
        &self,
        seed: &SecretSeed,
        network: drop_core::Network,
        account: u32,
    ) -> Result<Option<String>, ChainError> {
        let keys = CampaignKeys::derive(seed.expose_secret(), zcash_network(network), account)
            .map_err(permanent)?;
        Ok(Some(keys.funding_address()))
    }

    fn funding_sightings(&self, address: &str) -> Result<Vec<UtxoSighting>, ChainError> {
        self.connector.sightings(address)
    }
}

/// The scanning half of [`LightwalletdConnector`]: a source and the runtime that drives it.
struct Scanner {
    runtime: Runtime,
    source: LightwalletdSource,
}

/// A [`ZcashConnector`] over a real lightwalletd / Zaino endpoint.
pub struct LightwalletdConnector {
    config: ChainConfig,
    scanner: Mutex<Scanner>,
}

impl LightwalletdConnector {
    /// Connects, and checks that the server serves the configured network, is on the upgrade
    /// this build stamps for the next block, and serves the Ironwood tree state a batch needs
    /// (REQ-OPS-004). Returns the live tip and branch id too. Blocking: call it from a thread
    /// outside any tokio runtime (in the async operator, from `spawn_blocking`).
    pub fn connect(config: ChainConfig) -> Result<(Self, ChainInfo), ChainError> {
        let runtime = Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| permanent("could not start the async runtime"))?;
        let (source, _) = runtime
            .block_on(LightwalletdSource::connect(&config))
            .map_err(from_lwd)?;
        // Nobody should be shown a link, and so nobody should fund an address, while this build
        // could not spend from it: a network upgrade it does not know, or a node without the
        // Ironwood tree state, is found here and not after the deposit.
        let info = runtime.block_on(preflight(&source)).map_err(from_backend)?;
        Ok((
            LightwalletdConnector {
                config,
                scanner: Mutex::new(Scanner { runtime, source }),
            },
            info,
        ))
    }

    fn scanner(&self) -> MutexGuard<'_, Scanner> {
        self.scanner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ZcashConnector for LightwalletdConnector {
    type Backend = LightwalletdBackend;

    fn connect(&self, keys: &CampaignKeys) -> Result<Self::Backend, ChainError> {
        LightwalletdBackend::connect(&self.config, keys)
            .map(|(backend, _info)| backend)
            .map_err(from_backend)
    }

    fn sightings(&self, address: &str) -> Result<Vec<UtxoSighting>, ChainError> {
        let scanner = self.scanner();
        let (tip, utxos) = scanner
            .runtime
            .block_on(async {
                // `chain_info` re-checks the network on every look.
                let tip = scanner.source.chain_info().await?.tip_height;
                let utxos = scanner.source.utxos(address).await?;
                Ok::<_, LwdError>((tip, utxos))
            })
            .map_err(from_lwd)?;
        Ok(utxos
            .into_iter()
            .map(|u| UtxoSighting {
                outpoint: OutPoint {
                    txid: u.outpoint.txid,
                    vout: u.outpoint.vout,
                },
                amount: Zatoshi::new(u.value.as_u64()).unwrap_or(Zatoshi::ZERO),
                confirmations: u.height.map_or(0, |h| tip.saturating_sub(h) + 1),
            })
            .collect())
    }
}
