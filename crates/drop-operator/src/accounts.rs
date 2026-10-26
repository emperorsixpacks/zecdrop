//! Account numbers that are never handed out twice for one wallet seed (REQ-AUD-002).
//!
//! Every campaign has its own ZIP-32 account, so its funding address and viewing key belong
//! to that campaign alone. A store can only number the campaigns it holds, so a fresh store
//! opened with the same seed would start again at account 0 and give a new campaign the funding
//! address and viewing key of an old one, possibly one that was already given to an auditor.
//!
//! The registry closes that gap. It lives outside the store, in a small file per wallet seed
//! (named after the seed's fingerprint, a hash that does not reveal the seed) that records the
//! highest account number ever handed out. A new account is `max(store, registry) + 1`, the
//! very first for a seed is 0, and the registry is written and flushed **before** the number is
//! used, so a crash between the two skips a number and never reuses one.
//!
//! The guarantee is only as durable as the registry directory: deleting it, or running the same
//! seed with a different `--state-dir`, loses it. The operator therefore keeps it in the user's
//! own directory by default and not next to the store file.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// ZIP-32 account indices are below 2^31.
pub const MAX_ACCOUNT: u32 = (1 << 31) - 1;

/// Why an account number could not be handed out. Fixed text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AccountError {
    /// The registry file or directory could not be read or written.
    #[error("the account registry could not be read or written")]
    Io,
    /// The registry file is not what this build wrote: it is not trusted, because a wrong
    /// guess could reuse an account.
    #[error("the account registry is damaged; refusing to guess an account number")]
    Corrupt,
    /// There is no account number left.
    #[error("no account numbers are left for this wallet")]
    Exhausted,
    /// The wallet fingerprint is not a fingerprint.
    #[error("the wallet fingerprint is malformed")]
    BadFingerprint,
}

/// Hands out fresh account numbers.
pub trait AccountAllocator: Send + Sync {
    /// Reserves and returns the next account for the wallet with `fingerprint`, given the
    /// highest account `in_store` already holds for it (if any). The reservation is durable
    /// before this returns.
    fn reserve(&self, fingerprint: &str, in_store: Option<u32>) -> Result<u32, AccountError>;
}

/// The next number: one above everything known, or 0 if nothing is.
fn next_account(in_store: Option<u32>, in_registry: Option<u32>) -> Result<u32, AccountError> {
    let next = match in_store.max(in_registry) {
        None => 0,
        Some(highest) => highest.checked_add(1).ok_or(AccountError::Exhausted)?,
    };
    if next > MAX_ACCOUNT {
        return Err(AccountError::Exhausted);
    }
    Ok(next)
}

/// The registry as files in a directory.
#[derive(Debug, Clone)]
pub struct FileAccounts {
    dir: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    highest: u32,
}

impl FileAccounts {
    /// A registry in `dir` (created, owner-only, on first use).
    pub fn new(dir: impl Into<PathBuf>) -> FileAccounts {
        FileAccounts { dir: dir.into() }
    }

    /// The directory the registry lives in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The file that records `fingerprint`'s highest account.
    pub fn file_for(&self, fingerprint: &str) -> Result<PathBuf, AccountError> {
        // Only a hash's hex digits ever become part of a path.
        let well_formed = fingerprint.len() == 16
            && fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !well_formed {
            return Err(AccountError::BadFingerprint);
        }
        Ok(self.dir.join(format!("accounts-{fingerprint}.json")))
    }

    fn ensure_dir(&self) -> Result<(), AccountError> {
        if self.dir.is_dir() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir).map_err(|_| AccountError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| AccountError::Io)?;
        }
        Ok(())
    }

    fn read(path: &Path) -> Result<Option<u32>, AccountError> {
        let mut text = String::new();
        match std::fs::File::open(path) {
            Ok(mut file) => {
                // A registry is a few dozen bytes; anything large is not one.
                (&mut file)
                    .take(4096)
                    .read_to_string(&mut text)
                    .map_err(|_| AccountError::Corrupt)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(AccountError::Io),
        }
        let record: Record = serde_json::from_str(&text).map_err(|_| AccountError::Corrupt)?;
        if record.version != 1 || record.highest > MAX_ACCOUNT {
            return Err(AccountError::Corrupt);
        }
        Ok(Some(record.highest))
    }

    /// Writes the record next to the real file, flushes it, and renames it into place, so a
    /// crash leaves either the old registry or the new one.
    fn write(&self, path: &Path, highest: u32) -> Result<(), AccountError> {
        let text = serde_json::to_string(&Record {
            version: 1,
            highest,
        })
        .map_err(|_| AccountError::Io)?;
        let temporary = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| AccountError::Io)?;
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| AccountError::Io)?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|_| AccountError::Io)?;
        // Make the rename itself durable.
        std::fs::File::open(&self.dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| AccountError::Io)
    }
}

impl AccountAllocator for FileAccounts {
    fn reserve(&self, fingerprint: &str, in_store: Option<u32>) -> Result<u32, AccountError> {
        let path = self.file_for(fingerprint)?;
        self.ensure_dir()?;

        // One writer at a time, across threads and processes.
        let lock_path = path.with_extension("lock");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(&lock_path).map_err(|_| AccountError::Io)?;
        lock.lock().map_err(|_| AccountError::Io)?;

        let account = next_account(in_store, Self::read(&path)?)?;
        self.write(&path, account)?;
        // The lock is released when `lock` is dropped, after the new number is durable.
        drop(lock);
        Ok(account)
    }
}

/// A registry that lives in memory, for tests that do not care about durability.
#[derive(Debug, Default)]
pub struct MemoryAccounts(std::sync::Mutex<std::collections::HashMap<String, u32>>);

impl AccountAllocator for MemoryAccounts {
    fn reserve(&self, fingerprint: &str, in_store: Option<u32>) -> Result<u32, AccountError> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let account = next_account(in_store, map.get(fingerprint).copied())?;
        map.insert(fingerprint.to_owned(), account);
        Ok(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "0123456789abcdef";
    const OTHER: &str = "fedcba9876543210";

    fn registry() -> (tempfile::TempDir, FileAccounts) {
        let dir = tempfile::tempdir().unwrap();
        let accounts = FileAccounts::new(dir.path().join("state"));
        (dir, accounts)
    }

    // covers: REQ-AUD-002
    #[test]
    fn the_first_account_for_a_wallet_is_zero_and_then_they_count_up() {
        let (_dir, accounts) = registry();
        assert_eq!(accounts.reserve(FP, None), Ok(0));
        assert_eq!(accounts.reserve(FP, None), Ok(1));
        assert_eq!(accounts.reserve(FP, None), Ok(2));
        // Another wallet has its own count.
        assert_eq!(accounts.reserve(OTHER, None), Ok(0));
        assert_eq!(accounts.reserve(FP, None), Ok(3));
    }

    // covers: REQ-AUD-002
    #[test]
    fn a_new_account_is_above_both_the_store_and_the_registry() {
        let (_dir, accounts) = registry();
        // The store is ahead of a registry that has never seen this wallet.
        assert_eq!(accounts.reserve(FP, Some(4)), Ok(5));
        // The registry is ahead of a store that has fewer (a fresh one).
        assert_eq!(accounts.reserve(FP, None), Ok(6));
        assert_eq!(accounts.reserve(FP, Some(1)), Ok(7));
        // Neither is ahead when they agree.
        assert_eq!(accounts.reserve(FP, Some(7)), Ok(8));
        // The store being far ahead wins.
        assert_eq!(accounts.reserve(FP, Some(40)), Ok(41));
    }

    // covers: REQ-AUD-002
    #[test]
    fn the_registry_outlives_the_object_that_made_it() {
        let (dir, first) = registry();
        assert_eq!(first.reserve(FP, None), Ok(0));
        assert_eq!(first.reserve(FP, None), Ok(1));
        drop(first);
        let again = FileAccounts::new(dir.path().join("state"));
        assert_eq!(again.reserve(FP, None), Ok(2), "a new process continues");
    }

    // covers: REQ-AUD-002
    #[test]
    fn the_last_account_is_the_largest_zip32_index_and_then_none_is_left() {
        let (_dir, accounts) = registry();
        assert_eq!(accounts.reserve(FP, Some(MAX_ACCOUNT - 1)), Ok(MAX_ACCOUNT));
        assert_eq!(accounts.reserve(FP, None), Err(AccountError::Exhausted));
        assert_eq!(
            accounts.reserve(OTHER, Some(u32::MAX)),
            Err(AccountError::Exhausted)
        );
    }

    // covers: REQ-AUD-002
    #[test]
    fn a_failed_reservation_changes_nothing() {
        let (_dir, accounts) = registry();
        assert_eq!(accounts.reserve(FP, None), Ok(0));
        let path = accounts.file_for(FP).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            accounts.reserve(FP, Some(MAX_ACCOUNT)),
            Err(AccountError::Exhausted)
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    // covers: REQ-AUD-002
    #[test]
    fn a_damaged_registry_is_refused_instead_of_guessed_at() {
        let (_dir, accounts) = registry();
        assert_eq!(accounts.reserve(FP, None), Ok(0));
        let path = accounts.file_for(FP).unwrap();
        for bad in [
            "",
            "not json",
            "{}",
            r#"{"version":1}"#,
            r#"{"version":2,"highest":3}"#,
            r#"{"version":1,"highest":-1}"#,
            r#"{"version":1,"highest":2147483648}"#,
        ] {
            std::fs::write(&path, bad).unwrap();
            assert_eq!(
                accounts.reserve(FP, None),
                Err(AccountError::Corrupt),
                "{bad:?}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bad, "left alone");
        }
        // A huge file is not a registry either.
        std::fs::write(&path, " ".repeat(10_000)).unwrap();
        assert_eq!(accounts.reserve(FP, None), Err(AccountError::Corrupt));
    }

    // covers: REQ-AUD-002
    #[test]
    fn only_a_fingerprint_can_name_a_file() {
        let (dir, accounts) = registry();
        for bad in [
            "",
            "short",
            "../../etc/passwd",
            "0123456789abcdeg",
            "0123456789ABCDEF",
            "0123456789abcdef0",
            "0123456789abcde/",
        ] {
            assert_eq!(
                accounts.file_for(bad),
                Err(AccountError::BadFingerprint),
                "{bad:?}"
            );
            assert_eq!(
                accounts.reserve(bad, None),
                Err(AccountError::BadFingerprint)
            );
        }
        assert!(!dir.path().join("state").exists(), "nothing was created");
        assert_eq!(
            accounts.file_for(FP).unwrap(),
            dir.path().join("state").join(format!("accounts-{FP}.json"))
        );
    }

    // covers: REQ-AUD-002, REQ-SEC-001
    #[cfg(unix)]
    #[test]
    fn the_registry_is_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, accounts) = registry();
        accounts.reserve(FP, None).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(accounts.dir()), 0o700);
        assert_eq!(mode(&accounts.file_for(FP).unwrap()), 0o600);
        assert_eq!(
            mode(&accounts.file_for(FP).unwrap().with_extension("lock")),
            0o600
        );
        // No temporary file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(accounts.dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    // covers: REQ-AUD-002
    #[test]
    fn concurrent_reservations_never_collide() {
        let (_dir, accounts) = registry();
        let accounts = std::sync::Arc::new(accounts);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let accounts = std::sync::Arc::clone(&accounts);
                std::thread::spawn(move || {
                    (0..10)
                        .map(|_| accounts.reserve(FP, None).unwrap())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut all: Vec<u32> = handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect();
        all.sort_unstable();
        assert_eq!(all, (0..80).collect::<Vec<_>>());
    }

    // covers: REQ-AUD-002
    #[test]
    fn the_memory_registry_counts_the_same_way() {
        let accounts = MemoryAccounts::default();
        assert_eq!(accounts.reserve(FP, None), Ok(0));
        assert_eq!(accounts.reserve(FP, Some(3)), Ok(4));
        assert_eq!(accounts.reserve(FP, None), Ok(5));
        assert_eq!(accounts.reserve(OTHER, None), Ok(0));
    }
}
