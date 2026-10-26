//! Command-line settings for the hosted verifier.

use std::net::SocketAddr;
use std::time::Duration;

use clap::{Parser, ValueEnum};
use drop_core::Pool;
use thiserror::Error;

/// The pool batches must pay into, as a command-line value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum PoolArg {
    /// The Ironwood pool (default).
    Ironwood,
    /// The Orchard pool.
    Orchard,
}

impl From<PoolArg> for Pool {
    fn from(arg: PoolArg) -> Self {
        match arg {
            PoolArg::Ironwood => Pool::Ironwood,
            PoolArg::Orchard => Pool::Orchard,
        }
    }
}

/// ZecDrop hosted verifier: a stateless, key-less receipt service.
#[derive(Parser, Debug, Clone)]
#[command(name = "drop-verifier", version, about)]
pub struct Cli {
    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8080")]
    pub bind: SocketAddr,

    /// lightwalletd / Zaino gRPC endpoint for testnet, e.g. https://host:443.
    #[arg(long)]
    pub testnet_endpoint: Option<String>,

    /// lightwalletd / Zaino gRPC endpoint for mainnet.
    #[arg(long)]
    pub mainnet_endpoint: Option<String>,

    /// Confirmations at which a batch counts as final.
    #[arg(long, default_value_t = 3)]
    pub required_depth: u32,

    /// The pool batches must pay into.
    #[arg(long, value_enum, default_value = "ironwood")]
    pub expected_pool: PoolArg,

    /// Most transaction ids accepted in one request.
    #[arg(long, default_value_t = 64)]
    pub max_txids: usize,

    /// Seconds before a request is abandoned.
    #[arg(long, default_value_t = 20)]
    pub request_timeout_secs: u64,

    /// Most receipt requests worked on at once (health checks are not counted).
    #[arg(long, default_value_t = 32)]
    pub max_concurrency: usize,

    /// Most receipt requests waiting for a slot; beyond this, 503 at once (load shedding).
    #[arg(long, default_value_t = 64)]
    pub max_queue: usize,

    /// Most chain lookups (transactions plus their funding transactions) per request; beyond
    /// this, 422 `too_many_lookups`.
    #[arg(long, default_value_t = 256)]
    pub max_lookups: usize,

    /// Most open client connections; further connections are closed at once.
    #[arg(long, default_value_t = 512)]
    pub max_connections: usize,

    /// Seconds a client may take to send a request's headers (closes half-open and slow clients).
    #[arg(long, default_value_t = 10)]
    pub header_read_timeout_secs: u64,

    /// Seconds to keep retrying the chain endpoint at startup before exiting with an error.
    #[arg(long, default_value_t = 60)]
    pub startup_timeout_secs: u64,

    /// Origins allowed to read receipts from a browser (repeatable; `*` allows any).
    #[arg(long = "cors-origin")]
    pub cors_origins: Vec<String>,
}

/// Why the settings are unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SettingsError {
    /// No chain endpoint was configured.
    #[error("configure at least one of --testnet-endpoint and --mainnet-endpoint")]
    NoEndpoint,
    /// A numeric option is out of range.
    #[error("option out of range: {0}")]
    BadOption(&'static str),
    /// A CORS origin is not a plain origin.
    #[error("--cors-origin must be `*` or an origin like https://example.org")]
    BadOrigin,
}

/// Validated settings used by the request handlers.
#[derive(Clone, Debug)]
pub struct Settings {
    /// Confirmation depth at which a batch is final.
    pub required_depth: u32,
    /// The pool batches must pay into.
    pub expected_pool: Pool,
    /// Most transaction ids per request.
    pub max_txids: usize,
    /// Per-request time limit.
    pub request_timeout: Duration,
    /// Most receipt requests worked on at once.
    pub max_concurrency: usize,
    /// Most receipt requests waiting for a slot before load shedding.
    pub max_queue: usize,
    /// Most chain lookups per request.
    pub max_lookups: usize,
    /// Most open client connections.
    pub max_connections: usize,
    /// Time a client may take to send request headers.
    pub header_read_timeout: Duration,
    /// Time to keep retrying the chain endpoint at startup.
    pub startup_timeout: Duration,
    /// Allowed browser origins; `["*"]` for any; empty for none.
    pub cors_origins: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            required_depth: 3,
            expected_pool: Pool::Ironwood,
            max_txids: 64,
            request_timeout: Duration::from_secs(20),
            max_concurrency: 32,
            max_queue: 64,
            max_lookups: 256,
            max_connections: 512,
            header_read_timeout: Duration::from_secs(10),
            startup_timeout: Duration::from_secs(60),
            cors_origins: Vec::new(),
        }
    }
}

impl Settings {
    /// Validates the command line.
    pub fn from_cli(cli: &Cli) -> Result<Settings, SettingsError> {
        if cli.testnet_endpoint.is_none() && cli.mainnet_endpoint.is_none() {
            return Err(SettingsError::NoEndpoint);
        }
        if cli.required_depth == 0 {
            return Err(SettingsError::BadOption(
                "--required-depth must be at least 1",
            ));
        }
        if cli.max_txids == 0 || cli.max_txids > 1000 {
            return Err(SettingsError::BadOption(
                "--max-txids must be between 1 and 1000",
            ));
        }
        if cli.request_timeout_secs == 0 || cli.request_timeout_secs > 300 {
            return Err(SettingsError::BadOption(
                "--request-timeout-secs must be between 1 and 300",
            ));
        }
        if cli.max_concurrency == 0 {
            return Err(SettingsError::BadOption(
                "--max-concurrency must be at least 1",
            ));
        }
        if cli.max_queue > 10_000 {
            return Err(SettingsError::BadOption(
                "--max-queue must be at most 10000",
            ));
        }
        if cli.max_lookups == 0 || cli.max_lookups > 10_000 {
            return Err(SettingsError::BadOption(
                "--max-lookups must be between 1 and 10000",
            ));
        }
        if cli.max_connections <= cli.max_concurrency {
            return Err(SettingsError::BadOption(
                "--max-connections must exceed --max-concurrency, so health checks still get in",
            ));
        }
        if cli.header_read_timeout_secs == 0 || cli.header_read_timeout_secs > 120 {
            return Err(SettingsError::BadOption(
                "--header-read-timeout-secs must be between 1 and 120",
            ));
        }
        if cli.startup_timeout_secs == 0 || cli.startup_timeout_secs > 3600 {
            return Err(SettingsError::BadOption(
                "--startup-timeout-secs must be between 1 and 3600",
            ));
        }
        for origin in &cli.cors_origins {
            let plain = origin == "*"
                || ((origin.starts_with("https://") || origin.starts_with("http://"))
                    && !origin.ends_with('/')
                    && !origin.contains(['?', '#', ' '])
                    && origin.matches('/').count() == 2);
            if !plain {
                return Err(SettingsError::BadOrigin);
            }
        }
        Ok(Settings {
            required_depth: cli.required_depth,
            expected_pool: cli.expected_pool.into(),
            max_txids: cli.max_txids,
            request_timeout: Duration::from_secs(cli.request_timeout_secs),
            max_concurrency: cli.max_concurrency,
            max_queue: cli.max_queue,
            max_lookups: cli.max_lookups,
            max_connections: cli.max_connections,
            header_read_timeout: Duration::from_secs(cli.header_read_timeout_secs),
            startup_timeout: Duration::from_secs(cli.startup_timeout_secs),
            cors_origins: cli.cors_origins.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(args: &[&str]) -> Cli {
        let mut full = vec!["drop-verifier"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full).unwrap()
    }

    #[test]
    fn defaults_are_conservative() {
        let s = Settings::from_cli(&cli(&["--testnet-endpoint", "https://x.example:443"])).unwrap();
        assert_eq!((s.required_depth, s.max_txids), (3, 64));
        assert_eq!(s.expected_pool, Pool::Ironwood);
        assert!(s.cors_origins.is_empty(), "no CORS unless asked for");
        assert!(
            cli(&[]).bind.ip().is_loopback(),
            "listens on loopback unless told otherwise"
        );
    }

    #[test]
    fn nonsense_settings_are_refused() {
        let ep = ["--testnet-endpoint", "https://x.example"];
        let with = |extra: &[&str]| {
            let mut args = ep.to_vec();
            args.extend_from_slice(extra);
            Settings::from_cli(&cli(&args))
        };
        assert_eq!(
            Settings::from_cli(&cli(&[])).unwrap_err(),
            SettingsError::NoEndpoint
        );
        assert!(with(&["--required-depth", "0"]).is_err());
        assert!(with(&["--max-txids", "0"]).is_err());
        assert!(with(&["--max-txids", "5000"]).is_err());
        assert!(with(&["--request-timeout-secs", "0"]).is_err());
        assert!(with(&["--max-concurrency", "0"]).is_err());
        assert!(with(&["--max-lookups", "0"]).is_err());
        assert!(with(&["--max-connections", "32"]).is_err());
        assert!(with(&["--header-read-timeout-secs", "0"]).is_err());
        assert!(with(&["--startup-timeout-secs", "0"]).is_err());
        for bad in [
            "example.org",
            "https://example.org/",
            "https://example.org/path",
            "ftp://x.example",
            "https://a b",
        ] {
            assert_eq!(
                with(&["--cors-origin", bad]).unwrap_err(),
                SettingsError::BadOrigin,
                "{bad}"
            );
        }
        assert!(with(&[
            "--cors-origin",
            "https://verify.example.org",
            "--cors-origin",
            "*"
        ])
        .is_ok());
    }
}
