//! The TESTNET dev seed at `~/.zecdrop-dev/testnet.seed`: outside the repo, directory mode 0700,
//! file mode 0600, created once and reused. The seed is never printed, logged or committed.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use zeroize::Zeroize;

/// 32 bytes of seed material. Deliberately not `Debug`/`Clone`; zeroized on drop.
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

#[derive(Debug, PartialEq, Eq)]
pub enum Origin {
    Created,
    Reused,
}

pub fn path() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| io::Error::other("HOME is not set"))?;
    Ok(PathBuf::from(home)
        .join(".zecdrop-dev")
        .join("testnet.seed"))
}

/// Loads the dev seed, creating it from OS randomness if (and only if) the file does not exist.
pub fn load_or_create() -> io::Result<(DevSeed, Origin)> {
    match load() {
        Ok(seed) => Ok((seed, Origin::Reused)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => create().map(|s| (s, Origin::Created)),
        Err(e) => Err(e),
    }
}

/// Loads an existing dev seed; refuses a file readable by group or others.
pub fn load() -> io::Result<DevSeed> {
    let path = path()?;
    let mode = fs::metadata(&path)?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} has mode {:o}; expected 0600",
                path.display(),
                mode & 0o777
            ),
        ));
    }
    let mut text = fs::read_to_string(&path)?;
    let mut bytes =
        hex::decode(text.trim()).map_err(|_| io::Error::other("seed file is not hex"))?;
    text.zeroize();
    let seed = <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| io::Error::other("seed file is not 32 bytes"));
    bytes.zeroize();
    seed.map(DevSeed)
}

fn create() -> io::Result<DevSeed> {
    let path = path()?;
    let dir = path.parent().expect("seed path has a parent");
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;

    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| io::Error::other(e.to_string()))?;

    // `create_new` never overwrites: if another process created the file first, this fails.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    let mut text = hex::encode(seed);
    let written = file
        .write_all(text.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all());
    text.zeroize();
    written?;
    Ok(DevSeed(seed))
}
