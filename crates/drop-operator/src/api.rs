//! The local HTTP API.
//!
//! Every route except `GET /api/health` requires the per-run bearer token
//! (REQ-OPS-002). Responses and errors never contain recipient addresses, amounts
//! or memos (REQ-PRIV-002): campaigns are described by counts, batch totals,
//! transaction ids, warnings and the manifest commitment only.
//!
//! There are two deliberate exceptions, and both need the request header
//! `X-Zecdrop-Confirm-Disclosure: I-UNDERSTAND` and answer with a `warning` the UI must show:
//! the viewing-key export, whose key discloses every payout to whoever holds it, and, the second,
//! the payslips of a settled campaign, which name each payout row's address, amount and memo so
//! the payer's page can give each person theirs (REQ-PAY-005).
//!
//! | Route | Purpose |
//! |-------|---------|
//! | `GET /api/health` | `{"ok":true,"network":...,"mock":bool}`; no token |
//! | `POST /api/campaigns` | import a CSV, plan, commit, store encrypted |
//! | `GET /api/campaigns` | list campaigns |
//! | `GET /api/campaigns/{id}` | one campaign: phase, batches, warnings, run state |
//! | `GET /api/campaigns/{id}/receipt` | the public receipt |
//! | `POST /api/campaigns/{id}/fund-observed` | record the funding deposit (mock chain only) |
//! | `POST /api/campaigns/{id}/check-funding` | look at the funding address now (real chain only) |
//! | `GET /api/campaigns/{id}/audit-ufvk-export` | the campaign's viewing key, for an auditor; needs the disclosure header |
//! | `GET /api/campaigns/{id}/payslips` | every payslip of a settled campaign with its row's address, amount and memo; needs the disclosure header |
//! | `POST /api/campaigns/{id}/start` | run the engine in the background |
//! | `GET /api/campaigns/{id}/events` | Server-Sent Events of engine progress |
//! | `GET /api/near/tokens` | assets a funder could pay with through NEAR Intents (never ZEC) |
//! | `POST /api/near/preview` | a dry price quote for delivering some ZEC; creates nothing |
//! | `POST /api/campaigns/{id}/funding/near/dry-quote` | mainnet campaigns: a dry quote for what the campaign needs |
//! | `POST /api/campaigns/{id}/funding/near/live-quote` | mainnet only, acknowledged: asks for a deposit address |
//! | `GET /api/campaigns/{id}/funding/near/status` | mainnet only: where the swap stands (never "funded") |
//!
//! Logs hold the method, route template and status only.
//!
//! Anything else is served from the web directory (with `index.html` as the
//! fallback for client-side routes). The token reaches the UI in the URL
//! *fragment*, which browsers never send to the server; browsers' `EventSource`
//! cannot set headers, so the UI reads the event stream with `fetch`.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::extract::{DefaultBodyLimit, MatchedPath, Path, Request, State};
use axum::http::HeaderMap;
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use drop_core::{
    derive_phase, import_csv_str, plan_batches, privacy_warnings, CampaignId, CampaignPhase,
    FeePolicy, FundingSource, FundingState, ImportOptions, Ledger, Manifest, ManifestCommitment,
    Network, OutPoint, Pool, PrivacyWarning, PublicReceipt, ReceiptInputs, RowError, Salt, Txid,
    Zatoshi,
};
use drop_verify::payslip::Payslip;
use drop_zcash::MAX_IRONWOOD_ACTIONS_PER_TX;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::api_near;
use crate::auth::require_token;
use crate::chain::FundingLayout;
use crate::commands::{campaign_ufvk, DISCLOSURE_WARNING, PAYSLIPS_WARNING};
use crate::crypto::random_bytes;
use crate::error::StoreError;
use crate::events;
use crate::funding::{funding_plan, fundings_for, FundingPlan, FundingShortfall};
use crate::guard::{guard_static, require_loopback_host, StaticRoot, CONTENT_SECURITY_POLICY};
use crate::http::{ApiError, ApiJson};
use crate::logging::Logger;
use crate::payslips::{issue_stored_payslips, row_number, Issued, PayslipsError};
use crate::state::{
    needs_funding_split, AppState, FundingProgress, PollOutcome, RunState, StartOutcome,
};
use crate::store::{CampaignRecord, FundingObserved, FundingOutcome, NewCampaign};

/// Largest accepted request body: a maximal CSV plus JSON escaping overhead.
const MAX_BODY_BYTES: usize = 40 * 1024 * 1024;

/// How many row errors a failed import reports in full.
const MAX_REPORTED_ROW_ERRORS: usize = 200;

/// Builds the router. `web_dir`, if it holds a web UI, is served for non-API paths.
/// `bound` is the address the server listens on: requests are answered only if their `Host`
/// names it by a loopback name (see [`crate::guard`]).
pub fn build_router(state: AppState, web_dir: Option<PathBuf>, bound: SocketAddr) -> Router {
    let token = std::sync::Arc::clone(state.token());
    let logger = state.logger().clone();

    let protected = Router::new()
        .route(
            "/campaigns",
            get(list_campaigns)
                .post(create_campaign)
                .layer(DefaultBodyLimit::max(MAX_BODY_BYTES)),
        )
        .route("/campaigns/{id}", get(get_campaign))
        .route("/campaigns/{id}/receipt", get(get_receipt))
        .route("/campaigns/{id}/fund-observed", post(fund_observed))
        .route("/campaigns/{id}/check-funding", post(check_funding))
        .route("/campaigns/{id}/audit-ufvk-export", get(export_ufvk))
        .route("/campaigns/{id}/payslips", get(export_payslips))
        .route("/near/tokens", get(api_near::near_tokens))
        .route(
            "/near/preview",
            post(api_near::near_preview).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/campaigns/{id}/funding/near/dry-quote",
            post(api_near::near_dry_quote).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/campaigns/{id}/funding/near/live-quote",
            post(api_near::near_live_quote),
        )
        .route(
            "/campaigns/{id}/funding/near/status",
            get(api_near::near_status),
        )
        .route("/campaigns/{id}/start", post(start_campaign))
        .route("/campaigns/{id}/events", get(campaign_events))
        .fallback(api_not_found)
        .layer(middleware::from_fn_with_state(token, require_token));

    let api = Router::new()
        .route("/health", get(health))
        .merge(protected)
        .with_state(state);

    let app = Router::new().nest("/api", api);
    let app = match web_dir.as_deref().and_then(StaticRoot::new) {
        Some(root) => {
            let files =
                ServeDir::new(root.path()).fallback(ServeFile::new(root.path().join("index.html")));
            // The guard sits in front of the files: no dotfiles, nothing outside the directory.
            let guarded =
                Router::new()
                    .fallback_service(files)
                    .layer(middleware::from_fn_with_state(
                        std::sync::Arc::new(root),
                        guard_static,
                    ));
            app.fallback_service(guarded)
        }
        None => app.fallback(web_ui_missing),
    };

    let header = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::overriding(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        )
    };
    // Innermost first: the Host check, then the request log, then the headers every response
    // gets, a refusal included.
    app.layer(middleware::from_fn_with_state(
        bound.port(),
        require_loopback_host,
    ))
    .layer(middleware::from_fn_with_state(logger, log_requests))
    .layer(header("x-content-type-options", "nosniff"))
    .layer(header("referrer-policy", "no-referrer"))
    .layer(header("cache-control", "no-store"))
    .layer(header("content-security-policy", CONTENT_SECURITY_POLICY))
}

/// Logs one line per request: method, the matched route template and status.
///
/// The raw path and query string are never logged: a client controls them, and a
/// mistaken request must not be able to put an address, an amount or a token into
/// the log.
async fn log_requests(State(logger): State<Logger>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let route = match request.extensions().get::<MatchedPath>() {
        Some(matched) => matched.as_str().to_owned(),
        None if request.uri().path().starts_with("/api") => "/api/<unmatched>".to_owned(),
        None => "<web>".to_owned(),
    };
    let response = next.run(request).await;
    logger.info(format_args!(
        "{method} {route} -> {}",
        response.status().as_u16()
    ));
    response
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("route")
}

async fn web_ui_missing() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        "The web UI was not found. Build it and pass --web-dir, or use the JSON API under /api.",
    )
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "network": state.network(), "mock": state.backend().is_mock() }))
}

// ---------------------------------------------------------------------------
// Views (none of these carry recipient data)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct BatchView {
    index: u32,
    recipients: u32,
    total: Zatoshi,
    fee: Zatoshi,
    funding_required: Zatoshi,
    state: &'static str,
    txid: Option<Txid>,
    confirmations: u32,
    reason: Option<String>,
}

#[derive(Serialize)]
struct FundingView {
    outpoint: OutPoint,
    amount: Zatoshi,
}

#[derive(Serialize)]
struct WarningView {
    #[serde(flatten)]
    warning: PrivacyWarning,
    message: String,
}

#[derive(Serialize)]
struct CampaignView {
    id: CampaignId,
    name: String,
    network: Network,
    pool: Pool,
    created_at: u64,
    phase: CampaignPhase,
    phase_label: String,
    recipient_count: u32,
    batch_count: u32,
    max_outputs_per_batch: usize,
    fee_policy: FeePolicy,
    declared_total: Zatoshi,
    fee_total: Zatoshi,
    funding_required: Zatoshi,
    manifest_commitment: ManifestCommitment,
    /// Whether the wallet in use is the one this campaign was created with. When it is not,
    /// no funding address is shown and the campaign cannot be run.
    wallet_matches: bool,
    funding_address: Option<String>,
    funding: Option<FundingView>,
    funding_progress: Option<FundingProgress>,
    /// What the deposit (recorded, or still short of the depth) spent, once it is known
    /// (REQ-FUND-004). Never a reason to refuse anything.
    funding_source: Option<FundingSource>,
    /// The payout's shielded deposit address and what it holds (REQ-FUND-008), when the operator has them; read from
    /// memory only.
    inbox: Option<crate::inbox::engine::InboxView>,
    batches: Vec<BatchView>,
    warnings: Vec<WarningView>,
    run: RunState,
}

#[derive(Serialize)]
struct CampaignSummary {
    id: CampaignId,
    name: String,
    network: Network,
    pool: Pool,
    created_at: u64,
    phase: CampaignPhase,
    phase_label: String,
    recipient_count: u32,
    batch_count: u32,
    declared_total: Zatoshi,
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

pub(crate) fn load(state: &AppState, id: &str) -> Result<CampaignRecord, ApiError> {
    let id = CampaignId::new(id).map_err(|_| ApiError::not_found("campaign"))?;
    state
        .store()
        .load_campaign(&id)
        .map_err(|e| state.internal(&e))?
        .ok_or_else(|| ApiError::not_found("campaign"))
}

fn view(state: &AppState, record: &CampaignRecord) -> Result<CampaignView, ApiError> {
    let batches = state.plan(record)?;
    let plan = funding_plan(&batches, &record.fee_policy).map_err(|e| state.internal(&e))?;
    let statuses = state
        .store()
        .ledger()
        .statuses(&record.id, count(batches.len()))
        .map_err(|e| state.internal(&e))?;
    let funding_state = if record.funding.is_some() {
        FundingState::Funded
    } else {
        FundingState::Awaiting
    };
    let phase = derive_phase(funding_state, &statuses, state.options().required_depth);

    let batch_views = batches
        .iter()
        .zip(&statuses)
        .enumerate()
        .map(|(i, (batch, status))| BatchView {
            index: batch.index(),
            recipients: batch.output_count(),
            total: batch.total(),
            fee: plan.fees[i],
            funding_required: plan.per_batch[i],
            state: status.name(),
            txid: status.txid(),
            confirmations: match status {
                drop_core::BatchStatus::Confirmed { depth, .. } => *depth,
                _ => 0,
            },
            reason: match status {
                drop_core::BatchStatus::Failed { reason, .. } => Some(reason.clone()),
                _ => None,
            },
        })
        .collect();

    Ok(CampaignView {
        id: record.id.clone(),
        name: record.name.clone(),
        network: record.network,
        pool: record.pool,
        created_at: record.created_at,
        phase_label: phase.label(),
        phase,
        recipient_count: count(record.manifest.rows().len()),
        batch_count: count(batches.len()),
        max_outputs_per_batch: record.max_outputs_per_batch,
        fee_policy: record.fee_policy,
        declared_total: plan.declared_total,
        fee_total: plan.fee_total,
        funding_required: plan.required,
        manifest_commitment: record.commitment,
        wallet_matches: state.wallet_matches(record),
        funding_address: if state.wallet_matches(record) {
            state.funding_address(record)?
        } else {
            None
        },
        funding: record.funding.map(|f| FundingView {
            outpoint: f.outpoint,
            amount: f.amount,
        }),
        funding_progress: if record.funding.is_none() {
            state.funding_progress(&record.id)
        } else {
            None
        },
        funding_source: state.funding_source(record),
        inbox: if state.wallet_matches(record) {
            state.inboxes().and_then(|inboxes| inboxes.view(&record.id))
        } else {
            None
        },
        batches: batch_views,
        warnings: privacy_warnings(&batches)
            .into_iter()
            .map(|warning| WarningView {
                message: warning.message(),
                warning,
            })
            .collect(),
        run: state.run_state(&record.id),
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum FeePolicyName {
    Zip317Text,
    ZebraMain,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateCampaign {
    name: String,
    csv: String,
    max_outputs_per_batch: usize,
    fee_policy: FeePolicyName,
}

async fn create_campaign(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateCampaign>,
) -> Result<(StatusCode, Json<CampaignView>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(ApiError::unprocessable(
            "invalid_name",
            "the campaign name must be 1 to 100 characters without control characters",
        ));
    }
    // One batch is one transaction, and a transaction may hold only so many Ironwood actions
    // (ZIP-218): a larger plan could never be built, so it is refused before anything is stored.
    if body.max_outputs_per_batch > MAX_IRONWOOD_ACTIONS_PER_TX {
        return Err(ApiError::unprocessable(
            "batch_size_too_large",
            format!(
                "max_outputs_per_batch is {} but one transaction can pay at most \
                 {MAX_IRONWOOD_ACTIONS_PER_TX} recipients",
                body.max_outputs_per_batch
            ),
        ));
    }
    if body.csv.len() > drop_core::import::MAX_IMPORT_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "csv_too_large",
            "the CSV is too large",
        ));
    }

    let report = import_csv_str(&body.csv, state.codec(), &ImportOptions::default());
    let rows = report
        .into_result()
        .map_err(|errors| import_failed(&errors))?;
    let batches = plan_batches(&rows, body.max_outputs_per_batch)
        .map_err(|e| ApiError::unprocessable("plan_failed", e.to_string()))?;

    if state.backend().funding_layout() == FundingLayout::SingleDeposit && batches.len() > 1 {
        return Err(needs_funding_split());
    }

    let fee_policy = match body.fee_policy {
        FeePolicyName::Zip317Text => FeePolicy::zip317_text(),
        FeePolicyName::ZebraMain => FeePolicy::zebra_main(),
    };
    let plan = funding_plan(&batches, &fee_policy)
        .map_err(|e| ApiError::unprocessable("amount_too_large", e.to_string()))?;
    // Mainnet moves real money and this code has not been audited: a campaign above the cap is
    // refused before anything is stored (REQ-OPS-003). The message carries totals only.
    let cap = state.options().mainnet_max_funding_zat;
    if state.network() == Network::Mainnet && plan.required.as_u64() > cap {
        let zec = |zat: u64| {
            Zatoshi::new(zat).map_or_else(
                |_| format!("{zat} zat"),
                |z| format!("{} ZEC", z.format_zec()),
            )
        };
        return Err(ApiError::unprocessable(
            "mainnet_cap_exceeded",
            format!(
                "this operator caps a mainnet campaign at {} of funding and this one needs {}; \
                 raise the cap with --mainnet-max-funding-zat (in zatoshi) only if you mean to",
                zec(cap),
                zec(plan.required.as_u64())
            ),
        ));
    }

    let seed_fingerprint = state.seed().fingerprint();
    let mut id_bytes = [0u8; 6];
    random_bytes(&mut id_bytes).map_err(|e| state.internal(&e))?;
    let id =
        CampaignId::new(&format!("c-{}", hex::encode(id_bytes))).map_err(|e| state.internal(&e))?;
    let salt = Salt::generate().map_err(|e| state.internal(&e))?;
    let manifest = Manifest::new(id.clone(), salt, rows).map_err(|e| state.internal(&e))?;

    state
        .store()
        .insert_campaign(
            &NewCampaign {
                id: &id,
                name,
                network: state.network(),
                pool: state.pool(),
                fee_policy,
                max_outputs_per_batch: body.max_outputs_per_batch,
                manifest: &manifest,
                seed_fingerprint: &seed_fingerprint,
            },
            state.accounts(),
        )
        .map_err(|e| match e {
            // The registry says why in fixed words; nothing in them is secret.
            StoreError::Accounts(reason) => {
                state
                    .logger()
                    .info(format_args!("account registry: {reason}"));
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "account_registry_error",
                    format!("{reason}; no campaign was created"),
                )
            }
            other => state.internal(&other),
        })?;
    state.logger().info(format_args!(
        "campaign created id={id} batches={}",
        batches.len()
    ));

    let record = load(&state, id.as_str())?;
    Ok((StatusCode::CREATED, Json(view(&state, &record)?)))
}

/// A 422 listing row errors by line and kind. Row errors never quote the input.
fn import_failed(errors: &[RowError]) -> ApiError {
    ApiError::unprocessable(
        "import_failed",
        format!(
            "the CSV has {} problem(s); fix them and try again",
            errors.len()
        ),
    )
    .with_details(json!({
        "error_count": errors.len(),
        "errors": errors.iter().take(MAX_REPORTED_ROW_ERRORS).collect::<Vec<_>>(),
    }))
}

async fn list_campaigns(
    State(state): State<AppState>,
) -> Result<Json<Vec<CampaignSummary>>, ApiError> {
    let headers = state
        .store()
        .list_campaigns()
        .map_err(|e| state.internal(&e))?;
    let mut summaries = Vec::with_capacity(headers.len());
    for header in headers {
        let record = load(&state, header.id.as_str())?;
        let full = view(&state, &record)?;
        summaries.push(CampaignSummary {
            id: full.id,
            name: full.name,
            network: full.network,
            pool: full.pool,
            created_at: full.created_at,
            phase: full.phase,
            phase_label: full.phase_label,
            recipient_count: full.recipient_count,
            batch_count: full.batch_count,
            declared_total: full.declared_total,
        });
    }
    Ok(Json(summaries))
}

async fn get_campaign(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CampaignView>, ApiError> {
    let record = load(&state, &id)?;
    Ok(Json(view(&state, &record)?))
}

/// The funding references for a funded campaign, or a 409.
fn record_fundings(
    state: &AppState,
    record: &CampaignRecord,
    plan: &FundingPlan,
) -> Result<Vec<drop_core::FundingRef>, ApiError> {
    let deposit = record
        .funding
        .ok_or_else(|| ApiError::conflict("not_funded", "record the funding deposit first"))?;
    fundings_for(state.backend().funding_layout(), &deposit, plan)
        .map_err(|shortfall| state.funding_shortfall(shortfall))
}

async fn get_receipt(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PublicReceipt>, ApiError> {
    let record = load(&state, &id)?;
    let batches = state.plan(&record)?;
    let plan = funding_plan(&batches, &record.fee_policy).map_err(|e| state.internal(&e))?;
    let fundings = record_fundings(&state, &record, &plan)?;
    let statuses = state
        .store()
        .ledger()
        .statuses(&record.id, count(batches.len()))
        .map_err(|e| state.internal(&e))?;
    // The address the batches spend from: public on the chain, and what ties this receipt to the
    // campaign. A wallet that did not make the campaign cannot say what it is.
    let funding_address = if state.wallet_matches(&record) {
        state.funding_address(&record)?
    } else {
        None
    };
    let receipt = PublicReceipt::assemble(ReceiptInputs {
        campaign_id: &record.id,
        network: record.network,
        manifest_commitment: record.commitment,
        fee_policy: &record.fee_policy,
        pool: record.pool,
        batches: &batches,
        fundings: &fundings,
        statuses: &statuses,
        funding_state: FundingState::Funded,
        required_depth: state.options().required_depth,
        funding_address: funding_address.as_deref(),
        funding_source: state.funding_source(&record),
    })
    .map_err(|e| state.internal(&e))?;
    Ok(Json(receipt))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FundObserved {
    outpoint: OutPoint,
    amount: Zatoshi,
    /// What the declared deposit spent, for showing both kinds on the mock chain; optional.
    #[serde(default)]
    source: Option<FundingSource>,
}

async fn fund_observed(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<FundObserved>,
) -> Result<Json<CampaignView>, ApiError> {
    if !state.backend().is_mock() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "dev_only",
            "funding is observed from the chain; this endpoint exists for the mock chain only",
        ));
    }
    let record = load(&state, &id)?;
    let batches = state.plan(&record)?;
    let plan = funding_plan(&batches, &record.fee_policy).map_err(|e| state.internal(&e))?;
    let deposit = FundingObserved {
        outpoint: body.outpoint,
        amount: body.amount,
    };
    match fundings_for(state.backend().funding_layout(), &deposit, &plan) {
        Ok(_) => {}
        Err(FundingShortfall::Insufficient { required }) => {
            return Err(ApiError::unprocessable(
                "insufficient_funding",
                "the deposit does not cover the declared total plus fees",
            )
            .with_details(json!({ "required": required, "observed": deposit.amount })));
        }
        Err(FundingShortfall::BadOutpoint) => {
            return Err(ApiError::unprocessable(
                "invalid_outpoint",
                "the output index is too large for this plan",
            ));
        }
        Err(FundingShortfall::NeedsSplit) => return Err(needs_funding_split()),
    }
    match state.store().record_funding(&record.id, deposit) {
        Ok(FundingOutcome::Recorded | FundingOutcome::Unchanged) => {
            if let Some(source) = body.source {
                state.declare_deposit_source(deposit.outpoint.txid, source);
            }
        }
        Ok(FundingOutcome::Conflict(existing)) => {
            return Err(ApiError::conflict(
                "funding_conflict",
                "different funding is already recorded for this campaign",
            )
            .with_details(json!({ "recorded": FundingView { outpoint: existing.outpoint, amount: existing.amount } })));
        }
        Err(StoreError::NotFound) => return Err(ApiError::not_found("campaign")),
        Err(other) => return Err(state.internal(&other)),
    }
    let record = load(&state, &id)?;
    Ok(Json(view(&state, &record)?))
}

/// Looks at the campaign's funding address now (the operator also does so on a timer).
/// Only an output seen on the chain at the required depth marks the campaign funded.
async fn check_funding(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CampaignView>, ApiError> {
    let id = CampaignId::new(&id).map_err(|_| ApiError::not_found("campaign"))?;
    if matches!(state.poll_funding(&id).await?, PollOutcome::NotApplicable) {
        return Err(ApiError::conflict(
            "not_applicable",
            "this chain backend has no funding addresses; declare the deposit with fund-observed",
        ));
    }
    let record = load(&state, id.as_str())?;
    Ok(Json(view(&state, &record)?))
}

/// The request header that must carry [`EXPORT_CONFIRMATION`] for a viewing key, or a campaign's
/// payslips, to be released.
const EXPORT_HEADER: &str = "x-zecdrop-confirm-disclosure";

/// The value acknowledging that the answer discloses payouts to whoever reads it.
const EXPORT_CONFIRMATION: &str = "I-UNDERSTAND";

/// Refuses a disclosure the request does not acknowledge with [`EXPORT_HEADER`]. The refusal
/// carries `warning`, for the UI to show the person before it asks again.
fn require_disclosure(headers: &HeaderMap, warning: &'static str) -> Result<(), ApiError> {
    let confirmed = headers
        .get(EXPORT_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == EXPORT_CONFIRMATION);
    if confirmed {
        return Ok(());
    }
    Err(ApiError::bad_request(
        "confirmation_required",
        format!("send the header `X-Zecdrop-Confirm-Disclosure: {EXPORT_CONFIRMATION}` after showing the person the warning"),
    )
    .with_details(json!({ "warning": warning })))
}

/// The campaign's viewing key for an auditor.
///
/// Releasing it is irreversible, so the contract has two halves: the request must carry
/// `X-Zecdrop-Confirm-Disclosure: I-UNDERSTAND`, and the response always carries a
/// `warning` field that the UI must show to the person before the key leaves the screen.
async fn export_ufvk(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    if state.backend().is_mock() {
        return Err(ApiError::conflict(
            "not_available",
            "the mock chain has no real viewing keys",
        ));
    }
    require_disclosure(&headers, DISCLOSURE_WARNING)?;
    let record = load(&state, &id)?;
    state.check_wallet(&record)?;
    let ufvk = campaign_ufvk(state.seed(), record.network, record.account)
        .map_err(|e| state.internal(&e))?;
    Ok(Json(json!({
        "warning": DISCLOSURE_WARNING,
        "campaign_id": record.id,
        "network": record.network,
        "ufvk": ufvk.as_str(),
    })))
}

/// What the payer's page is given: every payslip of a settled campaign.
#[derive(Serialize)]
struct PayslipsView {
    warning: &'static str,
    campaign_id: CampaignId,
    network: Network,
    /// One per payout row, in payout-list order.
    payslips: Vec<PayslipRow>,
    unmatched_outputs: usize,
}

/// One payout row as the payout list has it, and its payslip; `null` if no output the campaign's
/// key opened matches the row.
#[derive(Serialize)]
struct PayslipRow {
    /// The row's 1-based position in the payout list, as in the CLI's file names.
    number: usize,
    address: String,
    amount: Zatoshi,
    memo: Option<String>,
    payslip: Option<Payslip>,
}

/// Every payslip of a settled campaign, for the payer's own page to give each person
/// theirs (REQ-PAY-005).
///
/// The second answer that carries recipient data, after the viewing key, with the same contract:
/// the request must carry `X-Zecdrop-Confirm-Disclosure: I-UNDERSTAND`, and the response always
/// carries a `warning` field that the UI must show before any payslip leaves the screen. The
/// payslips are issued from the transaction bytes stored before broadcast, so no node is asked,
/// and only once every batch is confirmed at the required depth (409 `not_settled` before).
async fn export_payslips(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PayslipsView>, ApiError> {
    if state.backend().is_mock() {
        return Err(ApiError::conflict(
            "not_available",
            "the mock chain has no real transactions to prove",
        ));
    }
    require_disclosure(&headers, PAYSLIPS_WARNING)?;
    let record = load(&state, &id)?;
    state.check_wallet(&record)?;
    let batches = state.plan(&record)?;
    let ledger = state.store().ledger();
    let statuses = ledger
        .statuses(&record.id, count(batches.len()))
        .map_err(|e| state.internal(&e))?;
    let ufvk = campaign_ufvk(state.seed(), record.network, record.account)
        .map_err(|e| state.internal(&e))?;
    let depth = state.options().required_depth;
    // Opening the outputs and checking every payslip is CPU work.
    let (record, issued) = tokio::task::spawn_blocking(move || {
        let issued = issue_stored_payslips(&ledger, &record, &statuses, &ufvk, depth);
        (record, issued)
    })
    .await
    .map_err(|_| ApiError::internal())?;
    let issued = issued.map_err(|e| match e {
        PayslipsError::NotSettled => ApiError::conflict("not_settled", e.to_string()),
        other => state.internal(&other),
    })?;
    Ok(Json(payslips_view(&state, &record, issued)?))
}

/// Pairs each payout row with its payslip. Both are in payout-list order: the plan keeps the
/// rows' order, and the payslips follow the plan.
fn payslips_view(
    state: &AppState,
    record: &CampaignRecord,
    issued: Issued,
) -> Result<PayslipsView, ApiError> {
    let rows = record.manifest.rows();
    if issued.rows.len() != rows.len() {
        return Err(state.internal(&"the payslips do not line up with the payout list"));
    }
    let payslips = rows
        .iter()
        .zip(issued.rows)
        .enumerate()
        .map(|(index, (row, payslip))| PayslipRow {
            number: row_number(index),
            address: row.address().to_owned(),
            amount: row.amount(),
            memo: row.memo().map(str::to_owned),
            payslip,
        })
        .collect();
    Ok(PayslipsView {
        warning: PAYSLIPS_WARNING,
        campaign_id: record.id.clone(),
        network: record.network,
        payslips,
        unmatched_outputs: issued.unmatched_outputs,
    })
}

async fn start_campaign(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let id = CampaignId::new(&id).map_err(|_| ApiError::not_found("campaign"))?;
    let outcome = state.start_run(&id)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "started": outcome == StartOutcome::Started,
            "run": state.run_state(&id),
        })),
    ))
}

async fn campaign_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError>
{
    let record = load(&state, &id)?;
    let hub = state.hub(&record.id);
    Ok(Sse::new(events::stream(hub)).keep_alive(KeepAlive::default()))
}
