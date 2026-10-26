//! The inbox engine (REQ-FUND-005, REQ-FUND-006, REQ-FUND-008): sets up each unfunded payout's shielded deposit address,
//! watches what reaches it, and moves exactly the payout's funding to its transparent funding address, once.
//!
//! One task does it all, one inbox at a time, under one lock it shares with the send-back route, so two inbox transactions
//! are never built at once. What the page shows is kept in memory ([`Inboxes::view`]): answering a page never runs
//! zcash-devtool. The order of a move is the order invariant 3 asks for: build, check the bytes (the backend does, with the
//! operator's own parser), store them sealed, then broadcast exactly them, and re-send them until they are mined. Another
//! move is built only after the first can no longer be mined (the wallet has scanned past its expiry), and never after one
//! is mined.

use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use drop_core::{CampaignId, Network, Txid};
use drop_zcash::{
    inbox::{orchard_receiver_owned_by, InboxTxContext, InboxTxFacts},
    zcash_network, CampaignKeys, InboxKeys,
};
use serde::Serialize;
use thiserror::Error;

use super::{
    keys::InboxPhrase,
    plan::{asked, holdings, plan, Held, Payout, Plan, SPENDABLE_AFTER},
    record::{InboxRecord, InboxTx, InboxTxKind},
    walletdb::{InboxNote, NoteSpend},
};
use crate::{funding::funding_plan, secret::SecretSeed, state::AppState, store::CampaignRecord};

/// A boxed future, for the backend's object-safe methods.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why the inbox's wallet or chain could not do something. A kind only: never zcash-devtool's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum InboxError {
    /// zcash-devtool failed, or its wallet could not be read or set up.
    #[error("the inbox wallet is unavailable")]
    Unavailable,
    /// The light wallet server could not be reached.
    #[error("the chain could not be reached")]
    Chain,
    /// The wallet has not caught up with the chain.
    #[error("the inbox wallet is behind the chain")]
    Behind,
    /// The transaction zcash-devtool built failed ZecDrop's check, and was neither stored nor sent.
    #[error("the inbox transaction failed ZecDrop's check and was not sent")]
    Refused,
}

/// Why a send-back was refused (REQ-FUND-007).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SendBackError {
    /// The payout has no shielded deposit address.
    #[error("this payout has no shielded deposit address")]
    NoInbox,
    /// The destination is not a shielded address with an Orchard receiver, or it is the inbox's own or the payout's own.
    #[error("send it to a shielded address with an Orchard receiver that is neither this inbox's nor the payout's own")]
    Refused,
    /// A move or a send-back is in flight, or the inbox may still move the payout's funding.
    #[error(
        "a transaction from this inbox is in flight, or it may still move the payout's funding"
    )]
    Busy,
    /// Nothing in the inbox can be spent now.
    #[error("there is nothing spendable in this inbox to send back")]
    Nothing,
    /// The wallet or the chain failed.
    #[error(transparent)]
    Inbox(#[from] InboxError),
}

/// What an inbox wallet holds, as of its last sync.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// The highest block it has scanned.
    pub wallet_tip: u32,
    /// Its Ironwood notes.
    pub notes: Vec<InboxNote>,
    /// Unspent Orchard value, which a move never spends.
    pub orchard: u64,
}

/// The chain as the node sees it now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainNow {
    /// The node's tip.
    pub tip: u32,
    /// The current consensus branch id.
    pub branch_id: u32,
}

/// A built and checked inbox transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Built {
    /// Its exact bytes.
    pub raw: Vec<u8>,
    /// What the check established.
    pub facts: InboxTxFacts,
}

/// What a broadcast came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sent {
    /// The node took it.
    Accepted,
    /// The node already has it (in its mempool, or mined).
    AlreadyKnown,
    /// The node refused it and does not have it.
    Rejected,
}

/// The wallet and chain an inbox needs. The operator's is zcash-devtool and drop-chain ([`super::backend`]); tests use a
/// fake.
pub trait InboxBackend: Send + Sync {
    /// Sets payout account `account`'s inbox wallet up (or checks the one already set up) and gives its address.
    fn set_up<'a>(
        &'a self,
        seed: &'a SecretSeed,
        account: u32,
        birthday: u32,
    ) -> BoxFuture<'a, Result<String, InboxError>>;
    /// Syncs the wallet and reads what it holds.
    fn refresh(&self, account: u32) -> BoxFuture<'_, Result<Snapshot, InboxError>>;
    /// The node's tip and branch.
    fn chain_now(&self) -> BoxFuture<'_, Result<ChainNow, InboxError>>;
    /// Builds a move of exactly `value` to `funding_address` and checks it ([`drop_zcash::InboxKeys::check_move`]).
    fn build_move<'a>(
        &'a self,
        seed: &'a SecretSeed,
        account: u32,
        funding_address: &'a str,
        value: u64,
        context: OwnedContext,
    ) -> BoxFuture<'a, Result<Built, InboxError>>;
    /// Builds a send-back of everything spendable to `to` and checks it ([`drop_zcash::InboxKeys::check_return`]).
    fn build_return<'a>(
        &'a self,
        seed: &'a SecretSeed,
        account: u32,
        to: &'a str,
        context: OwnedContext,
    ) -> BoxFuture<'a, Result<Built, InboxError>>;
    /// Broadcasts exactly `raw`.
    fn broadcast<'a>(&'a self, raw: &'a [u8]) -> BoxFuture<'a, Result<Sent, InboxError>>;
    /// The height a transaction was mined at, if it is mined.
    fn mined_height<'a>(&'a self, txid: &'a Txid)
        -> BoxFuture<'a, Result<Option<u32>, InboxError>>;
}

/// [`InboxTxContext`] with its notes owned, to cross into a backend's future.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedContext {
    /// The node's branch id.
    pub branch_id: u32,
    /// The node's tip.
    pub tip: u32,
    /// The inbox's spendable notes: (nullifier, value).
    pub notes: Vec<([u8; 32], u64)>,
}

impl OwnedContext {
    /// Borrowed, as the check takes it.
    pub fn as_context(&self) -> InboxTxContext<'_> {
        InboxTxContext {
            branch_id: self.branch_id,
            tip: self.tip,
            notes: &self.notes,
        }
    }
}

/// How the engine paces itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InboxSettings {
    /// How often it looks at every inbox.
    pub poll: Duration,
    /// The shortest wait between a move being possible and making it.
    pub delay_min: Duration,
    /// The longest.
    pub delay_max: Duration,
    /// How often a transaction in flight is sent again.
    pub resend: Duration,
}

impl Default for InboxSettings {
    fn default() -> Self {
        InboxSettings {
            poll: Duration::from_secs(20),
            delay_min: Duration::from_secs(60),
            delay_max: Duration::from_secs(600),
            resend: Duration::from_secs(120),
        }
    }
}

/// Where an inbox stands, as the funding screen shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxState {
    /// Being set up.
    Preparing,
    /// The wallet could not be set up or read; nothing moves until it can.
    Unavailable,
    /// Nothing has arrived.
    Waiting,
    /// A deposit is confirming.
    Confirming,
    /// Short of what the move needs.
    Short,
    /// Over by less than the smallest change zcash-devtool makes.
    Dust,
    /// Enough is there: the move is due at `move_at`.
    Scheduled,
    /// The move is sent and not yet mined (or mined, and the payout is not funded yet).
    Moving,
    /// The move is mined: the payout's funding is in place.
    Moved,
    /// The payout was funded another way; the inbox is not used.
    Unused,
    /// A send-back is in flight.
    Returning,
}

/// What the page shows of a payout's inbox (REQ-FUND-008). Amounts are zatoshi, as decimal strings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InboxView {
    /// Where it stands.
    pub state: InboxState,
    /// Its address, once it is set up: where the payer deposits.
    pub deposit_address: Option<String>,
    /// What the payer is asked to send: the funding and the move's fee.
    pub asked: String,
    /// Everything unspent that has arrived, confirmed or not.
    pub received: String,
    /// What the wallet can spend now.
    pub spendable: String,
    /// The fewest confirmations of a deposit still confirming.
    pub confirmations: Option<u32>,
    /// Confirmations a deposit needs before it can be moved.
    pub required_confirmations: u32,
    /// How much more is needed, when short (or to lift the change over the dust limit).
    pub need: Option<String>,
    /// When the move is due, in Unix seconds, when scheduled.
    pub move_at: Option<u64>,
    /// The move's (or send-back's) transaction id, once sent.
    pub txid: Option<String>,
    /// What is left in the inbox once the payout is funded, which can be sent back.
    pub left: String,
    /// Orchard (not Ironwood) value that reached the inbox: a move never spends it.
    pub orchard: String,
}

impl InboxView {
    fn preparing(asked_zat: u64) -> InboxView {
        InboxView {
            state: InboxState::Preparing,
            deposit_address: None,
            asked: asked_zat.to_string(),
            received: "0".into(),
            spendable: "0".into(),
            confirmations: None,
            required_confirmations: SPENDABLE_AFTER,
            need: None,
            move_at: None,
            txid: None,
            left: "0".into(),
            orchard: "0".into(),
        }
    }
}

/// The inboxes of one operator: the backend, and what the page reads.
pub struct Inboxes {
    backend: Arc<dyn InboxBackend>,
    settings: InboxSettings,
    views: Mutex<HashMap<CampaignId, InboxView>>,
    due: Mutex<HashMap<CampaignId, SystemTime>>,
    sent_at: Mutex<HashMap<CampaignId, Instant>>,
    refreshed_at: Mutex<HashMap<CampaignId, Instant>>,
    /// One inbox operation at a time: setup, refresh, move or send-back.
    work: tokio::sync::Mutex<()>,
    /// Held for the life of the process, so two operators never drive the same inbox wallets.
    _dir_lock: Option<std::fs::File>,
}

/// How often the inbox of a funded payout with nothing in flight is looked at.
const FINISHED_REFRESH: Duration = Duration::from_secs(600);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Inboxes {
    /// An engine over `backend`. `dir_lock` is the open lock file of the inbox directory, held for the life of the process.
    pub fn new(
        backend: Arc<dyn InboxBackend>,
        settings: InboxSettings,
        dir_lock: Option<std::fs::File>,
    ) -> Inboxes {
        Inboxes {
            backend,
            settings,
            views: Mutex::new(HashMap::new()),
            due: Mutex::new(HashMap::new()),
            sent_at: Mutex::new(HashMap::new()),
            refreshed_at: Mutex::new(HashMap::new()),
            work: tokio::sync::Mutex::new(()),
            _dir_lock: dir_lock,
        }
    }

    /// What the page shows of a payout's inbox, from memory only.
    pub fn view(&self, id: &CampaignId) -> Option<InboxView> {
        lock(&self.views).get(id).cloned()
    }

    fn set_view(&self, id: &CampaignId, view: InboxView) {
        lock(&self.views).insert(id.clone(), view);
    }

    /// Looks at every payout's inbox once: sets up the unfunded ones that have none, and moves where a move is due.
    pub async fn round(&self, state: &AppState) {
        let Ok(deposits) = state.store().campaign_deposits() else {
            return;
        };
        for (id, funding) in deposits {
            let _work = self.work.lock().await;
            if let Err(error) = self.one(state, &id, funding.is_some()).await {
                if let Some(mut view) = self.view(&id) {
                    if matches!(view.state, InboxState::Preparing)
                        || error == InboxError::Unavailable
                    {
                        view.state = InboxState::Unavailable;
                        self.set_view(&id, view);
                    }
                }
                state.logger().warn(format_args!("inbox of {id}: {error}"));
            }
        }
    }

    async fn one(&self, state: &AppState, id: &CampaignId, funded: bool) -> Result<(), InboxError> {
        let store = state.store();
        let record = store
            .load_campaign(id)
            .map_err(|_| InboxError::Unavailable)?
            .ok_or(InboxError::Unavailable)?;
        if record.network != Network::Testnet {
            return Ok(());
        }
        let Some(funding_address) = state
            .funding_address(&record)
            .map_err(|_| InboxError::Unavailable)?
        else {
            return Ok(());
        };
        let batches = state.plan(&record).map_err(|_| InboxError::Unavailable)?;
        let required = funding_plan(&batches, &record.fee_policy)
            .map_err(|_| InboxError::Unavailable)?
            .required
            .as_u64();
        let mut inbox = store.load_inbox(id).map_err(|_| InboxError::Unavailable)?;

        // A payout funded before it had an inbox never gets one.
        if inbox.is_none() {
            if funded {
                return Ok(());
            }
            self.set_view(id, InboxView::preparing(asked(required)));
            let chain = self.backend.chain_now().await?;
            let birthday = chain.tip.saturating_sub(10);
            let address = self
                .backend
                .set_up(state.seed(), record.account, birthday)
                .await?;
            let fresh = InboxRecord {
                created_at: now_secs(),
                address,
                birthday,
                pending: None,
                moved: None,
            };
            store
                .save_inbox(id, &fresh)
                .map_err(|_| InboxError::Unavailable)?;
            inbox = Some(fresh);
        }
        let Some(mut inbox) = inbox else {
            return Ok(());
        };

        // A funded payout with nothing in flight changes rarely: once the page has its final word on the inbox (moved, or
        // not used), the inbox is looked at every ten minutes, not every round.
        let finished = funded
            && inbox.pending.is_none()
            && self
                .view(id)
                .is_some_and(|view| matches!(view.state, InboxState::Moved | InboxState::Unused));
        if finished
            && lock(&self.refreshed_at)
                .get(id)
                .is_some_and(|at| at.elapsed() < FINISHED_REFRESH)
        {
            return Ok(());
        }
        let snapshot = self.backend.refresh(record.account).await?;
        lock(&self.refreshed_at).insert(id.clone(), Instant::now());
        let chain = self.backend.chain_now().await?;

        // A transaction in flight: mined, dead, or still to be sent again.
        if let Some(pending) = inbox.pending.clone() {
            let txid: Txid = pending.txid.parse().map_err(|_| InboxError::Unavailable)?;
            match self.backend.mined_height(&txid).await? {
                // Done once the wallet has scanned the block it is in. zcash-devtool learns of it only from the chain, so
                // until then the notes it spent still look unspent: it stays in flight (and a send-back stays refused).
                Some(height) if snapshot.wallet_tip >= height => {
                    if pending.kind == InboxTxKind::Move {
                        inbox.moved = Some(pending.txid.clone());
                    }
                    inbox.pending = None;
                    store
                        .save_inbox(id, &inbox)
                        .map_err(|_| InboxError::Unavailable)?;
                }
                Some(_) => {}
                // Past its expiry on the scanned chain and not mined: it can never be mined now.
                None if snapshot.wallet_tip > pending.expiry_height => {
                    inbox.pending = None;
                    store
                        .save_inbox(id, &inbox)
                        .map_err(|_| InboxError::Unavailable)?;
                }
                None => self.resend(id, &pending).await,
            }
        }

        let notes: Vec<Held> = snapshot
            .notes
            .iter()
            .map(|n| Held {
                value: n.value,
                confirmations: n.confirmations(snapshot.wallet_tip),
                is_change: n.is_change,
                unspent: n.spend == NoteSpend::Unspent,
            })
            .collect();
        let held = holdings(&notes);
        let payout = Payout {
            required,
            funded_otherwise: funded && inbox.moved.is_none() && inbox.pending.is_none(),
            busy_or_moved: inbox.pending.is_some() || inbox.moved.is_some(),
        };
        let decided = plan(payout, &notes);
        let mut view = InboxView {
            state: InboxState::Waiting,
            deposit_address: Some(inbox.address.clone()),
            asked: asked(required).to_string(),
            received: held.received.to_string(),
            spendable: held.spendable.to_string(),
            confirmations: held.confirming,
            required_confirmations: SPENDABLE_AFTER,
            need: None,
            move_at: None,
            txid: inbox
                .pending
                .as_ref()
                .map(|p| p.txid.clone())
                .or_else(|| inbox.moved.clone()),
            left: "0".into(),
            orchard: snapshot.orchard.to_string(),
        };
        view.state = match (&inbox.pending, &inbox.moved, decided) {
            (Some(p), _, _) if p.kind == InboxTxKind::Return => InboxState::Returning,
            (Some(_), _, _) => InboxState::Moving,
            (None, Some(_), _) => {
                view.left = held.received.to_string();
                if funded {
                    InboxState::Moved
                } else {
                    InboxState::Moving
                }
            }
            (None, None, Plan::Hold) => {
                view.left = held.received.to_string();
                InboxState::Unused
            }
            (None, None, Plan::Empty) => InboxState::Waiting,
            (None, None, Plan::Confirming) => InboxState::Confirming,
            (None, None, Plan::Short { need }) => {
                view.need = Some(need.to_string());
                InboxState::Short
            }
            (None, None, Plan::Dust { over }) => {
                view.need = Some(super::plan::MIN_CHANGE.saturating_sub(over).to_string());
                InboxState::Dust
            }
            (None, None, Plan::Move { .. }) => InboxState::Scheduled,
        };
        if view.state != InboxState::Scheduled {
            lock(&self.due).remove(id);
            self.set_view(id, view);
            return Ok(());
        }

        // Enough is there. The move waits a random while, so it does not line up in time with the deposit.
        let due = *lock(&self.due)
            .entry(id.clone())
            .or_insert_with(|| SystemTime::now() + self.delay());
        view.move_at = due.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs());
        self.set_view(id, view.clone());
        if SystemTime::now() < due {
            return Ok(());
        }
        let moved = self
            .do_move(
                state,
                id,
                &funding_address,
                required,
                &mut inbox,
                &snapshot,
                chain,
            )
            .await?;
        lock(&self.due).remove(id);
        view.move_at = None;
        if moved {
            view.state = InboxState::Moving;
            view.txid = inbox.pending.as_ref().map(|p| p.txid.clone());
        } else {
            // The payout is being funded another way (or already is): the inbox is not used.
            view.state = InboxState::Unused;
            view.left = held.received.to_string();
        }
        self.set_view(id, view);
        Ok(())
    }

    fn delay(&self) -> Duration {
        let (min, max) = (
            self.settings.delay_min,
            self.settings.delay_max.max(self.settings.delay_min),
        );
        let spread = max.saturating_sub(min).as_millis();
        if spread == 0 {
            return min;
        }
        let mut bytes = [0u8; 8];
        let random = getrandom::fill(&mut bytes)
            .map(|()| u64::from_le_bytes(bytes))
            .unwrap_or(0);
        let extra = u64::try_from(u128::from(random) % spread).unwrap_or(0);
        min + Duration::from_millis(extra)
    }

    /// The move, with every guard just before it: the payout still unfunded, nothing big enough at its funding address
    /// (read fresh), the wallet caught up with the node. Stored before it is sent. `false` when a guard held it back.
    #[allow(clippy::too_many_arguments)]
    async fn do_move(
        &self,
        state: &AppState,
        id: &CampaignId,
        funding_address: &str,
        required: u64,
        inbox: &mut InboxRecord,
        snapshot: &Snapshot,
        chain: ChainNow,
    ) -> Result<bool, InboxError> {
        let record = state
            .store()
            .load_campaign(id)
            .map_err(|_| InboxError::Unavailable)?
            .ok_or(InboxError::Unavailable)?;
        if record.funding.is_some() || inbox.pending.is_some() || inbox.moved.is_some() {
            return Ok(false);
        }
        state
            .check_wallet(&record)
            .map_err(|_| InboxError::Unavailable)?;
        let backend = Arc::clone(state.backend());
        let address = funding_address.to_owned();
        let seen = tokio::task::spawn_blocking(move || backend.funding_sightings(&address))
            .await
            .map_err(|_| InboxError::Chain)?
            .map_err(|_| InboxError::Chain)?;
        if seen.iter().any(|s| s.amount.as_u64() >= required) {
            return Ok(false);
        }
        if chain.tip.saturating_sub(snapshot.wallet_tip) > 2 {
            return Err(InboxError::Behind);
        }
        let context = OwnedContext {
            branch_id: chain.branch_id,
            tip: chain.tip,
            notes: snapshot
                .notes
                .iter()
                .filter(|n| n.spend == NoteSpend::Unspent)
                .filter_map(|n| n.nullifier.map(|nf| (nf, n.value)))
                .collect(),
        };
        let built = self
            .backend
            .build_move(
                state.seed(),
                record.account,
                funding_address,
                required,
                context,
            )
            .await?;
        inbox.pending = Some(InboxTx {
            kind: InboxTxKind::Move,
            txid: built.facts.txid.clone(),
            raw: hex::encode(&built.raw),
            expiry_height: built.facts.expiry_height,
        });
        // Stored before it is sent (invariant 3): a crash from here on re-sends these bytes, and builds no other.
        state
            .store()
            .save_inbox(id, inbox)
            .map_err(|_| InboxError::Unavailable)?;
        lock(&self.sent_at).insert(id.clone(), Instant::now());
        let sent = self.backend.broadcast(&built.raw).await;
        state.logger().info(format_args!(
            "inbox of {id}: move {} sent ({:?})",
            built.facts.txid,
            sent.unwrap_or(Sent::Rejected)
        ));
        Ok(true)
    }

    /// Sends everything spendable in a payout's inbox, less the fee, to the shielded address `to` (REQ-FUND-007): only when no
    /// move can happen (the payout is funded, or the inbox has moved, or it holds less than a move needs), never to a
    /// transparent or Sapling-only address, never to the inbox itself or to the payout's own account (whose viewing key an
    /// auditor holds). Checked, stored, then sent, like a move; gives its txid.
    pub async fn send_back(
        &self,
        state: &AppState,
        record: &CampaignRecord,
        to: &str,
    ) -> Result<String, SendBackError> {
        let _work = self.work.lock().await;
        let id = &record.id;
        let mut inbox = state
            .store()
            .load_inbox(id)
            .map_err(|_| InboxError::Unavailable)?
            .ok_or(SendBackError::NoInbox)?;
        if inbox.pending.is_some() {
            return Err(SendBackError::Busy);
        }
        let network = zcash_network(record.network);
        let phrase = InboxPhrase::derive(state.seed(), record.network, record.account)
            .map_err(|_| InboxError::Unavailable)?;
        let own = InboxKeys::derive(phrase.wallet_seed(), network)
            .map_err(|_| InboxError::Unavailable)?;
        let payout = CampaignKeys::derive(state.seed().expose_secret(), network, record.account)
            .map_err(|_| InboxError::Unavailable)?;
        match (
            orchard_receiver_owned_by(network, to, own.ufvk()),
            orchard_receiver_owned_by(network, to, payout.ufvk()),
        ) {
            (Some(false), Some(false)) => {}
            _ => return Err(SendBackError::Refused),
        }
        let snapshot = self.backend.refresh(record.account).await?;
        let chain = self.backend.chain_now().await?;
        let notes: Vec<Held> = snapshot
            .notes
            .iter()
            .map(|n| Held {
                value: n.value,
                confirmations: n.confirmations(snapshot.wallet_tip),
                is_change: n.is_change,
                unspent: n.spend == NoteSpend::Unspent,
            })
            .collect();
        if record.funding.is_none() && inbox.moved.is_none() {
            let batches = state.plan(record).map_err(|_| InboxError::Unavailable)?;
            let required = funding_plan(&batches, &record.fee_policy)
                .map_err(|_| InboxError::Unavailable)?
                .required
                .as_u64();
            let payout = Payout {
                required,
                funded_otherwise: false,
                busy_or_moved: false,
            };
            if matches!(plan(payout, &notes), Plan::Move { .. } | Plan::Confirming) {
                return Err(SendBackError::Busy);
            }
        }
        if holdings(&notes).spendable == 0 {
            return Err(SendBackError::Nothing);
        }
        if chain.tip.saturating_sub(snapshot.wallet_tip) > 2 {
            return Err(InboxError::Behind.into());
        }
        let context = OwnedContext {
            branch_id: chain.branch_id,
            tip: chain.tip,
            notes: snapshot
                .notes
                .iter()
                .filter(|n| n.spend == NoteSpend::Unspent)
                .filter_map(|n| n.nullifier.map(|nf| (nf, n.value)))
                .collect(),
        };
        let built = self
            .backend
            .build_return(state.seed(), record.account, to, context)
            .await?;
        inbox.pending = Some(InboxTx {
            kind: InboxTxKind::Return,
            txid: built.facts.txid.clone(),
            raw: hex::encode(&built.raw),
            expiry_height: built.facts.expiry_height,
        });
        state
            .store()
            .save_inbox(id, &inbox)
            .map_err(|_| InboxError::Unavailable)?;
        lock(&self.sent_at).insert(id.clone(), Instant::now());
        let sent = self.backend.broadcast(&built.raw).await;
        state.logger().info(format_args!(
            "inbox of {id}: send-back {} sent ({:?})",
            built.facts.txid,
            sent.unwrap_or(Sent::Rejected)
        ));
        // As the next round will say it: on its way back, and nothing said to be left.
        if let Some(mut view) = self.view(id) {
            view.state = InboxState::Returning;
            view.txid = Some(built.facts.txid.clone());
            view.left = "0".into();
            self.set_view(id, view);
        }
        Ok(built.facts.txid)
    }

    /// Sends a stored transaction again, at most every [`InboxSettings::resend`].
    async fn resend(&self, id: &CampaignId, pending: &InboxTx) {
        let due = lock(&self.sent_at)
            .get(id)
            .is_none_or(|at| at.elapsed() >= self.settings.resend);
        if !due {
            return;
        }
        if let Ok(raw) = hex::decode(&pending.raw) {
            let _ = self.backend.broadcast(&raw).await;
            lock(&self.sent_at).insert(id.clone(), Instant::now());
        }
    }

    /// Runs [`Inboxes::round`] every [`InboxSettings::poll`], for the life of the process.
    pub fn spawn(self: &Arc<Self>, state: AppState) -> tokio::task::JoinHandle<()> {
        let inboxes = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                inboxes.round(&state).await;
                tokio::time::sleep(inboxes.settings.poll).await;
            }
        })
    }
}

/// Where a seed's inbox wallets live: `<state-dir>/inbox/<seed fingerprint>`.
pub fn inbox_root(state_dir: &std::path::Path, seed: &SecretSeed) -> PathBuf {
    state_dir.join("inbox").join(seed.fingerprint())
}
