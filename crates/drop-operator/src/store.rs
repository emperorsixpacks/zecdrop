//! The encrypted local store (REQ-SEC-002) and its [`Ledger`] implementation.
//!
//! One SQLite file holds everything. What is encrypted (XChaCha20-Poly1305, key
//! from the passphrase via Argon2id, salt in the `meta` table):
//!
//! * the campaign name,
//! * the manifest: every recipient address, amount and memo, plus the commitment salt,
//! * each batch's raw built transaction,
//! * the wallet seed.
//!
//! What is stored in the clear because it is public or operational: ids, creation
//! time, network, pool, fee policy, batch size, the manifest commitment, the campaign's
//! ZIP-32 account and wallet fingerprint, batch states, transaction ids, confirmation depths,
//! failure reasons, and the funding outpoint and amount.
//!
//! Every sealed record is bound to its place by associated data (kind, campaign,
//! batch index), so records cannot be swapped between rows undetected. Every row of
//! `campaigns` and `batches` also carries a **tag**, an authenticated seal over all of its
//! columns: someone who can edit the file but does not know the passphrase cannot change a
//! column (say the account number, to make one campaign's key export another's), mark a batch
//! confirmed, or move a tag to another row without the next read failing with
//! [`StoreError::Corrupt`]. On load, the commitment stored beside a manifest must also be that
//! manifest's own commitment.
//!
//! A store written before rows carried tags is upgraded once, when it is first opened by this
//! build: its existing rows are tagged with what they hold at that moment, which is the only time
//! plaintext columns are taken on trust. The sealed key check records that the upgrade happened,
//! so afterwards an untagged row is damage.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use drop_core::{
    BatchStatus, CampaignId, FeePolicy, InMemoryLedger, Ledger, LedgerError, Manifest,
    ManifestCommitment, Network, OutPoint, Pool, Txid, Zatoshi,
};
use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension, TransactionBehavior};
use zeroize::Zeroizing;

use crate::accounts::AccountAllocator;
use crate::crypto::{self, derive_key, KdfParams, StoreKey, MIN_PASSPHRASE_CHARS, SALT_LEN};
use crate::error::StoreError;
use crate::secret::SecretSeed;

const FORMAT: &str = "1";
/// The sealed check value of a store from before its rows carried tags.
const KEY_CHECK: &[u8] = b"zecdrop-store-key-check";
/// The sealed check value of a store whose rows are all authenticated. Being sealed, it also
/// tells an authentic tagged store from an old one: it cannot be put back to the old value
/// without the key, so a missing tag in a tagged store is damage, not an upgrade.
const KEY_CHECK_TAGGED: &[u8] = b"zecdrop-store-key-check-tagged-rows";
const SEED_NAME: &str = "wallet_seed";

fn aad(kind: &str, campaign: &str, index: u32) -> Vec<u8> {
    format!("zecdrop|{kind}|{campaign}|{index}").into_bytes()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The deposit the campaign is funded with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FundingObserved {
    /// The funding output.
    pub outpoint: OutPoint,
    /// Its value.
    pub amount: Zatoshi,
}

/// What recording a funding observation did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FundingOutcome {
    /// The funding was recorded.
    Recorded,
    /// The same funding was already on record.
    Unchanged,
    /// Different funding is already on record.
    Conflict(FundingObserved),
}

/// Everything needed to create a campaign.
pub struct NewCampaign<'a> {
    /// The new campaign's id.
    pub id: &'a CampaignId,
    /// A display name (stored encrypted).
    pub name: &'a str,
    /// The network.
    pub network: Network,
    /// The shielded pool.
    pub pool: Pool,
    /// The fee policy the plan was made with.
    pub fee_policy: FeePolicy,
    /// The batch size ceiling the plan was made with.
    pub max_outputs_per_batch: usize,
    /// The private manifest (stored encrypted).
    pub manifest: &'a Manifest,
    /// A short fingerprint of the wallet seed the campaign's keys come from, so a later
    /// run with a different seed is noticed instead of deriving unrelated addresses. It also
    /// keys the account numbering: accounts are counted per seed.
    pub seed_fingerprint: &'a str,
}

/// A campaign loaded from the store.
pub struct CampaignRecord {
    /// The campaign id.
    pub id: CampaignId,
    /// The display name.
    pub name: String,
    /// Creation time, seconds since the Unix epoch.
    pub created_at: u64,
    /// The network.
    pub network: Network,
    /// The shielded pool.
    pub pool: Pool,
    /// The fee policy.
    pub fee_policy: FeePolicy,
    /// The batch size ceiling.
    pub max_outputs_per_batch: usize,
    /// The manifest commitment (public).
    pub commitment: ManifestCommitment,
    /// The private manifest.
    pub manifest: Manifest,
    /// The funding deposit, once observed.
    pub funding: Option<FundingObserved>,
    /// Whether a run was started (and so should resume after a restart).
    pub started: bool,
    /// The campaign's own ZIP-32 account, so a campaign's viewing key discloses that
    /// campaign and no other (REQ-AUD-002).
    pub account: u32,
    /// Fingerprint of the seed the account was derived from, if recorded.
    pub seed_fingerprint: Option<String>,
}

/// A campaign's name and creation time, for listings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CampaignHeader {
    /// The campaign id.
    pub id: CampaignId,
    /// The display name.
    pub name: String,
    /// Creation time, seconds since the Unix epoch.
    pub created_at: u64,
}

/// The encrypted store.
pub struct Store {
    path: PathBuf,
    conn: Mutex<Connection>,
    key: StoreKey,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Store{{path: {}}}", self.path.display())
    }
}

/// Brings a store written by an earlier build up to the current schema, in place.
/// Idempotent: columns that already exist are left alone.
fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let has_column = |table: &str, name: &str| -> Result<bool, StoreError> {
        let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let found = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|column| column == name);
        Ok(found)
    };
    if !has_column("campaigns", "account")? {
        conn.execute_batch("ALTER TABLE campaigns ADD COLUMN account INTEGER NOT NULL DEFAULT 0;")?;
        // Number the existing campaigns 0, 1, 2, ... in creation order.
        conn.execute_batch(
            "UPDATE campaigns SET account = (
                 SELECT COUNT(*) FROM campaigns AS earlier
                 WHERE earlier.created_at < campaigns.created_at
                    OR (earlier.created_at = campaigns.created_at AND earlier.id < campaigns.id)
             );",
        )?;
    }
    if !has_column("campaigns", "seed_fp")? {
        conn.execute_batch("ALTER TABLE campaigns ADD COLUMN seed_fp TEXT;")?;
    }
    for table in ["campaigns", "batches"] {
        if !has_column(table, "row_tag")? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN row_tag BLOB;"))?;
        }
    }
    Ok(())
}

/// Creates the (empty) database file readable by its owner only. SQLite gives its journal and
/// write-ahead files the permissions of the database file, so they follow.
fn create_private_file(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(_) => Ok(()),
            // An empty file is already there: it is used, and made private.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => restrict_to_owner(path),
            Err(_) => Err(StoreError::Permissions),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Makes the database file, and any journal or write-ahead file beside it, readable and
/// writable by its owner only.
fn restrict_to_owner(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            let file = PathBuf::from(name);
            let Ok(metadata) = std::fs::metadata(&file) else {
                continue;
            };
            if metadata.permissions().mode() & 0o177 != 0 {
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))
                    .map_err(|_| StoreError::Permissions)?;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn map_open_error(error: rusqlite::Error) -> StoreError {
    match &error {
        rusqlite::Error::SqliteFailure(e, _) if e.code == ErrorCode::NotADatabase => {
            StoreError::NotAStore
        }
        _ => StoreError::from(error),
    }
}

impl Store {
    /// Creates a new store file protected by `passphrase`.
    ///
    /// The file is created readable by its owner only, and so are the journal files SQLite
    /// derives from it. The passphrase must be at least [`MIN_PASSPHRASE_CHARS`] characters.
    pub fn create(path: &Path, passphrase: &str, kdf: KdfParams) -> Result<Store, StoreError> {
        if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
            return Err(StoreError::WeakPassphrase);
        }
        if path.exists() && std::fs::metadata(path).map(|m| m.len() > 0).unwrap_or(true) {
            return Err(StoreError::AlreadyExists);
        }
        create_private_file(path)?;
        let conn = Connection::open(path).map_err(map_open_error)?;
        conn.execute_batch(
            "PRAGMA secure_delete = ON; PRAGMA synchronous = FULL;
             CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
             CREATE TABLE campaigns (
                 id TEXT PRIMARY KEY,
                 created_at INTEGER NOT NULL,
                 network TEXT NOT NULL,
                 pool TEXT NOT NULL,
                 fee_policy TEXT NOT NULL,
                 max_outputs INTEGER NOT NULL,
                 commitment TEXT NOT NULL,
                 name_enc BLOB NOT NULL,
                 manifest_enc BLOB NOT NULL,
                 funding_outpoint TEXT,
                 funding_amount TEXT,
                 started INTEGER NOT NULL DEFAULT 0,
                 account INTEGER NOT NULL DEFAULT 0,
                 seed_fp TEXT,
                 row_tag BLOB
             );
             CREATE TABLE batches (
                 campaign_id TEXT NOT NULL,
                 batch_index INTEGER NOT NULL,
                 state TEXT NOT NULL,
                 txid TEXT,
                 raw_enc BLOB,
                 depth INTEGER,
                 reason TEXT,
                 row_tag BLOB,
                 PRIMARY KEY (campaign_id, batch_index)
             );
             CREATE TABLE secrets (name TEXT PRIMARY KEY, value_enc BLOB NOT NULL);
             CREATE TABLE near_quotes (
                 campaign_id TEXT PRIMARY KEY,
                 created_at INTEGER NOT NULL,
                 record_enc BLOB NOT NULL,
                 row_tag BLOB
             );",
        )?;

        let mut salt = [0u8; SALT_LEN];
        crypto::random_bytes(&mut salt)?;
        let key = derive_key(passphrase, &salt, &kdf)?;
        let key_check = crypto::seal(&key, &aad("key_check", "", 0), KEY_CHECK_TAGGED)?;
        let params_json = serde_json::to_vec(&kdf).map_err(|_| StoreError::Corrupt)?;
        for (name, value) in [
            ("format", FORMAT.as_bytes().to_vec()),
            ("kdf_salt", salt.to_vec()),
            ("kdf_params", params_json),
            ("key_check", key_check),
        ] {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![name, value],
            )?;
        }
        Ok(Store {
            path: path.to_owned(),
            conn: Mutex::new(conn),
            key,
        })
    }

    /// Opens an existing store. A wrong passphrase is reported cleanly.
    pub fn open(path: &Path, passphrase: &str) -> Result<Store, StoreError> {
        if !path.exists() {
            return Err(StoreError::Missing);
        }
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(map_open_error)?;
        let meta = |name: &str| -> Result<Vec<u8>, StoreError> {
            conn.query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![name],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => StoreError::NotAStore,
                rusqlite::Error::SqliteFailure(ref f, ref msg)
                    if f.code == ErrorCode::Unknown
                        && msg.as_deref().is_some_and(|m| m.contains("no such table")) =>
                {
                    StoreError::NotAStore
                }
                other => map_open_error(other),
            })
        };
        if meta("format")? != FORMAT.as_bytes() {
            return Err(StoreError::UnsupportedFormat);
        }
        let salt: [u8; SALT_LEN] = meta("kdf_salt")?
            .try_into()
            .map_err(|_| StoreError::NotAStore)?;
        let kdf: KdfParams =
            serde_json::from_slice(&meta("kdf_params")?).map_err(|_| StoreError::NotAStore)?;
        let key_check = meta("key_check")?;

        // A tampered header can only make the check below fail; unacceptable
        // parameters are refused before any memory is allocated for them.
        let key = derive_key(passphrase, &salt, &kdf).map_err(|_| StoreError::WrongPassphrase)?;
        let tagged = match crypto::open(&key, &aad("key_check", "", 0), &key_check) {
            Ok(plain) if plain.as_slice() == KEY_CHECK_TAGGED => true,
            Ok(plain) if plain.as_slice() == KEY_CHECK => false,
            _ => return Err(StoreError::WrongPassphrase),
        };
        conn.execute_batch("PRAGMA secure_delete = ON; PRAGMA synchronous = FULL;")?;
        // Stores from before NEAR funding gain its table; one that has it is left alone.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS near_quotes (
                 campaign_id TEXT PRIMARY KEY,
                 created_at INTEGER NOT NULL,
                 record_enc BLOB NOT NULL,
                 row_tag BLOB
             );",
        )?;
        // A store written by an earlier build may be readable by others: close that now.
        restrict_to_owner(path)?;
        let store = Store {
            path: path.to_owned(),
            conn: Mutex::new(conn),
            key,
        };
        if !tagged {
            store.upgrade_to_tagged_rows()?;
        }
        Ok(store)
    }

    /// Opens the store, creating it first if the file does not exist. The flag
    /// says whether it was created.
    pub fn open_or_create(
        path: &Path,
        passphrase: &str,
        kdf: KdfParams,
    ) -> Result<(Store, bool), StoreError> {
        if path.exists() {
            Store::open(path, passphrase).map(|store| (store, false))
        } else {
            Store::create(path, passphrase, kdf).map(|store| (store, true))
        }
    }

    /// The store file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn seal(
        &self,
        kind: &str,
        campaign: &str,
        index: u32,
        plain: &[u8],
    ) -> Result<Vec<u8>, StoreError> {
        Ok(crypto::seal(&self.key, &aad(kind, campaign, index), plain)?)
    }

    fn unseal(
        &self,
        kind: &str,
        campaign: &str,
        index: u32,
        record: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        crypto::open(&self.key, &aad(kind, campaign, index), record)
            .map_err(|_| StoreError::Corrupt)
    }

    /// Stores a new campaign and returns its ZIP-32 account. Fails with
    /// [`StoreError::Duplicate`] if the id is taken.
    ///
    /// The account is reserved with `accounts` (which outlives this store, see
    /// [`crate::accounts`]) before the campaign is written. If the write then fails, the number
    /// is skipped, never handed out again.
    pub fn insert_campaign(
        &self,
        new: &NewCampaign<'_>,
        accounts: &dyn AccountAllocator,
    ) -> Result<u32, StoreError> {
        let id = new.id.as_str();
        let manifest_json =
            Zeroizing::new(serde_json::to_vec(new.manifest).map_err(|_| StoreError::Corrupt)?);
        let manifest_enc = self.seal("manifest", id, 0, &manifest_json)?;
        let name_enc = self.seal("name", id, 0, new.name.as_bytes())?;
        let fee_json = serde_json::to_string(&new.fee_policy).map_err(|_| StoreError::Corrupt)?;
        let max_outputs =
            i64::try_from(new.max_outputs_per_batch).map_err(|_| StoreError::Corrupt)?;
        let created = i64::try_from(now_secs()).unwrap_or(i64::MAX);

        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let taken: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM campaigns WHERE id = ?1)",
            params![id],
            |r| r.get(0),
        )?;
        if taken {
            return Err(StoreError::Duplicate);
        }
        // The next free ZIP-32 account: every campaign gets its own and a number is never
        // handed out twice for one wallet seed, even by a store that has never seen it. Rows
        // from before the fingerprint was recorded could belong to any seed, so they count.
        let in_store: Option<i64> = tx.query_row(
            "SELECT MAX(account) FROM campaigns WHERE seed_fp = ?1 OR seed_fp IS NULL",
            params![new.seed_fingerprint],
            |r| r.get(0),
        )?;
        let in_store = in_store
            .map(|n| u32::try_from(n).map_err(|_| StoreError::Corrupt))
            .transpose()?;
        let account = accounts.reserve(new.seed_fingerprint, in_store)?;

        let columns = CampaignColumns {
            id: id.to_owned(),
            created_at: created,
            network: new.network.to_string(),
            pool: new.pool.to_string(),
            fee_policy: fee_json,
            max_outputs,
            commitment: new.manifest.commitment().to_string(),
            name_enc,
            manifest_enc,
            funding_outpoint: None,
            funding_amount: None,
            started: 0,
            account: i64::from(account),
            seed_fp: Some(new.seed_fingerprint.to_owned()),
        };
        let tag = self.tag(TABLE_CAMPAIGNS, &columns.fields())?;
        let result = tx.execute(
            "INSERT INTO campaigns
                 (id, created_at, network, pool, fee_policy, max_outputs, commitment, name_enc,
                  manifest_enc, funding_outpoint, funding_amount, started, account, seed_fp,
                  row_tag)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                columns.id,
                columns.created_at,
                columns.network,
                columns.pool,
                columns.fee_policy,
                columns.max_outputs,
                columns.commitment,
                columns.name_enc,
                columns.manifest_enc,
                columns.funding_outpoint,
                columns.funding_amount,
                columns.started,
                columns.account,
                columns.seed_fp,
                tag
            ],
        );
        match result {
            Ok(_) => {
                tx.commit()?;
                Ok(account)
            }
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == ErrorCode::ConstraintViolation =>
            {
                Err(StoreError::Duplicate)
            }
            Err(other) => Err(other.into()),
        }
    }

    /// Lists every campaign's id, name and creation time, oldest first.
    pub fn list_campaigns(&self) -> Result<Vec<CampaignHeader>, StoreError> {
        self.all_campaigns()?
            .into_iter()
            .map(|columns| {
                let name = self.unseal("name", &columns.id, 0, &columns.name_enc)?;
                Ok(CampaignHeader {
                    id: CampaignId::new(&columns.id).map_err(|_| StoreError::Corrupt)?,
                    name: String::from_utf8(name.to_vec()).map_err(|_| StoreError::Corrupt)?,
                    created_at: u64::try_from(columns.created_at).unwrap_or(0),
                })
            })
            .collect()
    }

    /// Loads and decrypts one campaign. Every column is authenticated first, and the stored
    /// commitment must be the commitment of the manifest it sits beside.
    pub fn load_campaign(&self, id: &CampaignId) -> Result<Option<CampaignRecord>, StoreError> {
        let columns = {
            let conn = self.conn();
            self.read_campaign(&conn, id.as_str())?
        };
        columns.map(|columns| self.record_from(columns)).transpose()
    }

    /// Keeps the live NEAR quote made for a campaign, so a restart does not lose its deposit
    /// address. The record is sealed (bound to the campaign) and its row is authenticated, so an
    /// edit made outside the operator, a different deposit address above all, is refused when it
    /// is read. A newer quote replaces an older one.
    pub fn save_near_quote(
        &self,
        campaign: &CampaignId,
        record: &crate::near::NearQuoteRecord,
    ) -> Result<(), StoreError> {
        let json = Zeroizing::new(serde_json::to_vec(record).map_err(|_| StoreError::Corrupt)?);
        let record_enc = self.seal("near_quote", campaign.as_str(), 0, &json)?;
        let created = i64::try_from(record.created_at).unwrap_or(i64::MAX);
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Only for a campaign that exists, and whose own row is sound.
        if self.read_campaign(&tx, campaign.as_str())?.is_none() {
            return Err(StoreError::NotFound);
        }
        let tag = self.tag(
            TABLE_NEAR,
            &near_fields(campaign.as_str(), created, &record_enc),
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO near_quotes (campaign_id, created_at, record_enc, row_tag)
             VALUES (?1, ?2, ?3, ?4)",
            params![campaign.as_str(), created, record_enc, tag],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The live NEAR quote kept for a campaign, if any.
    pub fn load_near_quote(
        &self,
        campaign: &CampaignId,
    ) -> Result<Option<crate::near::NearQuoteRecord>, StoreError> {
        let row: Option<(i64, Vec<u8>, Option<Vec<u8>>)> = self
            .conn()
            .query_row(
                "SELECT created_at, record_enc, row_tag FROM near_quotes WHERE campaign_id = ?1",
                params![campaign.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((created, record_enc, tag)) = row else {
            return Ok(None);
        };
        self.verify(
            TABLE_NEAR,
            &near_fields(campaign.as_str(), created, &record_enc),
            tag.as_deref(),
        )?;
        let json = self.unseal("near_quote", campaign.as_str(), 0, &record_enc)?;
        let record: crate::near::NearQuoteRecord =
            serde_json::from_slice(&json).map_err(|_| StoreError::Corrupt)?;
        if i64::try_from(record.created_at).ok() != Some(created) {
            return Err(StoreError::Corrupt);
        }
        Ok(Some(record))
    }

    /// The campaigns that have a live NEAR quote on file.
    pub fn near_quote_campaigns(&self) -> Result<Vec<CampaignId>, StoreError> {
        let ids: Vec<String> = {
            let conn = self.conn();
            let mut statement =
                conn.prepare("SELECT campaign_id FROM near_quotes ORDER BY campaign_id")?;
            let ids = statement
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            ids
        };
        ids.into_iter()
            .map(|id| CampaignId::new(&id).map_err(|_| StoreError::Corrupt))
            .collect()
    }

    /// Records the funding deposit. The first observation wins; repeating it is a
    /// no-op; a different one is reported, not applied.
    pub fn record_funding(
        &self,
        id: &CampaignId,
        funding: FundingObserved,
    ) -> Result<FundingOutcome, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(mut columns) = self.read_campaign(&tx, id.as_str())? else {
            return Err(StoreError::NotFound);
        };
        let outcome = match (&columns.funding_outpoint, &columns.funding_amount) {
            (Some(outpoint), Some(amount)) => {
                let current = FundingObserved {
                    outpoint: outpoint.parse().map_err(|_| StoreError::Corrupt)?,
                    amount: Zatoshi::new(amount.parse().map_err(|_| StoreError::Corrupt)?)
                        .map_err(|_| StoreError::Corrupt)?,
                };
                if current == funding {
                    FundingOutcome::Unchanged
                } else {
                    FundingOutcome::Conflict(current)
                }
            }
            _ => {
                columns.funding_outpoint = Some(funding.outpoint.to_string());
                columns.funding_amount = Some(funding.amount.as_u64().to_string());
                self.write_campaign_state(&tx, &columns)?;
                FundingOutcome::Recorded
            }
        };
        tx.commit()?;
        Ok(outcome)
    }

    /// Marks whether a run has been started for the campaign.
    pub fn set_started(&self, id: &CampaignId, started: bool) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(mut columns) = self.read_campaign(&tx, id.as_str())? else {
            return Err(StoreError::NotFound);
        };
        columns.started = i64::from(started);
        self.write_campaign_state(&tx, &columns)?;
        tx.commit()?;
        Ok(())
    }

    /// Ids of campaigns whose run was started, oldest first.
    pub fn started_campaigns(&self) -> Result<Vec<CampaignId>, StoreError> {
        self.all_campaigns()?
            .into_iter()
            .filter(|columns| columns.started != 0)
            .map(|columns| CampaignId::new(&columns.id).map_err(|_| StoreError::Corrupt))
            .collect()
    }

    /// The stored wallet seed, if the wallet was initialised.
    pub fn load_seed(&self) -> Result<Option<SecretSeed>, StoreError> {
        let record: Option<Vec<u8>> = self
            .conn()
            .query_row(
                "SELECT value_enc FROM secrets WHERE name = ?1",
                params![SEED_NAME],
                |r| r.get(0),
            )
            .optional()?;
        record
            .map(|record| {
                let plain = self.unseal("secret", SEED_NAME, 0, &record)?;
                let bytes: [u8; 32] = plain
                    .as_slice()
                    .try_into()
                    .map_err(|_| StoreError::Corrupt)?;
                Ok(SecretSeed::from_bytes(bytes))
            })
            .transpose()
    }

    /// Creates the wallet seed. Returns `true` if one was generated, `false` if the
    /// wallet already had one (it is never replaced).
    pub fn init_wallet(&self) -> Result<bool, StoreError> {
        if self.load_seed()?.is_some() {
            return Ok(false);
        }
        self.load_or_create_seed().map(|_| true)
    }

    /// Ids of campaigns still waiting for their funding deposit, oldest first.
    pub fn unfunded_campaigns(&self) -> Result<Vec<CampaignId>, StoreError> {
        self.all_campaigns()?
            .into_iter()
            .filter(|columns| columns.funding_outpoint.is_none())
            .map(|columns| CampaignId::new(&columns.id).map_err(|_| StoreError::Corrupt))
            .collect()
    }

    /// The transactions that funded the campaigns funded so far: each recorded deposit's txid.
    pub fn funded_deposits(&self) -> Result<Vec<Txid>, StoreError> {
        self.all_campaigns()?
            .into_iter()
            .filter_map(|columns| columns.funding_outpoint)
            .map(|outpoint| {
                outpoint
                    .parse::<OutPoint>()
                    .map(|o| o.txid)
                    .map_err(|_| StoreError::Corrupt)
            })
            .collect()
    }

    /// Returns the wallet seed, creating and storing a fresh one on first use.
    pub fn load_or_create_seed(&self) -> Result<SecretSeed, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<Vec<u8>> = tx
            .query_row(
                "SELECT value_enc FROM secrets WHERE name = ?1",
                params![SEED_NAME],
                |r| r.get(0),
            )
            .optional()?;
        let seed = match existing {
            Some(record) => {
                let plain = self.unseal("secret", SEED_NAME, 0, &record)?;
                let bytes: [u8; 32] = plain
                    .as_slice()
                    .try_into()
                    .map_err(|_| StoreError::Corrupt)?;
                SecretSeed::from_bytes(bytes)
            }
            None => {
                let seed = SecretSeed::generate()?;
                let record = self.seal("secret", SEED_NAME, 0, seed.expose_secret())?;
                tx.execute(
                    "INSERT INTO secrets (name, value_enc) VALUES (?1, ?2)",
                    params![SEED_NAME, record],
                )?;
                seed
            }
        };
        tx.commit()?;
        Ok(seed)
    }

    /// A [`Ledger`] over this store.
    pub fn ledger(self: &Arc<Self>) -> StoreLedger {
        StoreLedger {
            store: Arc::clone(self),
        }
    }
}

/// The table names that appear in row tags.
const TABLE_CAMPAIGNS: &str = "campaigns";
const TABLE_BATCHES: &str = "batches";
const TABLE_NEAR: &str = "near_quotes";

/// What a `near_quotes` row's tag covers: its place, its time, and its sealed record. (Each of
/// these is also caught a second way: the sealed record is bound to its campaign, and its own
/// time is compared with the column. The tag is the belt every other row has as well.)
fn near_fields(campaign: &str, created_at: i64, record_enc: &[u8]) -> Vec<Option<Vec<u8>>> {
    vec![text(campaign), number(created_at), Some(digest(record_enc))]
}

fn digest(bytes: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).to_vec()
}

fn text(value: &str) -> Option<Vec<u8>> {
    Some(value.as_bytes().to_vec())
}

fn number(value: impl ToString) -> Option<Vec<u8>> {
    Some(value.to_string().into_bytes())
}

/// Every column of a `campaigns` row. All but the two sealed blobs are stored in the clear, so
/// each row carries a tag over the lot (see [`crypto::row_tag`]): editing any column, or moving
/// a tag to another row, is detected the next time the row is read.
#[derive(Clone)]
struct CampaignColumns {
    id: String,
    created_at: i64,
    network: String,
    pool: String,
    fee_policy: String,
    max_outputs: i64,
    commitment: String,
    name_enc: Vec<u8>,
    manifest_enc: Vec<u8>,
    funding_outpoint: Option<String>,
    funding_amount: Option<String>,
    started: i64,
    account: i64,
    seed_fp: Option<String>,
}

const CAMPAIGN_SELECT: &str = "SELECT id, created_at, network, pool, fee_policy, max_outputs,
    commitment, name_enc, manifest_enc, funding_outpoint, funding_amount, started, account,
    seed_fp, row_tag FROM campaigns";

fn campaign_columns(r: &rusqlite::Row<'_>) -> rusqlite::Result<(CampaignColumns, Option<Vec<u8>>)> {
    Ok((
        CampaignColumns {
            id: r.get(0)?,
            created_at: r.get(1)?,
            network: r.get(2)?,
            pool: r.get(3)?,
            fee_policy: r.get(4)?,
            max_outputs: r.get(5)?,
            commitment: r.get(6)?,
            name_enc: r.get(7)?,
            manifest_enc: r.get(8)?,
            funding_outpoint: r.get(9)?,
            funding_amount: r.get(10)?,
            started: r.get(11)?,
            account: r.get(12)?,
            seed_fp: r.get(13)?,
        },
        r.get(14)?,
    ))
}

impl CampaignColumns {
    /// What the row tag covers: every column, the sealed blobs by their digests.
    fn fields(&self) -> Vec<Option<Vec<u8>>> {
        vec![
            text(&self.id),
            number(self.created_at),
            text(&self.network),
            text(&self.pool),
            text(&self.fee_policy),
            number(self.max_outputs),
            text(&self.commitment),
            Some(digest(&self.name_enc)),
            Some(digest(&self.manifest_enc)),
            self.funding_outpoint.as_deref().and_then(text),
            self.funding_amount.as_deref().and_then(text),
            number(self.started),
            number(self.account),
            self.seed_fp.as_deref().and_then(text),
        ]
    }
}

/// Every column of a `batches` row; see [`CampaignColumns`].
#[derive(Clone)]
struct BatchColumns {
    campaign_id: String,
    batch_index: u32,
    state: String,
    txid: Option<String>,
    raw_enc: Option<Vec<u8>>,
    depth: Option<i64>,
    reason: Option<String>,
}

impl BatchColumns {
    fn fields(&self) -> Vec<Option<Vec<u8>>> {
        vec![
            text(&self.campaign_id),
            number(self.batch_index),
            text(&self.state),
            self.txid.as_deref().and_then(text),
            self.raw_enc.as_deref().map(digest),
            self.depth.and_then(number),
            self.reason.as_deref().and_then(text),
        ]
    }
}

impl Store {
    /// The tag over a row's columns.
    fn tag(&self, table: &str, fields: &[Option<Vec<u8>>]) -> Result<Vec<u8>, StoreError> {
        let fields: Vec<Option<&[u8]>> = fields.iter().map(|f| f.as_deref()).collect();
        Ok(crypto::row_tag(&self.key, table, &fields)?)
    }

    /// Checks a row's columns against its tag. A row with no tag is as bad as a wrong one: in a
    /// store whose rows are tagged, there is no such thing as an untagged row that is fine.
    fn verify(
        &self,
        table: &str,
        fields: &[Option<Vec<u8>>],
        tag: Option<&[u8]>,
    ) -> Result<(), StoreError> {
        let tag = tag.ok_or(StoreError::Corrupt)?;
        let fields: Vec<Option<&[u8]>> = fields.iter().map(|f| f.as_deref()).collect();
        crypto::check_row_tag(&self.key, table, &fields, tag).map_err(|_| StoreError::Corrupt)
    }

    /// One campaign's columns, authenticated.
    fn read_campaign(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<Option<CampaignColumns>, StoreError> {
        let row = conn
            .query_row(
                &format!("{CAMPAIGN_SELECT} WHERE id = ?1"),
                params![id],
                campaign_columns,
            )
            .optional()?;
        row.map(|(columns, tag)| {
            self.verify(TABLE_CAMPAIGNS, &columns.fields(), tag.as_deref())?;
            Ok(columns)
        })
        .transpose()
    }

    /// Every campaign's columns, authenticated, oldest first. Anything that decides which
    /// campaigns to list, resume or poll goes through here, never through the raw columns.
    fn all_campaigns(&self) -> Result<Vec<CampaignColumns>, StoreError> {
        let rows = {
            let conn = self.conn();
            let mut statement = conn.prepare(CAMPAIGN_SELECT)?;
            let rows = statement
                .query_map([], campaign_columns)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut campaigns = rows
            .into_iter()
            .map(|(columns, tag)| {
                self.verify(TABLE_CAMPAIGNS, &columns.fields(), tag.as_deref())?;
                Ok(columns)
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        campaigns.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        Ok(campaigns)
    }

    /// Writes the columns that change after creation (funding, started) with a fresh tag.
    fn write_campaign_state(
        &self,
        conn: &Connection,
        columns: &CampaignColumns,
    ) -> Result<(), StoreError> {
        let tag = self.tag(TABLE_CAMPAIGNS, &columns.fields())?;
        conn.execute(
            "UPDATE campaigns SET funding_outpoint = ?1, funding_amount = ?2, started = ?3,
                    row_tag = ?4
             WHERE id = ?5",
            params![
                columns.funding_outpoint,
                columns.funding_amount,
                columns.started,
                tag,
                columns.id
            ],
        )?;
        Ok(())
    }

    /// Decrypts a campaign's sealed parts and builds its record. The commitment stored beside
    /// the manifest must be the commitment of that manifest.
    fn record_from(&self, columns: CampaignColumns) -> Result<CampaignRecord, StoreError> {
        let id = CampaignId::new(&columns.id).map_err(|_| StoreError::Corrupt)?;
        let name = self.unseal("name", &columns.id, 0, &columns.name_enc)?;
        let manifest_json = self.unseal("manifest", &columns.id, 0, &columns.manifest_enc)?;
        let manifest: Manifest =
            serde_json::from_slice(&manifest_json).map_err(|_| StoreError::Corrupt)?;
        if manifest.campaign_id() != &id {
            return Err(StoreError::Corrupt);
        }
        let commitment: ManifestCommitment = columns
            .commitment
            .parse()
            .map_err(|_| StoreError::Corrupt)?;
        if commitment != manifest.commitment() {
            return Err(StoreError::Corrupt);
        }
        let funding = match (&columns.funding_outpoint, &columns.funding_amount) {
            (Some(outpoint), Some(amount)) => Some(FundingObserved {
                outpoint: outpoint.parse().map_err(|_| StoreError::Corrupt)?,
                amount: Zatoshi::new(amount.parse().map_err(|_| StoreError::Corrupt)?)
                    .map_err(|_| StoreError::Corrupt)?,
            }),
            _ => None,
        };
        Ok(CampaignRecord {
            id,
            name: String::from_utf8(name.to_vec()).map_err(|_| StoreError::Corrupt)?,
            created_at: u64::try_from(columns.created_at).unwrap_or(0),
            network: match columns.network.as_str() {
                "testnet" => Network::Testnet,
                "mainnet" => Network::Mainnet,
                _ => return Err(StoreError::Corrupt),
            },
            pool: match columns.pool.as_str() {
                "ironwood" => Pool::Ironwood,
                "orchard" => Pool::Orchard,
                _ => return Err(StoreError::Corrupt),
            },
            fee_policy: serde_json::from_str(&columns.fee_policy)
                .map_err(|_| StoreError::Corrupt)?,
            max_outputs_per_batch: usize::try_from(columns.max_outputs)
                .map_err(|_| StoreError::Corrupt)?,
            commitment,
            manifest,
            funding,
            started: columns.started != 0,
            account: u32::try_from(columns.account).map_err(|_| StoreError::Corrupt)?,
            seed_fingerprint: columns.seed_fp,
        })
    }

    /// One-time upgrade of a store written before rows carried tags: adds the columns the
    /// current build needs, tags every existing row with what it holds now, and re-seals the
    /// key check so that from here on a missing or wrong tag is damage and not an upgrade.
    ///
    /// This is the only moment existing plaintext columns are taken on trust. A store that has
    /// already been upgraded never goes through here again, whatever is done to its rows.
    fn upgrade_to_tagged_rows(&self) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        migrate(&tx)?;
        let campaigns = {
            let mut statement = tx.prepare(CAMPAIGN_SELECT)?;
            let rows = statement
                .query_map([], campaign_columns)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (columns, _) in &campaigns {
            let tag = self.tag(TABLE_CAMPAIGNS, &columns.fields())?;
            tx.execute(
                "UPDATE campaigns SET row_tag = ?1 WHERE id = ?2",
                params![tag, columns.id],
            )?;
        }
        let batches = {
            let mut statement = tx.prepare(BATCH_SELECT)?;
            let rows = statement
                .query_map([], batch_columns)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (columns, _) in &batches {
            let tag = self.tag(TABLE_BATCHES, &columns.fields())?;
            tx.execute(
                "UPDATE batches SET row_tag = ?1 WHERE campaign_id = ?2 AND batch_index = ?3",
                params![tag, columns.campaign_id, columns.batch_index],
            )?;
        }
        let key_check = crypto::seal(&self.key, &aad("key_check", "", 0), KEY_CHECK_TAGGED)?;
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'key_check'",
            params![key_check],
        )?;
        tx.commit()?;
        Ok(())
    }
}

const BATCH_SELECT: &str =
    "SELECT campaign_id, batch_index, state, txid, raw_enc, depth, reason, row_tag FROM batches";

fn batch_columns(r: &rusqlite::Row<'_>) -> rusqlite::Result<(BatchColumns, Option<Vec<u8>>)> {
    Ok((
        BatchColumns {
            campaign_id: r.get(0)?,
            batch_index: r.get(1)?,
            state: r.get(2)?,
            txid: r.get(3)?,
            raw_enc: r.get(4)?,
            depth: r.get(5)?,
            reason: r.get(6)?,
        },
        r.get(7)?,
    ))
}

/// A stored batch row, with the anchor transaction decrypted.
struct BatchRow {
    state: String,
    txid: Option<Txid>,
    raw: Option<Vec<u8>>,
    /// The anchor transaction as it is sealed in the row, to be carried to the next state.
    raw_enc: Option<Vec<u8>>,
    depth: Option<u32>,
    reason: Option<String>,
}

impl BatchRow {
    fn status(&self) -> Result<BatchStatus, StoreError> {
        let txid = || self.txid.ok_or(StoreError::Corrupt);
        Ok(match self.state.as_str() {
            "planned" => BatchStatus::Planned,
            "built" => BatchStatus::Built {
                txid: txid()?,
                raw_tx: self.raw.clone().ok_or(StoreError::Corrupt)?,
            },
            "broadcast" => BatchStatus::Broadcast { txid: txid()? },
            "confirmed" => BatchStatus::Confirmed {
                txid: txid()?,
                depth: self.depth.ok_or(StoreError::Corrupt)?,
            },
            "failed" => BatchStatus::Failed {
                reason: self.reason.clone().ok_or(StoreError::Corrupt)?,
                txid: self.txid,
            },
            _ => return Err(StoreError::Corrupt),
        })
    }
}

/// Reads one batch row, authenticating every column before anything in it is believed.
fn read_row(
    store: &Store,
    conn: &Connection,
    campaign: &CampaignId,
    index: u32,
) -> Result<Option<BatchRow>, StoreError> {
    let row = conn
        .query_row(
            &format!("{BATCH_SELECT} WHERE campaign_id = ?1 AND batch_index = ?2"),
            params![campaign.as_str(), index],
            batch_columns,
        )
        .optional()?;
    let Some((columns, tag)) = row else {
        return Ok(None);
    };
    store.verify(TABLE_BATCHES, &columns.fields(), tag.as_deref())?;
    let raw = columns
        .raw_enc
        .as_deref()
        .map(|record| {
            store
                .unseal("raw", campaign.as_str(), index, record)
                .map(|plain| plain.to_vec())
        })
        .transpose()?;
    Ok(Some(BatchRow {
        state: columns.state,
        txid: columns
            .txid
            .map(|t| t.parse().map_err(|_| StoreError::Corrupt))
            .transpose()?,
        raw,
        raw_enc: columns.raw_enc,
        depth: columns.depth.and_then(|d| u32::try_from(d).ok()),
        reason: columns.reason,
    }))
}

/// Rebuilds the in-memory ledger entry that corresponds to a stored row, so the
/// transition rules of `drop-core` decide what is allowed, not a second copy of them.
fn replay(row: &BatchRow, campaign: &CampaignId, index: u32) -> Result<InMemoryLedger, StoreError> {
    let mut memory = InMemoryLedger::new();
    let mut apply = |status: BatchStatus| {
        memory
            .record(campaign, index, status)
            .map_err(|_| StoreError::Corrupt)
    };
    apply(BatchStatus::Planned)?;
    let anchor = match (row.txid, row.raw.clone()) {
        (Some(txid), Some(raw_tx)) => Some(BatchStatus::Built { txid, raw_tx }),
        (None, None) => None,
        _ => return Err(StoreError::Corrupt),
    };
    let txid = || row.txid.ok_or(StoreError::Corrupt);
    match row.state.as_str() {
        "planned" => {}
        "built" => {
            apply(anchor.ok_or(StoreError::Corrupt)?)?;
        }
        "broadcast" => {
            apply(anchor.ok_or(StoreError::Corrupt)?)?;
            apply(BatchStatus::Broadcast { txid: txid()? })?;
        }
        "confirmed" => {
            apply(anchor.ok_or(StoreError::Corrupt)?)?;
            apply(BatchStatus::Broadcast { txid: txid()? })?;
            apply(BatchStatus::Confirmed {
                txid: txid()?,
                depth: row.depth.ok_or(StoreError::Corrupt)?,
            })?;
        }
        "failed" => {
            if let Some(anchor) = anchor {
                apply(anchor)?;
            }
            // The ledger fills in the transaction built for the batch, which is the row's.
            apply(BatchStatus::Failed {
                reason: row.reason.clone().ok_or(StoreError::Corrupt)?,
                txid: None,
            })?;
        }
        _ => return Err(StoreError::Corrupt),
    }
    Ok(memory)
}

fn ledger_error(error: StoreError) -> LedgerError {
    LedgerError::Storage(error.to_string())
}

/// A [`Ledger`] backed by the encrypted store. Transitions are decided by
/// `drop-core`'s own rules and applied in one SQLite transaction.
#[derive(Clone)]
pub struct StoreLedger {
    store: Arc<Store>,
}

impl Ledger for StoreLedger {
    fn get(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<BatchStatus>, LedgerError> {
        let conn = self.store.conn();
        read_row(&self.store, &conn, campaign, batch_index)
            .and_then(|row| row.map(|r| r.status()).transpose())
            .map_err(ledger_error)
    }

    fn built_tx(
        &self,
        campaign: &CampaignId,
        batch_index: u32,
    ) -> Result<Option<(Txid, Vec<u8>)>, LedgerError> {
        let conn = self.store.conn();
        read_row(&self.store, &conn, campaign, batch_index)
            .map(|row| {
                row.and_then(|row| match (row.txid, row.raw) {
                    (Some(txid), Some(raw)) => Some((txid, raw)),
                    _ => None,
                })
            })
            .map_err(ledger_error)
    }

    fn record(
        &mut self,
        campaign: &CampaignId,
        batch_index: u32,
        status: BatchStatus,
    ) -> Result<(), LedgerError> {
        let mut conn = self.store.conn();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| ledger_error(e.into()))?;
        let row = read_row(&self.store, &tx, campaign, batch_index).map_err(ledger_error)?;

        let (mut memory, current) = match &row {
            Some(row) => (
                replay(row, campaign, batch_index).map_err(ledger_error)?,
                Some(row.status().map_err(ledger_error)?),
            ),
            None => (InMemoryLedger::new(), None),
        };
        memory.record(campaign, batch_index, status)?;
        let next = memory
            .get(campaign, batch_index)?
            .ok_or_else(|| ledger_error(StoreError::Corrupt))?;
        if current.as_ref() == Some(&next) {
            return Ok(());
        }

        // The whole row is written, with a fresh tag. What a state does not set is carried
        // over from the row it replaces: the anchor transaction stays with the batch.
        let id = campaign.as_str();
        let carried_raw = row.as_ref().and_then(|r| r.raw_enc.clone());
        let carried_depth = row.as_ref().and_then(|r| r.depth).map(i64::from);
        let mut columns = BatchColumns {
            campaign_id: id.to_owned(),
            batch_index,
            state: String::new(),
            txid: None,
            raw_enc: None,
            depth: None,
            reason: None,
        };
        match &next {
            BatchStatus::Planned => columns.state = "planned".to_owned(),
            BatchStatus::Built { txid, raw_tx } => {
                columns.state = "built".to_owned();
                columns.txid = Some(txid.to_string());
                columns.raw_enc = Some(
                    self.store
                        .seal("raw", id, batch_index, raw_tx)
                        .map_err(ledger_error)?,
                );
            }
            BatchStatus::Broadcast { txid } => {
                columns.state = "broadcast".to_owned();
                columns.txid = Some(txid.to_string());
                columns.raw_enc = carried_raw;
            }
            BatchStatus::Confirmed { txid, depth } => {
                columns.state = "confirmed".to_owned();
                columns.txid = Some(txid.to_string());
                columns.raw_enc = carried_raw;
                columns.depth = Some(i64::from(*depth));
            }
            BatchStatus::Failed { reason, txid } => {
                columns.state = "failed".to_owned();
                // The transaction built for the batch stays named by its record.
                columns.txid = txid.map(|t| t.to_string());
                columns.raw_enc = carried_raw;
                columns.depth = carried_depth;
                columns.reason = Some(reason.clone());
            }
        }
        let tag = self
            .store
            .tag(TABLE_BATCHES, &columns.fields())
            .map_err(ledger_error)?;
        tx.execute(
            "INSERT OR REPLACE INTO batches
                 (campaign_id, batch_index, state, txid, raw_enc, depth, reason, row_tag)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                columns.campaign_id,
                columns.batch_index,
                columns.state,
                columns.txid,
                columns.raw_enc,
                columns.depth,
                columns.reason,
                tag
            ],
        )
        .map_err(|e| ledger_error(e.into()))?;
        tx.commit().map_err(|e| ledger_error(e.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::MemoryAccounts;
    use drop_core::{Recipient, Salt};

    const PASS: &str = "correct horse battery staple";

    // Sentinels: none of these may ever appear in the database file.
    const SENTINEL_ADDRS: [&str; 3] = [
        "u1sentineladdressalpha00000000000000",
        "u1sentineladdressbravo00000000000000",
        "zs1sentineladdresscharlie00000000000",
    ];
    const SENTINEL_AMOUNTS: [u64; 3] = [7_777_001, 3_333_007, 1_111_003];
    const SENTINEL_MEMOS: [&str; 3] = [
        "sentinel-memo-one",
        "sentinel-memo-two",
        "sentinel-memo-three",
    ];
    const SENTINEL_NAME: &str = "sentinel-campaign-name";
    const SENTINEL_SALT: [u8; 32] = [0xC7; 32];
    const SENTINEL_RAW: [u8; 16] = [
        0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE,
        0xEF,
    ];

    fn id(name: &str) -> CampaignId {
        CampaignId::new(name).unwrap()
    }

    fn txid(n: u8) -> Txid {
        Txid::from_bytes([n; 32])
    }

    fn manifest(campaign: &CampaignId) -> Manifest {
        let rows = (0..3)
            .map(|i| {
                Recipient::new(
                    SENTINEL_ADDRS[i],
                    Zatoshi::new(SENTINEL_AMOUNTS[i]).unwrap(),
                    Some(SENTINEL_MEMOS[i].to_owned()),
                )
                .unwrap()
            })
            .collect();
        Manifest::new(campaign.clone(), Salt::from_bytes(SENTINEL_SALT), rows).unwrap()
    }

    fn new_store() -> (tempfile::TempDir, Arc<Store>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("s.sqlite"), PASS, KdfParams::TESTING).unwrap();
        (dir, Arc::new(store))
    }

    const FP: &str = "0011223344556677";

    fn add_campaign(store: &Store, campaign: &CampaignId) {
        let m = manifest(campaign);
        store
            .insert_campaign(
                &NewCampaign {
                    id: campaign,
                    name: SENTINEL_NAME,
                    network: Network::Testnet,
                    pool: Pool::Ironwood,
                    fee_policy: FeePolicy::zip317_text(),
                    max_outputs_per_batch: 3,
                    manifest: &m,
                    seed_fingerprint: FP,
                },
                &MemoryAccounts::default(),
            )
            .unwrap();
    }

    /// Every file SQLite may have written for this store.
    fn all_file_bytes(path: &Path) -> Vec<u8> {
        let mut bytes = std::fs::read(path).unwrap();
        for suffix in ["-journal", "-wal", "-shm"] {
            let mut sibling = path.as_os_str().to_owned();
            sibling.push(suffix);
            if let Ok(extra) = std::fs::read(sibling) {
                bytes.extend(extra);
            }
        }
        bytes
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    // covers: REQ-SEC-002
    #[test]
    fn the_raw_file_contains_no_recipient_data_name_salt_or_raw_tx() {
        let (_dir, store) = new_store();
        let campaign = id("camp-1");
        add_campaign(&store, &campaign);
        let mut ledger = store.ledger();
        ledger.record(&campaign, 0, BatchStatus::Planned).unwrap();
        ledger
            .record(
                &campaign,
                0,
                BatchStatus::Built {
                    txid: txid(1),
                    raw_tx: SENTINEL_RAW.to_vec(),
                },
            )
            .unwrap();
        ledger
            .record(&campaign, 0, BatchStatus::Broadcast { txid: txid(1) })
            .unwrap();
        store.load_or_create_seed().unwrap();

        let bytes = all_file_bytes(store.path());
        assert!(bytes.len() > 4096, "the file really was written");
        let mut needles: Vec<Vec<u8>> = Vec::new();
        for addr in SENTINEL_ADDRS {
            needles.push(addr.as_bytes().to_vec());
            needles.push(addr.as_bytes()[..14].to_vec());
        }
        for amount in SENTINEL_AMOUNTS {
            needles.push(amount.to_string().into_bytes());
            needles.push(Zatoshi::new(amount).unwrap().format_zec().into_bytes());
        }
        for memo in SENTINEL_MEMOS {
            needles.push(memo.as_bytes().to_vec());
        }
        needles.push(b"sentinel".to_vec());
        needles.push(SENTINEL_NAME.as_bytes().to_vec());
        needles.push(SENTINEL_SALT.to_vec());
        needles.push(hex::encode(SENTINEL_SALT).into_bytes());
        needles.push(SENTINEL_RAW.to_vec());
        for needle in needles {
            assert!(
                !contains(&bytes, &needle),
                "plaintext {:?} found in the store file",
                String::from_utf8_lossy(&needle)
            );
        }
        // Public bookkeeping is in the clear, as designed.
        assert!(contains(&bytes, campaign.as_str().as_bytes()));
        assert!(contains(&bytes, txid(1).to_string().as_bytes()));
    }

    // covers: REQ-SEC-002
    #[test]
    fn the_seed_bytes_are_not_in_the_file() {
        let (_dir, store) = new_store();
        let seed = store.load_or_create_seed().unwrap();
        let bytes = all_file_bytes(store.path());
        assert!(!contains(&bytes, seed.expose_secret()));
        assert!(!contains(
            &bytes,
            hex::encode(seed.expose_secret()).as_bytes()
        ));
    }

    // covers: REQ-SEC-002
    #[test]
    fn seed_is_stable_across_reopen() {
        let (dir, store) = new_store();
        let first = store.load_or_create_seed().unwrap();
        let again = store.load_or_create_seed().unwrap();
        assert_eq!(first.expose_secret(), again.expose_secret());
        let path = store.path().to_owned();
        drop(store);
        let reopened = Store::open(&path, PASS).unwrap();
        assert_eq!(
            reopened.load_or_create_seed().unwrap().expose_secret(),
            first.expose_secret()
        );
        drop(dir);
    }

    // covers: REQ-SEC-002
    #[test]
    fn campaigns_survive_close_and_reopen_with_the_right_passphrase() {
        let (dir, store) = new_store();
        let campaign = id("camp-1");
        add_campaign(&store, &campaign);
        let path = store.path().to_owned();
        drop(store);

        let reopened = Store::open(&path, PASS).unwrap();
        let loaded = reopened.load_campaign(&campaign).unwrap().unwrap();
        assert_eq!(loaded.name, SENTINEL_NAME);
        assert_eq!(loaded.manifest, manifest(&campaign));
        assert_eq!(loaded.commitment, manifest(&campaign).commitment());
        assert_eq!(loaded.fee_policy, FeePolicy::zip317_text());
        assert_eq!(loaded.max_outputs_per_batch, 3);
        assert_eq!(
            (loaded.network, loaded.pool),
            (Network::Testnet, Pool::Ironwood)
        );
        assert!(loaded.funding.is_none() && !loaded.started);
        assert_eq!(reopened.list_campaigns().unwrap().len(), 1);
        assert!(reopened.load_campaign(&id("missing")).unwrap().is_none());
        drop(dir);
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_wrong_passphrase_fails_cleanly() {
        let (dir, store) = new_store();
        add_campaign(&store, &id("camp-1"));
        let path = store.path().to_owned();
        drop(store);
        for wrong in [
            "",
            "wrong",
            "correct horse battery stapl",
            "Correct horse battery staple",
        ] {
            assert!(
                matches!(Store::open(&path, wrong), Err(StoreError::WrongPassphrase)),
                "{wrong:?}"
            );
        }
        assert!(
            Store::open(&path, PASS).is_ok(),
            "the right one still works"
        );
        drop(dir);
    }

    // covers: REQ-SEC-002
    #[test]
    fn missing_foreign_and_existing_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            Store::open(&dir.path().join("nope.sqlite"), PASS),
            Err(StoreError::Missing)
        ));

        let junk = dir.path().join("junk.sqlite");
        std::fs::write(
            &junk,
            b"this is not a database at all, just some text ".repeat(50),
        )
        .unwrap();
        assert!(matches!(
            Store::open(&junk, PASS),
            Err(StoreError::NotAStore)
        ));

        let other = dir.path().join("other.sqlite");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated (x INTEGER);")
            .unwrap();
        assert!(matches!(
            Store::open(&other, PASS),
            Err(StoreError::NotAStore)
        ));

        let (dir2, store) = new_store();
        assert!(matches!(
            Store::create(store.path(), PASS, KdfParams::TESTING),
            Err(StoreError::AlreadyExists)
        ));
        drop(dir2);
    }

    // covers: REQ-SEC-002
    #[test]
    fn the_header_holds_a_fresh_random_salt_and_the_kdf_parameters() {
        let (_d1, a) = new_store();
        let (_d2, b) = new_store();
        let header = |s: &Store, key: &str| -> Vec<u8> {
            s.conn()
                .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                    r.get(0)
                })
                .unwrap()
        };
        assert_eq!(header(&a, "kdf_salt").len(), SALT_LEN);
        assert_ne!(
            header(&a, "kdf_salt"),
            header(&b, "kdf_salt"),
            "salt differs per store"
        );
        let params: KdfParams = serde_json::from_slice(&header(&a, "kdf_params")).unwrap();
        assert_eq!(params, KdfParams::TESTING);
        // The passphrase itself is nowhere in the file.
        assert!(!contains(&all_file_bytes(a.path()), PASS.as_bytes()));
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_tampered_header_cannot_unlock_or_exhaust_memory() {
        let (dir, store) = new_store();
        let path = store.path().to_owned();
        drop(store);
        let conn = Connection::open(&path).unwrap();
        // Absurd cost parameters are refused without allocating them.
        let huge = serde_json::to_vec(&KdfParams {
            memory_kib: u32::MAX,
            iterations: 1,
            parallelism: 1,
        })
        .unwrap();
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'kdf_params'",
            params![huge],
        )
        .unwrap();
        assert!(matches!(
            Store::open(&path, PASS),
            Err(StoreError::WrongPassphrase)
        ));
        // Cheaper-but-valid parameters derive a different key, so the check fails.
        let cheap = serde_json::to_vec(&KdfParams {
            memory_kib: 64,
            iterations: 2,
            parallelism: 1,
        })
        .unwrap();
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'kdf_params'",
            params![cheap],
        )
        .unwrap();
        assert!(matches!(
            Store::open(&path, PASS),
            Err(StoreError::WrongPassphrase)
        ));
        drop(dir);
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_tampered_record_is_an_error_not_garbage() {
        for column in ["manifest_enc", "name_enc"] {
            let (_dir, store) = new_store();
            let campaign = id("camp-1");
            add_campaign(&store, &campaign);
            {
                let conn = store.conn();
                let mut blob: Vec<u8> = conn
                    .query_row(&format!("SELECT {column} FROM campaigns"), [], |r| r.get(0))
                    .unwrap();
                let middle = blob.len() / 2;
                blob[middle] ^= 0x01;
                conn.execute(
                    &format!("UPDATE campaigns SET {column} = ?1"),
                    params![blob],
                )
                .unwrap();
            }
            assert!(
                matches!(store.load_campaign(&campaign), Err(StoreError::Corrupt)),
                "{column}"
            );
        }

        // A tampered raw transaction.
        let (_dir, store) = new_store();
        let campaign = id("camp-1");
        add_campaign(&store, &campaign);
        let mut ledger = store.ledger();
        ledger.record(&campaign, 0, BatchStatus::Planned).unwrap();
        ledger
            .record(
                &campaign,
                0,
                BatchStatus::Built {
                    txid: txid(1),
                    raw_tx: vec![1, 2, 3],
                },
            )
            .unwrap();
        {
            let conn = store.conn();
            let mut blob: Vec<u8> = conn
                .query_row("SELECT raw_enc FROM batches", [], |r| r.get(0))
                .unwrap();
            let last = blob.len() - 1;
            blob[last] ^= 0x80;
            conn.execute("UPDATE batches SET raw_enc = ?1", params![blob])
                .unwrap();
        }
        assert!(matches!(
            ledger.get(&campaign, 0),
            Err(LedgerError::Storage(_))
        ));
        assert!(matches!(
            ledger.record(&campaign, 0, BatchStatus::Broadcast { txid: txid(1) }),
            Err(LedgerError::Storage(_))
        ));
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_valid_record_moved_to_another_campaign_is_rejected() {
        let (_dir, store) = new_store();
        let (a, b) = (id("camp-a"), id("camp-b"));
        add_campaign(&store, &a);
        add_campaign(&store, &b);
        {
            let conn = store.conn();
            let blob: Vec<u8> = conn
                .query_row(
                    "SELECT manifest_enc FROM campaigns WHERE id = 'camp-a'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            conn.execute(
                "UPDATE campaigns SET manifest_enc = ?1 WHERE id = 'camp-b'",
                params![blob],
            )
            .unwrap();
        }
        assert!(store.load_campaign(&a).unwrap().is_some());
        assert!(matches!(store.load_campaign(&b), Err(StoreError::Corrupt)));
    }

    // covers: REQ-SEC-002
    #[test]
    fn duplicate_campaigns_and_unknown_ids_are_reported() {
        let (_dir, store) = new_store();
        let campaign = id("camp-1");
        add_campaign(&store, &campaign);
        let m = manifest(&campaign);
        let again = store.insert_campaign(
            &NewCampaign {
                id: &campaign,
                name: "x",
                network: Network::Testnet,
                pool: Pool::Ironwood,
                fee_policy: FeePolicy::zip317_text(),
                max_outputs_per_batch: 3,
                manifest: &m,
                seed_fingerprint: FP,
            },
            &MemoryAccounts::default(),
        );
        assert!(matches!(again, Err(StoreError::Duplicate)));
        assert!(matches!(
            store.set_started(&id("nope"), true),
            Err(StoreError::NotFound)
        ));
        let funding = FundingObserved {
            outpoint: OutPoint {
                txid: txid(5),
                vout: 0,
            },
            amount: Zatoshi::new(1).unwrap(),
        };
        assert!(matches!(
            store.record_funding(&id("nope"), funding),
            Err(StoreError::NotFound)
        ));
    }

    // covers: REQ-SEC-002
    #[test]
    fn funding_is_recorded_once_and_conflicts_are_reported() {
        let (_dir, store) = new_store();
        let campaign = id("camp-1");
        add_campaign(&store, &campaign);
        let first = FundingObserved {
            outpoint: OutPoint {
                txid: txid(5),
                vout: 1,
            },
            amount: Zatoshi::new(50_000_000).unwrap(),
        };
        assert_eq!(
            store.record_funding(&campaign, first).unwrap(),
            FundingOutcome::Recorded
        );
        assert_eq!(
            store.record_funding(&campaign, first).unwrap(),
            FundingOutcome::Unchanged
        );
        let other = FundingObserved {
            amount: Zatoshi::new(60_000_000).unwrap(),
            ..first
        };
        assert_eq!(
            store.record_funding(&campaign, other).unwrap(),
            FundingOutcome::Conflict(first)
        );
        assert_eq!(
            store.load_campaign(&campaign).unwrap().unwrap().funding,
            Some(first)
        );
    }

    fn add_with(
        store: &Store,
        accounts: &dyn AccountAllocator,
        name: &str,
        fingerprint: &str,
    ) -> Result<u32, StoreError> {
        let c = id(name);
        let m = manifest(&c);
        store.insert_campaign(
            &NewCampaign {
                id: &c,
                name: "x",
                network: Network::Testnet,
                pool: Pool::Ironwood,
                fee_policy: FeePolicy::zip317_text(),
                max_outputs_per_batch: 3,
                manifest: &m,
                seed_fingerprint: fingerprint,
            },
            accounts,
        )
    }

    // covers: REQ-AUD-002
    #[test]
    fn every_campaign_is_allocated_its_own_account_in_order() {
        let (_dir, store) = new_store();
        let accounts = MemoryAccounts::default();
        let numbers: Vec<u32> = ["camp-a", "camp-b", "camp-c"]
            .iter()
            .map(|n| add_with(&store, &accounts, n, FP).unwrap())
            .collect();
        assert_eq!(numbers, vec![0, 1, 2]);
        let loaded = store.load_campaign(&id("camp-b")).unwrap().unwrap();
        assert_eq!(loaded.account, 1);
        assert_eq!(loaded.seed_fingerprint.as_deref(), Some(FP));

        // A duplicate id does not burn an account.
        assert!(matches!(
            add_with(&store, &accounts, "camp-a", FP),
            Err(StoreError::Duplicate)
        ));
        assert_eq!(add_with(&store, &accounts, "camp-d", FP).unwrap(), 3);
    }

    // covers: REQ-AUD-002
    #[test]
    fn accounts_are_counted_per_wallet_seed_even_in_one_store() {
        let (_dir, store) = new_store();
        let accounts = MemoryAccounts::default();
        assert_eq!(add_with(&store, &accounts, "camp-a", FP).unwrap(), 0);
        assert_eq!(add_with(&store, &accounts, "camp-b", FP).unwrap(), 1);
        // Another wallet's first campaign is account 0 of that wallet.
        assert_eq!(
            add_with(&store, &accounts, "camp-c", "8899aabbccddeeff").unwrap(),
            0
        );
        assert_eq!(add_with(&store, &accounts, "camp-d", FP).unwrap(), 2);
    }

    // covers: REQ-AUD-002
    #[test]
    fn a_fresh_store_continues_where_the_registry_left_off() {
        // The registry outlives the store: a new store opened with the same wallet seed must
        // not start again at account 0.
        let accounts = MemoryAccounts::default();
        let (_dir_a, old) = new_store();
        assert_eq!(add_with(&old, &accounts, "camp-a", FP).unwrap(), 0);
        assert_eq!(add_with(&old, &accounts, "camp-b", FP).unwrap(), 1);
        let (_dir_b, fresh) = new_store();
        assert_eq!(add_with(&fresh, &accounts, "camp-c", FP).unwrap(), 2);
    }

    // covers: REQ-AUD-002
    #[test]
    fn a_registry_that_has_not_seen_the_wallet_still_respects_the_store() {
        // The registry directory was lost (or never existed): the store's own rows still
        // keep the numbers apart.
        let (_dir, store) = new_store();
        assert_eq!(
            add_with(&store, &MemoryAccounts::default(), "camp-a", FP).unwrap(),
            0
        );
        assert_eq!(
            add_with(&store, &MemoryAccounts::default(), "camp-b", FP).unwrap(),
            1
        );
    }

    // covers: REQ-AUD-002
    #[test]
    fn rows_from_before_fingerprints_count_for_every_wallet() {
        let (_dir, store) = new_store();
        add_with(&store, &MemoryAccounts::default(), "camp-a", FP).unwrap();
        add_with(&store, &MemoryAccounts::default(), "camp-b", FP).unwrap();
        // Forget which wallet made them, as a store from an earlier build would.
        store
            .conn()
            .execute("UPDATE campaigns SET seed_fp = NULL", [])
            .unwrap();
        assert_eq!(
            add_with(
                &store,
                &MemoryAccounts::default(),
                "camp-c",
                "8899aabbccddeeff"
            )
            .unwrap(),
            2,
            "unknown rows could be this wallet's"
        );
    }

    /// An allocator that has the registry's behaviour but can be made to lose its place.
    struct Recording(MemoryAccounts, std::sync::Mutex<Vec<(String, Option<u32>)>>);

    impl AccountAllocator for Recording {
        fn reserve(
            &self,
            fingerprint: &str,
            in_store: Option<u32>,
        ) -> Result<u32, crate::accounts::AccountError> {
            self.1
                .lock()
                .unwrap()
                .push((fingerprint.to_owned(), in_store));
            self.0.reserve(fingerprint, in_store)
        }
    }

    // covers: REQ-AUD-002
    #[test]
    fn the_account_is_reserved_before_the_campaign_is_written_and_a_lost_write_skips_it() {
        let (_dir, store) = new_store();
        let accounts = Recording(MemoryAccounts::default(), Default::default());
        assert_eq!(add_with(&store, &accounts, "camp-a", FP).unwrap(), 0);

        // The write fails after the reservation (a row that cannot be stored): the number is
        // gone from the registry, so the next campaign gets the one after it.
        let c = id("camp-b");
        let m = manifest(&c);
        store
            .conn()
            .execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON campaigns BEGIN SELECT RAISE(ABORT, 'refused'); END;")
            .unwrap();
        let failed = store.insert_campaign(
            &NewCampaign {
                id: &c,
                name: "x",
                network: Network::Testnet,
                pool: Pool::Ironwood,
                fee_policy: FeePolicy::zip317_text(),
                max_outputs_per_batch: 3,
                manifest: &m,
                seed_fingerprint: FP,
            },
            &accounts,
        );
        assert!(failed.is_err());
        store.conn().execute_batch("DROP TRIGGER refuse;").unwrap();
        assert!(store.load_campaign(&c).unwrap().is_none());
        assert_eq!(
            add_with(&store, &accounts, "camp-c", FP).unwrap(),
            2,
            "1 was skipped"
        );
        // The allocator was told what the store held each time.
        let seen = accounts.1.lock().unwrap().clone();
        assert_eq!(seen[0], (FP.to_owned(), None));
        assert_eq!(seen[1], (FP.to_owned(), Some(0)));
        assert_eq!(
            seen[2],
            (FP.to_owned(), Some(0)),
            "camp-b never reached the store"
        );
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    // covers: REQ-SEC-002
    #[cfg(unix)]
    #[test]
    fn the_store_and_the_journal_beside_it_are_private_to_the_owner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let store = Store::create(&path, PASS, KdfParams::TESTING).unwrap();
        assert_eq!(mode_of(&path), 0o600);

        // SQLite gives the journal of an open write transaction the database's permissions.
        store
            .conn()
            .execute_batch(
                "BEGIN IMMEDIATE; INSERT INTO meta (key, value) VALUES ('probe', x'00');",
            )
            .unwrap();
        let journal = dir.path().join("s.sqlite-journal");
        assert!(journal.exists(), "the transaction wrote a journal");
        assert_eq!(mode_of(&journal), 0o600);
        store.conn().execute_batch("ROLLBACK;").unwrap();
    }

    // covers: REQ-SEC-002
    #[cfg(unix)]
    #[test]
    fn an_empty_file_that_was_already_there_is_made_private_too() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        Store::create(&path, PASS, KdfParams::TESTING).unwrap();
        assert_eq!(mode_of(&path), 0o600);
    }

    // covers: REQ-SEC-002
    #[cfg(unix)]
    #[test]
    fn opening_a_store_that_others_can_read_closes_it_to_them() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        drop(Store::create(&path, PASS, KdfParams::TESTING).unwrap());
        // A store as an earlier build left it, with leftovers beside it.
        let beside = |suffix: &str| dir.path().join(format!("s.sqlite{suffix}"));
        for file in [path.clone(), beside("-wal"), beside("-shm")] {
            if !file.exists() {
                std::fs::write(&file, b"").unwrap();
            }
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let store = Store::open(&path, PASS).unwrap();
        for file in [path.clone(), beside("-wal"), beside("-shm")] {
            assert_eq!(mode_of(&file), 0o600, "{}", file.display());
        }
        // A file that is already private is left as it is.
        drop(store);
        assert!(Store::open(&path, PASS).is_ok());
        assert_eq!(mode_of(&path), 0o600);
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_new_store_needs_a_passphrase_of_twelve_characters() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        for short in ["", "x", "eleven char", "ééééééééééé"] {
            assert!(short.chars().count() < 12);
            assert!(
                matches!(
                    Store::create(&path, short, KdfParams::TESTING),
                    Err(StoreError::WeakPassphrase)
                ),
                "{short:?}"
            );
            assert!(!path.exists(), "nothing was created for {short:?}");
        }
        // Twelve characters, counted as characters and not bytes.
        assert!(Store::create(&path, "twelve chars", KdfParams::TESTING).is_ok());
        let other = dir.path().join("t.sqlite");
        assert!(Store::create(&other, "éééééééééééé", KdfParams::TESTING).is_ok());
    }

    // covers: REQ-SEC-002
    #[test]
    fn an_existing_store_opens_with_whatever_passphrase_it_has() {
        // The minimum applies to new stores: opening reports a wrong passphrase as such.
        let (_dir, store) = new_store();
        let path = store.path().to_owned();
        drop(store);
        assert!(matches!(
            Store::open(&path, "short"),
            Err(StoreError::WrongPassphrase)
        ));
        assert!(Store::open(&path, PASS).is_ok());
    }

    /// Puts a store back the way an earlier build left it: no account, wallet or tag columns,
    /// and the old key check.
    fn rewind_to_untagged(store: &Store) {
        let conn = store.conn();
        conn.execute_batch(
            "ALTER TABLE campaigns DROP COLUMN account;
             ALTER TABLE campaigns DROP COLUMN seed_fp;
             ALTER TABLE campaigns DROP COLUMN row_tag;
             ALTER TABLE batches DROP COLUMN row_tag;",
        )
        .unwrap();
        let old_check = crypto::seal(&store.key, &aad("key_check", "", 0), KEY_CHECK).unwrap();
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'key_check'",
            params![old_check],
        )
        .unwrap();
    }

    /// A store with two campaigns, `camp-a` and `camp-b`.
    fn two_campaigns() -> (tempfile::TempDir, Arc<Store>) {
        let (dir, store) = new_store();
        let accounts = MemoryAccounts::default();
        add_with(&store, &accounts, "camp-a", FP).unwrap();
        add_with(&store, &accounts, "camp-b", FP).unwrap();
        (dir, store)
    }

    fn assert_corrupt<T>(what: &str, result: Result<T, StoreError>) {
        match result {
            Err(StoreError::Corrupt) => {}
            Err(other) => panic!("{what}: wrong error: {other}"),
            Ok(_) => panic!("{what}: the edit was accepted"),
        }
    }

    // covers: REQ-SEC-002, REQ-AUD-002
    #[test]
    fn editing_any_column_of_a_campaign_row_is_detected() {
        let a = "WHERE id = 'camp-a'";
        let b_of = |column: &str| format!("(SELECT {column} FROM campaigns WHERE id = 'camp-b')");
        let edits: Vec<(&str, String)> = vec![
            (
                "created_at",
                format!("UPDATE campaigns SET created_at = created_at + 1 {a}"),
            ),
            (
                "network",
                format!("UPDATE campaigns SET network = 'mainnet' {a}"),
            ),
            ("pool", format!("UPDATE campaigns SET pool = 'orchard' {a}")),
            (
                "fee_policy",
                format!(
                    r#"UPDATE campaigns SET fee_policy = '{{"grace_actions":1,"marginal_fee":1}}' {a}"#
                ),
            ),
            (
                "max_outputs",
                format!("UPDATE campaigns SET max_outputs = max_outputs + 1 {a}"),
            ),
            (
                "commitment",
                format!(
                    "UPDATE campaigns SET commitment = '{}' {a}",
                    "00".repeat(32)
                ),
            ),
            (
                "funding_outpoint",
                format!(
                    "UPDATE campaigns SET funding_outpoint = '{}:0' {a}",
                    "ab".repeat(32)
                ),
            ),
            (
                "funding_amount",
                format!("UPDATE campaigns SET funding_amount = '1' {a}"),
            ),
            ("started", format!("UPDATE campaigns SET started = 1 {a}")),
            // The one that matters most: another campaign's account is another campaign's key.
            (
                "account",
                format!("UPDATE campaigns SET account = account + 1 {a}"),
            ),
            (
                "account to b's",
                format!("UPDATE campaigns SET account = {} {a}", b_of("account")),
            ),
            (
                "seed_fp",
                format!("UPDATE campaigns SET seed_fp = 'ffffffffffffffff' {a}"),
            ),
            (
                "seed_fp removed",
                format!("UPDATE campaigns SET seed_fp = NULL {a}"),
            ),
            (
                "name_enc",
                format!("UPDATE campaigns SET name_enc = {} {a}", b_of("name_enc")),
            ),
            (
                "manifest_enc",
                format!(
                    "UPDATE campaigns SET manifest_enc = {} {a}",
                    b_of("manifest_enc")
                ),
            ),
            (
                "tag removed",
                format!("UPDATE campaigns SET row_tag = NULL {a}"),
            ),
            (
                "tag of another row",
                format!("UPDATE campaigns SET row_tag = {} {a}", b_of("row_tag")),
            ),
            (
                "tag damaged",
                format!("UPDATE campaigns SET row_tag = zeroblob(80) {a}"),
            ),
        ];
        for (what, sql) in edits {
            let (_dir, store) = two_campaigns();
            assert!(
                store.load_campaign(&id("camp-a")).unwrap().is_some(),
                "{what}: sound before"
            );
            let changed = store.conn().execute(&sql, []).unwrap();
            assert_eq!(changed, 1, "{what}");

            assert_corrupt(what, store.load_campaign(&id("camp-a")));
            // Everything that decides what to list, poll or resume refuses as well.
            assert_corrupt(what, store.list_campaigns());
            assert_corrupt(what, store.started_campaigns());
            assert_corrupt(what, store.unfunded_campaigns());
            assert_corrupt(
                what,
                store.record_funding(
                    &id("camp-a"),
                    FundingObserved {
                        outpoint: OutPoint {
                            txid: txid(1),
                            vout: 0,
                        },
                        amount: Zatoshi::new(1).unwrap(),
                    },
                ),
            );
            assert_corrupt(what, store.set_started(&id("camp-a"), true));
            // The other campaign is not the one that was edited.
            assert!(
                store.load_campaign(&id("camp-b")).unwrap().is_some(),
                "{what}"
            );
        }
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_commitment_that_is_not_the_manifests_is_refused_even_with_a_valid_tag() {
        // Someone with the passphrase's key could re-tag a row; the commitment is still the
        // manifest's own, checked against the manifest it sits beside.
        let (_dir, store) = two_campaigns();
        let mut columns = {
            let conn = store.conn();
            store.read_campaign(&conn, "camp-a").unwrap().unwrap()
        };
        columns.commitment = "00".repeat(32);
        let tag = store.tag(TABLE_CAMPAIGNS, &columns.fields()).unwrap();
        store
            .conn()
            .execute(
                "UPDATE campaigns SET commitment = ?1, row_tag = ?2 WHERE id = 'camp-a'",
                params![columns.commitment, tag],
            )
            .unwrap();
        assert_corrupt("commitment", store.load_campaign(&id("camp-a")));
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_manifest_that_belongs_to_another_campaign_is_refused_even_with_a_valid_tag() {
        // The sealed manifest names its own campaign; it must be the one it is stored under.
        let (_dir, store) = two_campaigns();
        let foreign = manifest(&id("camp-b"));
        let json = serde_json::to_vec(&foreign).unwrap();
        let sealed = store.seal("manifest", "camp-a", 0, &json).unwrap();
        let mut columns = {
            let conn = store.conn();
            store.read_campaign(&conn, "camp-a").unwrap().unwrap()
        };
        columns.manifest_enc = sealed;
        columns.commitment = foreign.commitment().to_string();
        let tag = store.tag(TABLE_CAMPAIGNS, &columns.fields()).unwrap();
        store
            .conn()
            .execute(
                "UPDATE campaigns SET manifest_enc = ?1, commitment = ?2, row_tag = ?3
                 WHERE id = 'camp-a'",
                params![columns.manifest_enc, columns.commitment, tag],
            )
            .unwrap();
        assert_corrupt(
            "manifest of another campaign",
            store.load_campaign(&id("camp-a")),
        );
    }

    fn near_record(created: u64) -> crate::near::NearQuoteRecord {
        crate::near::NearQuoteRecord {
            deposit_address: "SENTINELdepositADDRESS000111222".into(),
            deposit_memo: Some("memo-7".into()),
            origin_asset: "nep141:usdc".into(),
            origin_symbol: "USDC".into(),
            amount_in: "7679013".into(),
            amount_in_formatted: Some("7.679013".into()),
            zec_out_zat: "545000".into(),
            funding_address: "t1SENTINELfundingADDRESS0000000000".into(),
            refund_to: "SENTINELrefundADDRESS".into(),
            deadline: Some("2026-10-08T01:00:00Z".into()),
            created_at: created,
            valid_until: created + 21_600,
        }
    }

    // covers: REQ-FUND-001, REQ-SEC-002
    #[test]
    fn a_live_near_quote_is_kept_sealed_survives_a_restart_and_a_newer_one_replaces_it() {
        let (dir, store) = two_campaigns();
        let a = id("camp-a");
        assert_eq!(store.load_near_quote(&a).unwrap(), None);
        store.save_near_quote(&a, &near_record(1_000)).unwrap();
        assert_eq!(store.load_near_quote(&a).unwrap(), Some(near_record(1_000)));
        assert_eq!(store.near_quote_campaigns().unwrap(), vec![a.clone()]);
        assert_eq!(store.load_near_quote(&id("camp-b")).unwrap(), None);

        // None of it is readable in the file.
        let bytes = all_file_bytes(store.path());
        let hay = String::from_utf8_lossy(&bytes);
        for needle in [
            "SENTINELdeposit",
            "SENTINELrefund",
            "SENTINELfunding",
            "memo-7",
            "7679013",
        ] {
            assert!(!hay.contains(needle), "{needle} is in the store file");
        }

        // A newer quote replaces the older one, and a restart reads it back.
        store.save_near_quote(&a, &near_record(2_000)).unwrap();
        let path = store.path().to_owned();
        drop(store);
        let again = Store::open(&path, PASS).unwrap();
        assert_eq!(again.load_near_quote(&a).unwrap(), Some(near_record(2_000)));
        assert_eq!(again.near_quote_campaigns().unwrap().len(), 1);
        drop(dir);
    }

    // covers: REQ-FUND-001
    #[test]
    fn a_near_quote_is_kept_only_for_a_campaign_that_exists() {
        let (_dir, store) = two_campaigns();
        assert!(matches!(
            store.save_near_quote(&id("camp-nope"), &near_record(1)),
            Err(StoreError::NotFound)
        ));
        assert!(store.near_quote_campaigns().unwrap().is_empty());
    }

    // covers: REQ-FUND-001, REQ-SEC-002
    #[test]
    fn an_edited_near_quote_is_refused_the_deposit_address_above_all() {
        let edits = [
            ("created_at", "UPDATE near_quotes SET created_at = created_at + 1"),
            ("record swapped for another's", "UPDATE near_quotes SET record_enc = (SELECT record_enc FROM near_quotes WHERE campaign_id = 'camp-b') WHERE campaign_id = 'camp-a'"),
            ("record damaged", "UPDATE near_quotes SET record_enc = randomblob(300) WHERE campaign_id = 'camp-a'"),
            ("tag removed", "UPDATE near_quotes SET row_tag = NULL WHERE campaign_id = 'camp-a'"),
            ("tag of another row", "UPDATE near_quotes SET row_tag = (SELECT row_tag FROM near_quotes WHERE campaign_id = 'camp-b') WHERE campaign_id = 'camp-a'"),
            ("tag damaged", "UPDATE near_quotes SET row_tag = zeroblob(80) WHERE campaign_id = 'camp-a'"),
        ];
        for (what, sql) in edits {
            let (_dir, store) = two_campaigns();
            store
                .save_near_quote(&id("camp-a"), &near_record(1_000))
                .unwrap();
            store
                .save_near_quote(&id("camp-b"), &near_record(2_000))
                .unwrap();
            store.conn().execute(sql, []).unwrap();
            assert_corrupt(what, store.load_near_quote(&id("camp-a")));
        }

        // A quote moved to the other campaign is not that campaign's quote.
        let (_dir, store) = two_campaigns();
        store
            .save_near_quote(&id("camp-a"), &near_record(1_000))
            .unwrap();
        store
            .conn()
            .execute("UPDATE near_quotes SET campaign_id = 'camp-b'", [])
            .unwrap();
        assert_corrupt("moved", store.load_near_quote(&id("camp-b")));
        assert_eq!(store.load_near_quote(&id("camp-a")).unwrap(), None);

        // A record whose own time disagrees with the authenticated column is refused too.
        let (_dir, store) = two_campaigns();
        let a = id("camp-a");
        store.save_near_quote(&a, &near_record(1_000)).unwrap();
        let record = near_record(5_000);
        let json = serde_json::to_vec(&record).unwrap();
        let sealed = store.seal("near_quote", "camp-a", 0, &json).unwrap();
        let tag = store
            .tag(TABLE_NEAR, &near_fields("camp-a", 1_000, &sealed))
            .unwrap();
        store
            .conn()
            .execute(
                "UPDATE near_quotes SET record_enc = ?1, row_tag = ?2 WHERE campaign_id = 'camp-a'",
                params![sealed, tag],
            )
            .unwrap();
        assert_corrupt("record time", store.load_near_quote(&a));
    }

    // covers: REQ-FUND-001
    #[test]
    fn a_store_from_before_near_funding_gains_its_table_when_opened() {
        let (_dir, store) = two_campaigns();
        store
            .conn()
            .execute_batch("DROP TABLE near_quotes;")
            .unwrap();
        let path = store.path().to_owned();
        drop(store);
        let again = Store::open(&path, PASS).unwrap();
        assert_eq!(again.load_near_quote(&id("camp-a")).unwrap(), None);
        again
            .save_near_quote(&id("camp-a"), &near_record(9))
            .unwrap();
        assert_eq!(again.near_quote_campaigns().unwrap().len(), 1);
    }

    // covers: REQ-SEC-002
    #[test]
    fn legitimate_updates_keep_the_row_sound_and_change_its_tag() {
        let (_dir, store) = two_campaigns();
        let tag = |store: &Store| -> Vec<u8> {
            store
                .conn()
                .query_row(
                    "SELECT row_tag FROM campaigns WHERE id = 'camp-a'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        let before = tag(&store);
        let funding = FundingObserved {
            outpoint: OutPoint {
                txid: txid(2),
                vout: 1,
            },
            amount: Zatoshi::new(5_000).unwrap(),
        };
        assert_eq!(
            store.record_funding(&id("camp-a"), funding).unwrap(),
            FundingOutcome::Recorded
        );
        let funded = tag(&store);
        assert_ne!(before, funded);
        store.set_started(&id("camp-a"), true).unwrap();
        assert_ne!(funded, tag(&store));
        let loaded = store.load_campaign(&id("camp-a")).unwrap().unwrap();
        assert_eq!(loaded.funding, Some(funding));
        assert!(loaded.started);
        assert_eq!(store.started_campaigns().unwrap(), vec![id("camp-a")]);
        assert_eq!(store.unfunded_campaigns().unwrap(), vec![id("camp-b")]);
        // And survives a restart.
        let path = store.path().to_owned();
        drop(store);
        let again = Store::open(&path, PASS).unwrap();
        assert!(again.load_campaign(&id("camp-a")).unwrap().unwrap().started);
    }

    /// Ledger rows for `camp-a`: batch 0 confirmed (depth 3), batch 1 failed after being built.
    fn ledger_rows() -> (tempfile::TempDir, Arc<Store>) {
        let (dir, store) = two_campaigns();
        let mut ledger = store.ledger();
        let c = id("camp-a");
        ledger.record(&c, 0, BatchStatus::Planned).unwrap();
        ledger
            .record(
                &c,
                0,
                BatchStatus::Built {
                    txid: txid(1),
                    raw_tx: SENTINEL_RAW.to_vec(),
                },
            )
            .unwrap();
        ledger
            .record(&c, 0, BatchStatus::Broadcast { txid: txid(1) })
            .unwrap();
        ledger
            .record(
                &c,
                0,
                BatchStatus::Confirmed {
                    txid: txid(1),
                    depth: 3,
                },
            )
            .unwrap();
        ledger.record(&c, 1, BatchStatus::Planned).unwrap();
        ledger
            .record(
                &c,
                1,
                BatchStatus::Built {
                    txid: txid(2),
                    raw_tx: SENTINEL_RAW.to_vec(),
                },
            )
            .unwrap();
        ledger
            .record(
                &c,
                1,
                BatchStatus::Failed {
                    reason: "rejected".into(),
                    txid: None,
                },
            )
            .unwrap();
        (dir, store)
    }

    // covers: REQ-SEC-002, REQ-LED-001
    #[test]
    fn editing_any_column_of_a_ledger_row_is_detected() {
        let row0 = "WHERE campaign_id = 'camp-a' AND batch_index = 0";
        let row1 = "WHERE campaign_id = 'camp-a' AND batch_index = 1";
        let edits: Vec<(&str, u32, String)> = vec![
            ("state", 0, format!("UPDATE batches SET state = 'planned' {row0}")),
            ("state to confirmed", 1, format!("UPDATE batches SET state = 'confirmed', depth = 9 {row1}")),
            ("txid", 0, format!("UPDATE batches SET txid = '{}' {row0}", "09".repeat(32))),
            ("txid removed", 0, format!("UPDATE batches SET txid = NULL {row0}")),
            ("depth", 0, format!("UPDATE batches SET depth = depth + 1 {row0}")),
            ("reason", 1, format!("UPDATE batches SET reason = 'fine' {row1}")),
            ("raw_enc", 0, format!("UPDATE batches SET raw_enc = randomblob(64) {row0}")),
            (
                "raw_enc from another batch",
                0,
                format!("UPDATE batches SET raw_enc = (SELECT raw_enc FROM batches WHERE batch_index = 1) {row0}"),
            ),
            ("tag removed", 0, format!("UPDATE batches SET row_tag = NULL {row0}")),
            (
                "tag of another row",
                0,
                format!("UPDATE batches SET row_tag = (SELECT row_tag FROM batches WHERE batch_index = 1) {row0}"),
            ),
            ("batch moved", 0, format!("UPDATE batches SET batch_index = 5 {row0}")),
        ];
        for (what, index, sql) in edits {
            let (_dir, store) = ledger_rows();
            let ledger = store.ledger();
            let c = id("camp-a");
            let at = if what == "batch moved" { 5 } else { index };
            assert!(
                ledger.get(&c, at.min(index)).unwrap().is_some(),
                "{what}: sound before"
            );
            assert_eq!(store.conn().execute(&sql, []).unwrap(), 1, "{what}");

            let error = ledger.get(&c, at).unwrap_err().to_string();
            assert!(
                error.contains(crate::error::STORE_CORRUPT_TEXT),
                "{what}: {error}"
            );
            // Recording over it is refused too: a damaged row is never built upon.
            let mut ledger = store.ledger();
            let error = ledger
                .record(
                    &c,
                    at,
                    BatchStatus::Failed {
                        reason: "x".into(),
                        txid: None,
                    },
                )
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(crate::error::STORE_CORRUPT_TEXT),
                "{what}: {error}"
            );
            // The untouched row of the same campaign still reads.
            let other = if at == 0 || at == 5 { 1 } else { 0 };
            assert!(ledger.get(&c, other).unwrap().is_some(), "{what}");
        }
    }

    // covers: REQ-SEC-002, REQ-LED-001
    #[test]
    fn a_ledger_row_cannot_be_copied_to_another_batch_or_campaign() {
        // A batch that failed before anything was built has nothing sealed in its row, so only
        // its tag ties it to its place: copying it elsewhere must not produce a believable row.
        let (_dir, store) = two_campaigns();
        let mut ledger = store.ledger();
        let a = id("camp-a");
        ledger.record(&a, 0, BatchStatus::Planned).unwrap();
        ledger
            .record(
                &a,
                0,
                BatchStatus::Failed {
                    reason: "build rejected".into(),
                    txid: None,
                },
            )
            .unwrap();
        assert!(ledger.get(&a, 0).unwrap().is_some());
        let copies = [
            (
                "to another batch of the campaign",
                "INSERT INTO batches SELECT campaign_id, 7, state, txid, raw_enc, depth, reason, row_tag
                 FROM batches WHERE campaign_id = 'camp-a' AND batch_index = 0",
                (id("camp-a"), 7),
            ),
            (
                "to another campaign",
                "INSERT INTO batches SELECT 'camp-b', batch_index, state, txid, raw_enc, depth, reason, row_tag
                 FROM batches WHERE campaign_id = 'camp-a' AND batch_index = 0",
                (id("camp-b"), 0),
            ),
        ];
        for (what, sql, (campaign, index)) in copies {
            assert_eq!(store.conn().execute(sql, []).unwrap(), 1, "{what}");
            let error = ledger.get(&campaign, index).unwrap_err().to_string();
            assert!(
                error.contains(crate::error::STORE_CORRUPT_TEXT),
                "{what}: {error}"
            );
        }
        // The original is untouched.
        assert!(ledger.get(&a, 0).unwrap().is_some());
    }

    // covers: REQ-LED-001
    #[test]
    fn ledger_rows_written_by_the_ledger_read_back_and_keep_their_anchor() {
        let (_dir, store) = ledger_rows();
        let ledger = store.ledger();
        let c = id("camp-a");
        assert_eq!(
            ledger.get(&c, 0).unwrap(),
            Some(BatchStatus::Confirmed {
                txid: txid(1),
                depth: 3
            })
        );
        assert_eq!(
            ledger.get(&c, 1).unwrap(),
            Some(BatchStatus::Failed {
                reason: "rejected".into(),
                // The transaction built for the batch stays named by its record.
                txid: Some(txid(2)),
            })
        );
        // Moving on from Built keeps the sealed transaction in the row.
        let kept: i64 = store
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM batches WHERE raw_enc IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 2);
    }

    // covers: REQ-AUD-002, REQ-SEC-002
    #[test]
    fn a_store_from_an_earlier_build_is_upgraded_in_place() {
        let (dir, store) = new_store();
        for name in ["camp-a", "camp-b", "camp-c"] {
            add_campaign(&store, &id(name));
        }
        // A ledger row as well, so batches are upgraded too.
        let mut ledger = store.ledger();
        ledger
            .record(&id("camp-a"), 0, BatchStatus::Planned)
            .unwrap();
        rewind_to_untagged(&store);
        let path = store.path().to_owned();
        drop(ledger);
        drop(store);

        let reopened = Store::open(&path, PASS).unwrap();
        let mut accounts: Vec<u32> = ["camp-a", "camp-b", "camp-c"]
            .iter()
            .map(|n| reopened.load_campaign(&id(n)).unwrap().unwrap().account)
            .collect();
        accounts.sort_unstable();
        assert_eq!(
            accounts,
            vec![0, 1, 2],
            "each existing campaign got its own account"
        );
        assert!(reopened
            .load_campaign(&id("camp-a"))
            .unwrap()
            .unwrap()
            .seed_fingerprint
            .is_none());
        // Every row was tagged, and the ledger row still reads.
        let untagged: i64 = reopened
            .conn()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM campaigns WHERE row_tag IS NULL)
                      + (SELECT COUNT(*) FROM batches WHERE row_tag IS NULL)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untagged, 0);
        let reopened = Arc::new(reopened);
        assert_eq!(
            reopened.ledger().get(&id("camp-a"), 0).unwrap(),
            Some(BatchStatus::Planned)
        );
        let first: Vec<u32> = ["camp-a", "camp-b", "camp-c"]
            .iter()
            .map(|n| reopened.load_campaign(&id(n)).unwrap().unwrap().account)
            .collect();
        drop(reopened);
        // Opening again changes nothing.
        let again = Store::open(&path, PASS).unwrap();
        let second: Vec<u32> = ["camp-a", "camp-b", "camp-c"]
            .iter()
            .map(|n| again.load_campaign(&id(n)).unwrap().unwrap().account)
            .collect();
        assert_eq!(first, second);
        drop(dir);
    }

    // covers: REQ-SEC-002
    #[test]
    fn the_upgrade_happens_once_and_a_missing_tag_afterwards_is_damage() {
        let (_dir, store) = new_store();
        add_campaign(&store, &id("camp-a"));
        rewind_to_untagged(&store);
        let path = store.path().to_owned();
        drop(store);
        drop(Store::open(&path, PASS).unwrap()); // the upgrade

        // Someone edits a column and removes the tag, hoping it will be taken on trust again.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("UPDATE campaigns SET account = 9, row_tag = NULL", [])
                .unwrap();
        }
        let store = Store::open(&path, PASS).unwrap();
        assert!(matches!(
            store.load_campaign(&id("camp-a")),
            Err(StoreError::Corrupt)
        ));

        // Nor can the old key check be put back without the passphrase.
        drop(store);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "UPDATE meta SET value = ?1 WHERE key = 'key_check'",
                params![vec![0u8; 80]],
            )
            .unwrap();
        }
        assert!(matches!(
            Store::open(&path, PASS),
            Err(StoreError::WrongPassphrase)
        ));
    }

    // covers: REQ-SEC-001
    #[test]
    fn the_wallet_is_initialised_once_and_never_replaced() {
        let (_dir, store) = new_store();
        assert!(
            store.load_seed().unwrap().is_none(),
            "a new store has no wallet"
        );
        assert!(store.init_wallet().unwrap(), "first call creates it");
        let seed = store.load_seed().unwrap().unwrap();
        assert!(!store.init_wallet().unwrap(), "second call changes nothing");
        assert_eq!(
            store.load_seed().unwrap().unwrap().expose_secret(),
            seed.expose_secret()
        );
        assert_eq!(
            store.load_or_create_seed().unwrap().expose_secret(),
            seed.expose_secret()
        );
        // And the seed is not in the file.
        let bytes = all_file_bytes(store.path());
        assert!(!contains(&bytes, seed.expose_secret()));
    }

    // covers: REQ-FUND-002
    #[test]
    fn unfunded_campaigns_are_listed_until_a_deposit_is_recorded() {
        let (_dir, store) = new_store();
        let (a, b) = (id("camp-a"), id("camp-b"));
        add_campaign(&store, &a);
        add_campaign(&store, &b);
        assert_eq!(
            store.unfunded_campaigns().unwrap(),
            vec![a.clone(), b.clone()]
        );
        let funding = FundingObserved {
            outpoint: OutPoint {
                txid: txid(5),
                vout: 0,
            },
            amount: Zatoshi::new(1).unwrap(),
        };
        store.record_funding(&a, funding).unwrap();
        assert_eq!(store.unfunded_campaigns().unwrap(), vec![b]);
    }

    // covers: REQ-SEC-002
    #[test]
    fn started_flags_round_trip() {
        let (_dir, store) = new_store();
        let (a, b) = (id("camp-a"), id("camp-b"));
        add_campaign(&store, &a);
        add_campaign(&store, &b);
        assert!(store.started_campaigns().unwrap().is_empty());
        store.set_started(&b, true).unwrap();
        assert_eq!(store.started_campaigns().unwrap(), vec![b.clone()]);
        assert!(store.load_campaign(&b).unwrap().unwrap().started);
        store.set_started(&b, false).unwrap();
        assert!(store.started_campaigns().unwrap().is_empty());
    }

    // ---- the Ledger implementation: same behaviours as the in-memory one ----

    use BatchStatus::*;

    fn built(n: u8) -> BatchStatus {
        Built {
            txid: txid(n),
            raw_tx: vec![n, n, n],
        }
    }

    fn ledger_at(store: &Arc<Store>, c: &CampaignId, status: BatchStatus) -> StoreLedger {
        let mut l = store.ledger();
        l.record(c, 0, Planned).unwrap();
        match &status {
            Planned => {}
            Built { .. } | Failed { .. } => l.record(c, 0, status.clone()).unwrap(),
            Broadcast { txid } => {
                l.record(c, 0, built(txid.as_bytes()[0])).unwrap();
                l.record(c, 0, status.clone()).unwrap();
            }
            Confirmed { txid, .. } => {
                l.record(c, 0, built(txid.as_bytes()[0])).unwrap();
                l.record(c, 0, Broadcast { txid: *txid }).unwrap();
                l.record(c, 0, status.clone()).unwrap();
            }
        }
        l
    }

    // covers: REQ-LED-001
    #[test]
    fn happy_path_walks_through_every_status_and_survives_reopen() {
        let (_dir, store) = new_store();
        let c = id("camp-1");
        let mut l = store.ledger();
        assert_eq!(l.get(&c, 0).unwrap(), None);
        l.record(&c, 0, Planned).unwrap();
        l.record(&c, 0, built(1)).unwrap();
        assert_eq!(l.get(&c, 0).unwrap(), Some(built(1)));
        l.record(&c, 0, Broadcast { txid: txid(1) }).unwrap();
        l.record(
            &c,
            0,
            Confirmed {
                txid: txid(1),
                depth: 1,
            },
        )
        .unwrap();
        l.record(
            &c,
            0,
            Confirmed {
                txid: txid(1),
                depth: 5,
            },
        )
        .unwrap();
        let path = store.path().to_owned();
        drop(l);
        drop(store);

        let reopened = Arc::new(Store::open(&path, PASS).unwrap());
        assert_eq!(
            reopened.ledger().get(&c, 0).unwrap(),
            Some(Confirmed {
                txid: txid(1),
                depth: 5
            })
        );
    }

    // covers: REQ-LED-001
    #[test]
    fn recording_the_same_built_tx_twice_is_a_no_op() {
        let (_dir, store) = new_store();
        let c = id("camp-1");
        let mut l = ledger_at(&store, &c, built(1));
        l.record(&c, 0, built(1)).unwrap();
        assert_eq!(l.get(&c, 0).unwrap(), Some(built(1)));
        l.record(&c, 0, Broadcast { txid: txid(1) }).unwrap();
        l.record(&c, 0, built(1)).unwrap();
        assert_eq!(l.get(&c, 0).unwrap(), Some(Broadcast { txid: txid(1) }));
        l.record(
            &c,
            0,
            Confirmed {
                txid: txid(1),
                depth: 2,
            },
        )
        .unwrap();
        l.record(&c, 0, built(1)).unwrap();
        l.record(&c, 0, Broadcast { txid: txid(1) }).unwrap();
        assert_eq!(
            l.get(&c, 0).unwrap(),
            Some(Confirmed {
                txid: txid(1),
                depth: 2
            })
        );
    }

    // covers: REQ-LED-001
    #[test]
    fn a_different_tx_for_a_built_batch_is_a_conflict() {
        let (_dir, store) = new_store();
        let c = id("camp-1");
        let mut l = ledger_at(&store, &c, built(1));
        assert_eq!(
            l.record(&c, 0, built(2)).unwrap_err(),
            LedgerError::Conflict {
                batch_index: 0,
                existing_txid: txid(1)
            }
        );
        // Same txid but different raw bytes is a conflict too.
        assert!(matches!(
            l.record(
                &c,
                0,
                Built {
                    txid: txid(1),
                    raw_tx: vec![9, 9]
                }
            ),
            Err(LedgerError::Conflict { .. })
        ));
        assert_eq!(l.get(&c, 0).unwrap(), Some(built(1)), "state unchanged");
    }

    // covers: REQ-LED-001
    #[test]
    fn a_different_tx_for_a_broadcast_or_confirmed_batch_is_a_conflict() {
        for start in [
            Broadcast { txid: txid(1) },
            Confirmed {
                txid: txid(1),
                depth: 3,
            },
        ] {
            let (_dir, store) = new_store();
            let c = id("camp-1");
            let mut l = ledger_at(&store, &c, start.clone());
            for attempt in [
                built(2),
                Broadcast { txid: txid(2) },
                Confirmed {
                    txid: txid(2),
                    depth: 9,
                },
                Built {
                    txid: txid(1),
                    raw_tx: vec![0],
                },
            ] {
                let err = l.record(&c, 0, attempt.clone()).unwrap_err();
                assert!(
                    matches!(err, LedgerError::Conflict { existing_txid, .. } if existing_txid == txid(1)),
                    "{start:?} <- {attempt:?}: {err}"
                );
            }
            assert_eq!(l.get(&c, 0).unwrap(), Some(start));
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn illegal_transitions_are_rejected_and_change_nothing() {
        let cases: Vec<(BatchStatus, BatchStatus)> = vec![
            (built(1), Planned),
            (Broadcast { txid: txid(1) }, Planned),
            (
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
                Planned,
            ),
            (
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
            ),
            (Planned, Broadcast { txid: txid(1) }),
            (
                Planned,
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
            ),
            (
                built(1),
                Confirmed {
                    txid: txid(1),
                    depth: 1,
                },
            ),
            (
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
                Planned,
            ),
            (
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
                built(1),
            ),
            (
                Failed {
                    reason: "x".into(),
                    txid: None,
                },
                Failed {
                    reason: "y".into(),
                    txid: None,
                },
            ),
        ];
        for (from, to) in cases {
            let (_dir, store) = new_store();
            let c = id("camp-1");
            let mut l = ledger_at(&store, &c, from.clone());
            let err = l.record(&c, 0, to.clone()).unwrap_err();
            assert!(
                matches!(err, LedgerError::IllegalTransition { .. }),
                "{from:?} -> {to:?} gave {err}"
            );
            assert_eq!(l.get(&c, 0).unwrap(), Some(from), "state unchanged");
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn first_record_must_be_planned_and_depth_must_be_positive() {
        let (_dir, store) = new_store();
        let c = id("camp-1");
        let mut l = store.ledger();
        for s in [
            built(1),
            Broadcast { txid: txid(1) },
            Failed {
                reason: "x".into(),
                txid: None,
            },
        ] {
            assert!(matches!(
                l.record(&c, 0, s),
                Err(LedgerError::IllegalTransition { from: "none", .. })
            ));
        }
        assert!(matches!(
            l.record(
                &c,
                0,
                Confirmed {
                    txid: txid(1),
                    depth: 0
                }
            ),
            Err(LedgerError::InvalidStatus { .. })
        ));
        assert_eq!(l.get(&c, 0).unwrap(), None);
    }

    // covers: REQ-LED-001
    #[test]
    fn failed_is_idempotent_for_the_same_reason_and_keeps_the_anchor() {
        for start in [Planned, built(1), Broadcast { txid: txid(1) }] {
            let (_dir, store) = new_store();
            let c = id("camp-1");
            let mut l = ledger_at(&store, &c, start.clone());
            l.record(
                &c,
                0,
                Failed {
                    reason: "rejected".into(),
                    txid: None,
                },
            )
            .unwrap();
            l.record(
                &c,
                0,
                Failed {
                    reason: "rejected".into(),
                    txid: None,
                },
            )
            .unwrap();
            // The failed batch still names the transaction that was built for it, if any,
            // and the bytes are still there to be found.
            assert_eq!(
                l.get(&c, 0).unwrap(),
                Some(Failed {
                    reason: "rejected".into(),
                    txid: start.txid(),
                })
            );
            let anchor = l.built_tx(&c, 0).unwrap().map(|(txid, _)| txid);
            assert_eq!(anchor, start.txid());
        }
    }

    // covers: REQ-LED-001
    #[test]
    fn the_stored_transaction_can_be_read_back_whatever_the_batch_has_become() {
        let (_dir, store) = new_store();
        let c = id("camp-1");
        let mut l = ledger_at(&store, &c, Planned);
        assert_eq!(l.built_tx(&c, 0).unwrap(), None);
        assert_eq!(l.built_tx(&c, 9).unwrap(), None, "a batch never recorded");
        l.record(&c, 0, built(4)).unwrap();
        let anchor = Some((txid(4), vec![4, 4, 4]));
        assert_eq!(l.built_tx(&c, 0).unwrap(), anchor);
        l.record(&c, 0, Broadcast { txid: txid(4) }).unwrap();
        assert_eq!(l.built_tx(&c, 0).unwrap(), anchor);
        l.record(
            &c,
            0,
            Confirmed {
                txid: txid(4),
                depth: 2,
            },
        )
        .unwrap();
        assert_eq!(l.built_tx(&c, 0).unwrap(), anchor);
    }

    // covers: REQ-LED-001
    #[test]
    fn a_failure_cannot_name_another_transaction_than_the_one_built() {
        let (_dir, store) = new_store();
        let c = id("camp-1");
        let mut l = ledger_at(&store, &c, built(1));
        assert!(matches!(
            l.record(
                &c,
                0,
                Failed {
                    reason: "x".into(),
                    txid: Some(txid(9))
                }
            ),
            Err(LedgerError::Conflict { .. })
        ));
        assert_eq!(l.get(&c, 0).unwrap(), Some(built(1)));
    }

    // covers: REQ-LED-001
    #[test]
    fn batches_and_campaigns_are_independent_and_unrecorded_counts_as_planned() {
        let (_dir, store) = new_store();
        let (a, b) = (id("camp-a"), id("camp-b"));
        let mut l = store.ledger();
        for c in [&a, &b] {
            for i in 0..2 {
                l.record(c, i, Planned).unwrap();
            }
        }
        l.record(&a, 0, built(1)).unwrap();
        l.record(&a, 1, built(2)).unwrap();
        l.record(&b, 0, built(3)).unwrap();
        assert_eq!(l.get(&b, 1).unwrap(), Some(Planned));
        assert_eq!(
            l.statuses(&a, 3).unwrap(),
            vec![built(1), built(2), Planned]
        );
    }
}
