//! The operator's inbox backend: zcash-devtool for the wallet ([`super::devtool`]), drop-chain for the node.
//!
//! Every transaction it builds goes through the same steps: a PCZT created from the inbox's Ironwood notes, proved, signed
//! with the inbox's own keys (the identity on stdin), combined, and extracted with its raw bytes; then the operator's own
//! check of those bytes ([`drop_zcash::InboxKeys::check_move`] / [`drop_zcash::InboxKeys::check_return`]). The PCZT files
//! (which hold viewing keys and amounts) live in a 0700 scratch directory inside the wallet and are deleted whatever happens.

use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

use drop_chain::{BroadcastOutcome, LightwalletdSource};
use drop_core::{Network, Txid};
use drop_verify::ChainSource;
use drop_zcash::{zcash_network, InboxKeys};

use super::{
    devtool::Devtool,
    engine::{BoxFuture, Built, ChainNow, InboxBackend, InboxError, OwnedContext, Sent, Snapshot},
    keys::{age_identity, InboxPhrase},
    setup,
    walletdb::WalletDb,
};
use crate::secret::SecretSeed;

/// The name of the scratch directory inside each inbox wallet where a transaction is built.
pub const SCRATCH: &str = "zecdrop-pczt";

/// zcash-devtool wallets under one root, and a light wallet server.
pub struct DevtoolInbox {
    devtool: Devtool,
    root: PathBuf,
    network: Network,
    chain: LightwalletdSource,
}

impl DevtoolInbox {
    /// Inbox wallets under `root` (`<state-dir>/inbox/<seed fingerprint>`), driven by `devtool`, against `chain`.
    pub fn new(
        devtool: Devtool,
        root: PathBuf,
        network: Network,
        chain: LightwalletdSource,
    ) -> DevtoolInbox {
        DevtoolInbox {
            devtool,
            root,
            network,
            chain,
        }
    }

    /// What a crash may have left behind: setup scratch directories (which may hold an identity), PCZT files, and a
    /// wallet database journal; and any wallet directory others could read. Run once at start-up, before anything else
    /// touches the wallets.
    pub fn tidy(&self) {
        setup::sweep_leftovers(&self.root);
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let wallet = entry.path();
            if wallet.is_dir() {
                let _ = setup::own_only(&wallet);
                let _ = fs::remove_dir_all(wallet.join(SCRATCH));
                let _ = WalletDb::of(&wallet).recover_journal();
            }
        }
    }

    fn keys(&self, seed: &SecretSeed, account: u32) -> Result<InboxKeys, InboxError> {
        let phrase = InboxPhrase::derive(seed, self.network, account)
            .map_err(|_| InboxError::Unavailable)?;
        InboxKeys::derive(phrase.wallet_seed(), zcash_network(self.network))
            .map_err(|_| InboxError::Unavailable)
    }

    /// Proves, signs, combines and extracts the PCZT at `scratch/created.pczt`; gives its raw bytes and txid.
    async fn finish(
        &self,
        seed: &SecretSeed,
        wallet: &Path,
        scratch: &Path,
    ) -> Result<(Vec<u8>, String), InboxError> {
        let step = |name: &str| scratch.join(name);
        let unavailable = |_| InboxError::Unavailable;
        self.devtool
            .prove(wallet, &step("created.pczt"), &step("proven.pczt"))
            .await
            .map_err(unavailable)?;
        let identity = age_identity(seed, self.network).map_err(|_| InboxError::Unavailable)?;
        self.devtool
            .sign(
                wallet,
                &identity,
                &step("created.pczt"),
                &step("signed.pczt"),
            )
            .await
            .map_err(unavailable)?;
        drop(identity);
        self.devtool
            .combine(
                wallet,
                &step("proven.pczt"),
                &step("signed.pczt"),
                &step("final.pczt"),
            )
            .await
            .map_err(unavailable)?;
        let txid = self
            .devtool
            .extract(&step("final.pczt"), &step("tx.bin"))
            .await
            .map_err(unavailable)?;
        let raw = fs::read(step("tx.bin")).map_err(|_| InboxError::Unavailable)?;
        Ok((raw, txid))
    }
}

/// A transaction's scratch directory (0700) in a wallet, deleted however the build ends: done, failed, or dropped half way (a
/// send-back whose page went away), as its PCZT files hold viewing keys and amounts.
struct Scratch(PathBuf);

impl Scratch {
    fn new(wallet: &Path) -> Result<Scratch, InboxError> {
        let path = wallet.join(SCRATCH);
        let _ = fs::remove_dir_all(&path);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| InboxError::Unavailable)?;
        Ok(Scratch(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl InboxBackend for DevtoolInbox {
    fn set_up<'a>(
        &'a self,
        seed: &'a SecretSeed,
        account: u32,
        birthday: u32,
    ) -> BoxFuture<'a, Result<String, InboxError>> {
        Box::pin(async move {
            setup::set_up(
                &self.devtool,
                seed,
                self.network,
                account,
                &self.root,
                birthday,
            )
            .await
            .map(|wallet| wallet.address)
            .map_err(|_| InboxError::Unavailable)
        })
    }

    fn has_wallet(&self, account: u32) -> bool {
        setup::wallet_dir(&self.root, account).is_dir()
    }

    fn refresh(&self, account: u32) -> BoxFuture<'_, Result<Snapshot, InboxError>> {
        Box::pin(async move {
            let wallet = setup::wallet_dir(&self.root, account);
            self.devtool
                .sync(&wallet)
                .await
                .map_err(|_| InboxError::Unavailable)?;
            let db = WalletDb::of(&wallet);
            let unavailable = |_| InboxError::Unavailable;
            Ok(Snapshot {
                wallet_tip: db.scanned_tip().map_err(unavailable)?.unwrap_or(0),
                notes: db.ironwood_notes().map_err(unavailable)?,
                orchard: db.unspent_orchard_value().map_err(unavailable)?,
            })
        })
    }

    fn chain_now(&self) -> BoxFuture<'_, Result<ChainNow, InboxError>> {
        Box::pin(async move {
            let info = self
                .chain
                .chain_info()
                .await
                .map_err(|_| InboxError::Chain)?;
            Ok(ChainNow {
                tip: info.tip_height,
                branch_id: info.consensus_branch_id,
            })
        })
    }

    fn build_move<'a>(
        &'a self,
        seed: &'a SecretSeed,
        account: u32,
        funding_address: &'a str,
        value: u64,
        context: OwnedContext,
    ) -> BoxFuture<'a, Result<Built, InboxError>> {
        Box::pin(async move {
            let keys = self.keys(seed, account)?;
            let wallet = setup::wallet_dir(&self.root, account);
            let account_uuid = WalletDb::of(&wallet)
                .account()
                .ok()
                .flatten()
                .ok_or(InboxError::Unavailable)?
                .uuid;
            let scratch = Scratch::new(&wallet)?;
            let built = async {
                self.devtool
                    .create(
                        &wallet,
                        &account_uuid,
                        funding_address,
                        value,
                        &scratch.path().join("created.pczt"),
                    )
                    .await
                    .map_err(|_| InboxError::Unavailable)?;
                self.finish(seed, &wallet, scratch.path()).await
            }
            .await;
            drop(scratch);
            let (raw, txid) = built?;
            let facts = keys
                .check_move(&raw, funding_address, value, &context.as_context())
                .map_err(|_| InboxError::Refused)?;
            if facts.txid != txid {
                return Err(InboxError::Refused);
            }
            Ok(Built { raw, facts })
        })
    }

    fn build_return<'a>(
        &'a self,
        seed: &'a SecretSeed,
        account: u32,
        to: &'a str,
        context: OwnedContext,
    ) -> BoxFuture<'a, Result<Built, InboxError>> {
        Box::pin(async move {
            let keys = self.keys(seed, account)?;
            let wallet = setup::wallet_dir(&self.root, account);
            let account_uuid = WalletDb::of(&wallet)
                .account()
                .ok()
                .flatten()
                .ok_or(InboxError::Unavailable)?
                .uuid;
            let scratch = Scratch::new(&wallet)?;
            let built = async {
                self.devtool
                    .create_max(
                        &wallet,
                        &account_uuid,
                        to,
                        &scratch.path().join("created.pczt"),
                    )
                    .await
                    .map_err(|_| InboxError::Unavailable)?;
                self.finish(seed, &wallet, scratch.path()).await
            }
            .await;
            drop(scratch);
            let (raw, txid) = built?;
            let facts = keys
                .check_return(&raw, to, &context.as_context())
                .map_err(|_| InboxError::Refused)?;
            if facts.txid != txid {
                return Err(InboxError::Refused);
            }
            Ok(Built { raw, facts })
        })
    }

    fn broadcast<'a>(&'a self, raw: &'a [u8]) -> BoxFuture<'a, Result<Sent, InboxError>> {
        Box::pin(async move {
            match self.chain.broadcast(raw).await {
                Ok(BroadcastOutcome::Accepted { .. }) => Ok(Sent::Accepted),
                Ok(BroadcastOutcome::AlreadyKnown { .. }) => Ok(Sent::AlreadyKnown),
                Ok(BroadcastOutcome::Rejected { .. }) => Ok(Sent::Rejected),
                Err(_) => Err(InboxError::Chain),
            }
        })
    }

    fn mined_height<'a>(
        &'a self,
        txid: &'a Txid,
    ) -> BoxFuture<'a, Result<Option<u32>, InboxError>> {
        Box::pin(async move {
            let fetched = self
                .chain
                .transaction(txid)
                .await
                .map_err(|_| InboxError::Chain)?;
            Ok(fetched.and_then(|tx| tx.mined_height))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use drop_chain::ChainConfig;

    use super::*;

    #[tokio::test]
    async fn start_up_removes_what_a_crash_left_and_makes_every_wallet_the_owners_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let wallet = root.join("3");
        fs::create_dir_all(wallet.join(SCRATCH)).unwrap();
        fs::write(wallet.join(SCRATCH).join("created.pczt"), "x").unwrap();
        fs::set_permissions(&wallet, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(root.join(".setup-4-abcd")).unwrap();
        fs::write(root.join(".setup-4-abcd/identity.age"), "x").unwrap();
        let chain = LightwalletdSource::connect_lazy(&ChainConfig::new(
            "http://127.0.0.1:1",
            Network::Testnet,
        ))
        .unwrap();
        let devtool = Devtool::new(root.join("unused"), "127.0.0.1:1".into(), Network::Testnet);

        DevtoolInbox::new(devtool, root.clone(), Network::Testnet, chain).tidy();

        assert!(!wallet.join(SCRATCH).exists(), "no PCZT file is left");
        assert!(!root.join(".setup-4-abcd").exists(), "no identity is left");
        assert_eq!(
            fs::metadata(&wallet).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn a_scratch_directory_is_the_owners_alone_and_goes_however_the_build_ends() {
        let dir = tempfile::tempdir().unwrap();
        let scratch = Scratch::new(dir.path()).unwrap();
        let path = scratch.path().to_path_buf();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        fs::write(path.join("created.pczt"), "x").unwrap();
        // Dropped without finishing, as a build is when the request that started it goes away.
        drop(scratch);
        assert!(!path.exists());
    }
}
