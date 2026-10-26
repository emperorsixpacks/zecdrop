//! The HTTP API end to end, in process: real encrypted store, real engine, mock chain.

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use drop_core::{PublicReceipt, Txid};
use drop_operator::mock::MockConfig;
use drop_operator::state::RunState;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;

const PROTECTED_ROUTES: [(&str, &str); 11] = [
    ("GET", "/api/campaigns"),
    ("POST", "/api/campaigns"),
    ("GET", "/api/campaigns/c-000000000000"),
    ("GET", "/api/campaigns/c-000000000000/receipt"),
    ("POST", "/api/campaigns/c-000000000000/fund-observed"),
    ("POST", "/api/campaigns/c-000000000000/start"),
    ("GET", "/api/campaigns/c-000000000000/events"),
    ("POST", "/api/campaigns/c-000000000000/check-funding"),
    ("GET", "/api/campaigns/c-000000000000/audit-ufvk-export"),
    ("GET", "/api/campaigns/c-000000000000/payslips"),
    ("POST", "/api/campaigns/c-000000000000/inbox/return"),
];

fn method(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).unwrap()
}

// ---------------------------------------------------------------------------
// REQ-OPS-002: token and loopback
// ---------------------------------------------------------------------------

// covers: REQ-OPS-002
#[tokio::test]
async fn health_needs_no_token_and_reveals_only_ok_network_and_mock_mode() {
    let h = Harness::new();
    let reply = h.call(Method::GET, "/api/health", Auth::None, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    // Exact equality is the guard: no other key may ever appear on the unauthenticated route.
    // The test harness runs on the mock chain, so the UI can show its "nothing is sent" banner.
    assert_eq!(
        reply.json(),
        json!({ "ok": true, "network": "testnet", "mock": true })
    );
}

// covers: REQ-OPS-002
#[tokio::test]
async fn every_other_api_route_refuses_requests_without_the_token() {
    let h = Harness::new();
    for (verb, path) in PROTECTED_ROUTES {
        let body = (verb == "POST").then(|| json!({}));
        let reply = h.call(method(verb), path, Auth::None, body).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{verb} {path}");
        assert_eq!(reply.json()["error"]["code"], "unauthorized");
        assert_eq!(reply.headers["www-authenticate"], "Bearer");
    }
    // Unknown API paths are not a way around it either.
    let reply = h.call(Method::GET, "/api/nope", Auth::None, None).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let reply = h.call(Method::GET, "/api/nope", Auth::Token, None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

// covers: REQ-OPS-002
#[tokio::test]
async fn a_wrong_token_is_refused_everywhere() {
    let h = Harness::new();
    for (verb, path) in PROTECTED_ROUTES {
        let body = (verb == "POST").then(|| json!({}));
        let reply = h.call(method(verb), path, Auth::Wrong, body).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{verb} {path}");
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn the_right_token_is_accepted() {
    let h = Harness::new();
    let reply = h.get("/api/campaigns").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json(), json!([]));
}

// covers: REQ-OPS-002
#[tokio::test]
async fn a_token_in_the_query_string_is_not_accepted() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    let h = Harness::new();
    for query in [
        format!("?token={TOKEN}"),
        format!("?access_token={TOKEN}"),
        format!("?authorization=Bearer%20{TOKEN}"),
        format!("?Bearer={TOKEN}"),
    ] {
        let response = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .header("host", BOUND)
                    .uri(format!("/api/campaigns{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{query}");
    }
    // Wrong scheme or malformed header values do not count either.
    for value in [
        TOKEN.to_owned(),
        format!("Basic {TOKEN}"),
        format!("Token {TOKEN}"),
        format!("Bearer  {TOKEN}"),
    ] {
        let response = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .header("host", BOUND)
                    .uri("/api/campaigns")
                    .header("authorization", value.clone())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{value}");
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn the_server_binds_loopback_and_enforces_the_token_over_a_real_socket() {
    let h = Harness::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    assert!(addr.ip().is_loopback());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(drop_operator::serve::serve(
        listener,
        h.state.clone(),
        None,
        async {
            let _ = stopped.await;
        },
    ));

    let fetch = move |path: String, auth: Option<&'static str>| {
        tokio::task::spawn_blocking(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            let auth_line = auth
                .map(|t| format!("Authorization: Bearer {t}\r\n"))
                .unwrap_or_default();
            write!(
                stream,
                "GET {path} HTTP/1.1\r\nHost: {addr}\r\n{auth_line}Connection: close\r\n\r\n"
            )
            .unwrap();
            let mut text = String::new();
            stream.read_to_string(&mut text).unwrap();
            text
        })
    };
    let health = fetch("/api/health".to_owned(), None).await.unwrap();
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    assert!(
        health.contains(r#"{"network":"testnet","ok":true}"#) || health.contains(r#""ok":true"#)
    );

    let refused = fetch("/api/campaigns".to_owned(), None).await.unwrap();
    assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");
    let in_query = fetch(format!("/api/campaigns?token={TOKEN}"), None)
        .await
        .unwrap();
    assert!(in_query.starts_with("HTTP/1.1 401"), "{in_query}");
    let allowed = fetch("/api/campaigns".to_owned(), Some(TOKEN))
        .await
        .unwrap();
    assert!(allowed.starts_with("HTTP/1.1 200"), "{allowed}");

    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

// covers: REQ-OPS-002
#[tokio::test]
async fn neither_the_token_nor_the_query_string_ever_reaches_the_log() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    let h = Harness::new();
    h.get("/api/campaigns").await;
    h.call(Method::GET, "/api/campaigns", Auth::Wrong, None)
        .await;
    let _ = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .header("host", BOUND)
                .uri(format!("/api/campaigns?token={TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let lines = h.logs.lines();
    assert!(
        lines
            .iter()
            .any(|l| l.contains("GET /api/campaigns -> 200")),
        "{lines:?}"
    );
    assert!(lines.iter().any(|l| l.contains("-> 401")), "{lines:?}");
    let joined = lines.join("\n");
    assert!(!joined.contains(TOKEN), "{joined}");
    assert!(!joined.contains("token="), "{joined}");
    assert!(!joined.contains("wrong"), "{joined}");
}

// covers: REQ-PRIV-002
#[tokio::test]
async fn logs_hold_route_templates_never_client_supplied_paths() {
    let h = Harness::new();
    h.get("/api/campaigns/c-ffffffffffff").await;
    h.get(&format!("/api/campaigns/{}", SENTINEL_ADDRS[0]))
        .await;
    h.get("/api/no/such/route/zzz-unique-marker").await;
    h.call(
        Method::GET,
        "/some/web/route/zzz-web-marker",
        Auth::None,
        None,
    )
    .await;
    let logs = h.logs.lines().join("\n");
    assert!(logs.contains("GET /api/campaigns/{id} -> 404"), "{logs}");
    assert!(logs.contains("/api/<unmatched>"), "{logs}");
    assert!(logs.contains("<web>"), "{logs}");
    for leaked in [
        "c-ffffffffffff",
        "sentinel",
        "zzz-unique-marker",
        "zzz-web-marker",
    ] {
        assert!(!logs.contains(leaked), "{leaked} in {logs}");
    }
}

// ---------------------------------------------------------------------------
// Creating and reading campaigns
// ---------------------------------------------------------------------------

// covers: REQ-PRIV-003, REQ-PLAN-001
#[tokio::test]
async fn creating_a_campaign_plans_commits_and_reports_funding_needs() {
    let h = Harness::new();
    let (id, view) = h.create().await;

    assert_eq!(view["name"], "Spring drop");
    assert_eq!(view["network"], "testnet");
    assert_eq!(view["pool"], "ironwood");
    assert_eq!(view["recipient_count"], 5);
    assert_eq!(view["batch_count"], 2);
    assert_eq!(view["phase"]["phase"], "awaiting_funding");
    assert_eq!(view["phase_label"], "Waiting for funds");
    assert_eq!(view["declared_total"], "2575546811");
    // 3 outputs: (3 + 1) * 5000; 2 outputs: (2 + 1) * 5000.
    assert_eq!(view["fee_total"], "35000");
    assert_eq!(view["funding_required"], "2575581811");
    assert_eq!(
        view["fee_policy"],
        json!({ "marginal_fee": 5000, "grace_actions": 2 })
    );
    assert_eq!(view["batches"][0]["recipients"], 3);
    assert_eq!(view["batches"][0]["total"], "1575645599");
    assert_eq!(view["batches"][0]["fee"], "20000");
    assert_eq!(view["batches"][1]["recipients"], 2);
    assert_eq!(view["batches"][1]["state"], "planned");
    assert!(view["batches"][1]["txid"].is_null());
    assert_eq!(view["run"], json!({ "state": "idle" }));
    assert!(view["funding"].is_null());

    // The batch of two is flagged for review (REQ-PRIV-003), with counts only.
    let warnings = view["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert_eq!(warnings[0]["code"], "two_recipient_batch");
    assert_eq!(warnings[0]["batch_index"], 1);
    assert!(warnings[0]["message"].as_str().unwrap().contains("Batch 1"));

    // The commitment is the stored manifest's, and the salt is fresh per campaign.
    let record = h.state.store().load_campaign(&id).unwrap().unwrap();
    assert_eq!(
        view["manifest_commitment"],
        record.manifest.commitment().to_string()
    );
    let (_, second) = h.create().await;
    assert_ne!(view["manifest_commitment"], second["manifest_commitment"]);

    // No recipient rows anywhere in the response.
    let object = view.as_object().unwrap();
    for key in [
        "rows",
        "recipients_list",
        "manifest",
        "salt",
        "addresses",
        "memos",
    ] {
        assert!(!object.contains_key(key), "{key}");
    }
}

// covers: REQ-PRIV-002
#[tokio::test]
async fn no_response_contains_recipient_addresses_amounts_or_memos() {
    let h = Harness::new();
    let needles = recipient_needles();
    let (id, view) = h.create().await;
    assert_clean("create", &view.to_string(), &needles);

    assert_eq!(h.fund(&id, &view).await.status, StatusCode::OK);
    h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Settled);

    for path in [
        "/api/campaigns".to_owned(),
        format!("/api/campaigns/{id}"),
        format!("/api/campaigns/{id}/receipt"),
        format!("/api/campaigns/{id}/events"),
        "/api/health".to_owned(),
    ] {
        let reply = h.get(&path).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert_clean(&path, &reply.text(), &needles);
    }
    let joined_logs = h.logs.lines().join("\n");
    assert_clean("logs", &joined_logs, &needles);
}

// covers: REQ-PRIV-002
#[tokio::test]
async fn errors_never_echo_the_request() {
    let h = Harness::new();
    let needles = recipient_needles();
    let secret_addr = SENTINEL_ADDRS[0];

    let mut replies = Vec::new();
    // Invalid rows: a bad amount, a bad address, a duplicate and a long memo.
    let csv = format!(
        "address,amount,memo\n{secret_addr},not-{},sentinel memo alpha\n{secret_addr}!bad,1,x\n{},1,\n{},1,\n",
        SENTINEL_ZEC[0], SENTINEL_ADDRS[1], SENTINEL_ADDRS[1]
    );
    replies.push(
        h.post(
            "/api/campaigns",
            json!({ "name": "n", "csv": csv, "max_outputs_per_batch": 3, "fee_policy": "zip317_text" }),
        )
        .await,
    );
    // A body that is not JSON, a wrong type that carries sentinel text, an unknown field.
    replies.push(
        h.call(
            Method::POST,
            "/api/campaigns",
            Auth::Token,
            Some(json!("raw string")),
        )
        .await,
    );
    replies.push(
        h.post(
            "/api/campaigns",
            json!({ "name": SENTINEL_ADDRS[2], "csv": 5, "max_outputs_per_batch": SENTINEL_ZEC[1], "fee_policy": SENTINEL_MEMOS[0] }),
        )
        .await,
    );
    replies.push(
        h.post(
            "/api/campaigns",
            json!({ "name": "n", "csv": sentinel_csv(), "max_outputs_per_batch": 3, "fee_policy": "zip317_text", SENTINEL_ADDRS[3]: 1 }),
        )
        .await,
    );
    // Plan failures and a bad name that is itself a sentinel.
    replies.push(
        h.post(
            "/api/campaigns",
            json!({ "name": "n", "csv": sentinel_csv(), "max_outputs_per_batch": 1, "fee_policy": "zip317_text" }),
        )
        .await,
    );
    replies.push(
        h.post(
            "/api/campaigns",
            json!({ "name": format!("{}\nmore", SENTINEL_ADDRS[4]), "csv": sentinel_csv(), "max_outputs_per_batch": 3, "fee_policy": "zip317_text" }),
        )
        .await,
    );
    // Unknown ids and malformed ids that contain sentinel text.
    replies.push(
        h.get(&format!("/api/campaigns/{}", SENTINEL_ADDRS[0]))
            .await,
    );
    replies.push(h.get("/api/campaigns/c-ffffffffffff/receipt").await);
    replies.push(
        h.post(
            &format!("/api/campaigns/{}/start", SENTINEL_ADDRS[1]),
            json!({}),
        )
        .await,
    );

    for reply in &replies {
        assert!(
            reply.status.is_client_error(),
            "{} {}",
            reply.status,
            reply.text()
        );
        let body = reply.text();
        assert_clean("error body", &body, &needles);
        assert!(
            reply.json()["error"]["code"].is_string(),
            "errors have a code: {body}"
        );
    }
    let joined_logs = h.logs.lines().join("\n");
    assert_clean("logs", &joined_logs, &needles);
    assert!(!joined_logs.contains(TOKEN));
}

// covers: REQ-IMP-001
#[tokio::test]
async fn import_problems_are_reported_by_line_without_quoting_the_data() {
    let h = Harness::new();
    let csv = format!(
        "address,amount,memo\n{},1,\n{},abc,\nnot an address!,1,\n{},1,\n",
        SENTINEL_ADDRS[0], SENTINEL_ADDRS[1], SENTINEL_ADDRS[0]
    );
    let reply = h
        .post(
            "/api/campaigns",
            json!({ "name": "n", "csv": csv, "max_outputs_per_batch": 3, "fee_policy": "zip317_text" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let error = &reply.json()["error"];
    assert_eq!(error["code"], "import_failed");
    assert_eq!(error["error_count"], 3);
    let lines: Vec<u64> = error["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["line"].as_u64().unwrap())
        .collect();
    assert_eq!(lines, vec![3, 4, 5]);
    assert_eq!(error["errors"][2]["kind"]["code"], "duplicate_address");
    assert_eq!(error["errors"][2]["kind"]["first_line"], 2);
    assert!(error["errors"][0]["message"].is_string());
    assert!(
        h.get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty(),
        "nothing stored"
    );
}

// covers: REQ-PLAN-003
#[tokio::test]
async fn plans_that_cannot_avoid_a_singleton_batch_are_refused() {
    let h = Harness::new();
    let reply = h
        .post(
            "/api/campaigns",
            json!({ "name": "n", "csv": sentinel_csv(), "max_outputs_per_batch": 1, "fee_policy": "zip317_text" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.json()["error"]["code"], "plan_failed");
    let zero = h
        .post(
            "/api/campaigns",
            json!({ "name": "n", "csv": sentinel_csv(), "max_outputs_per_batch": 0, "fee_policy": "zip317_text" }),
        )
        .await;
    assert_eq!(zero.status, StatusCode::UNPROCESSABLE_ENTITY);
}

// covers: REQ-OPS-001
#[tokio::test]
async fn transparent_recipients_are_refused_by_default() {
    let h = Harness::new();
    let csv = "address,amount\nt1sentineltransparent00000000000,1\nu1other000000000000000000000,2\nu1more0000000000000000000000,3\n";
    let reply = h
        .post(
            "/api/campaigns",
            json!({ "name": "n", "csv": csv, "max_outputs_per_batch": 3, "fee_policy": "zip317_text" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        reply.json()["error"]["errors"][0]["kind"]["reason"]["code"],
        "transparent_not_allowed"
    );
    assert!(!reply.text().contains("sentineltransparent"));
}

// covers: REQ-PLAN-002
#[tokio::test]
async fn the_fee_policy_choice_changes_the_funding_requirement() {
    let h = Harness::new();
    let mut body = create_body();
    body["fee_policy"] = json!("zebra_main");
    let reply = h.post("/api/campaigns", body).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let view = reply.json();
    assert_eq!(view["fee_total"], "7000");
    assert_eq!(
        view["fee_policy"],
        json!({ "marginal_fee": 1000, "grace_actions": 2 })
    );

    let mut bad = create_body();
    bad["fee_policy"] = json!("whatever");
    assert_eq!(
        h.post("/api/campaigns", bad).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn request_bodies_must_be_valid_json_of_the_right_shape() {
    let h = Harness::new();
    // Missing field, wrong type, unknown field.
    for body in [
        json!({ "name": "n" }),
        json!({ "name": 5, "csv": "", "max_outputs_per_batch": 3, "fee_policy": "zip317_text" }),
        json!({ "name": "n", "csv": "", "max_outputs_per_batch": 3, "fee_policy": "zip317_text", "extra": 1 }),
    ] {
        let reply = h.post("/api/campaigns", body).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text());
        assert_eq!(reply.json()["error"]["code"], "invalid_body");
    }
    // No Content-Type.
    let reply = h
        .call(Method::POST, "/api/campaigns", Auth::Token, None)
        .await;
    assert_eq!(reply.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    // Names must be sensible.
    for name in ["", "   ", "line\nbreak"] {
        let mut body = create_body();
        body["name"] = json!(name);
        assert_eq!(
            h.post("/api/campaigns", body).await.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{name:?}"
        );
    }
}

#[tokio::test]
async fn campaigns_can_be_listed_and_fetched() {
    let h = Harness::new();
    let (id, _) = h.create().await;
    let list = h.get("/api/campaigns").await.json();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id.as_str());
    assert_eq!(list[0]["batch_count"], 2);
    assert_eq!(list[0]["phase"]["phase"], "awaiting_funding");
    assert!(list[0].get("batches").is_none(), "the list is a summary");

    let one = h.get(&format!("/api/campaigns/{id}")).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.json()["id"], id.as_str());

    for bad in ["c-ffffffffffff", "x", "has%20space", "..%2f..%2fetc"] {
        let reply = h.get(&format!("/api/campaigns/{bad}")).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{bad}");
    }
}

// ---------------------------------------------------------------------------
// Funding, running, receipt, events
// ---------------------------------------------------------------------------

// covers: REQ-OPS-001
#[tokio::test]
async fn fund_observed_is_available_on_the_mock_chain_only() {
    let h = Builder {
        real_backend: true,
        ..Builder::default()
    }
    .build();
    let (id, view) = h.create().await;
    let reply = h.fund(&id, &view).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.json()["error"]["code"], "dev_only");
}

#[tokio::test]
async fn funding_is_validated_recorded_once_and_conflicts_are_reported() {
    let h = Harness::new();
    let (id, view) = h.create().await;
    let path = format!("/api/campaigns/{id}/fund-observed");
    let outpoint = format!("{}:2", "d1".repeat(32));

    let short = h
        .post(
            &path,
            json!({ "outpoint": outpoint, "amount": "2575581810" }),
        )
        .await;
    assert_eq!(short.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(short.json()["error"]["code"], "insufficient_funding");
    assert_eq!(short.json()["error"]["required"], "2575581811");

    for bad in [
        json!({ "outpoint": "nonsense", "amount": "5" }),
        json!({ "outpoint": outpoint, "amount": 5 }),
        json!({ "outpoint": outpoint }),
        json!({ "outpoint": format!("{}:4294967295", "d1".repeat(32)), "amount": view["funding_required"] }),
    ] {
        let reply = h.post(&path, bad).await;
        assert!(reply.status.is_client_error(), "{}", reply.text());
    }

    let ok = h
        .post(
            &path,
            json!({ "outpoint": outpoint, "amount": view["funding_required"] }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
    assert_eq!(ok.json()["phase"]["phase"], "funded");
    assert_eq!(ok.json()["funding"]["outpoint"], outpoint);

    let again = h
        .post(
            &path,
            json!({ "outpoint": outpoint, "amount": view["funding_required"] }),
        )
        .await;
    assert_eq!(again.status, StatusCode::OK);

    let other = h
        .post(&path, json!({ "outpoint": format!("{}:0", "e2".repeat(32)), "amount": view["funding_required"] }))
        .await;
    assert_eq!(other.status, StatusCode::CONFLICT);
    assert_eq!(other.json()["error"]["code"], "funding_conflict");
    assert_eq!(
        h.get(&format!("/api/campaigns/{id}")).await.json()["funding"]["outpoint"],
        outpoint
    );

    assert_eq!(
        h.post(
            "/api/campaigns/c-ffffffffffff/fund-observed",
            json!({ "outpoint": outpoint, "amount": "1" })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn the_receipt_and_start_wait_for_funding() {
    let h = Harness::new();
    let (id, _) = h.create().await;
    let receipt = h.get(&format!("/api/campaigns/{id}/receipt")).await;
    assert_eq!(receipt.status, StatusCode::CONFLICT);
    assert_eq!(receipt.json()["error"]["code"], "not_funded");
    let start = h.post_empty(&format!("/api/campaigns/{id}/start")).await;
    assert_eq!(start.status, StatusCode::CONFLICT);
    assert_eq!(start.json()["error"]["code"], "not_funded");
    assert_eq!(h.state.run_state(&id), RunState::Idle);
    assert!(
        h.chain.builds().is_empty(),
        "nothing is built before funding"
    );
}

// covers: REQ-RES-001, REQ-PRIV-001
#[tokio::test]
async fn a_funded_campaign_runs_to_settled_and_the_receipt_matches_the_chain() {
    let h = Harness::new();
    let (id, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Settled);

    // Each batch was built exactly once and broadcast exactly once.
    let builds = h.chain.builds();
    assert_eq!(
        builds.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
        vec![0, 1]
    );
    let mut broadcast = h.chain.broadcasts();
    let mut built: Vec<Txid> = builds.iter().map(|(_, t)| *t).collect();
    broadcast.sort();
    built.sort();
    assert_eq!(broadcast, built);

    let view = h.get(&format!("/api/campaigns/{id}")).await.json();
    assert_eq!(view["phase"]["phase"], "settled");
    assert_eq!(view["run"]["state"], "settled");
    for (i, batch) in view["batches"].as_array().unwrap().iter().enumerate() {
        assert_eq!(batch["state"], "confirmed");
        assert!(batch["confirmations"].as_u64().unwrap() >= 3);
        assert_eq!(batch["txid"], builds[i].1.to_string());
    }

    // The receipt parses as a PublicReceipt (unknown fields are rejected) and agrees.
    let reply = h.get(&format!("/api/campaigns/{id}/receipt")).await;
    assert_eq!(reply.status, StatusCode::OK);
    let receipt: PublicReceipt = serde_json::from_slice(&reply.body).unwrap();
    assert_eq!(receipt.batches.len(), 2);
    assert_eq!(
        receipt.funding_address, None,
        "the mock chain has no addresses"
    );
    assert_eq!(receipt.declared_total.as_u64(), 2_575_546_811);
    assert_eq!(receipt.fee_total.map(|f| f.as_u64()), Some(35_000));
    assert_eq!(receipt.phase, drop_core::CampaignPhase::Settled);
    assert_eq!(receipt.batches[1].txid, Some(builds[1].1));
    assert_eq!(receipt.batches[0].pool, Some(drop_core::Pool::Ironwood));
    assert_eq!(receipt.batches[0].shielded_actions, Some(3));
    assert_eq!(
        receipt.manifest_commitment.to_string(),
        view["manifest_commitment"]
    );
    assert_eq!(receipt.batches[0].funding_input.map(|o| o.vout), Some(0));
    assert_eq!(receipt.batches[1].funding_input.map(|o| o.vout), Some(1));
}

#[tokio::test]
async fn starting_twice_while_running_starts_one_engine() {
    let h = Builder {
        mock: MockConfig {
            confirm_after_polls: 20,
            ..MockConfig::default()
        },
        ..Builder::default()
    }
    .build();
    let (id, view) = h.create().await;
    h.fund(&id, &view).await;
    let path = format!("/api/campaigns/{id}/start");
    let first = h.post_empty(&path).await;
    let second = h.post_empty(&path).await;
    assert_eq!(first.json()["started"], true);
    assert_eq!(second.status, StatusCode::ACCEPTED);
    assert_eq!(second.json()["started"], false);
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Settled);
    assert_eq!(
        h.chain.builds().len(),
        2,
        "one engine, two batches, two builds"
    );
}

// covers: REQ-RES-001
#[tokio::test]
async fn transient_chain_errors_are_retried_and_the_batch_is_not_rebuilt() {
    let h = Builder {
        mock: MockConfig {
            transient_broadcast_failures: 2,
            ..MockConfig::default()
        },
        ..Builder::default()
    }
    .build();
    let (id, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Settled);
    assert_eq!(h.chain.builds().len(), 2);
    assert_eq!(h.chain.broadcasts().len(), 2);
    let logs = h.logs.lines().join("\n");
    assert!(logs.contains("step failed"), "retries are logged: {logs}");
    assert!(h.get(&format!("/api/campaigns/{id}")).await.json()["phase"]["phase"] == "settled");
}

// covers: REQ-RES-001
#[tokio::test]
async fn a_run_that_keeps_failing_stalls_and_can_be_restarted() {
    let h = Builder {
        mock: MockConfig {
            transient_broadcast_failures: 100,
            ..MockConfig::default()
        },
        ..Builder::default()
    }
    .build();
    let (id, end) = h.run_to_end().await;
    match end {
        RunState::Stalled { error } => assert!(error.contains("unreachable"), "{error}"),
        other => panic!("{other:?}"),
    }
    let view = h.get(&format!("/api/campaigns/{id}")).await.json();
    assert_eq!(view["run"]["state"], "stalled");
    assert_eq!(
        view["batches"][0]["state"], "built",
        "the built transaction is kept"
    );
    assert!(h.chain.broadcasts().is_empty());
}

// covers: REQ-RES-001
#[tokio::test]
async fn a_permanently_rejected_batch_halts_the_campaign_without_hiding_the_others() {
    let h = Builder {
        mock: MockConfig {
            reject_builds: vec![1],
            ..MockConfig::default()
        },
        ..Builder::default()
    }
    .build();
    let (id, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Halted);
    let view = h.get(&format!("/api/campaigns/{id}")).await.json();
    assert_eq!(view["phase"]["phase"], "failed");
    assert_eq!(view["batches"][0]["state"], "confirmed");
    assert_eq!(view["batches"][1]["state"], "failed");
    assert!(view["batches"][1]["reason"]
        .as_str()
        .unwrap()
        .contains("rejected"));
}

// covers: REQ-RES-001, REQ-PRIV-002
#[tokio::test]
async fn the_event_stream_carries_progress_without_recipient_data() {
    let h = Harness::new();
    let unauthorized = h
        .call(
            Method::GET,
            "/api/campaigns/c-000000000000/events",
            Auth::None,
            None,
        )
        .await;
    assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);

    let (id, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Settled);
    let reply = h.get(&format!("/api/campaigns/{id}/events")).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.headers["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));

    let text = reply.text();
    let events: Vec<Value> = text
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|d| serde_json::from_str(d.trim()).unwrap())
        .collect();
    assert!(
        text.lines().any(|l| l.trim() == "event: progress"),
        "{text}"
    );
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds.first(), Some(&"built"));
    assert_eq!(kinds.last(), Some(&"settled"));
    for expected in ["built", "broadcast"] {
        assert_eq!(
            kinds.iter().filter(|k| **k == expected).count(),
            2,
            "{expected}: {kinds:?}"
        );
    }
    // Confirmations are reported as they grow; each batch ends at the required depth.
    let final_depth = |batch: u64| {
        events
            .iter()
            .filter(|e| e["event"] == "confirmed" && e["batch_index"] == batch)
            .map(|e| e["depth"].as_u64().unwrap())
            .max()
    };
    assert_eq!(
        (final_depth(0), final_depth(1)),
        (Some(3), Some(3)),
        "{kinds:?}"
    );
    assert!(events.iter().all(|e| e["event"] != "failed"));
    assert_eq!(events.last().unwrap()["campaign_id"], id.as_str());
    assert_clean("events", &text, &recipient_needles());

    assert_eq!(
        h.get("/api/campaigns/c-ffffffffffff/events").await.status,
        StatusCode::NOT_FOUND
    );
}

// ---------------------------------------------------------------------------
// REQ-SEC-001 / REQ-SEC-002 through the API
// ---------------------------------------------------------------------------

// covers: REQ-SEC-001
#[tokio::test]
async fn the_seed_never_appears_in_any_response_or_log_line() {
    use base64::Engine as _;
    let seed = [0x5A; 32];
    let h = Builder {
        seed,
        ..Builder::default()
    }
    .build();

    let mut texts = vec![format!("{:?}", h.state), format!("{:?}", h.state.seed())];
    let (id, view) = h.create().await;
    texts.push(view.to_string());
    texts.push(h.fund(&id, &view).await.text());
    texts.push(
        h.post_empty(&format!("/api/campaigns/{id}/start"))
            .await
            .text(),
    );
    assert_eq!(h.state.wait_for_run(&id).await, RunState::Settled);
    for path in [
        "/api/health".to_owned(),
        "/api/campaigns".to_owned(),
        format!("/api/campaigns/{id}"),
        format!("/api/campaigns/{id}/receipt"),
        format!("/api/campaigns/{id}/events"),
        "/api/campaigns/c-ffffffffffff".to_owned(),
    ] {
        texts.push(h.get(&path).await.text());
    }
    texts.push(
        h.call(Method::GET, "/api/campaigns", Auth::None, None)
            .await
            .text(),
    );
    texts.push(h.logs.lines().join("\n"));

    let mut needles = vec![
        hex::encode(seed),
        hex::encode(seed).to_uppercase(),
        "Z".repeat(32),
        base64::engine::general_purpose::STANDARD.encode(seed),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(seed),
        "90, 90, 90".to_owned(),
    ];
    needles.push(format!("{:?}", seed.to_vec()));
    for text in &texts {
        assert_clean("output", text, &needles);
    }
    assert_eq!(texts.len(), 13);
}

// covers: REQ-SEC-002
#[tokio::test]
async fn the_database_file_never_contains_recipient_data_even_after_a_full_run() {
    let h = Harness::new();
    let (id, end) = h.run_to_end().await;
    assert_eq!(end, RunState::Settled);
    assert!(h
        .get(&format!("/api/campaigns/{id}"))
        .await
        .status
        .is_success());

    let mut bytes = std::fs::read(&h.db).unwrap();
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut sibling = h.db.as_os_str().to_owned();
        sibling.push(suffix);
        if let Ok(extra) = std::fs::read(sibling) {
            bytes.extend(extra);
        }
    }
    assert!(bytes.len() > 4096);
    let contains = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
    for needle in recipient_needles() {
        assert!(
            !contains(needle.as_bytes()),
            "{needle:?} is in the store file"
        );
    }
    assert!(!contains(&[0x5A; 32]), "the seed is not in the store file");
    assert!(!contains(b"Spring drop"), "the campaign name is encrypted");
    assert!(!contains(b"MOCKTX"), "raw transactions are encrypted");
    assert!(!contains(PASSPHRASE.as_bytes()));
    assert!(!contains(TOKEN.as_bytes()));
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// covers: REQ-OPS-002
#[tokio::test]
async fn the_web_dir_is_served_with_an_index_fallback_and_never_shadows_the_api() {
    let web = tempfile::tempdir().unwrap();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(
        web.path().join("index.html"),
        "<!doctype html><title>ui</title>",
    )
    .unwrap();
    std::fs::write(web.path().join("assets/app.js"), "console.log('ui')").unwrap();

    let h = Builder {
        web_dir: Some(web.path().to_owned()),
        ..Builder::default()
    }
    .build();
    let root = h.call(Method::GET, "/", Auth::None, None).await;
    assert_eq!(root.status, StatusCode::OK);
    assert!(root.text().contains("<title>ui</title>"));

    let asset = h
        .call(Method::GET, "/assets/app.js", Auth::None, None)
        .await;
    assert_eq!(asset.status, StatusCode::OK);
    assert_eq!(asset.text(), "console.log('ui')");

    // A client-side route falls back to the app shell.
    let route = h
        .call(Method::GET, "/campaigns/c-123/review", Auth::None, None)
        .await;
    assert_eq!(route.status, StatusCode::OK);
    assert!(route.text().contains("<title>ui</title>"));

    // The API is not shadowed: JSON health, and 401 (not the app shell) for others.
    assert_eq!(
        h.call(Method::GET, "/api/health", Auth::None, None)
            .await
            .json()["ok"],
        true
    );
    let api = h
        .call(Method::GET, "/api/campaigns", Auth::None, None)
        .await;
    assert_eq!(api.status, StatusCode::UNAUTHORIZED);
    assert!(!api.text().contains("<title>"));

    // Hardening headers on everything.
    for reply in [&root, &asset, &api] {
        assert_eq!(reply.headers["x-content-type-options"], "nosniff");
        assert_eq!(reply.headers["referrer-policy"], "no-referrer");
        assert_eq!(reply.headers["cache-control"], "no-store");
    }
}

#[tokio::test]
async fn without_a_web_dir_the_root_explains_and_the_api_still_works() {
    let h = Builder {
        web_dir: Some(h_missing_dir()),
        ..Builder::default()
    }
    .build();
    let root = h.call(Method::GET, "/", Auth::None, None).await;
    assert_eq!(root.status, StatusCode::NOT_FOUND);
    assert!(root.text().contains("--web-dir"));
    assert_eq!(h.get("/api/campaigns").await.status, StatusCode::OK);
}

fn h_missing_dir() -> std::path::PathBuf {
    std::path::PathBuf::from("/nonexistent/zecdrop-web-dir")
}

// covers: REQ-FUND-004
#[tokio::test]
async fn the_mock_chain_says_only_what_fund_observed_declares() {
    let h = Harness::new();
    for (source, byte) in [
        (Some("shielded"), "d2"),
        (Some("transparent"), "d3"),
        (None, "d4"),
    ] {
        let (id, view) = h.create().await;
        let mut body = json!({
            "outpoint": format!("{}:0", byte.repeat(32)),
            "amount": view["funding_required"],
        });
        if let Some(source) = source {
            body["source"] = json!(source);
        }
        let reply = h
            .post(&format!("/api/campaigns/{id}/fund-observed"), body)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
        let expected = source.map_or(Value::Null, |s| json!(s));
        assert_eq!(reply.json()["funding_source"], expected, "{source:?}");
        let got = h.get(&format!("/api/campaigns/{id}")).await.json();
        assert_eq!(got["funding_source"], expected, "{source:?}");
    }
    // Only the two kinds are read.
    let (id, view) = h.create().await;
    let reply = h
        .post(
            &format!("/api/campaigns/{id}/fund-observed"),
            json!({
                "outpoint": format!("{}:0", "d5".repeat(32)),
                "amount": view["funding_required"],
                "source": "mixed",
            }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text());
    assert_eq!(reply.json()["error"]["code"], "invalid_body");
    assert!(h.get(&format!("/api/campaigns/{id}")).await.json()["funding"].is_null());
    // A null source says nothing, like a missing one.
    let reply = h
        .post(
            &format!("/api/campaigns/{id}/fund-observed"),
            json!({
                "outpoint": format!("{}:0", "d6".repeat(32)),
                "amount": view["funding_required"],
                "source": null,
            }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert!(reply.json()["funding_source"].is_null());
}
