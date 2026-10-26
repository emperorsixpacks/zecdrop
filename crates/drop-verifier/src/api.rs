//! The HTTP surface of the hosted verifier.
//!
//! | Route | Purpose |
//! |-------|---------|
//! | `GET /v1/health` | `{"ok":true}` |
//! | `GET /v1/receipt?...` | a [`drop_core::PublicReceipt`] computed from chain data |
//! | `POST /v1/payslip` | checks one recipient's payslip (REQ-VER-006): a JSON body of at most 1 KiB |
//!
//! Stateless: nothing is stored between requests. No keys: viewing-key-shaped input
//! is refused before anything else (REQ-VER-002). Errors and logs carry fixed text,
//! route templates and counts; caller-supplied text is never echoed.
//!
//! A payslip is a bearer document that names a receiver and an amount, and whose `rseed` also
//! opens one output's memo. It therefore travels in a POST body (never in a URL, which proxies
//! log), is never logged or echoed, and the answer carries only what is public about the
//! transaction (REQ-VER-006).
//!
//! Load limits (receipt and payslip routes, which share them; `/v1/health` bypasses them):
//! * at most `max_concurrency` receipts are worked on at once and `max_queue` wait; any more
//!   are refused at once with 503 `overloaded` (load shedding);
//! * the request timeout sits OUTSIDE the limiter, so time spent waiting counts too (504);
//! * at most `max_lookups` chain lookups per request (422 `too_many_lookups`).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use drop_core::{Network, PublicReceipt, Txid};
use drop_verify::payslip::NOT_PROVEN;
use drop_verify::{
    check_payslip, verify_campaign, ChainSource, CheckError, FetchedTx, Payslip, PayslipError,
    SourceError, VerifyConfig, VerifyError, VerifyRequest,
};
use serde_json::json;
use tokio::sync::Semaphore;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;

use crate::config::Settings;
use crate::log::Logger;
use crate::query::{self, QueryError};

/// The chain sources, one per network that is configured.
pub struct Sources<S> {
    /// The testnet source, if configured.
    pub testnet: Option<S>,
    /// The mainnet source, if configured.
    pub mainnet: Option<S>,
}

/// Everything the handlers share.
pub struct VerifierState<S> {
    /// Chain access.
    pub sources: Sources<S>,
    /// Limits and judgement settings.
    pub settings: Settings,
    /// Where log lines go.
    pub logger: Logger,
}

/// An error response: `{"error": {"code", "message"}}`.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
        }
    }

    /// The HTTP status.
    pub fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

impl From<QueryError> for ApiError {
    fn from(error: QueryError) -> Self {
        let bad = |code, message: String| ApiError::new(StatusCode::BAD_REQUEST, code, message);
        match error {
            QueryError::ViewingKey => bad(
                "viewing_key_refused",
                "This service never accepts viewing keys. Remove it from the request.".to_owned(),
            ),
            QueryError::TooLong => bad("query_too_long", "the query string is too long".to_owned()),
            QueryError::UnknownParameter => bad(
                "unknown_parameter",
                "the request has a parameter this service does not accept".to_owned(),
            ),
            QueryError::DuplicateParameter(name) => bad(
                "duplicate_parameter",
                format!("parameter `{name}` may appear only once"),
            ),
            QueryError::Missing(name) => bad(
                "missing_parameter",
                format!("parameter `{name}` is required"),
            ),
            QueryError::Invalid(name) => bad(
                "invalid_parameter",
                format!("parameter `{name}` is not valid"),
            ),
            QueryError::TooManyTxids { max } => bad(
                "too_many_transactions",
                format!("at most {max} transactions per request"),
            ),
        }
    }
}

impl From<VerifyError> for ApiError {
    fn from(error: VerifyError) -> Self {
        match error {
            VerifyError::Source(SourceError::Unavailable) => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "chain_unavailable",
                "the chain data source is unavailable; try again shortly",
            ),
            VerifyError::Source(SourceError::Inconsistent) => ApiError::new(
                StatusCode::BAD_GATEWAY,
                "chain_inconsistent",
                "the chain data source returned inconsistent data",
            ),
            VerifyError::NoTransactions | VerifyError::DuplicateTxid | VerifyError::ZeroDepth => {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "the request cannot be verified",
                )
            }
            VerifyError::Receipt(_) => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "the receipt could not be assembled",
            ),
        }
    }
}

/// Builds the router.
pub fn build_router<S>(state: Arc<VerifierState<S>>) -> Router
where
    S: ChainSource + Send + Sync + 'static,
{
    let settings = state.settings.clone();
    let logger = state.logger.clone();

    // The limiter guards the receipt and payslip routes (one budget for both), so health checks
    // are never queued.
    let limiter = Limiter::new(settings.max_concurrency, settings.max_queue);
    let receipt_route = get(receipt::<S>).layer(middleware::from_fn_with_state(
        limiter.clone(),
        limit_receipts,
    ));
    let payslip_route =
        post(payslip::<S>).layer(middleware::from_fn_with_state(limiter, limit_receipts));
    // CORS applies to those two routes only, and only when origins are configured.
    let receipt_route = match cors_layer(&settings.cors_origins, &[Method::GET], &[]) {
        Some(cors) => receipt_route.layer(cors),
        None => receipt_route,
    };
    let payslip_route = match cors_layer(
        &settings.cors_origins,
        &[Method::POST],
        &[axum::http::header::CONTENT_TYPE],
    ) {
        Some(cors) => payslip_route.layer(cors),
        None => payslip_route,
    };
    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/receipt", receipt_route)
        .route("/v1/payslip", payslip_route);

    let header = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::overriding(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        )
    };
    router
        .fallback(not_found)
        .with_state(state)
        .layer(header("x-content-type-options", "nosniff"))
        .layer(header("referrer-policy", "no-referrer"))
        .layer(header("cache-control", "no-store"))
        // Router-level, so it wraps the receipt route's limiter: queue time counts.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            settings.request_timeout,
        ))
        .layer(middleware::from_fn_with_state(logger, log_requests))
}

/// Admission (running + queued) and work (running) permits for the receipt route.
#[derive(Clone)]
struct Limiter {
    admission: Arc<Semaphore>,
    work: Arc<Semaphore>,
}

impl Limiter {
    fn new(max_concurrency: usize, max_queue: usize) -> Self {
        Limiter {
            admission: Arc::new(Semaphore::new(max_concurrency.saturating_add(max_queue))),
            work: Arc::new(Semaphore::new(max_concurrency)),
        }
    }
}

fn overloaded() -> Response {
    let mut response = ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "overloaded",
        "too many requests in progress; try again shortly",
    )
    .into_response();
    response
        .headers_mut()
        .insert("retry-after", HeaderValue::from_static("1"));
    response
}

/// Sheds load when the queue is full; otherwise waits for a work slot (bounded by the
/// router-level timeout, which wraps this).
async fn limit_receipts(State(limiter): State<Limiter>, request: Request, next: Next) -> Response {
    let Ok(_admitted) = Arc::clone(&limiter.admission).try_acquire_owned() else {
        return overloaded();
    };
    let Ok(_working) = Arc::clone(&limiter.work).acquire_owned().await else {
        return overloaded();
    };
    next.run(request).await
}

/// A chain source that allows at most a fixed number of transaction lookups for one request,
/// so a request naming transactions with many inputs cannot fan out without bound.
struct Budgeted<'a, S> {
    inner: &'a S,
    remaining: AtomicUsize,
    exhausted: AtomicBool,
}

impl<'a, S> Budgeted<'a, S> {
    fn new(inner: &'a S, lookups: usize) -> Self {
        Budgeted {
            inner,
            remaining: AtomicUsize::new(lookups),
            exhausted: AtomicBool::new(false),
        }
    }
}

impl<S: ChainSource + Sync> ChainSource for Budgeted<'_, S> {
    async fn transaction(&self, txid: &Txid) -> Result<Option<FetchedTx>, SourceError> {
        let took = self
            .remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |r| r.checked_sub(1));
        if took.is_err() {
            self.exhausted.store(true, Ordering::SeqCst);
            return Err(SourceError::Unavailable);
        }
        self.inner.transaction(txid).await
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        self.inner.tip_height().await
    }
}

fn cors_layer(origins: &[String], methods: &[Method], headers: &[HeaderName]) -> Option<CorsLayer> {
    if origins.is_empty() {
        return None;
    }
    let allow = if origins.iter().any(|o| o == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()))
    };
    Some(
        CorsLayer::new()
            .allow_origin(allow)
            .allow_methods(methods.to_vec())
            .allow_headers(headers.to_vec())
            .max_age(std::time::Duration::from_secs(600)),
    )
}

/// Logs method, route template and status. Never the path, query or headers.
async fn log_requests(State(logger): State<Logger>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let route = match request.extensions().get::<MatchedPath>() {
        Some(matched) => matched.as_str().to_owned(),
        None => "<unmatched>".to_owned(),
    };
    let response = next.run(request).await;
    logger.info(format_args!(
        "{method} {route} -> {}",
        response.status().as_u16()
    ));
    response
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "no such route")
}

async fn receipt<S>(
    State(state): State<Arc<VerifierState<S>>>,
    uri: Uri,
) -> Result<Json<PublicReceipt>, ApiError>
where
    S: ChainSource + Send + Sync + 'static,
{
    let parsed = match query::parse(uri.query(), state.settings.max_txids) {
        Ok(parsed) => parsed,
        Err(error) => {
            // Only the kind of refusal is logged, never the input.
            let kind = match error {
                QueryError::ViewingKey => "viewing-key-shaped input refused",
                _ => "query refused",
            };
            state.logger.warn(format_args!("{kind}"));
            return Err(error.into());
        }
    };

    let source = match parsed.network {
        Network::Testnet => state.sources.testnet.as_ref(),
        Network::Mainnet => state.sources.mainnet.as_ref(),
    }
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "network_not_configured",
            "this verifier is not configured for that network",
        )
    })?;

    let request = VerifyRequest {
        network: parsed.network,
        txids: parsed.txids,
        manifest_commitment: parsed.commitment,
        declared_total: parsed.declared_total,
        campaign_id: parsed.campaign,
    };
    let config = VerifyConfig {
        required_depth: state.settings.required_depth,
        expected_pool: state.settings.expected_pool,
    };
    let budgeted = Budgeted::new(source, state.settings.max_lookups);
    let result = verify_campaign(&budgeted, &request, &config).await;
    if result.is_err() && budgeted.exhausted.load(Ordering::SeqCst) {
        state.logger.warn(format_args!(
            "receipt refused network={} txids={} lookup budget exhausted",
            request.network,
            request.txids.len()
        ));
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "too_many_lookups",
            format!(
                "verifying this request needs more than {} chain lookups (transactions plus their funding transactions); request fewer transactions at a time",
                state.settings.max_lookups
            ),
        ));
    }
    match &result {
        Ok(receipt) => state.logger.info(format_args!(
            "receipt network={} txids={} findings={}",
            request.network,
            request.txids.len(),
            receipt.findings.len()
        )),
        Err(_) => state.logger.warn(format_args!(
            "receipt failed network={} txids={}",
            request.network,
            request.txids.len()
        )),
    }
    Ok(Json(result?))
}

/// The largest payslip body accepted: a payslip is about 300 bytes.
const MAX_PAYSLIP_BODY: usize = 1024;

/// The words for a payslip that does not verify: fixed codes, not the payslip's contents.
fn invalid_reason(error: PayslipError) -> &'static str {
    match error {
        PayslipError::UnsupportedVersion => "unsupported_version",
        PayslipError::TxUnparseable => "tx_unparseable",
        PayslipError::TxidMismatch => "txid_mismatch",
        PayslipError::NoIronwoodBundle => "no_ironwood_outputs",
        PayslipError::ActionOutOfRange => "no_such_action",
        PayslipError::MalformedNote => "malformed_note",
        PayslipError::CommitmentMismatch => "does_not_match",
    }
}

/// `POST /v1/payslip`: runs the key-less payslip check (REQ-PAY-001) against the chain and
/// reports the verdict, the confirmations and what a verified payslip does not prove. The
/// request body is never logged or echoed.
async fn payslip<S>(
    State(state): State<Arc<VerifierState<S>>>,
    request: Request,
) -> Result<Json<serde_json::Value>, ApiError>
where
    S: ChainSource + Send + Sync + 'static,
{
    let bytes = axum::body::to_bytes(request.into_body(), MAX_PAYSLIP_BODY)
        .await
        .map_err(|_| {
            state
                .logger
                .warn(format_args!("payslip refused: body too large"));
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "a payslip is at most 1 KiB",
            )
        })?;
    if query::looks_like_a_viewing_key(&String::from_utf8_lossy(&bytes)) {
        state
            .logger
            .warn(format_args!("viewing-key-shaped input refused"));
        return Err(QueryError::ViewingKey.into());
    }
    // serde's own words would quote the body; ours do not.
    let payslip: Payslip = serde_json::from_slice(&bytes).map_err(|_| {
        state
            .logger
            .warn(format_args!("payslip refused: not a payslip"));
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_payslip",
            "the body is not a payslip this service reads",
        )
    })?;

    let source = match payslip.network {
        Network::Testnet => state.sources.testnet.as_ref(),
        Network::Mainnet => state.sources.mainnet.as_ref(),
    }
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "network_not_configured",
            "this verifier is not configured for that network",
        )
    })?;

    // One lookup: the payslip's own transaction.
    let budgeted = Budgeted::new(source, 1);
    let required_depth = state.settings.required_depth;
    let (verdict, reason, confirmations, actions) =
        match check_payslip(&budgeted, &payslip, required_depth).await {
            Ok(check) => (
                if check.is_final {
                    "verified"
                } else {
                    "pending"
                },
                None,
                Some(check.confirmations),
                Some(check.proof.ironwood_actions),
            ),
            Err(CheckError::NotFound) => ("not_found", None, None, None),
            Err(CheckError::Payslip(error)) => ("invalid", Some(invalid_reason(error)), None, None),
            Err(CheckError::Source(SourceError::Unavailable)) => {
                state.logger.warn(format_args!(
                    "payslip failed network={} chain unavailable",
                    payslip.network
                ));
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "chain_unavailable",
                    "the chain data source is unavailable; try again shortly",
                ));
            }
            Err(CheckError::Source(SourceError::Inconsistent)) => {
                return Err(ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "chain_inconsistent",
                    "the chain data source returned inconsistent data",
                ));
            }
            Err(CheckError::ZeroDepth) => {
                return Err(ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "the payslip could not be checked",
                ));
            }
        };
    // Network and verdict only: nothing of the payslip.
    state.logger.info(format_args!(
        "payslip network={} verdict={verdict}",
        payslip.network
    ));
    Ok(Json(json!({
        "network": payslip.network,
        "txid": payslip.txid,
        "action": payslip.action,
        "verdict": verdict,
        "reason": reason,
        "confirmations": confirmations,
        "required_depth": required_depth,
        "ironwood_actions": actions,
        "not_proven": NOT_PROVEN,
    })))
}
