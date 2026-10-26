//! A stand-in for the shielded deposit addresses' wallets and node (docs/ADR/0006-shielded-inbox.md), for the engine's tests
//! and the API goldens. Nothing here runs zcash-devtool or touches a network.
#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use drop_core::Txid;
use drop_operator::{
    inbox::{
        engine::{
            BoxFuture, Built, ChainNow, InboxBackend, InboxError, InboxSettings, Inboxes,
            OwnedContext, Sent, Snapshot,
        },
        walletdb::{InboxNote, NoteSpend},
    },
    secret::SecretSeed,
};
use drop_zcash::inbox::InboxTxFacts;

use super::Harness;

/// A move the fake built: (account, to, value, the notes it was given).
pub type BuiltMove = (u32, String, u64, Vec<([u8; 32], u64)>);

/// A send-back the fake built: (account, to, the notes it was given, its txid).
pub type BuiltReturn = (u32, String, Vec<([u8; 32], u64)>, String);

pub const BRANCH: u32 = 0x7719_0ad9;
pub const FEE: u64 = 15_000;

/// A stand-in for the zcash-devtool wallets and the node behind them.
#[derive(Default)]
pub struct Fake {
    pub set_up: Vec<(u32, u32)>,
    pub notes: HashMap<u32, Vec<InboxNote>>,
    pub wallet_tip: u32,
    pub chain_tip: u32,
    /// Every move built: (account, to, value, the notes it was given).
    pub built: Vec<BuiltMove>,
    /// The txid of each move built, in the same order.
    pub built_txids: Vec<String>,
    /// Every send-back built: (account, to, the notes it was given), and its txid.
    pub returns: Vec<BuiltReturn>,
    pub broadcasts: Vec<Vec<u8>>,
    pub mined: HashMap<String, u32>,
    pub fail_setup: bool,
}

#[derive(Clone, Default)]
pub struct FakeInbox(Arc<Mutex<Fake>>);

impl FakeInbox {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Fake> {
        self.0.lock().unwrap()
    }

    pub fn address(account: u32) -> String {
        format!("utest1fakeinboxADDRESSforaccount{account}")
    }

    pub fn deposit(&self, account: u32, value: u64, mined_at: u32, nf: u8) {
        self.lock()
            .notes
            .entry(account)
            .or_default()
            .push(InboxNote {
                value,
                nullifier: Some([nf; 32]),
                is_change: false,
                mined_height: Some(mined_at),
                spend: NoteSpend::Unspent,
            });
    }

    /// The transaction `txid` is mined at `height`; if it is one of the moves built, the wallet sees what a real one would
    /// after a sync: the notes it spent are spent, and its change (if any) arrives as a note of the inbox's own.
    pub fn mine(&self, txid: &str, height: u32) {
        let mut fake = self.lock();
        fake.mined.insert(txid.to_owned(), height);
        if let Some(index) = fake.returns.iter().position(|r| r.3 == txid) {
            let (account, _, notes, _) = fake.returns[index].clone();
            for note in fake.notes.entry(account).or_default().iter_mut() {
                if note
                    .nullifier
                    .is_some_and(|nf| notes.iter().any(|(spent_nf, _)| *spent_nf == nf))
                {
                    note.spend = NoteSpend::Mined;
                }
            }
            return;
        }
        let Some(index) = fake.built_txids.iter().position(|t| t == txid) else {
            return;
        };
        let (account, _, value, notes) = fake.built[index].clone();
        let spent: u64 = notes.iter().map(|n| n.1).sum();
        let list = fake.notes.entry(account).or_default();
        for note in list.iter_mut() {
            if note
                .nullifier
                .is_some_and(|nf| notes.iter().any(|(spent_nf, _)| *spent_nf == nf))
            {
                note.spend = NoteSpend::Mined;
            }
        }
        let change = spent.saturating_sub(value + FEE);
        if change > 0 {
            list.push(InboxNote {
                value: change,
                nullifier: Some([0xcc; 32]),
                is_change: true,
                mined_height: Some(height),
                spend: NoteSpend::Unspent,
            });
        }
    }

    pub fn tip(&self, tip: u32) {
        let mut fake = self.lock();
        fake.wallet_tip = tip;
        fake.chain_tip = tip;
    }
}

fn txid_of(raw: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(raw))
}

impl InboxBackend for FakeInbox {
    fn set_up<'a>(
        &'a self,
        _seed: &'a SecretSeed,
        account: u32,
        birthday: u32,
    ) -> BoxFuture<'a, Result<String, InboxError>> {
        Box::pin(async move {
            let mut fake = self.lock();
            if fake.fail_setup {
                return Err(InboxError::Unavailable);
            }
            fake.set_up.push((account, birthday));
            Ok(FakeInbox::address(account))
        })
    }

    fn refresh(&self, account: u32) -> BoxFuture<'_, Result<Snapshot, InboxError>> {
        Box::pin(async move {
            let fake = self.lock();
            Ok(Snapshot {
                wallet_tip: fake.wallet_tip,
                notes: fake.notes.get(&account).cloned().unwrap_or_default(),
                orchard: 0,
            })
        })
    }

    fn chain_now(&self) -> BoxFuture<'_, Result<ChainNow, InboxError>> {
        Box::pin(async move {
            Ok(ChainNow {
                tip: self.lock().chain_tip,
                branch_id: BRANCH,
            })
        })
    }

    fn build_move<'a>(
        &'a self,
        _seed: &'a SecretSeed,
        account: u32,
        funding_address: &'a str,
        value: u64,
        context: OwnedContext,
    ) -> BoxFuture<'a, Result<Built, InboxError>> {
        Box::pin(async move {
            let mut fake = self.lock();
            let n = fake.built.len();
            fake.built.push((
                account,
                funding_address.to_owned(),
                value,
                context.notes.clone(),
            ));
            let raw = format!("move-{account}-{n}-{value}").into_bytes();
            fake.built_txids.push(txid_of(&raw));
            let spent: u64 = context.notes.iter().map(|n| n.1).sum();
            Ok(Built {
                facts: InboxTxFacts {
                    txid: txid_of(&raw),
                    expiry_height: context.tip + 40,
                    fee: FEE,
                    spent,
                    change: spent - value - FEE,
                },
                raw,
            })
        })
    }

    fn build_return<'a>(
        &'a self,
        _seed: &'a SecretSeed,
        account: u32,
        to: &'a str,
        context: OwnedContext,
    ) -> BoxFuture<'a, Result<Built, InboxError>> {
        Box::pin(async move {
            let mut fake = self.lock();
            let raw = format!("return-{account}-{}", fake.returns.len()).into_bytes();
            let txid = txid_of(&raw);
            fake.returns
                .push((account, to.to_owned(), context.notes.clone(), txid.clone()));
            let spent: u64 = context.notes.iter().map(|n| n.1).sum();
            Ok(Built {
                facts: InboxTxFacts {
                    txid,
                    expiry_height: context.tip + 40,
                    fee: 10_000,
                    spent,
                    change: 0,
                },
                raw,
            })
        })
    }

    fn broadcast<'a>(&'a self, raw: &'a [u8]) -> BoxFuture<'a, Result<Sent, InboxError>> {
        Box::pin(async move {
            self.lock().broadcasts.push(raw.to_vec());
            Ok(Sent::Accepted)
        })
    }

    fn mined_height<'a>(
        &'a self,
        txid: &'a Txid,
    ) -> BoxFuture<'a, Result<Option<u32>, InboxError>> {
        Box::pin(async move { Ok(self.lock().mined.get(&txid.to_string()).copied()) })
    }
}

pub fn now_settings() -> InboxSettings {
    InboxSettings {
        poll: Duration::from_millis(1),
        delay_min: Duration::ZERO,
        delay_max: Duration::ZERO,
        resend: Duration::ZERO,
    }
}

pub fn attach(h: &Harness, fake: &FakeInbox) -> Arc<Inboxes> {
    let inboxes = Arc::new(Inboxes::new(Arc::new(fake.clone()), now_settings(), None));
    h.state.attach_inboxes(Arc::clone(&inboxes));
    inboxes
}
