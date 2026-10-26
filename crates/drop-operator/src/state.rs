//! Shared application state and the background engine runner.
//!
//! A *run* drives one campaign's [`Engine`] on a blocking thread, publishing each
//! [`ProgressEvent`] to the campaign's [`EventHub`]. Everything the engine needs to
//! continue lives in the encrypted store's ledger, so a run that dies (process
//! killed, or the `--mock-crash-after-steps` simulation) is continued by starting
//! it again: stored transactions are re-broadcast, never rebuilt (REQ-RES-001).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use drop_core::{
    derive_phase, plan_batches, AddressCodec, Batch, CampaignId, CampaignPhase, Engine, FeePolicy,
    FundingRef, FundingSource, FundingState, Ledger, Network, OutPoint, Pool, ProgressEvent, Txid,
    Zatoshi,
};
use serde::Serialize;
use tokio::sync::watch;

use drop_zcash::MAX_IRONWOOD_ACTIONS_PER_TX;

use crate::accounts::AccountAllocator;
use crate::auth::Token;
use crate::chain::{
    BoxedDistributor, ChainBackend, ChainError, ChainPort, RunContext, UtxoSighting,
};
use crate::error::{StoreError, STORE_CORRUPT_TEXT};
use crate::events::EventHub;
use crate::funding::{funding_plan, fundings_for, FundingShortfall};
use crate::http::ApiError;
use crate::logging::Logger;
use crate::secret::SecretSeed;
use crate::store::{CampaignRecord, FundingObserved, FundingOutcome, Store, StoreLedger};

/// Where a campaign's run stands in this process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RunState {
    /// No run has been started in this process.
    Idle,
    /// The engine is working.
    Running,
    /// Every batch is confirmed at the required depth.
    Settled,
    /// Some batches failed permanently; nothing more can be done automatically.
    Halted,
    /// The engine gave up after repeated errors; start again to retry.
    Stalled {
        /// The last error (free of recipient data).
        error: String,
    },
    /// The run stopped silently as a simulated crash.
    Crashed,
}

impl RunState {
    /// Whether the run is still working.
    pub fn is_running(&self) -> bool {
        matches!(self, RunState::Running)
    }
}

/// The default cap on what a mainnet campaign may need in funding: 0.1 ZEC, in zatoshi
/// (REQ-OPS-003). Real money moves on mainnet and the code has not been audited.
pub const DEFAULT_MAINNET_MAX_FUNDING_ZAT: u64 = 10_000_000;

/// Tunables for runs.
#[derive(Clone, Debug)]
pub struct Options {
    /// Confirmation depth at which a batch is final.
    pub required_depth: u32,
    /// Pause between confirmation polls.
    pub poll_interval: Duration,
    /// Consecutive transient errors tolerated before a run stalls.
    pub max_consecutive_errors: u32,
    /// Simulate a crash after this many engine steps.
    pub crash_after_steps: Option<u32>,
    /// The most funding (declared total plus fee), in zatoshi, a mainnet campaign may need.
    /// Not applied on testnet.
    pub mainnet_max_funding_zat: u64,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            required_depth: 3,
            poll_interval: Duration::from_millis(500),
            max_consecutive_errors: 5,
            crash_after_steps: None,
            mainnet_max_funding_zat: DEFAULT_MAINNET_MAX_FUNDING_ZAT,
        }
    }
}

/// The parts an [`AppState`] is made from.
pub struct AppParts {
    /// The network every new campaign runs on.
    pub network: Network,
    /// The shielded pool new campaigns pay into.
    pub pool: Pool,
    /// The encrypted store.
    pub store: Arc<Store>,
    /// Address validation (the real codec comes from `drop-zcash`).
    pub codec: Arc<dyn AddressCodec + Send + Sync>,
    /// The chain the engine runs against.
    pub backend: Arc<dyn ChainBackend>,
    /// The wallet seed, held for the chain backend.
    pub seed: SecretSeed,
    /// Hands out ZIP-32 account numbers that are never reused for this seed.
    pub accounts: Arc<dyn AccountAllocator>,
    /// The per-run API token.
    pub token: Token,
    /// Where log lines go.
    pub logger: Logger,
    /// Run tunables.
    pub options: Options,
    /// What the NEAR Intents funding routes need.
    pub near: crate::near::NearParts,
}

struct Inner {
    network: Network,
    pool: Pool,
    store: Arc<Store>,
    codec: Arc<dyn AddressCodec + Send + Sync>,
    backend: Arc<dyn ChainBackend>,
    seed: Arc<SecretSeed>,
    accounts: Arc<dyn AccountAllocator>,
    token: Arc<Token>,
    logger: Logger,
    options: Options,
    runs: Mutex<HashMap<CampaignId, watch::Sender<RunState>>>,
    hubs: Mutex<HashMap<CampaignId, Arc<EventHub>>>,
    addresses: Mutex<HashMap<CampaignId, String>>,
    progress: Mutex<HashMap<CampaignId, FundingProgress>>,
    /// What each deposit seen so far spent, by its txid (REQ-FUND-004). Public chain data, read
    /// from the deposit's own bytes and kept for the life of the process; only known answers are
    /// kept, so a failed read is tried again by the next poll.
    sources: Mutex<HashMap<Txid, FundingSource>>,
    near: crate::near::NearState,
}

/// The handle shared by every request handler and run.
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AppState{{network: {}}}", self.0.network)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What starting a run did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartOutcome {
    /// A new run was started.
    Started,
    /// A run was already in progress.
    AlreadyRunning,
}

/// What the funding poll has seen at a campaign's address. Not persisted: only a deposit
/// that has reached the required depth is recorded as the campaign's funding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FundingProgress {
    /// The best candidate output seen.
    pub outpoint: OutPoint,
    /// Its value.
    pub amount: Zatoshi,
    /// Its confirmations so far.
    pub confirmations: u32,
    /// Confirmations needed before the campaign counts as funded.
    pub required_depth: u32,
    /// Whether the value covers the plan (declared total plus fees).
    pub sufficient: bool,
}

/// What a funding poll concluded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PollOutcome {
    /// The campaign was already funded.
    AlreadyFunded,
    /// A deposit at the required depth was found and recorded.
    Funded(FundingObserved),
    /// Not funded yet; the best candidate seen, if any.
    Waiting(Option<FundingProgress>),
    /// This backend has no funding addresses (the mock chain).
    NotApplicable,
}

impl AppState {
    /// Builds the state. No run is started; see [`AppState::resume_started`].
    pub fn new(parts: AppParts) -> Self {
        AppState(Arc::new(Inner {
            network: parts.network,
            pool: parts.pool,
            store: parts.store,
            codec: parts.codec,
            backend: parts.backend,
            seed: Arc::new(parts.seed),
            accounts: parts.accounts,
            token: Arc::new(parts.token),
            logger: parts.logger,
            options: parts.options,
            runs: Mutex::new(HashMap::new()),
            hubs: Mutex::new(HashMap::new()),
            addresses: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            sources: Mutex::new(HashMap::new()),
            near: crate::near::NearState::new(parts.near),
        }))
    }

    /// The NEAR Intents funding state (token cache, pending dry quotes) and its parts.
    pub fn near(&self) -> &crate::near::NearState {
        &self.0.near
    }

    /// The network.
    pub fn network(&self) -> Network {
        self.0.network
    }

    /// The pool new campaigns pay into.
    pub fn pool(&self) -> Pool {
        self.0.pool
    }

    /// The store.
    pub fn store(&self) -> &Arc<Store> {
        &self.0.store
    }

    /// The account numbering.
    pub fn accounts(&self) -> &dyn AccountAllocator {
        self.0.accounts.as_ref()
    }

    /// The address codec.
    pub fn codec(&self) -> &(dyn AddressCodec + Send + Sync) {
        self.0.codec.as_ref()
    }

    /// The chain backend.
    pub fn backend(&self) -> &Arc<dyn ChainBackend> {
        &self.0.backend
    }

    /// The wallet seed. Only a signing backend should call this.
    pub fn seed(&self) -> &SecretSeed {
        &self.0.seed
    }

    /// The API token.
    pub fn token(&self) -> &Arc<Token> {
        &self.0.token
    }

    /// The logger.
    pub fn logger(&self) -> &Logger {
        &self.0.logger
    }

    /// The run tunables.
    pub fn options(&self) -> &Options {
        &self.0.options
    }

    /// The event hub of a campaign (created on first use).
    pub fn hub(&self, id: &CampaignId) -> Arc<EventHub> {
        Arc::clone(
            lock(&self.0.hubs)
                .entry(id.clone())
                .or_insert_with(EventHub::new),
        )
    }

    /// The campaign's run state in this process.
    pub fn run_state(&self, id: &CampaignId) -> RunState {
        lock(&self.0.runs)
            .get(id)
            .map_or(RunState::Idle, |sender| sender.borrow().clone())
    }

    /// Waits until the campaign's run is no longer running and returns how it ended.
    pub async fn wait_for_run(&self, id: &CampaignId) -> RunState {
        let receiver = lock(&self.0.runs).get(id).map(watch::Sender::subscribe);
        let Some(mut receiver) = receiver else {
            return RunState::Idle;
        };
        loop {
            let current = receiver.borrow_and_update().clone();
            if !current.is_running() {
                return current;
            }
            if receiver.changed().await.is_err() {
                return receiver.borrow().clone();
            }
        }
    }

    /// The phase of a campaign, from the ledger and the funding state.
    pub fn phase(&self, record: &CampaignRecord) -> Result<CampaignPhase, ApiError> {
        let plan = self.plan(record)?;
        let ledger = self.0.store.ledger();
        let count = u32::try_from(plan.len()).unwrap_or(u32::MAX);
        let statuses = ledger
            .statuses(&record.id, count)
            .map_err(|e| self.internal(&e))?;
        let funding = if record.funding.is_some() {
            FundingState::Funded
        } else {
            FundingState::Awaiting
        };
        Ok(derive_phase(
            funding,
            &statuses,
            self.0.options.required_depth,
        ))
    }

    /// Re-derives the batches from the stored manifest. Planning is deterministic,
    /// so this always matches the plan shown at creation.
    pub fn plan(&self, record: &CampaignRecord) -> Result<Vec<Batch>, ApiError> {
        plan_batches(record.manifest.rows(), record.max_outputs_per_batch)
            .map_err(|e| self.internal(&e))
    }

    /// The campaign's transparent funding address, if the backend has addresses. Derived
    /// from the wallet seed and the campaign's own account, then cached.
    pub fn funding_address(&self, record: &CampaignRecord) -> Result<Option<String>, ApiError> {
        if let Some(cached) = lock(&self.0.addresses).get(&record.id) {
            return Ok(Some(cached.clone()));
        }
        self.check_wallet(record)?;
        let derived = self
            .0
            .backend
            .funding_address(&self.0.seed, record.network, record.account)
            .map_err(|e| self.internal(&e))?;
        if let Some(address) = &derived {
            lock(&self.0.addresses).insert(record.id.clone(), address.clone());
        }
        Ok(derived)
    }

    /// What the last funding poll saw for a campaign that is not funded yet.
    pub fn funding_progress(&self, id: &CampaignId) -> Option<FundingProgress> {
        lock(&self.0.progress).get(id).cloned()
    }

    /// What the campaign's deposit spent, if that is known (REQ-FUND-004): the recorded deposit's,
    /// or else that of the deposit the last poll saw. Read from memory only, never from the chain.
    pub fn funding_source(&self, record: &CampaignRecord) -> Option<FundingSource> {
        let deposit = match record.funding {
            Some(funding) => funding.outpoint.txid,
            None => self.funding_progress(&record.id)?.outpoint.txid,
        };
        lock(&self.0.sources).get(&deposit).copied()
    }

    /// What a deposit declared to the mock chain's `fund-observed` spent.
    pub fn declare_deposit_source(&self, deposit: Txid, source: FundingSource) {
        lock(&self.0.sources).insert(deposit, source);
    }

    /// Reads once what `deposit` spent, from its own bytes. A known answer is kept; a failure is
    /// not, so the next poll tries again. It never fails anything: where a deposit came from
    /// informs the page and decides nothing.
    async fn learn_deposit_source(&self, deposit: Txid) {
        if lock(&self.0.sources).contains_key(&deposit) {
            return;
        }
        let backend = Arc::clone(&self.0.backend);
        let read = tokio::task::spawn_blocking(move || backend.deposit_source(&deposit)).await;
        if let Ok(Ok(Some(source))) = read {
            lock(&self.0.sources).insert(deposit, source);
        }
    }

    /// Looks at the campaign's funding address once.
    ///
    /// A deposit counts only when it is on the chain at the required depth and covers the
    /// plan (REQ-FUND-002): nothing reported by a swap provider or a client can mark a
    /// campaign funded. Shallower or smaller deposits are reported as progress only.
    pub async fn poll_funding(&self, id: &CampaignId) -> Result<PollOutcome, ApiError> {
        let record = self
            .0
            .store
            .load_campaign(id)
            .map_err(|e| self.internal(&e))?
            .ok_or_else(|| ApiError::not_found("campaign"))?;
        if let Some(funding) = record.funding {
            // After a restart, what the deposit spent is read again (it is kept in memory only).
            self.learn_deposit_source(funding.outpoint.txid).await;
            return Ok(PollOutcome::AlreadyFunded);
        }
        let Some(address) = self.funding_address(&record)? else {
            return Ok(PollOutcome::NotApplicable);
        };
        let batches = self.plan(&record)?;
        let required = funding_plan(&batches, &record.fee_policy)
            .map_err(|e| self.internal(&e))?
            .required;

        let backend = Arc::clone(&self.0.backend);
        let sightings = tokio::task::spawn_blocking(move || backend.funding_sightings(&address))
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(|_| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "chain_unavailable",
                    "the chain data source is unavailable; try again shortly",
                )
            })?;

        let depth = self.0.options.required_depth;
        let chosen = choose_deposit(&sightings, required, depth);
        if let Some(sighting) = chosen {
            let deposit = FundingObserved {
                outpoint: sighting.outpoint,
                amount: sighting.amount,
            };
            return match self.0.store.record_funding(id, deposit) {
                Ok(FundingOutcome::Recorded | FundingOutcome::Unchanged) => {
                    lock(&self.0.progress).remove(id);
                    self.0.logger.info(format_args!(
                        "funding confirmed campaign={id} confirmations={}",
                        sighting.confirmations
                    ));
                    // Recorded first: reading where it came from never holds funding up.
                    self.learn_deposit_source(deposit.outpoint.txid).await;
                    Ok(PollOutcome::Funded(deposit))
                }
                Ok(FundingOutcome::Conflict(_)) => Ok(PollOutcome::AlreadyFunded),
                Err(error) => Err(self.internal(&error)),
            };
        }

        let best = best_candidate(&sightings, required);
        let progress = best.map(|s| FundingProgress {
            outpoint: s.outpoint,
            amount: s.amount,
            confirmations: s.confirmations,
            required_depth: depth,
            sufficient: s.amount >= required,
        });
        match &progress {
            Some(p) => {
                lock(&self.0.progress).insert(id.clone(), p.clone());
            }
            None => {
                lock(&self.0.progress).remove(id);
            }
        }
        // A deposit still short of the depth can already say where it came from.
        if let Some(p) = &progress {
            self.learn_deposit_source(p.outpoint.txid).await;
        }
        Ok(PollOutcome::Waiting(progress))
    }

    /// Polls every unfunded campaign now and then, forever. Start it only for backends
    /// with funding addresses.
    pub fn spawn_funding_poller(&self, interval: Duration) -> tokio::task::JoinHandle<()> {
        let state = self.clone();
        tokio::spawn(async move {
            loop {
                match state.0.store.unfunded_campaigns() {
                    Ok(ids) => {
                        for id in ids {
                            if state.poll_funding(&id).await.is_err() {
                                state
                                    .0
                                    .logger
                                    .warn(format_args!("funding poll failed campaign={id}"));
                            }
                        }
                    }
                    Err(error) => state.0.logger.warn(format_args!("funding poll: {error}")),
                }
                // After a restart, what the funded campaigns' deposits spent is read again.
                match state.0.store.funded_deposits() {
                    Ok(deposits) => {
                        for deposit in deposits {
                            state.learn_deposit_source(deposit).await;
                        }
                    }
                    Err(error) => state.0.logger.warn(format_args!("funding poll: {error}")),
                }
                tokio::time::sleep(interval).await;
            }
        })
    }

    /// The API error for a deposit that cannot fund a plan.
    pub fn funding_shortfall(&self, shortfall: FundingShortfall) -> ApiError {
        match shortfall {
            FundingShortfall::Insufficient { .. } => ApiError::conflict(
                "insufficient_funding",
                "the recorded deposit does not cover this plan",
            ),
            FundingShortfall::NeedsSplit => needs_funding_split(),
            FundingShortfall::BadOutpoint => self.internal(&"funding output index overflow"),
        }
    }

    /// Whether the wallet in use is the one the campaign was created with (campaigns made
    /// before fingerprints were recorded count as matching).
    pub fn wallet_matches(&self, record: &CampaignRecord) -> bool {
        record
            .seed_fingerprint
            .as_ref()
            .is_none_or(|recorded| *recorded == self.0.seed.fingerprint())
    }

    /// Refuses to use a campaign with a wallet other than the one that created it.
    pub fn check_wallet(&self, record: &CampaignRecord) -> Result<(), ApiError> {
        match &record.seed_fingerprint {
            Some(recorded) if *recorded != self.0.seed.fingerprint() => Err(ApiError::conflict(
                "wrong_wallet_seed",
                "this campaign was created with a different wallet seed than the one in use",
            )),
            _ => Ok(()),
        }
    }

    /// Logs an unexpected error and returns the generic 500.
    pub fn internal(&self, error: &dyn std::fmt::Display) -> ApiError {
        let message = error.to_string();
        self.0
            .logger
            .warn(format_args!("internal error: {message}"));
        // A store whose data fails its integrity check is not a mystery: say so.
        if message.contains(STORE_CORRUPT_TEXT) {
            return ApiError::store_corrupt();
        }
        ApiError::internal()
    }

    /// Starts the campaign's engine in the background (or reports that it is
    /// already running). The campaign must be funded.
    pub fn start_run(&self, id: &CampaignId) -> Result<StartOutcome, ApiError> {
        let record = self
            .0
            .store
            .load_campaign(id)
            .map_err(|e| self.internal(&e))?
            .ok_or_else(|| ApiError::not_found("campaign"))?;
        let Some(deposit) = record.funding else {
            return Err(ApiError::conflict(
                "not_funded",
                "record the funding deposit before starting",
            ));
        };
        let batches = self.plan(&record)?;
        let plan = funding_plan(&batches, &record.fee_policy).map_err(|e| self.internal(&e))?;
        let fundings = fundings_for(self.0.backend.funding_layout(), &deposit, &plan)
            .map_err(|shortfall| self.funding_shortfall(shortfall))?;
        self.check_wallet(&record)?;
        // The distributor is made on the run's own blocking thread: some backends start a
        // runtime of their own to talk to the node, which must not happen inside a task.
        let backend = Arc::clone(&self.0.backend);
        let seed = Arc::clone(&self.0.seed);
        let (campaign, account, network, fee_policy) = (
            id.clone(),
            record.account,
            record.network,
            record.fee_policy,
        );
        let distributor: DistributorFactory = Box::new(move || {
            backend.distributor(&RunContext {
                seed: &seed,
                campaign: &campaign,
                account,
                network,
                fee_policy,
            })
        });

        // Claim the slot atomically so two requests cannot start two engines.
        let sender = {
            let mut runs = lock(&self.0.runs);
            match runs.get(id) {
                Some(existing) if existing.borrow().is_running() => {
                    return Ok(StartOutcome::AlreadyRunning)
                }
                Some(existing) => {
                    existing.send_replace(RunState::Running);
                    existing.clone()
                }
                None => {
                    let (sender, _) = watch::channel(RunState::Running);
                    runs.insert(id.clone(), sender.clone());
                    sender
                }
            }
        };
        if let Err(error) = self.0.store.set_started(id, true) {
            sender.send_replace(RunState::Idle);
            return Err(self.internal(&error));
        }

        let hub = self.hub(id);
        hub.reset();
        let job = RunJob {
            id: id.clone(),
            batches,
            fundings,
            fee_policy: record.fee_policy,
            distributor,
            ledger: self.0.store.ledger(),
            hub,
            logger: self.0.logger.clone(),
            options: self.0.options.clone(),
        };
        self.0
            .logger
            .info(format_args!("run started campaign={id}"));
        let logger = self.0.logger.clone();
        let campaign = id.clone();
        tokio::spawn(async move {
            let outcome = match tokio::task::spawn_blocking(move || run_blocking(job)).await {
                Ok(state) => state,
                Err(_) => RunState::Stalled {
                    error: "the run stopped unexpectedly".to_owned(),
                },
            };
            logger.info(format_args!(
                "run ended campaign={campaign} state={outcome:?}"
            ));
            sender.send_replace(outcome);
        });
        Ok(StartOutcome::Started)
    }

    /// Reads every campaign and every ledger row once, so that a store that fails its
    /// integrity check, or that holds campaigns of another network, is found before the
    /// operator says it is serving. Returns the number of campaigns checked.
    pub fn verify_store(&self) -> Result<usize, StoreError> {
        let headers = self.0.store.list_campaigns()?;
        for header in &headers {
            let record = self
                .0
                .store
                .load_campaign(&header.id)?
                .ok_or(StoreError::Corrupt)?;
            // One store per network: every start-up path below (the funding poller, resuming
            // interrupted runs) walks all campaigns, so a campaign of the other network would be
            // run against the wrong node.
            if record.network != self.0.network {
                return Err(StoreError::WrongNetwork {
                    campaign: record.network,
                    operator: self.0.network,
                });
            }
            let batches =
                drop_core::plan_batches(record.manifest.rows(), record.max_outputs_per_batch)
                    .map_err(|_| StoreError::Corrupt)?;
            let count = u32::try_from(batches.len()).map_err(|_| StoreError::Corrupt)?;
            self.0
                .store
                .ledger()
                .statuses(&record.id, count)
                .map_err(|e| {
                    if e.to_string().contains(STORE_CORRUPT_TEXT) {
                        StoreError::Corrupt
                    } else {
                        StoreError::Database(e.to_string())
                    }
                })?;
        }
        // The live NEAR quotes are read too: a deposit address that was edited is found now.
        for id in self.0.store.near_quote_campaigns()? {
            self.0.store.load_near_quote(&id)?;
        }
        Ok(headers.len())
    }

    /// Restarts the run of every campaign that was started but is neither settled
    /// nor failed. Returns how many runs were started. Call once after opening the store.
    pub fn resume_started(&self) -> Result<usize, StoreError> {
        let mut resumed = 0;
        for id in self.0.store.started_campaigns()? {
            let Some(record) = self.0.store.load_campaign(&id)? else {
                continue;
            };
            match self.phase(&record) {
                Ok(CampaignPhase::Settled | CampaignPhase::Failed) | Err(_) => continue,
                Ok(_) => {}
            }
            if matches!(self.start_run(&id), Ok(StartOutcome::Started)) {
                resumed += 1;
            }
        }
        Ok(resumed)
    }
}

/// Everything a run needs, moved onto its blocking thread.
/// Builds a run's distributor; called once, on the run's blocking thread.
type DistributorFactory = Box<dyn FnOnce() -> Result<Box<dyn ChainPort>, ChainError> + Send>;

struct RunJob {
    id: CampaignId,
    batches: Vec<Batch>,
    fundings: Vec<FundingRef>,
    fee_policy: FeePolicy,
    distributor: DistributorFactory,
    ledger: StoreLedger,
    hub: Arc<EventHub>,
    logger: Logger,
    options: Options,
}

fn run_blocking(job: RunJob) -> RunState {
    let RunJob {
        id,
        batches,
        fundings,
        fee_policy,
        distributor,
        ledger,
        hub,
        logger,
        options,
    } = job;
    let distributor = match distributor() {
        Ok(distributor) => BoxedDistributor(distributor),
        Err(error) => {
            logger.warn(format_args!(
                "campaign={id} cannot reach the chain: {error}"
            ));
            return RunState::Stalled {
                error: error.to_string(),
            };
        }
    };
    let mut engine = match Engine::new(
        id.clone(),
        batches,
        fundings,
        options.required_depth,
        &fee_policy,
        distributor,
        ledger,
    ) {
        Ok(engine) => engine,
        Err(error) => {
            logger.warn(format_args!("campaign={id} cannot start: {error}"));
            return RunState::Stalled {
                error: error.to_string(),
            };
        }
    };

    let (mut steps, mut errors) = (0u32, 0u32);
    loop {
        if options
            .crash_after_steps
            .is_some_and(|limit| steps >= limit)
        {
            logger.warn(format_args!(
                "campaign={id} simulated crash after {steps} steps"
            ));
            return RunState::Crashed;
        }
        match engine.step() {
            Ok(event) => {
                steps += 1;
                errors = 0;
                log_event(&logger, &id, &event);
                let outcome = match &event {
                    ProgressEvent::Settled { .. } => Some(RunState::Settled),
                    ProgressEvent::Halted { .. } => Some(RunState::Halted),
                    _ => None,
                };
                let waiting = matches!(event, ProgressEvent::Waiting { .. });
                hub.publish(event);
                if let Some(outcome) = outcome {
                    return outcome;
                }
                if waiting {
                    std::thread::sleep(options.poll_interval);
                }
            }
            Err(error) => {
                errors += 1;
                logger.warn(format_args!(
                    "campaign={id} step failed ({errors}): {error}"
                ));
                if errors >= options.max_consecutive_errors {
                    return RunState::Stalled {
                        error: error.to_string(),
                    };
                }
                std::thread::sleep(options.poll_interval);
            }
        }
    }
}

fn log_event(logger: &Logger, id: &CampaignId, event: &ProgressEvent) {
    match event {
        ProgressEvent::Built {
            batch_index, txid, ..
        } => {
            logger.info(format_args!(
                "campaign={id} built batch={batch_index} txid={txid}"
            ));
        }
        ProgressEvent::Broadcast { batch_index, txid } => {
            logger.info(format_args!(
                "campaign={id} broadcast batch={batch_index} txid={txid}"
            ));
        }
        ProgressEvent::Confirmed {
            batch_index, depth, ..
        } => {
            logger.info(format_args!(
                "campaign={id} confirmed batch={batch_index} depth={depth}"
            ));
        }
        ProgressEvent::Failed {
            batch_index,
            reason,
        } => {
            logger.warn(format_args!(
                "campaign={id} failed batch={batch_index}: {reason}"
            ));
        }
        ProgressEvent::Halted { failed_batches } => {
            logger.warn(format_args!(
                "campaign={id} halted failed={failed_batches:?}"
            ));
        }
        ProgressEvent::Settled { .. } => logger.info(format_args!("campaign={id} settled")),
        ProgressEvent::Waiting { .. } => {}
    }
}

/// The error for a real-chain campaign that needs more than one funding output.
pub fn needs_funding_split() -> ApiError {
    ApiError::unprocessable(
        "needs_funding_split",
        format!(
            "this campaign has more than one batch, and a funding-split transaction (one exact \
             output per batch) is not implemented yet; use a single batch of up to \
             {MAX_IRONWOOD_ACTIONS_PER_TX} recipients"
        ),
    )
}

/// The deposit to fund the campaign with: an output at the required depth whose value
/// covers the plan. Among several, the deepest, then the smallest outpoint (deterministic).
fn choose_deposit(
    sightings: &[UtxoSighting],
    required: Zatoshi,
    depth: u32,
) -> Option<UtxoSighting> {
    sightings
        .iter()
        .filter(|s| s.confirmations >= depth && s.amount >= required)
        .copied()
        .max_by(|a, b| {
            a.confirmations
                .cmp(&b.confirmations)
                .then_with(|| b.outpoint.to_string().cmp(&a.outpoint.to_string()))
        })
}

/// The most promising output seen so far, for progress reporting: one that covers the plan
/// if any does, otherwise the largest; deepest first.
fn best_candidate(sightings: &[UtxoSighting], required: Zatoshi) -> Option<UtxoSighting> {
    sightings.iter().copied().max_by(|a, b| {
        (a.amount >= required)
            .cmp(&(b.amount >= required))
            .then_with(|| a.confirmations.cmp(&b.confirmations))
            .then_with(|| a.amount.cmp(&b.amount))
            .then_with(|| b.outpoint.to_string().cmp(&a.outpoint.to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sighting(vout: u32, zat: u64, confirmations: u32) -> UtxoSighting {
        UtxoSighting {
            outpoint: OutPoint {
                txid: drop_core::Txid::from_bytes([vout as u8; 32]),
                vout,
            },
            amount: Zatoshi::new(zat).unwrap(),
            confirmations,
        }
    }

    // covers: REQ-FUND-002
    #[test]
    fn a_deposit_counts_only_with_enough_depth_and_enough_value() {
        let required = Zatoshi::new(1_000).unwrap();
        // Too shallow, too small, and both.
        assert_eq!(choose_deposit(&[sighting(0, 5_000, 2)], required, 3), None);
        assert_eq!(choose_deposit(&[sighting(0, 999, 50)], required, 3), None);
        assert_eq!(choose_deposit(&[sighting(0, 999, 1)], required, 3), None);
        assert_eq!(choose_deposit(&[], required, 3), None);
        // Exactly at the depth and the value is enough.
        let exact = sighting(0, 1_000, 3);
        assert_eq!(choose_deposit(&[exact], required, 3), Some(exact));
    }

    // covers: REQ-FUND-002
    #[test]
    fn among_several_qualifying_deposits_the_deepest_wins_deterministically() {
        let required = Zatoshi::new(1_000).unwrap();
        let shallow = sighting(1, 9_000, 4);
        let deep = sighting(2, 1_000, 40);
        let tied = sighting(3, 1_000, 40);
        let chosen = choose_deposit(&[shallow, tied, deep], required, 3).unwrap();
        assert_eq!(chosen.confirmations, 40);
        // Tie on depth: the lower outpoint, whatever the order given.
        let again = choose_deposit(&[deep, tied, shallow], required, 3).unwrap();
        assert_eq!(chosen, again);
    }

    #[test]
    fn progress_prefers_a_sufficient_output_then_the_deepest() {
        let required = Zatoshi::new(1_000).unwrap();
        let small_deep = sighting(1, 10, 90);
        let big_shallow = sighting(2, 5_000, 1);
        let big_deeper = sighting(3, 5_000, 2);
        assert_eq!(
            best_candidate(&[small_deep, big_shallow, big_deeper], required),
            Some(big_deeper)
        );
        assert_eq!(best_candidate(&[small_deep], required), Some(small_deep));
        assert_eq!(best_candidate(&[], required), None);
    }
}
