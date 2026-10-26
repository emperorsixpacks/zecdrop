//! The `drop-verifier` binary.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use drop_chain::{ChainConfig, LightwalletdSource};
use drop_core::Network;
use drop_verifier::api::{build_router, Sources, VerifierState};
use drop_verifier::config::{Cli, Settings};
use drop_verifier::log::Logger;
use drop_verifier::server::{serve, ServeLimits};
use drop_verifier::startup::wait_for_chain;
use tokio::net::TcpListener;

/// Connects to a configured endpoint and fails closed: the verifier does not serve until the
/// endpoint has answered and serves `network` (retried with backoff up to the startup timeout).
async fn source_for(
    endpoint: Option<&String>,
    network: Network,
    settings: &Settings,
    logger: &Logger,
) -> Result<Option<LightwalletdSource>, Box<dyn std::error::Error>> {
    let Some(endpoint) = endpoint else {
        return Ok(None);
    };
    let source = LightwalletdSource::connect_lazy(&ChainConfig::new(endpoint.clone(), network))?;
    let info = wait_for_chain(
        || source.chain_info(),
        settings.startup_timeout,
        Duration::from_millis(500),
    )
    .await
    .map_err(|e| format!("{network} endpoint: {e}"))?;
    logger.info(format_args!(
        "{network} endpoint serves the expected chain (tip {}, branch {:08x})",
        info.tip_height, info.consensus_branch_id
    ));
    Ok(Some(source))
}

async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let settings = Settings::from_cli(&cli)?;
    let logger = Logger::stderr();
    let sources = Sources {
        testnet: source_for(
            cli.testnet_endpoint.as_ref(),
            Network::Testnet,
            &settings,
            &logger,
        )
        .await?,
        mainnet: source_for(
            cli.mainnet_endpoint.as_ref(),
            Network::Mainnet,
            &settings,
            &logger,
        )
        .await?,
    };
    let limits = ServeLimits {
        max_connections: settings.max_connections,
        header_read_timeout: settings.header_read_timeout,
    };
    let state = Arc::new(VerifierState {
        sources,
        settings,
        logger: logger.clone(),
    });
    let listener = TcpListener::bind(cli.bind).await?;
    logger.info(format_args!("listening on {}", listener.local_addr()?));
    serve(listener, build_router(state), limits, logger, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await;
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
