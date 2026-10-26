//! Shared by the demo examples: the TESTNET dev seed and the demo recipient accounts.
//!
//! The dev seed lives in `~/.zecdrop-dev/testnet.seed` (created by the spike's
//! `gen-testnet-wallet`), outside the repo. It is read here, never printed, and zeroized.

#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use zeroize::Zeroize;

/// Demo recipients are ZIP 32 accounts 9000..9007 of the dev seed: a high range kept apart
/// from campaign accounts (which start at 0).
pub const DEMO_ACCOUNT_BASE: u32 = 9000;

/// The demo payouts in TAZ: varied (no uniform-batch warning), summing to exactly 0.005.
pub const DEMO_AMOUNTS: [&str; 8] = [
    "0.0006", "0.0004", "0.0009", "0.0005", "0.0007", "0.0003", "0.0010", "0.0006",
];

/// The account of demo recipient `n` (1-based, matching the CSV row and memo).
pub fn demo_account(n: u32) -> u32 {
    DEMO_ACCOUNT_BASE + n - 1
}

pub fn demo_memo(n: u32) -> String {
    format!("ZecDrop demo payout {n}")
}

/// 32 bytes of TESTNET dev seed. Not `Debug`/`Clone`; zeroized on drop.
pub struct DevSeed([u8; 32]);

impl DevSeed {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for DevSeed {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Reads the dev seed, refusing a file that group or others can read. Errors never contain
/// seed material.
pub fn load_dev_seed() -> Result<DevSeed, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let path = PathBuf::from(home)
        .join(".zecdrop-dev")
        .join("testnet.seed");
    let mode = fs::metadata(&path)
        .map_err(|e| {
            format!(
                "{}: {e} (create it with the spike's gen-testnet-wallet)",
                path.display()
            )
        })?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(format!(
            "{} has mode {:o}; expected 0600",
            path.display(),
            mode & 0o777
        ));
    }
    let mut text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let decoded = hex::decode(text.trim());
    text.zeroize();
    let mut bytes = decoded.map_err(|_| "the seed file is not hex")?;
    let seed = <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "the seed file is not 32 bytes");
    bytes.zeroize();
    seed.map(DevSeed).map_err(str::to_string)
}
