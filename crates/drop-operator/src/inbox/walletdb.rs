//! What an inbox wallet holds, read from zcash-devtool's own database (`<wallet>/data.sqlite`).
//!
//! zcash-devtool owns that database; ZecDrop only ever opens it read-only (and once read-write at start-up, to roll back a
//! journal a killed zcash-devtool left behind, which is what any SQLite reader would do). The schema is
//! `zcash_client_sqlite`'s at the commit `scripts/zcash-devtool/build.sh` pins; a change there is caught by the start-up
//! check and the tests, never guessed at.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use thiserror::Error;

/// The wallet database could not be read. Says nothing about what is in it.
#[derive(Debug, Error)]
#[error("the inbox wallet's database could not be read")]
pub struct WalletDbError;

impl From<rusqlite::Error> for WalletDbError {
    fn from(_: rusqlite::Error) -> Self {
        WalletDbError
    }
}

/// Whether, and how, a note has been spent, as far as the wallet has scanned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteSpend {
    /// Not spent by any transaction that is mined or could still be.
    Unspent,
    /// Spent by a transaction that is mined.
    Mined,
    /// Spent by a transaction the wallet knows of that is not mined yet and has not expired.
    Pending,
}

/// One Ironwood note the inbox received (a payer's deposit, or the change of a move).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxNote {
    /// The note's value, in zatoshi.
    pub value: u64,
    /// The note's nullifier, as the chain will show it when the note is spent.
    pub nullifier: Option<[u8; 32]>,
    /// Change of the inbox's own transaction, which the wallet trusts sooner than a note from outside.
    pub is_change: bool,
    /// The height of the block that mined the note's transaction, if it is mined.
    pub mined_height: Option<u32>,
    /// Whether it has been spent.
    pub spend: NoteSpend,
}

impl InboxNote {
    /// Confirmations at `tip`: 1 in the block that mined it, 0 while unmined.
    pub fn confirmations(&self, tip: u32) -> u32 {
        match self.mined_height {
            Some(height) if height <= tip => tip - height + 1,
            _ => 0,
        }
    }
}

/// The inbox's account, as the wallet set it up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxAccount {
    /// The account's UUID, in the form zcash-devtool's commands take.
    pub uuid: String,
    /// Its external Orchard incoming viewing key, cached by the wallet (64 bytes).
    pub orchard_ivk: Vec<u8>,
    /// Its ZIP 32 account index under the wallet's seed (0 for an inbox).
    pub hd_account_index: Option<u32>,
}

/// Read access to one inbox wallet's database.
pub struct WalletDb {
    path: PathBuf,
}

impl WalletDb {
    /// The database of the wallet in `wallet_dir`.
    pub fn of(wallet_dir: &Path) -> WalletDb {
        WalletDb {
            path: wallet_dir.join("data.sqlite"),
        }
    }

    fn connect(&self) -> Result<Connection, WalletDbError> {
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(conn)
    }

    /// Rolls back a journal a killed zcash-devtool left behind, so the next reader sees a whole database. Opening it
    /// read-write and reading once is enough: SQLite recovers the journal on first access.
    pub fn recover_journal(&self) -> Result<(), WalletDbError> {
        if !self.path.exists() {
            return Ok(());
        }
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let _: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))?;
        Ok(())
    }

    /// The wallet's one account, if it has been set up. An inbox wallet has exactly one.
    pub fn account(&self) -> Result<Option<InboxAccount>, WalletDbError> {
        let conn = self.connect()?;
        let count: i64 = conn.query_row("SELECT count(*) FROM accounts", [], |row| row.get(0))?;
        if count != 1 {
            return if count == 0 {
                Ok(None)
            } else {
                Err(WalletDbError)
            };
        }
        let row = conn
            .query_row(
                "SELECT uuid, orchard_ivk_item_cache, hd_account_index FROM accounts",
                [],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, Option<Vec<u8>>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((uuid, ivk, index)) = row else {
            return Ok(None);
        };
        Ok(Some(InboxAccount {
            uuid: uuid_text(&uuid).ok_or(WalletDbError)?,
            orchard_ivk: ivk.ok_or(WalletDbError)?,
            hd_account_index: index
                .map(u32::try_from)
                .transpose()
                .map_err(|_| WalletDbError)?,
        }))
    }

    /// The highest block the wallet has scanned, if any.
    pub fn scanned_tip(&self) -> Result<Option<u32>, WalletDbError> {
        let conn = self.connect()?;
        let tip: Option<i64> =
            conn.query_row("SELECT MAX(height) FROM blocks", [], |row| row.get(0))?;
        tip.map(u32::try_from)
            .transpose()
            .map_err(|_| WalletDbError)
    }

    /// Every Ironwood note the inbox has received, with how far it is spent at the wallet's scanned tip.
    pub fn ironwood_notes(&self) -> Result<Vec<InboxNote>, WalletDbError> {
        let conn = self.connect()?;
        let tip: i64 =
            conn.query_row("SELECT COALESCE(MAX(height), 0) FROM blocks", [], |row| {
                row.get(0)
            })?;
        let mut notes = conn.prepare(
            "SELECT n.id, n.value, n.nf, n.is_change, t.mined_height
               FROM ironwood_received_notes n
               JOIN transactions t ON t.id_tx = n.transaction_id
              ORDER BY n.id",
        )?;
        let mut spends = conn.prepare(
            "SELECT t.mined_height, t.expiry_height
               FROM ironwood_received_note_spends s
               JOIN transactions t ON t.id_tx = s.transaction_id
              WHERE s.ironwood_received_note_id = ?1",
        )?;
        let rows = notes
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (id, value, nf, is_change, mined) in rows {
            let mut spend = NoteSpend::Unspent;
            for row in spends.query_map([id], |row| {
                Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?))
            })? {
                let (spend_mined, expiry) = row?;
                if spend_mined.is_some() {
                    spend = NoteSpend::Mined;
                    break;
                }
                // Expiry 0 means the transaction never expires; otherwise it is dead once the chain is past it.
                if expiry.is_none_or(|e| e == 0 || e > tip) {
                    spend = NoteSpend::Pending;
                }
            }
            out.push(InboxNote {
                value: u64::try_from(value).map_err(|_| WalletDbError)?,
                nullifier: nf
                    .map(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| WalletDbError))
                    .transpose()?,
                is_change,
                mined_height: mined
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|_| WalletDbError)?,
                spend,
            });
        }
        Ok(out)
    }

    /// The value of unspent Orchard (not Ironwood) notes that reached the inbox: an inbox move never spends them, so they
    /// are reported, never counted.
    pub fn unspent_orchard_value(&self) -> Result<u64, WalletDbError> {
        let conn = self.connect()?;
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(n.value), 0) FROM orchard_received_notes n
              WHERE NOT EXISTS (
                SELECT 1 FROM orchard_received_note_spends s
                  JOIN transactions t ON t.id_tx = s.transaction_id
                 WHERE s.orchard_received_note_id = n.id AND t.mined_height IS NOT NULL)",
            [],
            |row| row.get(0),
        )?;
        u64::try_from(total).map_err(|_| WalletDbError)
    }
}

/// A UUID's 16 bytes in its usual hyphenated text form.
fn uuid_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 16 {
        return None;
    }
    let hex = hex::encode(bytes);
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database with only the tables and columns this module reads, shaped like zcash_client_sqlite's.
    fn fake_wallet(dir: &Path) -> Connection {
        let conn = Connection::open(dir.join("data.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, uuid BLOB NOT NULL, hd_account_index INTEGER, orchard_ivk_item_cache BLOB);
             CREATE TABLE blocks (height INTEGER PRIMARY KEY);
             CREATE TABLE transactions (id_tx INTEGER PRIMARY KEY, txid BLOB, mined_height INTEGER, expiry_height INTEGER);
             CREATE TABLE ironwood_received_notes (id INTEGER PRIMARY KEY, transaction_id INTEGER, account_id INTEGER, value INTEGER, nf BLOB, is_change INTEGER);
             CREATE TABLE ironwood_received_note_spends (ironwood_received_note_id INTEGER, transaction_id INTEGER);
             CREATE TABLE orchard_received_notes (id INTEGER PRIMARY KEY, transaction_id INTEGER, value INTEGER);
             CREATE TABLE orchard_received_note_spends (orchard_received_note_id INTEGER, transaction_id INTEGER);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn reads_the_account_the_tip_and_each_note_with_its_spend() {
        let dir = tempfile::tempdir().unwrap();
        let conn = fake_wallet(dir.path());
        conn.execute(
            "INSERT INTO accounts VALUES (1, ?1, 0, ?2)",
            (vec![0xabu8; 16], vec![9u8; 64]),
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO blocks VALUES (100), (110);
             INSERT INTO transactions VALUES (1, x'01', 101, 0), (2, x'02', 105, 0), (3, x'03', NULL, 140), (4, x'04', NULL, 90), (5, x'05', 108, 0);
             -- note 1: a deposit, unspent; note 2: spent by a pending move (expiry 140 > tip 110);
             -- note 3: once in a transaction that expired (90 < 110): unspent again; note 4: spent by a mined transaction.
             INSERT INTO ironwood_received_notes VALUES (1, 1, 1, 500, x'1111111111111111111111111111111111111111111111111111111111111111', 0),
                                                       (2, 2, 1, 700, NULL, 0),
                                                       (3, 2, 1, 50, NULL, 1),
                                                       (4, 1, 1, 9, NULL, 0);
             INSERT INTO ironwood_received_note_spends VALUES (2, 3), (3, 4), (4, 5);
             INSERT INTO orchard_received_notes VALUES (1, 1, 1234);",
        )
        .unwrap();
        let db = WalletDb::of(dir.path());
        let account = db.account().unwrap().unwrap();
        assert_eq!(account.uuid, "abababab-abab-abab-abab-abababababab");
        assert_eq!(account.orchard_ivk, vec![9u8; 64]);
        assert_eq!(account.hd_account_index, Some(0));
        assert_eq!(db.scanned_tip().unwrap(), Some(110));
        let notes = db.ironwood_notes().unwrap();
        assert_eq!(
            notes.iter().map(|n| (n.value, n.spend)).collect::<Vec<_>>(),
            vec![
                (500, NoteSpend::Unspent),
                (700, NoteSpend::Pending),
                (50, NoteSpend::Unspent),
                (9, NoteSpend::Mined),
            ]
        );
        assert_eq!(notes[0].confirmations(110), 10);
        assert_eq!(notes[0].nullifier, Some([0x11; 32]));
        assert!(notes[2].is_change);
        assert_eq!(db.unspent_orchard_value().unwrap(), 1234);
        db.recover_journal().unwrap();
    }

    #[test]
    fn an_empty_or_ambiguous_wallet_is_no_account() {
        let dir = tempfile::tempdir().unwrap();
        let conn = fake_wallet(dir.path());
        let db = WalletDb::of(dir.path());
        assert_eq!(db.account().unwrap(), None);
        assert_eq!(db.scanned_tip().unwrap(), None);
        conn.execute_batch("INSERT INTO accounts VALUES (1, x'00000000000000000000000000000001', 0, x'01'), (2, x'00000000000000000000000000000002', 1, x'02');").unwrap();
        assert!(
            db.account().is_err(),
            "an inbox wallet has exactly one account"
        );
    }

    #[test]
    fn a_missing_database_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let db = WalletDb::of(&dir.path().join("nowhere"));
        assert!(db.account().is_err());
        db.recover_journal().unwrap();
    }
}
