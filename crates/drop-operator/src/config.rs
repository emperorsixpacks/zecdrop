//! Command-line options and the start-up safety rules (REQ-OPS-001, REQ-OPS-002).
//!
//! The passphrase is deliberately not an option: it comes from the
//! `ZECDROP_PASSPHRASE` environment variable or an interactive prompt, so it never
//! lands in shell history or the process list.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use clap::{ArgGroup, Args, Parser, Subcommand, ValueEnum};
use drop_core::Network;

use crate::crypto::MIN_PASSPHRASE_CHARS;
use crate::error::ConfigError;
use crate::mock::MockConfig;
use crate::state::DEFAULT_MAINNET_MAX_FUNDING_ZAT;

/// Environment variable that must hold [`CONFIRM_MAINNET_VALUE`] to run on mainnet.
pub const CONFIRM_MAINNET_ENV: &str = "ZECDROP_CONFIRM_MAINNET";

/// The exact value of [`CONFIRM_MAINNET_ENV`] that confirms a mainnet run.
pub const CONFIRM_MAINNET_VALUE: &str = "I-UNDERSTAND";

/// Environment variable that names the account registry directory.
pub const STATE_DIR_ENV: &str = "ZECDROP_STATE_DIR";

/// Environment variable that supplies the store passphrase non-interactively.
pub const PASSPHRASE_ENV: &str = "ZECDROP_PASSPHRASE";

/// The network as a command-line value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum NetworkArg {
    /// The public test network (default).
    Testnet,
    /// The production network; needs extra confirmation.
    Mainnet,
}

impl From<NetworkArg> for Network {
    fn from(arg: NetworkArg) -> Self {
        match arg {
            NetworkArg::Testnet => Network::Testnet,
            NetworkArg::Mainnet => Network::Mainnet,
        }
    }
}

/// ZecDrop operator: a local service for confidential batch payouts.
#[derive(Parser, Debug, Clone)]
#[command(name = "drop-operator", version, about)]
pub struct Cli {
    /// What to do. Without a subcommand the operator serves its local API and UI.
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Which network to run on.
    #[arg(long, value_enum, default_value = "testnet", global = true)]
    pub network: NetworkArg,

    /// Allow mainnet. Also requires ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND in the environment.
    #[arg(long, global = true)]
    pub allow_mainnet: bool,

    /// Address to listen on. Must be a loopback address.
    #[arg(long, default_value = "127.0.0.1:8787")]
    pub bind: String,

    /// Path of the encrypted store file (created on first run).
    #[arg(long, default_value = "zecdrop.sqlite", global = true)]
    pub db: PathBuf,

    /// Directory with the built web UI to serve.
    #[arg(long, default_value = "web/dist")]
    pub web_dir: PathBuf,

    /// Run against a fake in-process chain (development and demos only).
    #[arg(long, conflicts_with = "lightwalletd_url", global = true)]
    pub mock_chain: bool,

    /// Run against a real chain through this lightwalletd / Zaino gRPC endpoint, for example
    /// `https://testnet.zec.rocks:443`. Not combinable with --mock-chain.
    #[arg(long, global = true)]
    pub lightwalletd_url: Option<String>,

    /// Base URL of the NEAR Intents 1Click API, for funding a campaign from other assets
    /// (default `https://1click.chaindefuser.com`). The API key, if you have one, is read from
    /// the environment variable `NEAR_INTENTS_JWT`, never from an argument. Mainnet only.
    #[arg(long, global = true)]
    pub near_base_url: Option<String>,

    /// Where the account registry is kept (default: `$ZECDROP_STATE_DIR`, else `~/.zecdrop`).
    /// It must outlive the store file: it is what stops a new store from giving a new campaign
    /// the account, funding address and viewing key of an old one.
    #[arg(long, global = true)]
    pub state_dir: Option<PathBuf>,

    /// TESTNET ONLY: read the wallet seed (64 hex characters, or 32 raw bytes) from this file
    /// instead of the encrypted store. The file must not be readable by group or others.
    #[arg(long, global = true)]
    pub seed_file: Option<PathBuf>,

    /// Seconds between looks at unfunded campaigns' funding addresses.
    #[arg(long, default_value_t = 15)]
    pub funding_poll_secs: u64,

    /// Confirmations at which a batch counts as final.
    #[arg(long, default_value_t = 3)]
    pub required_depth: u32,

    /// Mainnet only: the most a campaign may need in funding (the declared total plus the fee),
    /// in zatoshi. Real money moves on mainnet and this code has not been audited, so a larger
    /// campaign is refused when it is created. The default is 0.1 ZEC.
    #[arg(long, default_value_t = DEFAULT_MAINNET_MAX_FUNDING_ZAT)]
    pub mainnet_max_funding_zat: u64,

    /// Mock chain: polls that report "unconfirmed" before the first block.
    #[arg(long, default_value_t = 1)]
    pub mock_confirm_after_polls: u32,

    /// Mock chain: simulate a crash (the run stops silently) after this many engine
    /// steps, to demonstrate resuming. Restart with a new `start` to continue.
    #[arg(long)]
    pub mock_crash_after_steps: Option<u32>,

    /// Milliseconds between confirmation polls.
    #[arg(long, default_value_t = 1000)]
    pub poll_interval_ms: u64,
}

/// Things the binary can do besides serving.
#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    /// Create the wallet seed in the encrypted store (once). Prints nothing secret.
    InitWallet,
    /// Reconcile a campaign's on-chain payouts with its payout list, locally, using the
    /// campaign's viewing key (REQ-AUD-001/003). Needs --lightwalletd-url.
    Audit(AuditArgs),
    /// Print a campaign's viewing key (UFVK) for an auditor. Disclosing it is irreversible.
    ExportUfvk(ExportArgs),
    /// Write one payslip per payout of a settled campaign, into a new directory, from the campaign's own key.
    /// A payslip is one recipient's proof that one output of a public transaction paid them an amount; it also opens
    /// that output's memo, so give each only to its recipient. Needs --lightwalletd-url. Prints no address, amount or memo.
    Payslips(PayslipsArgs),
    /// Check a payslip against a transaction: offline with --tx FILE, or by fetching it with --lightwalletd-url.
    /// Needs no store and no key, and says what a successful check does not prove.
    VerifyPayslip(VerifyPayslipArgs),
    /// Audit one transaction from files, with no store and no node: recover its outputs with a
    /// viewing key and compare their number and sum with what the chain publishes (REQ-AUD-001).
    AuditTx(AuditTxArgs),
}

/// The recipe printed under `audit --help`: how to give `audit` the campaign key without ever
/// showing it or putting it on a command line.
pub const AUDIT_HELP: &str = "\
Giving audit the campaign key (it travels through a pipe, so it is never printed, never on a
command line and never in your shell history):

  drop-operator FLAGS export-ufvk --campaign ID --i-understand-this-is-irreversible \\
    | drop-operator FLAGS audit --campaign ID --ufvk-stdin --receipt-commitment HEX

FLAGS are the same for both commands: --db, --seed-file, --state-dir and --lightwalletd-url
(and the same ZECDROP_PASSPHRASE). Write them out in full in each command: a shell that does not
split a variable into words (zsh, for one) will not split one that holds them.

HEX is the manifest commitment on the public receipt; leave --receipt-commitment out to compare
with the commitment stored for the campaign instead. The warning export-ufvk prints goes to the
terminal, the key only into the pipe.";

/// Arguments of `audit`. The viewing key is read from stdin or a file, never from the
/// command line, so it cannot land in shell history or the process list.
#[derive(Args, Debug, Clone)]
#[command(
    group(ArgGroup::new("ufvk_source").required(true).multiple(false).args(["ufvk_stdin", "ufvk_file"])),
    after_help = AUDIT_HELP
)]
pub struct AuditArgs {
    /// The campaign to audit.
    #[arg(long)]
    pub campaign: String,

    /// Read the campaign UFVK from standard input.
    #[arg(long)]
    pub ufvk_stdin: bool,

    /// Read the campaign UFVK from this file.
    #[arg(long)]
    pub ufvk_file: Option<PathBuf>,

    /// Compare against this commitment (64 hex characters) instead of the one stored for
    /// the campaign, for example the one shown on the public receipt.
    #[arg(long)]
    pub receipt_commitment: Option<String>,

    /// Print the report as JSON.
    #[arg(long)]
    pub json: bool,
}

/// Arguments of `audit-tx`. The viewing key comes from stdin or a file, or is derived from a
/// testnet development seed file (`--seed-file`) and a campaign account: it is never an argument
/// and never printed.
#[derive(Args, Debug, Clone)]
#[command(group(ArgGroup::new("ufvk_source").required(true).multiple(false).args(["ufvk_stdin", "ufvk_file", "account"])))]
pub struct AuditTxArgs {
    /// The transaction, as a file of hexadecimal text.
    #[arg(long)]
    pub tx: PathBuf,

    /// The outputs it spends, as a JSON list of `{txid, index, value_zat, script_pubkey_hex}`.
    #[arg(long)]
    pub prevouts: PathBuf,

    /// Read the campaign UFVK from standard input.
    #[arg(long)]
    pub ufvk_stdin: bool,

    /// Read the campaign UFVK from this file.
    #[arg(long)]
    pub ufvk_file: Option<PathBuf>,

    /// TESTNET ONLY: derive the UFVK of this campaign account from the seed in `--seed-file`.
    #[arg(long)]
    pub account: Option<u32>,

    /// Print the report as JSON.
    #[arg(long)]
    pub json: bool,
}

/// Arguments of `payslips`.
#[derive(Args, Debug, Clone)]
pub struct PayslipsArgs {
    /// The campaign whose payslips to write.
    #[arg(long)]
    pub campaign: String,

    /// A new directory to write one payslip file per payout into (owner-only; it must not exist).
    #[arg(long)]
    pub out_dir: PathBuf,
}

/// Arguments of `verify-payslip`.
#[derive(Args, Debug, Clone)]
pub struct VerifyPayslipArgs {
    /// The payslip file (JSON).
    #[arg(long)]
    pub payslip: PathBuf,

    /// The transaction as hexadecimal text in a file: checks offline, with no node. Without it,
    /// the transaction is fetched through --lightwalletd-url.
    #[arg(long)]
    pub tx: Option<PathBuf>,
}

/// Arguments of `export-ufvk`.
#[derive(Args, Debug, Clone)]
pub struct ExportArgs {
    /// The campaign whose viewing key to print.
    #[arg(long)]
    pub campaign: String,

    /// Confirms you know the key discloses every payout of the campaign, forever.
    #[arg(long)]
    pub i_understand_this_is_irreversible: bool,
}

/// How the operator reaches the chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChainMode {
    /// A fake in-process chain.
    Mock,
    /// A lightwalletd / Zaino endpoint.
    Lightwalletd(String),
}

/// Validated settings.
#[derive(Clone, Debug)]
pub struct Config {
    /// The network.
    pub network: Network,
    /// Where to listen (always a loopback address).
    pub bind: SocketAddr,
    /// The store file.
    pub db: PathBuf,
    /// The web UI directory.
    pub web_dir: PathBuf,
    /// Whether to use the fake chain.
    pub mock_chain: bool,
    /// The chain the operator talks to.
    pub chain: ChainMode,
    /// A testnet wallet seed file, if given.
    pub seed_file: Option<PathBuf>,
    /// The `--state-dir` flag, if given (see [`resolve_state_dir`]).
    pub state_dir: Option<PathBuf>,
    /// The NEAR Intents API base URL, if not the default.
    pub near_base_url: Option<String>,
    /// Whether `--allow-mainnet` was given (a real NEAR swap is mainnet money).
    pub allow_mainnet: bool,
    /// Pause between looks at unfunded campaigns' funding addresses.
    pub funding_poll_interval: Duration,
    /// Confirmation depth at which a batch is final.
    pub required_depth: u32,
    /// The most funding a mainnet campaign may need, in zatoshi.
    pub mainnet_max_funding_zat: u64,
    /// Fake chain behaviour.
    pub mock: MockConfig,
    /// Simulated crash point, if any.
    pub crash_after_steps: Option<u32>,
    /// Pause between confirmation polls.
    pub poll_interval: Duration,
}

/// REQ-OPS-001: testnet needs nothing; mainnet needs `--allow-mainnet` **and**
/// `ZECDROP_CONFIRM_MAINNET=I-UNDERSTAND`.
pub fn check_network_gate(
    network: Network,
    allow_mainnet: bool,
    confirm_env: Option<&str>,
) -> Result<(), ConfigError> {
    match network {
        Network::Testnet => Ok(()),
        Network::Mainnet if !allow_mainnet => Err(ConfigError::MainnetNeedsFlag),
        Network::Mainnet if confirm_env != Some(CONFIRM_MAINNET_VALUE) => {
            Err(ConfigError::MainnetNeedsConfirmation)
        }
        Network::Mainnet => Ok(()),
    }
}

/// REQ-OPS-002: only loopback addresses may be bound.
pub fn check_bind(address: &str) -> Result<SocketAddr, ConfigError> {
    let parsed: SocketAddr = address.parse().map_err(|_| ConfigError::BadBindAddress)?;
    if parsed.ip().is_loopback() {
        Ok(parsed)
    } else {
        Err(ConfigError::NonLoopbackBind)
    }
}

/// Rejects an empty passphrase. Opening an existing store accepts any passphrase that opens it.
pub fn check_passphrase(passphrase: &str) -> Result<(), ConfigError> {
    if passphrase.is_empty() {
        Err(ConfigError::EmptyPassphrase)
    } else {
        Ok(())
    }
}

/// Rejects a passphrase that is too short for a new store.
pub fn check_new_passphrase(passphrase: &str) -> Result<(), ConfigError> {
    check_passphrase(passphrase)?;
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(ConfigError::PassphraseTooShort);
    }
    Ok(())
}

/// Reads an environment variable and removes it from this process's environment, so that
/// neither a child process nor a later reader of the environment finds it there.
pub fn take_env(name: &str) -> Option<String> {
    let value = std::env::var(name).ok();
    std::env::remove_var(name);
    value
}

/// Where the account registry lives: the flag, else `ZECDROP_STATE_DIR`, else `~/.zecdrop`.
/// An empty value counts as unset.
pub fn resolve_state_dir(
    flag: Option<&std::path::Path>,
    env_dir: Option<&str>,
    home: Option<&str>,
) -> Result<PathBuf, ConfigError> {
    if let Some(path) = flag.filter(|p| !p.as_os_str().is_empty()) {
        return Ok(path.to_owned());
    }
    if let Some(dir) = env_dir.filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    match home.filter(|h| !h.is_empty()) {
        Some(home) => Ok(PathBuf::from(home).join(".zecdrop")),
        None => Err(ConfigError::NoStateDir),
    }
}

/// Chooses the chain mode from the flags. A real chain needs `--lightwalletd-url` on either
/// network; on mainnet the gate in [`check_network_gate`] has already passed by the time this
/// runs, and the mock chain is refused separately (`MockOnMainnet`).
pub fn chain_mode(cli: &Cli, network: Network) -> Result<ChainMode, ConfigError> {
    match (&cli.lightwalletd_url, cli.mock_chain) {
        (Some(_), true) => Err(ConfigError::ChainConflict),
        (Some(url), false) => {
            drop_chain::ChainConfig::new(url.clone(), network)
                .uri()
                .map_err(|_| ConfigError::BadEndpoint)?;
            Ok(ChainMode::Lightwalletd(url.clone()))
        }
        (None, true) => Ok(ChainMode::Mock),
        (None, false) => Err(ConfigError::NoChainBackend),
    }
}

impl Config {
    /// Validates the command line. `confirm_env` is the value of
    /// [`CONFIRM_MAINNET_ENV`], passed in so the rules can be tested without
    /// touching the process environment.
    pub fn from_cli(cli: Cli, confirm_env: Option<&str>) -> Result<Config, ConfigError> {
        let network = Network::from(cli.network);
        check_network_gate(network, cli.allow_mainnet, confirm_env)?;
        let bind = check_bind(&cli.bind)?;
        if cli.seed_file.is_some() && network == Network::Mainnet {
            return Err(ConfigError::SeedFileMainnet);
        }
        if cli.mock_chain && network == Network::Mainnet {
            return Err(ConfigError::MockOnMainnet);
        }
        let chain = chain_mode(&cli, network)?;
        let near_base_url = match &cli.near_base_url {
            Some(url) => {
                drop_chain::ChainConfig::new(url.clone(), Network::Testnet)
                    .uri()
                    .map_err(|_| ConfigError::BadNearUrl)?;
                Some(url.clone())
            }
            None => None,
        };
        if cli.funding_poll_secs == 0 {
            return Err(ConfigError::BadOption(
                "--funding-poll-secs must be at least 1",
            ));
        }
        if cli.required_depth == 0 {
            return Err(ConfigError::BadOption(
                "--required-depth must be at least 1",
            ));
        }
        if cli.poll_interval_ms == 0 {
            return Err(ConfigError::BadOption(
                "--poll-interval-ms must be at least 1",
            ));
        }
        if cli.mainnet_max_funding_zat == 0 {
            return Err(ConfigError::BadOption(
                "--mainnet-max-funding-zat must be at least 1",
            ));
        }
        Ok(Config {
            network,
            bind,
            db: cli.db,
            web_dir: cli.web_dir,
            mock_chain: cli.mock_chain,
            chain,
            seed_file: cli.seed_file,
            state_dir: cli.state_dir,
            near_base_url,
            allow_mainnet: cli.allow_mainnet,
            funding_poll_interval: Duration::from_secs(cli.funding_poll_secs),
            required_depth: cli.required_depth,
            mainnet_max_funding_zat: cli.mainnet_max_funding_zat,
            mock: MockConfig {
                confirm_after_polls: cli.mock_confirm_after_polls,
                ..MockConfig::default()
            },
            crash_after_steps: cli.mock_crash_after_steps,
            poll_interval: Duration::from_millis(cli.poll_interval_ms),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(args: &[&str]) -> Cli {
        let mut full = vec!["drop-operator"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full).unwrap()
    }

    // covers: REQ-AUD-002
    #[test]
    fn the_account_registry_is_kept_in_the_users_own_directory_unless_told_otherwise() {
        use std::path::Path;
        let flag = Path::new("/flag");
        assert_eq!(
            resolve_state_dir(Some(flag), Some("/env"), Some("/home/u")).unwrap(),
            Path::new("/flag")
        );
        assert_eq!(
            resolve_state_dir(None, Some("/env"), Some("/home/u")).unwrap(),
            Path::new("/env")
        );
        assert_eq!(
            resolve_state_dir(None, None, Some("/home/u")).unwrap(),
            Path::new("/home/u/.zecdrop")
        );
        // Empty means unset, and with nothing else there is nowhere to keep it.
        assert_eq!(
            resolve_state_dir(Some(Path::new("")), Some(""), Some("/home/u")).unwrap(),
            Path::new("/home/u/.zecdrop")
        );
        assert!(matches!(
            resolve_state_dir(None, None, None),
            Err(ConfigError::NoStateDir)
        ));
        assert!(matches!(
            resolve_state_dir(None, Some(""), Some("")),
            Err(ConfigError::NoStateDir)
        ));
        // It is a global flag.
        let config =
            Config::from_cli(cli(&["--mock-chain", "--state-dir", "/somewhere"]), None).unwrap();
        assert_eq!(config.state_dir.as_deref(), Some(Path::new("/somewhere")));
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_new_passphrase_must_be_long_enough() {
        assert_eq!(check_passphrase(""), Err(ConfigError::EmptyPassphrase));
        assert_eq!(
            check_passphrase("x"),
            Ok(()),
            "an existing store may have a short one"
        );
        assert_eq!(check_new_passphrase(""), Err(ConfigError::EmptyPassphrase));
        assert_eq!(
            check_new_passphrase("eleven char"),
            Err(ConfigError::PassphraseTooShort)
        );
        assert_eq!(check_new_passphrase("twelve chars"), Ok(()));
        assert_eq!(
            check_new_passphrase("éééééééééééé"),
            Ok(()),
            "characters, not bytes"
        );
        assert_eq!(
            check_new_passphrase("ééééééééééé"),
            Err(ConfigError::PassphraseTooShort)
        );
    }

    // covers: REQ-SEC-002
    #[test]
    fn a_secret_taken_from_the_environment_is_no_longer_in_it() {
        let name = "ZECDROP_TEST_TAKE_ENV_ONLY_USED_BY_THIS_TEST";
        std::env::set_var(name, "hunter2 hunter2");
        assert_eq!(take_env(name).as_deref(), Some("hunter2 hunter2"));
        assert!(std::env::var(name).is_err(), "still in the environment");
        assert_eq!(take_env(name), None);
    }

    // covers: REQ-OPS-001
    #[test]
    fn testnet_is_the_default() {
        let config = Config::from_cli(cli(&["--mock-chain"]), None).unwrap();
        assert_eq!(config.network, Network::Testnet);
        let config =
            Config::from_cli(cli(&["--network", "testnet", "--mock-chain"]), None).unwrap();
        assert_eq!(config.network, Network::Testnet);
    }

    // covers: REQ-OPS-001
    #[test]
    fn mainnet_without_the_flag_is_refused() {
        assert_eq!(
            check_network_gate(Network::Mainnet, false, None),
            Err(ConfigError::MainnetNeedsFlag)
        );
        // Even with the confirmation variable set.
        assert_eq!(
            check_network_gate(Network::Mainnet, false, Some(CONFIRM_MAINNET_VALUE)),
            Err(ConfigError::MainnetNeedsFlag)
        );
        assert_eq!(
            Config::from_cli(cli(&["--network", "mainnet"]), Some(CONFIRM_MAINNET_VALUE))
                .unwrap_err(),
            ConfigError::MainnetNeedsFlag
        );
    }

    // covers: REQ-OPS-001
    #[test]
    fn mainnet_with_the_flag_but_no_confirmation_is_refused() {
        for env in [
            None,
            Some(""),
            Some("yes"),
            Some("i-understand"),
            Some("I-UNDERSTAND "),
        ] {
            assert_eq!(
                check_network_gate(Network::Mainnet, true, env),
                Err(ConfigError::MainnetNeedsConfirmation),
                "{env:?}"
            );
        }
        assert_eq!(
            Config::from_cli(cli(&["--network", "mainnet", "--allow-mainnet"]), None).unwrap_err(),
            ConfigError::MainnetNeedsConfirmation
        );
    }

    // covers: REQ-OPS-001
    #[test]
    fn mainnet_with_flag_and_confirmation_passes_the_gate() {
        assert_eq!(
            check_network_gate(Network::Mainnet, true, Some(CONFIRM_MAINNET_VALUE)),
            Ok(())
        );
        // Testnet never needs either.
        assert_eq!(check_network_gate(Network::Testnet, false, None), Ok(()));
        // Past the gate, a fake chain is still refused on mainnet, and without a real
        // chain there is nothing to run, so the error is about that.
        let args = ["--network", "mainnet", "--allow-mainnet"];
        let mut with_mock = args.to_vec();
        with_mock.push("--mock-chain");
        assert_eq!(
            Config::from_cli(cli(&with_mock), Some(CONFIRM_MAINNET_VALUE)).unwrap_err(),
            ConfigError::MockOnMainnet
        );
        assert_eq!(
            Config::from_cli(cli(&args), Some(CONFIRM_MAINNET_VALUE)).unwrap_err(),
            ConfigError::NoChainBackend
        );
    }

    // covers: REQ-OPS-001
    #[test]
    fn a_run_without_any_chain_backend_is_refused() {
        assert_eq!(
            Config::from_cli(cli(&[]), None).unwrap_err(),
            ConfigError::NoChainBackend
        );
    }

    // covers: REQ-OPS-002
    #[test]
    fn only_loopback_addresses_can_be_bound() {
        for ok in [
            "127.0.0.1:8787",
            "127.0.0.1:0",
            "[::1]:9000",
            "127.1.2.3:80",
        ] {
            assert!(check_bind(ok).is_ok(), "{ok}");
        }
        for wide in [
            "0.0.0.0:8787",
            "192.168.1.20:8787",
            "10.0.0.1:80",
            "8.8.8.8:80",
            "[::]:8787",
            "[fe80::1]:80",
        ] {
            assert_eq!(
                check_bind(wide),
                Err(ConfigError::NonLoopbackBind),
                "{wide}"
            );
        }
        for junk in ["", "localhost:8787", "127.0.0.1", "8787", "not an address"] {
            assert_eq!(
                check_bind(junk),
                Err(ConfigError::BadBindAddress),
                "{junk:?}"
            );
        }
    }

    // covers: REQ-OPS-002
    #[test]
    fn the_command_line_cannot_bind_a_public_address() {
        assert_eq!(
            Config::from_cli(cli(&["--mock-chain", "--bind", "0.0.0.0:8787"]), None).unwrap_err(),
            ConfigError::NonLoopbackBind
        );
        let config = Config::from_cli(cli(&["--mock-chain"]), None).unwrap();
        assert_eq!(config.bind.to_string(), "127.0.0.1:8787");
    }

    // covers: REQ-SEC-002
    #[test]
    fn there_is_no_passphrase_option_on_the_command_line() {
        assert!(Cli::try_parse_from(["drop-operator", "--passphrase", "hunter2"]).is_err());
        assert!(Cli::try_parse_from(["drop-operator", "--password=hunter2"]).is_err());
        assert_eq!(check_passphrase(""), Err(ConfigError::EmptyPassphrase));
        assert_eq!(check_passphrase("x"), Ok(()));
    }

    // covers: REQ-OPS-001
    #[test]
    fn a_real_chain_is_chosen_with_a_url_and_excludes_the_mock() {
        let config = Config::from_cli(
            cli(&["--lightwalletd-url", "https://testnet.zec.rocks:443"]),
            None,
        )
        .unwrap();
        assert_eq!(
            config.chain,
            ChainMode::Lightwalletd("https://testnet.zec.rocks:443".into())
        );
        assert!(!config.mock_chain);
        assert_eq!(config.network, Network::Testnet);

        // Both at once is refused by the parser itself.
        assert!(Cli::try_parse_from([
            "drop-operator",
            "--mock-chain",
            "--lightwalletd-url",
            "https://x.example"
        ])
        .is_err());

        for bad in [
            "testnet.zec.rocks:443",
            "ftp://x.example",
            "https://user:pw@x.example",
            "",
        ] {
            assert_eq!(
                Config::from_cli(cli(&["--lightwalletd-url", bad]), None).unwrap_err(),
                ConfigError::BadEndpoint,
                "{bad:?}"
            );
        }
    }

    // covers: REQ-OPS-001, REQ-OPS-003
    #[test]
    fn mainnet_is_gated_first_and_then_runs_on_a_real_chain() {
        let mainnet = [
            "--network",
            "mainnet",
            "--lightwalletd-url",
            "https://zec.rocks:443",
        ];
        assert_eq!(
            Config::from_cli(cli(&mainnet), None).unwrap_err(),
            ConfigError::MainnetNeedsFlag
        );
        let mut allowed = mainnet.to_vec();
        allowed.push("--allow-mainnet");
        assert_eq!(
            Config::from_cli(cli(&allowed), None).unwrap_err(),
            ConfigError::MainnetNeedsConfirmation
        );
        // A wrong confirmation value is as good as none.
        assert_eq!(
            Config::from_cli(cli(&allowed), Some("yes")).unwrap_err(),
            ConfigError::MainnetNeedsConfirmation
        );
        // Flag and confirmation together: a real chain is accepted, with the default cap of
        // 0.1 ZEC and the endpoint as given.
        let config = Config::from_cli(cli(&allowed), Some(CONFIRM_MAINNET_VALUE)).unwrap();
        assert_eq!(config.network, Network::Mainnet);
        assert_eq!(
            config.chain,
            ChainMode::Lightwalletd("https://zec.rocks:443".to_owned())
        );
        assert_eq!(config.mainnet_max_funding_zat, 10_000_000);
        // The endpoint is still validated, and a bare real chain still needs a URL.
        let mut bad_url = allowed.clone();
        bad_url[3] = "ftp://zec.rocks";
        assert_eq!(
            Config::from_cli(cli(&bad_url), Some(CONFIRM_MAINNET_VALUE)).unwrap_err(),
            ConfigError::BadEndpoint
        );
    }

    // covers: REQ-OPS-003
    #[test]
    fn the_mainnet_funding_cap_is_a_flag_with_a_floor() {
        let base = [
            "--network",
            "mainnet",
            "--allow-mainnet",
            "--lightwalletd-url",
            "https://zec.rocks:443",
        ];
        let mut args = base.to_vec();
        args.extend(["--mainnet-max-funding-zat", "250000"]);
        let config = Config::from_cli(cli(&args), Some(CONFIRM_MAINNET_VALUE)).unwrap();
        assert_eq!(config.mainnet_max_funding_zat, 250_000);
        let mut zero = base.to_vec();
        zero.extend(["--mainnet-max-funding-zat", "0"]);
        assert!(matches!(
            Config::from_cli(cli(&zero), Some(CONFIRM_MAINNET_VALUE)).unwrap_err(),
            ConfigError::BadOption(_)
        ));
    }

    // covers: REQ-SEC-001
    #[test]
    fn a_seed_file_is_for_testnet_only() {
        let ok = cli(&[
            "--lightwalletd-url",
            "https://x.example",
            "--seed-file",
            "/tmp/seed",
        ]);
        let config = Config::from_cli(ok, None).unwrap();
        assert_eq!(
            config.seed_file.as_deref(),
            Some(std::path::Path::new("/tmp/seed"))
        );

        let mainnet = cli(&[
            "--network",
            "mainnet",
            "--allow-mainnet",
            "--lightwalletd-url",
            "https://x.example",
            "--seed-file",
            "/tmp/seed",
        ]);
        assert_eq!(
            Config::from_cli(mainnet, Some(CONFIRM_MAINNET_VALUE)).unwrap_err(),
            ConfigError::SeedFileMainnet
        );
    }

    // covers: REQ-SEC-001, REQ-AUD-001
    #[test]
    fn subcommands_parse_and_never_take_secrets_as_arguments() {
        assert!(cli(&["--mock-chain"]).command.is_none());
        assert!(matches!(
            cli(&["init-wallet"]).command,
            Some(Command::InitWallet)
        ));

        let audit = cli(&[
            "audit",
            "--campaign",
            "c-1",
            "--ufvk-stdin",
            "--db",
            "x.sqlite",
            "--lightwalletd-url",
            "https://h.example",
        ]);
        assert_eq!(
            audit.db,
            std::path::PathBuf::from("x.sqlite"),
            "shared flags work after the subcommand"
        );
        assert_eq!(audit.lightwalletd_url.as_deref(), Some("https://h.example"));
        let Some(Command::Audit(args)) = audit.command else {
            panic!("audit")
        };
        assert!(args.ufvk_stdin && args.ufvk_file.is_none() && !args.json);

        let from_file = cli(&["audit", "--campaign", "c-1", "--ufvk-file", "/tmp/k"]);
        assert!(matches!(from_file.command, Some(Command::Audit(a)) if a.ufvk_file.is_some()));

        // A source is required, and exactly one.
        for bad in [
            vec!["audit", "--campaign", "c-1"],
            vec![
                "audit",
                "--campaign",
                "c-1",
                "--ufvk-stdin",
                "--ufvk-file",
                "/tmp/k",
            ],
            // There is no way to put the key on the command line.
            vec!["audit", "--campaign", "c-1", "--ufvk", "uviewtest1abc"],
            vec![
                "audit",
                "--campaign",
                "c-1",
                "--ufvk-stdin",
                "--ufvk=uviewtest1abc",
            ],
            vec!["export-ufvk", "--campaign", "c-1", "--ufvk", "x"],
        ] {
            let mut full = vec!["drop-operator"];
            full.extend(bad.iter().copied());
            assert!(Cli::try_parse_from(full).is_err(), "{bad:?}");
        }

        let export = cli(&["export-ufvk", "--campaign", "c-1"]);
        assert!(matches!(
            export.command,
            Some(Command::ExportUfvk(a)) if !a.i_understand_this_is_irreversible
        ));
    }

    #[test]
    fn nonsense_numbers_are_refused() {
        assert!(matches!(
            Config::from_cli(cli(&["--mock-chain", "--required-depth", "0"]), None),
            Err(ConfigError::BadOption(_))
        ));
        assert!(matches!(
            Config::from_cli(cli(&["--mock-chain", "--poll-interval-ms", "0"]), None),
            Err(ConfigError::BadOption(_))
        ));
    }
}
