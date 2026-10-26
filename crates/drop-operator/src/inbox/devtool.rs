//! Driving zcash-devtool, the wallet each payout's inbox lives in (docs/ADR/0006-shielded-inbox.md).
//!
//! zcash-devtool runs as a separate process, built by `scripts/zcash-devtool/build.sh` from upstream at a pinned commit with
//! ZecDrop's own patch. Every call: a fixed argument list (never a secret in argv), secrets on stdin only, `RUST_LOG=error`
//! and `NO_COLOR`, a time limit after which the process is killed, and at most [`OUTPUT_LIMIT`] bytes of output kept. Its
//! output is parsed for one thing only, a transaction id; everything else is read from its database ([`super::walletdb`]).
//! Errors are fixed kinds: zcash-devtool's own text can name paths and amounts, so it is never put in a message or a log.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use drop_core::Network;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

/// The most output kept from one call, stdout and stderr each.
pub const OUTPUT_LIMIT: usize = 64 * 1024;

/// How long a call may take before it is killed.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Reading help or a single PCZT step that does no proving.
    pub quick: Duration,
    /// Setting up a wallet, or catching it up with the chain (a testnet sync has been seen to hang for hours).
    pub sync: Duration,
    /// Creating, proving or signing a transaction.
    pub build: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            quick: Duration::from_secs(60),
            sync: Duration::from_secs(300),
            build: Duration::from_secs(600),
        }
    }
}

/// Why a zcash-devtool call failed. Never carries zcash-devtool's output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DevtoolError {
    /// The binary, a file it needs, or a path could not be used.
    #[error("zcash-devtool could not be started")]
    Spawn,
    /// It ran past its time limit, and was killed.
    #[error("zcash-devtool took too long and was stopped")]
    Timeout,
    /// It exited with a failure.
    #[error("zcash-devtool failed")]
    Failed,
    /// It succeeded, but did not print what it should have.
    #[error("zcash-devtool's answer was not understood")]
    Output,
    /// It does not have ZecDrop's patch.
    #[error(
        "this zcash-devtool lacks ZecDrop's patch: build it with scripts/zcash-devtool/build.sh"
    )]
    Unpatched,
}

/// One zcash-devtool binary, for one network and light wallet server.
#[derive(Clone, Debug)]
pub struct Devtool {
    bin: PathBuf,
    server: String,
    network: Network,
    limits: Limits,
}

struct Output {
    stdout: String,
}

impl Devtool {
    /// `server` is a light wallet server as zcash-devtool takes it (`host:port`, or `zecrocks`).
    pub fn new(bin: PathBuf, server: String, network: Network) -> Devtool {
        Devtool {
            bin,
            server,
            network,
            limits: Limits::default(),
        }
    }

    /// The same binary with other time limits (tests use short ones).
    pub fn with_limits(mut self, limits: Limits) -> Devtool {
        self.limits = limits;
        self
    }

    fn network_arg(&self) -> &'static str {
        match self.network {
            Network::Testnet => "test",
            Network::Mainnet => "main",
        }
    }

    async fn run(
        &self,
        args: &[&str],
        stdin: Option<&[u8]>,
        limit: Duration,
    ) -> Result<Output, DevtoolError> {
        let mut command = Command::new(&self.bin);
        command
            .args(args)
            .env("RUST_LOG", "error")
            .env("NO_COLOR", "1")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| DevtoolError::Spawn)?;
        let mut child_stdin = child.stdin.take();
        let mut stdout = child.stdout.take().ok_or(DevtoolError::Spawn)?;
        let mut stderr = child.stderr.take().ok_or(DevtoolError::Spawn)?;
        let work = async {
            if let (Some(pipe), Some(bytes)) = (child_stdin.as_mut(), stdin) {
                // A closed pipe (the program did not read) is not an error of ours; its exit status says what happened.
                let _ = pipe.write_all(bytes).await;
                let _ = pipe.shutdown().await;
            }
            drop(child_stdin.take());
            let (out, _err) = tokio::join!(read_bounded(&mut stdout), read_bounded(&mut stderr));
            let status = child.wait().await.map_err(|_| DevtoolError::Failed)?;
            Ok::<_, DevtoolError>((status, out))
        };
        let (status, out) = tokio::time::timeout(limit, work)
            .await
            .map_err(|_| DevtoolError::Timeout)??;
        if !status.success() {
            return Err(DevtoolError::Failed);
        }
        Ok(Output {
            stdout: String::from_utf8_lossy(&out).into_owned(),
        })
    }

    /// Refuses a binary without ZecDrop's patch: one that could not sign an Ironwood spend, restrict a spend to Ironwood
    /// notes, or hand over the raw transaction for checking.
    pub async fn check_patched(&self) -> Result<(), DevtoolError> {
        for (args, flag) in [
            (&["pczt", "create", "--help"][..], "--ironwood-only"),
            (&["pczt", "create-max", "--help"][..], "--ironwood-only"),
            (&["pczt", "extract", "--help"][..], "--tx-out"),
        ] {
            let help = self.run(args, None, self.limits.quick).await?;
            if !help.stdout.contains(flag) {
                return Err(DevtoolError::Unpatched);
            }
        }
        Ok(())
    }

    /// Sets up a wallet in `wallet_dir` from `phrase` (given on stdin), encrypting it to the identity in `identity_file`
    /// (which must exist: otherwise zcash-devtool would make a random one). `birthday` is the height to scan from.
    pub async fn init(
        &self,
        wallet_dir: &Path,
        identity_file: &Path,
        phrase: &str,
        birthday: u32,
    ) -> Result<(), DevtoolError> {
        if !identity_file.is_file() {
            return Err(DevtoolError::Spawn);
        }
        let wallet = path_arg(wallet_dir)?;
        let identity = path_arg(identity_file)?;
        let birthday = birthday.to_string();
        let mut line = zeroize::Zeroizing::new(Vec::with_capacity(phrase.len() + 1));
        line.extend_from_slice(phrase.as_bytes());
        line.push(b'\n');
        self.run(
            &[
                "wallet",
                "-w",
                wallet,
                "init",
                "--name",
                "inbox",
                "-i",
                identity,
                "--birthday",
                &birthday,
                "-n",
                self.network_arg(),
                "-s",
                &self.server,
            ],
            Some(&line),
            self.limits.sync,
        )
        .await
        .map(|_| ())
    }

    /// Catches the wallet up with the chain.
    pub async fn sync(&self, wallet_dir: &Path) -> Result<(), DevtoolError> {
        let wallet = path_arg(wallet_dir)?;
        self.run(
            &["wallet", "-w", wallet, "sync", "-s", &self.server],
            None,
            self.limits.sync,
        )
        .await
        .map(|_| ())
    }

    /// A PCZT paying `value` zatoshi to `to` from the account's Ironwood notes, with at most one change note (so the fee
    /// is predictable), written to `out`.
    pub async fn create(
        &self,
        wallet_dir: &Path,
        account: &str,
        to: &str,
        value: u64,
        out: &Path,
    ) -> Result<(), DevtoolError> {
        let wallet = path_arg(wallet_dir)?;
        let out = path_arg(out)?;
        let value = value.to_string();
        self.run(
            &[
                "pczt",
                "-w",
                wallet,
                "create",
                account,
                "--ironwood-only",
                "--address",
                to,
                "--value",
                &value,
                "--target-note-count",
                "1",
                "--output",
                out,
            ],
            None,
            self.limits.build,
        )
        .await
        .map(|_| ())
    }

    /// A PCZT paying everything spendable in the account's Ironwood notes, less the fee, to `to`, written to `out`.
    pub async fn create_max(
        &self,
        wallet_dir: &Path,
        account: &str,
        to: &str,
        out: &Path,
    ) -> Result<(), DevtoolError> {
        let wallet = path_arg(wallet_dir)?;
        let out = path_arg(out)?;
        self.run(
            &[
                "pczt",
                "-w",
                wallet,
                "create-max",
                account,
                "--ironwood-only",
                "--only-spendable",
                "--address",
                to,
                "--output",
                out,
            ],
            None,
            self.limits.build,
        )
        .await
        .map(|_| ())
    }

    /// Adds the proofs to the PCZT in `input`, written to `out`.
    pub async fn prove(
        &self,
        wallet_dir: &Path,
        input: &Path,
        out: &Path,
    ) -> Result<(), DevtoolError> {
        let wallet = path_arg(wallet_dir)?;
        let (input, out) = (path_arg(input)?, path_arg(out)?);
        self.run(
            &["pczt", "-w", wallet, "prove", input, "--output", out],
            None,
            self.limits.build,
        )
        .await
        .map(|_| ())
    }

    /// Signs the PCZT in `input` with the wallet's own keys, unlocked by `identity` (an age identity, given on stdin), into
    /// `out`.
    pub async fn sign(
        &self,
        wallet_dir: &Path,
        identity: &str,
        input: &Path,
        out: &Path,
    ) -> Result<(), DevtoolError> {
        let wallet = path_arg(wallet_dir)?;
        let (input, out) = (path_arg(input)?, path_arg(out)?);
        let mut line = zeroize::Zeroizing::new(Vec::with_capacity(identity.len() + 1));
        line.extend_from_slice(identity.as_bytes());
        line.push(b'\n');
        self.run(
            &[
                "pczt",
                "-w",
                wallet,
                "sign",
                "-i",
                "/dev/stdin",
                input,
                "--output",
                out,
            ],
            Some(&line),
            self.limits.build,
        )
        .await
        .map(|_| ())
    }

    /// Joins the proven and the signed PCZT into `out`.
    pub async fn combine(
        &self,
        wallet_dir: &Path,
        proven: &Path,
        signed: &Path,
        out: &Path,
    ) -> Result<(), DevtoolError> {
        let wallet = path_arg(wallet_dir)?;
        let (proven, signed, out) = (path_arg(proven)?, path_arg(signed)?, path_arg(out)?);
        self.run(
            &[
                "pczt", "-w", wallet, "combine", "-i", proven, "-i", signed, "-o", out,
            ],
            None,
            self.limits.quick,
        )
        .await
        .map(|_| ())
    }

    /// Extracts the finished transaction from the PCZT in `pczt`: its raw bytes go to `tx_out`, and its id (as
    /// zcash-devtool prints it, display order) is returned.
    pub async fn extract(&self, pczt: &Path, tx_out: &Path) -> Result<String, DevtoolError> {
        let bytes = tokio::fs::read(pczt)
            .await
            .map_err(|_| DevtoolError::Spawn)?;
        let tx_out = path_arg(tx_out)?;
        let out = self
            .run(
                &["pczt", "extract", "--tx-out", tx_out],
                Some(&bytes),
                self.limits.build,
            )
            .await?;
        last_txid(&out.stdout).ok_or(DevtoolError::Output)
    }
}

async fn read_bounded(reader: &mut (impl AsyncReadExt + Unpin)) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = OUTPUT_LIMIT.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..n.min(room)]);
                // Keep reading past the limit, so the program never blocks on a full pipe.
            }
        }
    }
    kept
}

fn path_arg(path: &Path) -> Result<&str, DevtoolError> {
    path.to_str().ok_or(DevtoolError::Spawn)
}

/// The last line of `text` that is exactly a transaction id (64 lowercase hex digits).
pub(crate) fn last_txid(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .rfind(|line| {
            line.len() == 64
                && line
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in for zcash-devtool: a shell script, made executable.
    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-devtool");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn devtool(bin: PathBuf) -> Devtool {
        Devtool::new(bin, "testnet.example:443".into(), Network::Testnet).with_limits(Limits {
            quick: Duration::from_secs(5),
            sync: Duration::from_secs(5),
            build: Duration::from_secs(5),
        })
    }

    #[test]
    fn the_txid_is_the_last_line_that_is_one() {
        let a = "a".repeat(64);
        let b = "0123456789abcdef".repeat(4);
        assert_eq!(
            last_txid(&format!("Building…\n{a}\nnoise\n{b}\n")),
            Some(b.clone())
        );
        assert_eq!(
            last_txid(&format!("{}\n", "A".repeat(64))),
            None,
            "upper case is not how it prints one"
        );
        assert_eq!(last_txid("no id here"), None);
    }

    #[tokio::test]
    async fn an_unpatched_binary_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let unpatched = devtool(script(dir.path(), "echo '      --address <ADDRESS>'"));
        assert_eq!(
            unpatched.check_patched().await,
            Err(DevtoolError::Unpatched)
        );
        let patched = devtool(script(dir.path(), "echo '--ironwood-only --tx-out'"));
        assert_eq!(patched.check_patched().await, Ok(()));
    }

    #[tokio::test]
    async fn a_secret_goes_in_on_stdin_never_in_argv() {
        let dir = tempfile::tempdir().unwrap();
        let seen = dir.path().join("seen");
        let bin = script(
            dir.path(),
            &format!(
                "echo \"$@\" > {argv}.argv; cat > {argv}.stdin; touch \"$9\"",
                argv = seen.display()
            ),
        );
        let out = dir.path().join("signed.pczt");
        devtool(bin)
            .sign(
                dir.path(),
                "AGE-SECRET-KEY-1SECRETSECRET",
                &dir.path().join("in.pczt"),
                &out,
            )
            .await
            .unwrap();
        let argv = std::fs::read_to_string(seen.with_extension("argv")).unwrap();
        assert!(!argv.contains("SECRET"));
        assert!(argv.contains("-i /dev/stdin"));
        assert_eq!(
            std::fs::read_to_string(seen.with_extension("stdin")).unwrap(),
            "AGE-SECRET-KEY-1SECRETSECRET\n"
        );
    }

    #[tokio::test]
    async fn a_failure_or_a_hang_is_a_fixed_error_that_says_nothing_of_the_output() {
        let dir = tempfile::tempdir().unwrap();
        let failing = devtool(script(
            dir.path(),
            "echo 'secret path /home/x and 12345 zat' >&2; exit 3",
        ));
        let err = failing.sync(dir.path()).await.unwrap_err();
        assert_eq!(err, DevtoolError::Failed);
        assert!(!err.to_string().contains("12345"));
        let hanging = Devtool::new(
            script(dir.path(), "sleep 30"),
            "x:1".into(),
            Network::Testnet,
        )
        .with_limits(Limits {
            quick: Duration::from_millis(200),
            sync: Duration::from_millis(200),
            build: Duration::from_millis(200),
        });
        assert_eq!(hanging.sync(dir.path()).await, Err(DevtoolError::Timeout));
    }

    #[tokio::test]
    async fn output_beyond_the_limit_is_dropped_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let txid = "c".repeat(64);
        // 1 MiB of noise, then the id: kept output stops at the limit, so the id is not found, and nothing blocks.
        let bin = script(
            dir.path(),
            &format!("head -c 1048576 /dev/zero | tr '\\0' 'x'; echo; echo {txid}"),
        );
        let pczt = dir.path().join("final.pczt");
        std::fs::write(&pczt, b"PCZT").unwrap();
        let got = devtool(bin)
            .extract(&pczt, &dir.path().join("tx.bin"))
            .await;
        assert_eq!(got, Err(DevtoolError::Output));
    }
}
