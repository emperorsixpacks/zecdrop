//! Setting up one payout's inbox wallet, and proving it is the one meant before its address is ever shown.
//!
//! zcash-devtool silently makes up what it is not given: a random phrase when stdin is empty, a random identity when the
//! identity file is missing. So the wallet is set up in a scratch directory of its own (0700), from the derived phrase (on
//! stdin) and the derived identity (in a 0600 file that is deleted as soon as `init` returns), with the birthday given
//! explicitly; then its one account's cached Orchard incoming viewing key must equal the one the operator derives itself
//! from the same phrase. Only then is the directory moved into place. A wallet that fails the check is deleted, and nothing
//! of it is used.

use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use drop_core::Network;
use drop_zcash::{zcash_network, InboxKeys};
use thiserror::Error;

use super::{
    devtool::{Devtool, DevtoolError},
    keys::{age_identity, InboxKeyError, InboxPhrase},
    walletdb::{WalletDb, WalletDbError},
};
use crate::secret::SecretSeed;

/// Why an inbox wallet could not be set up. Says nothing about keys or amounts.
#[derive(Debug, Error)]
pub enum SetupError {
    /// zcash-devtool failed or was not usable.
    #[error(transparent)]
    Devtool(#[from] DevtoolError),
    /// The wallet it made could not be read.
    #[error(transparent)]
    WalletDb(#[from] WalletDbError),
    /// The wallet it made is not the one the operator derives: it was deleted.
    #[error("the inbox wallet zcash-devtool set up is not the expected one; it was removed")]
    Mismatch,
    /// A directory or file could not be made.
    #[error("the inbox wallet's directory could not be prepared")]
    Io,
    /// The inbox's secrets could not be derived.
    #[error(transparent)]
    Keys(#[from] InboxKeyError),
}

impl From<std::io::Error> for SetupError {
    fn from(_: std::io::Error) -> Self {
        SetupError::Io
    }
}

/// A set-up inbox wallet: where it is, its account, and the address payers pay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxWallet {
    /// The wallet's directory (zcash-devtool's `-w`).
    pub dir: PathBuf,
    /// Its one account's UUID, as zcash-devtool's commands take it.
    pub account: String,
    /// The inbox's address: a Unified Address with an Orchard receiver only.
    pub address: String,
}

/// The directory of payout account `account`'s inbox under `root` (`<state-dir>/inbox/<seed fingerprint>`).
pub fn wallet_dir(root: &Path, account: u32) -> PathBuf {
    root.join(account.to_string())
}

/// Sets up payout account `account`'s inbox wallet under `root`, scanning from `birthday`, and checks it.
pub async fn set_up(
    devtool: &Devtool,
    seed: &SecretSeed,
    network: Network,
    account: u32,
    root: &Path,
    birthday: u32,
) -> Result<InboxWallet, SetupError> {
    let phrase = InboxPhrase::derive(seed, network, account)?;
    let keys = InboxKeys::derive(phrase.wallet_seed(), zcash_network(network))
        .map_err(|_| SetupError::Mismatch)?;
    let target = wallet_dir(root, account);
    if target.exists() {
        // Already set up: check it again rather than trust it.
        return check(&target, &keys);
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)?;
    let scratch = root.join(format!(
        ".setup-{account}-{}",
        hex::encode(random_suffix()?)
    ));
    fs::DirBuilder::new().mode(0o700).create(&scratch)?;
    let result = async {
        let identity_file = scratch.join("identity.age");
        {
            let identity = age_identity(seed, network)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&identity_file)?;
            file.write_all(identity.as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }
        let wallet = scratch.join("wallet");
        let initialised = devtool
            .init(&wallet, &identity_file, phrase.expose_phrase(), birthday)
            .await;
        // The identity is only needed to encrypt the phrase: it goes at once, whatever happened.
        let _ = fs::remove_file(&identity_file);
        initialised?;
        check(&wallet, &keys)?;
        fs::rename(&wallet, &target)?;
        Ok::<(), SetupError>(())
    }
    .await;
    let _ = fs::remove_dir_all(&scratch);
    result?;
    check(&target, &keys)
}

/// The wallet in `dir` has exactly one account, account 0 of the inbox's seed, whose cached Orchard key is ours.
fn check(dir: &Path, keys: &InboxKeys) -> Result<InboxWallet, SetupError> {
    let account = WalletDb::of(dir).account()?.ok_or(SetupError::Mismatch)?;
    if account.orchard_ivk != keys.orchard_ivk_bytes() || account.hd_account_index != Some(0) {
        return Err(SetupError::Mismatch);
    }
    Ok(InboxWallet {
        dir: dir.to_path_buf(),
        account: account.uuid,
        address: keys.address(),
    })
}

/// Removes what a setup interrupted by a crash left behind under `root`: scratch directories (which may hold an identity).
pub fn sweep_leftovers(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(".setup-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn random_suffix() -> Result<[u8; 8], SetupError> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| SetupError::Io)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, time::Duration};

    use crate::inbox::devtool::Limits;

    fn test_seed() -> SecretSeed {
        SecretSeed::from_bytes(*b"TEST-ONLY drop-operator inbox!!!")
    }

    /// A stand-in zcash-devtool whose `init` writes a wallet database with one account whose cached Orchard key is `ivk`,
    /// and records the identity file it was given (to prove the file was there during `init`, and gone after).
    fn fake_devtool(dir: &Path, ivk_hex: &str) -> Devtool {
        let bin = dir.join("fake-devtool");
        let body = format!(
            r#"#!/bin/sh
wallet=$3
identity=$8
mkdir -p "$wallet"
cat > "$wallet/seen-phrase"
test -f "$identity" && echo present > "$wallet/seen-identity"
sqlite3 "$wallet/data.sqlite" "CREATE TABLE accounts (id INTEGER PRIMARY KEY, uuid BLOB, hd_account_index INTEGER, orchard_ivk_item_cache BLOB);
INSERT INTO accounts VALUES (1, x'0102030405060708090a0b0c0d0e0f10', 0, x'{ivk_hex}');"
"#
        );
        std::fs::write(&bin, body).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        Devtool::new(bin, "x:1".into(), Network::Testnet).with_limits(Limits {
            quick: Duration::from_secs(10),
            sync: Duration::from_secs(10),
            build: Duration::from_secs(10),
        })
    }

    fn expected_keys() -> InboxKeys {
        let phrase = InboxPhrase::derive(&test_seed(), Network::Testnet, 4).unwrap();
        InboxKeys::derive(phrase.wallet_seed(), zcash_network(Network::Testnet)).unwrap()
    }

    #[tokio::test]
    async fn the_wallet_is_set_up_from_the_derived_phrase_checked_and_moved_into_place() {
        if std::process::Command::new("sqlite3")
            .arg("-version")
            .output()
            .is_err()
        {
            return; // the stand-in needs the sqlite3 shell
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("inbox");
        let keys = expected_keys();
        let devtool = fake_devtool(dir.path(), &hex::encode(keys.orchard_ivk_bytes()));
        let wallet = set_up(
            &devtool,
            &test_seed(),
            Network::Testnet,
            4,
            &root,
            4_500_000,
        )
        .await
        .unwrap();
        assert_eq!(wallet.dir, root.join("4"));
        assert_eq!(wallet.address, keys.address());
        assert_eq!(wallet.account, "01020304-0506-0708-090a-0b0c0d0e0f10");
        // The phrase went in on stdin; the identity file existed during init and is gone now, with every scratch directory.
        let phrase = InboxPhrase::derive(&test_seed(), Network::Testnet, 4).unwrap();
        assert_eq!(
            std::fs::read_to_string(wallet.dir.join("seen-phrase")).unwrap(),
            format!("{}\n", phrase.expose_phrase())
        );
        assert!(wallet.dir.join("seen-identity").exists());
        let left: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("4")]);
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // Setting it up again only checks it.
        assert_eq!(
            set_up(&devtool, &test_seed(), Network::Testnet, 4, &root, 1)
                .await
                .unwrap(),
            wallet
        );
    }

    #[tokio::test]
    async fn a_wallet_that_is_not_the_expected_one_is_refused_and_removed() {
        if std::process::Command::new("sqlite3")
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("inbox");
        let devtool = fake_devtool(dir.path(), &"00".repeat(64));
        let err = set_up(
            &devtool,
            &test_seed(),
            Network::Testnet,
            4,
            &root,
            4_500_000,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SetupError::Mismatch));
        assert!(!root.join("4").exists());
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            0,
            "no scratch directory, no identity left behind"
        );
    }

    #[test]
    fn leftovers_of_an_interrupted_setup_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".setup-3-abcd")).unwrap();
        std::fs::write(dir.path().join(".setup-3-abcd/identity.age"), "x").unwrap();
        std::fs::create_dir_all(dir.path().join("3")).unwrap();
        sweep_leftovers(dir.path());
        assert!(!dir.path().join(".setup-3-abcd").exists());
        assert!(dir.path().join("3").exists());
    }
}
