//! Shared test harness: a real encrypted store in a temp dir, the mock chain, and
//! the real router driven in-process.
#![allow(dead_code)]

pub mod near;
pub mod zcash;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::Router;
use drop_core::{AddressCodec, CampaignId, Network, Pool};
use drop_operator::accounts::{AccountAllocator, FileAccounts};
use drop_operator::auth::Token;
use drop_operator::chain::{
    ChainBackend, ChainError, ChainPort, FundingLayout, RunContext, UtxoSighting,
};
use drop_operator::codec::LooseAddressCodec;
use drop_operator::crypto::KdfParams;
use drop_operator::logging::{CaptureSink, Logger};
use drop_operator::mock::{MockBackend, MockChain, MockConfig};
use drop_operator::near::{Clock, NearParts};
use drop_operator::secret::SecretSeed;
use drop_operator::state::{AppParts, AppState, Options};
use drop_operator::store::Store;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

pub const PASSPHRASE: &str = "a test passphrase";
/// The address the in-process router pretends to be bound to; requests carry it as `Host`.
pub const BOUND: &str = "127.0.0.1:8787";
pub const TOKEN: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

/// A chain backend that claims not to be a mock, to exercise the dev-only guard.
pub struct NotMockBackend(pub MockChain);

impl ChainBackend for NotMockBackend {
    fn is_mock(&self) -> bool {
        false
    }

    fn funding_layout(&self) -> FundingLayout {
        FundingLayout::SplitDeposit
    }

    fn distributor(&self, run: &RunContext<'_>) -> Result<Box<dyn ChainPort>, ChainError> {
        MockBackend::new(self.0.clone()).distributor(run)
    }

    fn funding_address(
        &self,
        _seed: &SecretSeed,
        _network: Network,
        _account: u32,
    ) -> Result<Option<String>, ChainError> {
        Ok(None)
    }

    fn funding_sightings(&self, _address: &str) -> Result<Vec<UtxoSighting>, ChainError> {
        Ok(Vec::new())
    }
}

/// How requests authenticate.
#[derive(Clone, Copy, Debug)]
pub enum Auth {
    /// The right bearer token.
    Token,
    /// No credentials.
    None,
    /// A wrong bearer token.
    Wrong,
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub struct Builder {
    pub mock: MockConfig,
    pub options: Options,
    pub seed: [u8; 32],
    pub real_backend: bool,
    pub web_dir: Option<PathBuf>,
    /// A complete backend to use instead of the mock chain.
    pub backend: Option<Arc<dyn ChainBackend>>,
    /// An address codec to use instead of the shape-only one.
    pub codec: Option<Arc<dyn AddressCodec + Send + Sync>>,
    /// An account numbering to use instead of a registry in the harness's own directory.
    pub accounts: Option<Arc<dyn AccountAllocator>>,
    /// The network the operator runs on.
    pub network: Network,
    /// The stand-in for the NEAR Intents service.
    pub near: near::FakeNear,
    /// The API key the NEAR client carries, if a test wants one.
    pub jwt: Option<drop_near::Jwt>,
    /// The clock the NEAR routes read, set by hand.
    pub clock: ManualClock,
    /// Whether the operator counts as started with `--allow-mainnet`.
    pub allow_mainnet: bool,
}

/// A clock that moves only when told to. Starts at 2026-10-08 00:00:00 UTC.
#[derive(Clone)]
pub struct ManualClock(Arc<std::sync::atomic::AtomicU64>);

impl ManualClock {
    pub const START: u64 = 1_791_417_600;

    pub fn new() -> ManualClock {
        ManualClock(Arc::new(std::sync::atomic::AtomicU64::new(Self::START)))
    }

    pub fn advance(&self, secs: u64) {
        self.0.fetch_add(secs, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn now(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        ManualClock::new()
    }
}

impl Clock for ManualClock {
    fn now_secs(&self) -> u64 {
        self.now()
    }
}

impl Default for Builder {
    fn default() -> Self {
        Builder {
            mock: MockConfig::default(),
            options: Options {
                required_depth: 3,
                poll_interval: Duration::from_millis(1),
                max_consecutive_errors: 5,
                crash_after_steps: None,
            },
            seed: [0x5A; 32],
            real_backend: false,
            web_dir: None,
            backend: None,
            codec: None,
            accounts: None,
            network: Network::Testnet,
            near: near::FakeNear::new(),
            jwt: None,
            clock: ManualClock::new(),
            allow_mainnet: false,
        }
    }
}

impl Builder {
    pub fn build(self) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("operator.sqlite");
        let store = Store::create(&db, PASSPHRASE, KdfParams::TESTING).unwrap();
        let chain = MockChain::new(self.mock.clone());
        Harness::start(dir, db, Arc::new(store), chain, self)
    }
}

pub struct Harness {
    pub dir: TempDir,
    pub db: PathBuf,
    pub chain: MockChain,
    pub logs: CaptureSink,
    pub state: AppState,
    pub router: Router,
    pub seed: [u8; 32],
    pub web_dir: Option<PathBuf>,
    pub backend: Arc<dyn ChainBackend>,
    pub codec: Arc<dyn AddressCodec + Send + Sync>,
    pub accounts: Arc<dyn AccountAllocator>,
    pub network: Network,
    pub near: near::FakeNear,
    pub clock: ManualClock,
    pub allow_mainnet: bool,
}

impl Harness {
    pub fn new() -> Harness {
        Builder::default().build()
    }

    pub fn from_parts(
        dir: TempDir,
        db: PathBuf,
        store: Arc<Store>,
        chain: MockChain,
        spec: Builder,
    ) -> Harness {
        Harness::start(dir, db, store, chain, spec)
    }

    fn start(
        dir: TempDir,
        db: PathBuf,
        store: Arc<Store>,
        chain: MockChain,
        spec: Builder,
    ) -> Harness {
        let (logger, logs) = Logger::capture();
        let backend: Arc<dyn ChainBackend> = match spec.backend {
            Some(backend) => backend,
            None if spec.real_backend => Arc::new(NotMockBackend(chain.clone())),
            None => Arc::new(MockBackend::new(chain.clone())),
        };
        let codec: Arc<dyn AddressCodec + Send + Sync> =
            spec.codec.unwrap_or_else(|| Arc::new(LooseAddressCodec));
        let accounts: Arc<dyn AccountAllocator> = spec
            .accounts
            .unwrap_or_else(|| Arc::new(FileAccounts::new(dir.path().join("state"))));
        let near_parts = NearParts {
            gateway: Arc::new(drop_near::OneClick::new(spec.near.clone(), spec.jwt)),
            clock: Arc::new(spec.clock.clone()),
            allow_mainnet: spec.allow_mainnet,
        };
        let state = AppState::new(AppParts {
            network: spec.network,
            near: near_parts,
            pool: Pool::Ironwood,
            store,
            codec: Arc::clone(&codec),
            backend: Arc::clone(&backend),
            seed: SecretSeed::from_bytes(spec.seed),
            accounts: Arc::clone(&accounts),
            token: Token::from_hex(TOKEN),
            logger,
            options: spec.options,
        });
        let bound: std::net::SocketAddr = BOUND.parse().unwrap();
        let router = drop_operator::api::build_router(state.clone(), spec.web_dir.clone(), bound);
        Harness {
            dir,
            db,
            chain,
            logs,
            state,
            router,
            seed: spec.seed,
            web_dir: spec.web_dir,
            backend,
            codec,
            accounts,
            network: spec.network,
            near: spec.near,
            clock: spec.clock,
            allow_mainnet: spec.allow_mainnet,
        }
    }

    /// Simulates restarting the process: the same store file (reopened with the
    /// passphrase) and the same chain, with new options and no in-memory state.
    pub fn restart(self, options: Options) -> Harness {
        let seed = self.seed;
        self.restart_as(seed, options)
    }

    /// Like [`Harness::restart`], with the operator now holding another wallet seed.
    pub fn restart_as(self, seed: [u8; 32], options: Options) -> Harness {
        let Harness {
            dir,
            db,
            chain,
            seed: _,
            web_dir,
            state,
            router,
            backend,
            codec,
            accounts,
            network,
            near,
            clock,
            allow_mainnet,
            logs: _,
        } = self;
        drop(router);
        drop(state);
        let store = Arc::new(Store::open(&db, PASSPHRASE).unwrap());
        let spec = Builder {
            options,
            seed,
            web_dir,
            backend: Some(backend),
            codec: Some(codec),
            accounts: Some(accounts),
            network,
            near,
            clock,
            allow_mainnet,
            ..Builder::default()
        };
        Harness::start(dir, db, store, chain, spec)
    }

    pub async fn call(&self, method: Method, path: &str, auth: Auth, body: Option<Value>) -> Reply {
        self.call_with(method, path, auth, body, &[]).await
    }

    /// Like [`Harness::call`], with extra request headers. They replace the defaults, `Host`
    /// (the bound address) included; an empty value removes the header.
    pub async fn call_with(
        &self,
        method: Method,
        path: &str,
        auth: Auth,
        body: Option<Value>,
        extra: &[(&str, &str)],
    ) -> Reply {
        let request = match body {
            Some(value) => Request::builder()
                .method(method)
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(value.to_string())),
            None => Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty()),
        };
        let mut request = request.unwrap();
        let headers = request.headers_mut();
        headers.insert(header::HOST, BOUND.parse().unwrap());
        match auth {
            Auth::Token => {
                headers.insert(
                    header::AUTHORIZATION,
                    format!("Bearer {TOKEN}").parse().unwrap(),
                );
            }
            Auth::Wrong => {
                headers.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
            }
            Auth::None => {}
        }
        for (name, value) in extra {
            let name = header::HeaderName::from_bytes(name.as_bytes()).unwrap();
            if value.is_empty() {
                headers.remove(&name);
            } else {
                headers.insert(name, header::HeaderValue::from_str(value).unwrap());
            }
        }
        let response = self.router.clone().oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        Reply {
            status: parts.status,
            headers: parts.headers,
            body: body.collect().await.unwrap().to_bytes().to_vec(),
        }
    }

    pub async fn get(&self, path: &str) -> Reply {
        self.call(Method::GET, path, Auth::Token, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Reply {
        self.call(Method::POST, path, Auth::Token, Some(body)).await
    }

    pub async fn post_empty(&self, path: &str) -> Reply {
        self.call(Method::POST, path, Auth::Token, None).await
    }

    /// Creates the standard sentinel campaign and returns its id and the response.
    pub async fn create(&self) -> (CampaignId, Value) {
        let reply = self.post("/api/campaigns", create_body()).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
        let view = reply.json();
        let id = CampaignId::new(view["id"].as_str().unwrap()).unwrap();
        (id, view)
    }

    /// Records a deposit that exactly covers the campaign's funding requirement.
    pub async fn fund(&self, id: &CampaignId, view: &Value) -> Reply {
        self.post(
            &format!("/api/campaigns/{id}/fund-observed"),
            json!({
                "outpoint": format!("{}:0", "d1".repeat(32)),
                "amount": view["funding_required"],
            }),
        )
        .await
    }

    /// Creates, funds and starts a campaign; returns its id once the run has ended.
    pub async fn run_to_end(&self) -> (CampaignId, drop_operator::state::RunState) {
        let (id, view) = self.create().await;
        assert_eq!(self.fund(&id, &view).await.status, StatusCode::OK);
        let started = self.post_empty(&format!("/api/campaigns/{id}/start")).await;
        assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.text());
        let end = self.state.wait_for_run(&id).await;
        (id, end)
    }
}

// ---- the sentinel data -----------------------------------------------------

pub const SENTINEL_ADDRS: [&str; 5] = [
    "u1sentinelalpha000000000000000001",
    "u1sentinelbravo000000000000000002",
    "zs1sentinelcharlie00000000000000003",
    "u1sentineldelta000000000000000004",
    "u1sentinelecho0000000000000000005",
];
pub const SENTINEL_ZEC: [&str; 5] = [
    "12.34567891",
    "0.07777001",
    "3.33300707",
    "1.11100303",
    "8.88800909",
];
pub const SENTINEL_ZAT: [&str; 5] = [
    "1234567891",
    "7777001",
    "333300707",
    "111100303",
    "888800909",
];
pub const SENTINEL_MEMOS: [&str; 3] = [
    "sentinel memo alpha",
    "sentinel memo charlie",
    "sentinel memo echo",
];

pub fn sentinel_csv() -> String {
    let memos = [
        Some(SENTINEL_MEMOS[0]),
        None,
        Some(SENTINEL_MEMOS[1]),
        None,
        Some(SENTINEL_MEMOS[2]),
    ];
    let mut csv = String::from("address,amount,memo\n");
    for i in 0..5 {
        csv.push_str(&format!(
            "{},{},{}\n",
            SENTINEL_ADDRS[i],
            SENTINEL_ZEC[i],
            memos[i].unwrap_or("")
        ));
    }
    csv
}

pub fn create_body() -> Value {
    json!({
        "name": "Spring drop",
        "csv": sentinel_csv(),
        "max_outputs_per_batch": 3,
        "fee_policy": "zip317_text",
    })
}

/// Every string that must never appear in a response, log line or database file.
pub fn recipient_needles() -> Vec<String> {
    let mut needles: Vec<String> = Vec::new();
    needles.extend(SENTINEL_ADDRS.iter().map(|s| s.to_string()));
    needles.extend(SENTINEL_ZEC.iter().map(|s| s.to_string()));
    needles.extend(SENTINEL_ZAT.iter().map(|s| s.to_string()));
    needles.extend(SENTINEL_MEMOS.iter().map(|s| s.to_string()));
    needles.push("sentinel".to_owned());
    needles
}

pub fn assert_clean(label: &str, text: &str, needles: &[String]) {
    for needle in needles {
        assert!(
            !text.contains(needle.as_str()),
            "{label} leaked {needle:?}: {text}"
        );
    }
}
