//! The `drop-operator` binary: validates the command line, opens the encrypted store, and
//! either serves the local API or runs one of the subcommands (`init-wallet`, `audit`,
//! `export-ufvk`).

use std::error::Error;
use std::io::IsTerminal;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use drop_chain::{ChainConfig, LightwalletdSource};
use drop_core::{AddressCodec, Network, Pool};
use drop_operator::accounts::FileAccounts;
use drop_operator::audit::{read_ufvk, UfvkSource};
use drop_operator::auth::Token;
use drop_operator::chain::ChainBackend;
use drop_operator::codec::LooseAddressCodec;
use drop_operator::commands::{
    campaign_ufvk, ensure_campaign_network, run_audit, run_export_ufvk, run_payslips,
};
use drop_operator::config::{
    chain_mode, check_network_gate, check_new_passphrase, check_passphrase, resolve_state_dir,
    take_env, AuditArgs, AuditTxArgs, ChainMode, Cli, Command, Config, ExportArgs, InboxConfig,
    PayslipsArgs, VerifyPayslipArgs, CONFIRM_MAINNET_ENV, PASSPHRASE_ENV, STATE_DIR_ENV,
};
use drop_operator::crypto::KdfParams;
use drop_operator::inbox::{
    backend::DevtoolInbox,
    devtool::Devtool,
    engine::{inbox_root, InboxSettings, Inboxes},
};
use drop_operator::logging::Logger;
use drop_operator::mock::{MockBackend, MockChain};
use drop_operator::near::{NearGateway, NearParts, SystemClock};
use drop_operator::payslips::{
    payslip_network, run_verify_payslip_offline, run_verify_payslip_on_chain, PayslipsError,
};
use drop_operator::real::{LightwalletdConnector, ZcashBackend};
use drop_operator::secret::SecretSeed;
use drop_operator::seedfile::read_seed_file;
use drop_operator::serve::{serve, startup_banner};
use drop_operator::state::{AppParts, AppState, Options};
use drop_operator::store::Store;
use drop_operator::txaudit::{audit_transaction, read_prevouts, read_tx_hex};
use drop_zcash::{zcash_network, MainnetPermit, ZcashAddressCodec};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

/// Reads the store passphrase from the environment or, in a terminal, a hidden prompt. A new
/// store's passphrase must be long enough; the variable is removed from the environment as soon
/// as it is read.
fn passphrase(creating: bool) -> Result<Zeroizing<String>, Box<dyn Error>> {
    let check = |value: &str| {
        if creating {
            check_new_passphrase(value)
        } else {
            check_passphrase(value)
        }
    };
    if let Some(value) = take_env(PASSPHRASE_ENV) {
        check(&value)?;
        return Ok(Zeroizing::new(value));
    }
    if !std::io::stdin().is_terminal() {
        return Err(format!("set {PASSPHRASE_ENV} or run in a terminal to be prompted").into());
    }
    let first = Zeroizing::new(rpassword::prompt_password("Store passphrase: ")?);
    check(&first)?;
    if creating {
        let again = Zeroizing::new(rpassword::prompt_password("Repeat passphrase: ")?);
        if *first != *again {
            return Err("the passphrases do not match".into());
        }
    }
    Ok(first)
}

/// Opens (or, if allowed, creates) the store at `db`.
fn open_store(db: &Path, create: bool) -> Result<Store, Box<dyn Error>> {
    let exists = db.exists();
    if !exists && !create {
        return Err(format!(
            "no store at {}; run `drop-operator init-wallet` first",
            db.display()
        )
        .into());
    }
    let pass = passphrase(!exists)?;
    let (store, _) = Store::open_or_create(db, &pass, KdfParams::PRODUCTION)?;
    Ok(store)
}

/// The wallet seed: a testnet seed file if given, else the store's seed. With the fake chain
/// (which never signs anything) a seed is created on first use for convenience.
fn wallet_seed(
    seed_file: Option<&Path>,
    mock: bool,
    store: &Store,
) -> Result<SecretSeed, Box<dyn Error>> {
    if let Some(path) = seed_file {
        return Ok(read_seed_file(path)?);
    }
    if mock {
        return Ok(store.load_or_create_seed()?);
    }
    store.load_seed()?.ok_or_else(|| {
        "this store has no wallet seed; run `drop-operator init-wallet` (or, on testnet, pass --seed-file)"
            .into()
    })
}

/// Applies the mainnet gate for subcommands, which have no full `Config`.
fn tool_network(cli: &Cli, confirm: Option<&str>) -> Result<Network, Box<dyn Error>> {
    let network = Network::from(cli.network);
    check_network_gate(network, cli.allow_mainnet, confirm)?;
    Ok(network)
}

fn init_wallet(cli: &Cli, confirm: Option<&str>) -> Result<ExitCode, Box<dyn Error>> {
    tool_network(cli, confirm)?;
    let store = open_store(&cli.db, true)?;
    if store.init_wallet()? {
        println!(
            "Wallet created. Its seed is stored encrypted in {}.",
            cli.db.display()
        );
    } else {
        println!(
            "The wallet in {} is already initialised; nothing changed.",
            cli.db.display()
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn export_ufvk(
    cli: &Cli,
    args: &ExportArgs,
    confirm: Option<&str>,
) -> Result<ExitCode, Box<dyn Error>> {
    let network = tool_network(cli, confirm)?;
    let store = open_store(&cli.db, false)?;
    ensure_campaign_network(&store, &args.campaign, network)?;
    let seed = wallet_seed(cli.seed_file.as_deref(), false, &store)?;
    run_export_ufvk(
        &store,
        &seed,
        args,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
    )?;
    Ok(ExitCode::SUCCESS)
}

fn audit_tx(
    cli: &Cli,
    args: &AuditTxArgs,
    confirm: Option<&str>,
) -> Result<ExitCode, Box<dyn Error>> {
    let network = tool_network(cli, confirm)?;
    let ufvk = match args.account {
        Some(account) => {
            if network != Network::Testnet {
                return Err("--account derives from a development seed file: testnet only".into());
            }
            let path = cli
                .seed_file
                .as_deref()
                .ok_or("--account needs --seed-file <development seed file>")?;
            let seed = read_seed_file(path)?;
            campaign_ufvk(&seed, network, account)?
        }
        None => {
            let source = match &args.ufvk_file {
                Some(path) => UfvkSource::File(path),
                None => UfvkSource::Stdin,
            };
            read_ufvk(source, &mut std::io::stdin())?
        }
    };
    let raw = read_tx_hex(&args.tx)?;
    let prevouts = read_prevouts(&args.prevouts)?;
    let report = audit_transaction(&raw, &prevouts, network, &ufvk)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", report.render());
    }
    Ok(if report.reconciled {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

async fn payslips(
    cli: &Cli,
    args: &PayslipsArgs,
    confirm: Option<&str>,
) -> Result<ExitCode, Box<dyn Error>> {
    let network = tool_network(cli, confirm)?;
    let ChainMode::Lightwalletd(url) = chain_mode(cli, network)? else {
        return Err("payslips read the real chain: pass --lightwalletd-url".into());
    };
    let store = Arc::new(open_store(&cli.db, false)?);
    ensure_campaign_network(&store, &args.campaign, network)?;
    let seed = wallet_seed(cli.seed_file.as_deref(), false, &store)?;
    let (source, _info) = LightwalletdSource::connect(&ChainConfig::new(url, network)).await?;
    let complete = run_payslips(
        &store,
        &seed,
        args,
        &source,
        Options::default().required_depth,
        &mut std::io::stdout(),
    )
    .await?;
    // Differences are not a failure of the tool: exit code 2, as for the audit.
    Ok(if complete {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

async fn verify_payslip(cli: &Cli, args: &VerifyPayslipArgs) -> Result<ExitCode, Box<dyn Error>> {
    let mut stdout = std::io::stdout();
    if let Some(tx) = &args.tx {
        run_verify_payslip_offline(&args.payslip, tx, &mut stdout)?;
        return Ok(ExitCode::SUCCESS);
    }
    let url = cli
        .lightwalletd_url
        .clone()
        .ok_or(PayslipsError::NoTransaction)?;
    let network = payslip_network(&args.payslip)?;
    let (source, _info) = LightwalletdSource::connect(&ChainConfig::new(url, network)).await?;
    let is_final = run_verify_payslip_on_chain(
        &args.payslip,
        &source,
        Options::default().required_depth,
        &mut stdout,
    )
    .await?;
    // A payslip that verifies but is not final yet is PENDING: exit code 2.
    Ok(if is_final {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

async fn audit(
    cli: &Cli,
    args: &AuditArgs,
    confirm: Option<&str>,
) -> Result<ExitCode, Box<dyn Error>> {
    let network = tool_network(cli, confirm)?;
    let ChainMode::Lightwalletd(url) = chain_mode(cli, network)? else {
        return Err("audit reads the real chain: pass --lightwalletd-url".into());
    };
    let store = Arc::new(open_store(&cli.db, false)?);
    ensure_campaign_network(&store, &args.campaign, network)?;
    let (source, _info) = LightwalletdSource::connect(&ChainConfig::new(url, network)).await?;
    let reconciled = run_audit(
        &store,
        args,
        &source,
        Options::default().required_depth,
        &mut std::io::stdin(),
        &mut std::io::stdout(),
    )
    .await?;
    // A completed audit that found differences is not a failure of the tool: exit code 2.
    Ok(if reconciled {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

/// The NEAR Intents client. The API key comes from the environment only, and is taken out of it
/// as soon as it is read.
fn near_gateway(base_url: Option<&str>) -> Arc<dyn NearGateway> {
    let jwt = drop_near::Jwt::from_env();
    std::env::remove_var(drop_near::client::JWT_ENV_VAR);
    let mut client = drop_near::OneClick::new(drop_near::UreqClient::default(), jwt);
    if let Some(url) = base_url {
        client = client.with_base_url(url);
    }
    Arc::new(client)
}

/// The engine of the shielded deposit addresses (docs/ADR/0006-shielded-inbox.md): checks zcash-devtool, takes the inbox
/// directory's lock for the life of the process, and tidies what a crash left behind.
async fn start_inboxes(
    inbox: &InboxConfig,
    url: &str,
    network: Network,
    state_dir: &Path,
    state: &AppState,
) -> Result<Arc<Inboxes>, Box<dyn Error>> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let server = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_owned();
    let devtool = Devtool::new(inbox.devtool.clone(), server, network);
    devtool.check_patched().await?;
    let root = inbox_root(state_dir, state.seed());
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(root.join(".lock"))?;
    lock.try_lock()
        .map_err(|_| "another operator is already using these shielded deposit addresses")?;
    let chain = LightwalletdSource::connect_lazy(&ChainConfig::new(url.to_owned(), network))?;
    let backend = DevtoolInbox::new(devtool, root, network, chain);
    backend.tidy();
    let settings = InboxSettings {
        poll: inbox.poll,
        delay_min: inbox.delay_min,
        delay_max: inbox.delay_max,
        ..InboxSettings::default()
    };
    Ok(Arc::new(Inboxes::new(
        Arc::new(backend),
        settings,
        Some(lock),
    )))
}

async fn serve_operator(cli: Cli, confirm: Option<&str>) -> Result<ExitCode, Box<dyn Error>> {
    let config = Config::from_cli(cli, confirm)?;
    let store = Arc::new(open_store(&config.db, true)?);
    let mock = config.chain == ChainMode::Mock;
    let seed = wallet_seed(config.seed_file.as_deref(), mock, &store)?;
    let logger = Logger::stderr();

    let (backend, codec): (Arc<dyn ChainBackend>, Arc<dyn AddressCodec + Send + Sync>) =
        match &config.chain {
            ChainMode::Mock => (
                Arc::new(MockBackend::new(MockChain::new(config.mock.clone()))),
                Arc::new(LooseAddressCodec),
            ),
            ChainMode::Lightwalletd(url) => {
                let chain_config = ChainConfig::new(url.clone(), config.network);
                // The connector owns a runtime of its own, so it is built off the async threads.
                let (connector, info) = tokio::task::spawn_blocking(move || {
                    LightwalletdConnector::connect(chain_config)
                })
                .await??;
                logger.info(format_args!(
                    "connected to the {} chain (tip {}, branch {:08x})",
                    config.network, info.tip_height, info.consensus_branch_id
                ));
                // Mainnet is real money: the backend only learns it may run mainnet campaigns here,
                // after `Config::from_cli` has checked the flag and the confirmation.
                let zcash = ZcashBackend::new(connector);
                let zcash = match config.network {
                    Network::Mainnet => zcash.allow_mainnet(MainnetPermit::after_operator_gate()),
                    Network::Testnet => zcash,
                };
                (
                    Arc::new(zcash),
                    Arc::new(ZcashAddressCodec::new(zcash_network(config.network))),
                )
            }
        };

    let state_dir = resolve_state_dir(
        config.state_dir.as_deref(),
        std::env::var(STATE_DIR_ENV).ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )?;
    let state = AppState::new(AppParts {
        network: config.network,
        pool: Pool::Ironwood,
        store,
        codec,
        backend,
        seed,
        accounts: Arc::new(FileAccounts::new(state_dir.clone())),
        token: Token::generate()?,
        logger: logger.clone(),
        options: Options {
            required_depth: config.required_depth,
            poll_interval: config.poll_interval,
            crash_after_steps: config.crash_after_steps,
            mainnet_max_funding_zat: config.mainnet_max_funding_zat,
            ..Options::default()
        },
        near: NearParts {
            gateway: near_gateway(config.near_base_url.as_deref()),
            clock: Arc::new(SystemClock),
            allow_mainnet: config.allow_mainnet,
        },
    });

    // The shielded deposit addresses: refused unless zcash-devtool carries ZecDrop's patch and no other operator drives them.
    if let (Some(inbox), ChainMode::Lightwalletd(url)) = (&config.inbox, &config.chain) {
        let inboxes = start_inboxes(inbox, url, config.network, &state_dir, &state).await?;
        state.attach_inboxes(inboxes);
        logger.info(format_args!(
            "shielded deposit addresses: on (zcash-devtool checked)"
        ));
    }

    let listener = TcpListener::bind(config.bind).await?;
    // The link is printed only once everything that can fail before serving has passed: the
    // store (every row is read and authenticated) and, on a real chain, the connection above.
    // A damaged store ends here with an error and no link.
    let checked = state.verify_store()?;
    logger.info(format_args!("store checked: {checked} campaign(s)"));
    println!(
        "{}",
        startup_banner(listener.local_addr()?, state.token(), config.network, mock)
    );
    let resumed = state.resume_started()?;
    if resumed > 0 {
        logger.info(format_args!(
            "resumed {resumed} interrupted run(s) from the ledger"
        ));
    }
    if !mock {
        state.spawn_funding_poller(config.funding_poll_interval);
    }
    if let Some(inboxes) = state.inboxes() {
        inboxes.spawn(state.clone());
    }

    serve(listener, state, Some(config.web_dir), async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(ExitCode::SUCCESS)
}

async fn run(cli: Cli) -> Result<ExitCode, Box<dyn Error>> {
    let confirm = std::env::var(CONFIRM_MAINNET_ENV).ok();
    match cli.command.clone() {
        None => serve_operator(cli, confirm.as_deref()).await,
        Some(Command::InitWallet) => init_wallet(&cli, confirm.as_deref()),
        Some(Command::Audit(args)) => audit(&cli, &args, confirm.as_deref()).await,
        Some(Command::ExportUfvk(args)) => export_ufvk(&cli, &args, confirm.as_deref()),
        Some(Command::Payslips(args)) => payslips(&cli, &args, confirm.as_deref()).await,
        Some(Command::VerifyPayslip(args)) => verify_payslip(&cli, &args).await,
        Some(Command::AuditTx(args)) => audit_tx(&cli, &args, confirm.as_deref()),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
