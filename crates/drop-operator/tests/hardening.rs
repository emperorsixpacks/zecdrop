//! Limits and hardening of the operator's HTTP surface: the batch-size cap, the Host check
//! against DNS rebinding, what the static server will and will not serve, and the headers
//! every response carries.

mod common;

use std::path::{Path, PathBuf};

use axum::http::{Method, StatusCode};
use common::zcash::*;
use common::*;
use drop_zcash::MAX_IRONWOOD_ACTIONS_PER_TX;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// The batch-size cap
// ---------------------------------------------------------------------------

fn create_request(max_outputs: Value) -> Value {
    let mut body = create_body();
    body["max_outputs_per_batch"] = max_outputs;
    body
}

// covers: REQ-PLAN-001
#[tokio::test]
async fn a_batch_larger_than_one_transaction_can_hold_is_refused_before_anything_is_stored() {
    let limit = MAX_IRONWOOD_ACTIONS_PER_TX;
    assert_eq!(limit, 330, "ZIP-218 (NU7)");
    let node = SharedNode::default();
    for h in [Harness::new(), real_harness(&node, 3)] {
        for too_big in [json!(limit + 1), json!(1_000), json!(u64::MAX)] {
            let reply = h
                .post("/api/campaigns", create_request(too_big.clone()))
                .await;
            assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{too_big}");
            let error = &reply.json()["error"];
            assert_eq!(error["code"], "batch_size_too_large");
            let message = error["message"].as_str().unwrap();
            assert!(message.contains("330"), "{message}");
            assert!(
                !reply.text().contains(&SENTINEL_ADDRS[0][..8]),
                "no recipient data in the refusal"
            );
        }
        assert!(
            h.get("/api/campaigns")
                .await
                .json()
                .as_array()
                .unwrap()
                .is_empty(),
            "nothing was stored"
        );
    }
}

// covers: REQ-PLAN-001
#[tokio::test]
async fn a_batch_at_the_limit_is_accepted() {
    let h = Harness::new();
    let reply = h
        .post(
            "/api/campaigns",
            create_request(json!(MAX_IRONWOOD_ACTIONS_PER_TX)),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    assert_eq!(
        reply.json()["max_outputs_per_batch"],
        MAX_IRONWOOD_ACTIONS_PER_TX
    );
}

// ---------------------------------------------------------------------------
// The Host header (DNS rebinding)
// ---------------------------------------------------------------------------

async fn with_host(h: &Harness, method: Method, path: &str, host: &str) -> Reply {
    h.call_with(method, path, Auth::Token, None, &[("host", host)])
        .await
}

// covers: REQ-OPS-002
#[tokio::test]
async fn a_request_for_another_name_is_refused_on_every_route() {
    let web = web_dir();
    let h = Builder {
        web_dir: Some(web.path().to_owned()),
        ..Builder::default()
    }
    .build();
    let (id, _) = h.create().await;
    let paths = [
        "/api/health".to_owned(),
        "/api/campaigns".to_owned(),
        format!("/api/campaigns/{id}"),
        format!("/api/campaigns/{id}/events"),
        "/api/nothing-here".to_owned(),
        "/".to_owned(),
        "/assets/app.js".to_owned(),
        "/not/a/file".to_owned(),
    ];
    for host in [
        "evil.example",
        "evil.example:8787",
        "127.0.0.1:9999",
        "localhost:9999",
        "localhost.evil.example:8787",
        "127.0.0.1.evil.example:8787",
        "0.0.0.0:8787",
        "[::]:8787",
        "127.0.0.1",
    ] {
        for path in &paths {
            let reply = with_host(&h, Method::GET, path, host).await;
            assert_eq!(
                reply.status,
                StatusCode::MISDIRECTED_REQUEST,
                "{host} {path}"
            );
            assert_eq!(reply.json()["error"]["code"], "host_not_allowed");
            if host.contains("evil") {
                assert!(
                    !reply.text().contains("evil"),
                    "the refusal does not repeat the name it was given"
                );
            }
        }
    }
    // The same for a state-changing request: nothing happened.
    let reply = with_host(&h, Method::POST, "/api/campaigns", "evil.example:8787").await;
    assert_eq!(reply.status, StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(
        h.get("/api/campaigns")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // And the log never learns the name.
    assert!(!h.logs.lines().join("\n").contains("evil.example"));
}

// covers: REQ-OPS-002
#[tokio::test]
async fn a_request_without_a_host_is_refused() {
    let h = Harness::new();
    let reply = h
        .call_with(
            Method::GET,
            "/api/health",
            Auth::Token,
            None,
            &[("host", "")],
        )
        .await;
    assert_eq!(reply.status, StatusCode::MISDIRECTED_REQUEST);
}

// covers: REQ-OPS-002
#[tokio::test]
async fn without_a_host_header_the_request_target_must_name_the_server() {
    // HTTP/2 and absolute-form requests carry the authority in the target, not in a header.
    let h = Harness::new();
    let ok = h
        .call_with(
            Method::GET,
            "http://127.0.0.1:8787/api/health",
            Auth::Token,
            None,
            &[("host", "")],
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    for target in [
        "http://evil.example:8787/api/health",
        "http://127.0.0.1:9999/api/health",
        "http://evil.example/api/health",
    ] {
        let reply = h
            .call_with(Method::GET, target, Auth::Token, None, &[("host", "")])
            .await;
        assert_eq!(reply.status, StatusCode::MISDIRECTED_REQUEST, "{target}");
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn the_names_a_person_types_still_work() {
    let h = Harness::new();
    for host in [
        "127.0.0.1:8787",
        "localhost:8787",
        "LocalHost:8787",
        "[::1]:8787",
    ] {
        let reply = with_host(&h, Method::GET, "/api/health", host).await;
        assert_eq!(reply.status, StatusCode::OK, "{host}");
        assert_eq!(reply.json()["ok"], true);
    }
    // The refusal is about the name, not the token: a wrong token is still a 401 for a good name.
    let reply = h
        .call_with(Method::GET, "/api/campaigns", Auth::Wrong, None, &[])
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// Headers on every response
// ---------------------------------------------------------------------------

fn assert_secure_headers(label: &str, reply: &Reply) {
    let header = |name: &str| {
        reply
            .headers
            .get(name)
            .unwrap_or_else(|| panic!("{label}: no {name} header"))
            .to_str()
            .unwrap()
            .to_owned()
    };
    let csp = header("content-security-policy");
    for directive in [
        "default-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'none'",
    ] {
        assert!(csp.contains(directive), "{label}: {csp}");
    }
    assert_eq!(header("x-content-type-options"), "nosniff", "{label}");
    assert_eq!(header("referrer-policy"), "no-referrer", "{label}");
    assert_eq!(header("cache-control"), "no-store", "{label}");
}

// covers: REQ-OPS-002
#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let web = web_dir();
    let h = Builder {
        web_dir: Some(web.path().to_owned()),
        ..Builder::default()
    }
    .build();
    let (id, _) = h.create().await;
    let replies = [
        ("api ok", h.get("/api/health").await),
        ("api json", h.get(&format!("/api/campaigns/{id}")).await),
        ("api 404", h.get("/api/campaigns/c-000000000000").await),
        (
            "api 401",
            h.call_with(Method::GET, "/api/campaigns", Auth::None, None, &[])
                .await,
        ),
        ("static index", h.get("/").await),
        ("static file", h.get("/assets/app.js").await),
        ("static spa route", h.get("/some/route").await),
        ("static refused", h.get("/.env").await),
        (
            "host refused",
            with_host(&h, Method::GET, "/", "evil.example").await,
        ),
    ];
    for (label, reply) in &replies {
        assert_secure_headers(label, reply);
    }
}

// ---------------------------------------------------------------------------
// The static server
// ---------------------------------------------------------------------------

const INDEX: &str = "<!doctype html><title>INDEX-PAGE</title>";
const SECRET_MARKERS: [&str; 5] = [
    "SECRET_ENV_VALUE",
    "SECRET_GIT_CONFIG",
    "SECRET_HIDDEN",
    "OUTSIDE_SECRET",
    "SECRET_NESTED",
];

/// A web directory as a build would leave it, plus things that must not be served.
struct Web {
    _root: tempfile::TempDir,
    web: PathBuf,
}

impl Web {
    fn path(&self) -> &Path {
        &self.web
    }
}

fn web_dir() -> Web {
    let root = tempfile::tempdir().unwrap();
    let web = root.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::create_dir_all(web.join(".git")).unwrap();
    std::fs::create_dir_all(web.join("sub/.cache")).unwrap();
    std::fs::write(web.join("index.html"), INDEX).unwrap();
    std::fs::write(web.join("assets/app.js"), "console.log('app')").unwrap();
    std::fs::write(web.join(".env"), "SECRET_ENV_VALUE=hunter2").unwrap();
    std::fs::write(web.join(".git/config"), "SECRET_GIT_CONFIG").unwrap();
    std::fs::write(web.join("assets/.hidden"), "SECRET_HIDDEN").unwrap();
    std::fs::write(web.join("sub/.cache/x"), "SECRET_NESTED").unwrap();
    // Outside the web directory, reachable only through links or traversal.
    std::fs::create_dir_all(root.path().join("outside")).unwrap();
    std::fs::write(root.path().join("outside/secret.txt"), "OUTSIDE_SECRET").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(root.path().join("outside/secret.txt"), web.join("link-out")).unwrap();
        symlink(root.path().join("outside"), web.join("dir-out")).unwrap();
        symlink("../outside/secret.txt", web.join("relative-out")).unwrap();
        symlink("assets/app.js", web.join("link-in")).unwrap();
        symlink("assets", web.join("assets-link")).unwrap();
    }
    Web { _root: root, web }
}

fn serving(web: &Web) -> Harness {
    Builder {
        web_dir: Some(web.path().to_owned()),
        ..Builder::default()
    }
    .build()
}

fn assert_no_secret(label: &str, reply: &Reply) {
    let text = reply.text();
    for marker in SECRET_MARKERS {
        assert!(!text.contains(marker), "{label} served {marker}");
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn the_web_app_is_served_and_unknown_routes_fall_back_to_its_index() {
    let web = web_dir();
    let h = serving(&web);
    let index = h.get("/").await;
    assert_eq!(index.status, StatusCode::OK);
    assert_eq!(index.text(), INDEX);
    let script = h.get("/assets/app.js").await;
    assert_eq!(script.status, StatusCode::OK);
    assert_eq!(script.text(), "console.log('app')");
    // A client-side route has no file: the single-page app answers it.
    let route = h.get("/campaigns/c-1/receipt").await;
    assert_eq!(route.status, StatusCode::OK);
    assert_eq!(route.text(), INDEX);
    // A link that stays inside the directory is fine.
    #[cfg(unix)]
    {
        assert_eq!(h.get("/link-in").await.text(), "console.log('app')");
        assert_eq!(
            h.get("/assets-link/app.js").await.text(),
            "console.log('app')"
        );
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn dotfiles_are_never_served() {
    let web = web_dir();
    let h = serving(&web);
    for path in [
        "/.env",
        "/.git/config",
        "/.git",
        "/.git/",
        "/assets/.hidden",
        "/sub/.cache/x",
        "/sub/.cache",
        "/%2eenv",
        "/%2Eenv",
        "/.%65nv",
        "/assets/%2ehidden",
        "/.env/",
        "//.env",
        "/./.env",
        "/assets/./.hidden",
    ] {
        let reply = h.get(path).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        assert_no_secret(path, &reply);
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn nothing_outside_the_web_directory_is_served_by_any_spelling() {
    let web = web_dir();
    let h = serving(&web);
    for path in [
        "/../outside/secret.txt",
        "/assets/../../outside/secret.txt",
        "/%2e%2e/outside/secret.txt",
        "/..%2foutside%2fsecret.txt",
        "/%2e%2e%2foutside%2fsecret.txt",
        "/assets/%2e%2e/%2e%2e/outside/secret.txt",
        "/%252e%252e/outside/secret.txt",
        "/..%5coutside%5csecret.txt",
        "/assets%5c..%5c..%5coutside%5csecret.txt",
        "/%00",
        "/assets/%00.js",
        "/%ff",
        "/%",
        "/%zz",
    ] {
        let reply = h.get(path).await;
        assert_no_secret(path, &reply);
        // A name that is no file in the directory is answered by the app's index, never by
        // something else.
        assert!(
            reply.status != StatusCode::OK || reply.text() == INDEX,
            "{path} was served: {}",
            reply.text()
        );
    }
}

#[cfg(unix)]
// covers: REQ-OPS-002
#[tokio::test]
async fn a_symbolic_link_out_of_the_web_directory_is_not_followed() {
    let web = web_dir();
    let h = serving(&web);
    for path in [
        "/link-out",
        "/relative-out",
        "/dir-out",
        "/dir-out/",
        "/dir-out/secret.txt",
        "/dir-out/../outside/secret.txt",
    ] {
        let reply = h.get(path).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        assert_no_secret(path, &reply);
    }
}

#[cfg(unix)]
// covers: REQ-OPS-002
#[tokio::test]
async fn a_web_directory_whose_index_points_outside_is_not_served_at_all() {
    let root = tempfile::tempdir().unwrap();
    let web = root.path().join("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(root.path().join("elsewhere.html"), "OUTSIDE_SECRET").unwrap();
    std::os::unix::fs::symlink(root.path().join("elsewhere.html"), web.join("index.html")).unwrap();
    let h = Builder {
        web_dir: Some(web),
        ..Builder::default()
    }
    .build();
    for path in ["/", "/index.html", "/anything"] {
        let reply = h.get(path).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        assert_no_secret(path, &reply);
    }
    // The API is unaffected.
    assert_eq!(h.get("/api/health").await.status, StatusCode::OK);
}

// covers: REQ-OPS-002
#[tokio::test]
async fn serving_the_web_source_directory_does_not_expose_its_dotfiles() {
    // `--web-dir web` is easy to type. Whatever dotfiles the repository's own web/ holds
    // (`.env`, `.env.example`, `.gitignore`, ...) are not served.
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web");
    if !web.join("index.html").is_file() {
        return;
    }
    let h = Builder {
        web_dir: Some(web.clone()),
        ..Builder::default()
    }
    .build();
    assert_eq!(h.get("/").await.status, StatusCode::OK, "web/ is served");
    let mut dotfiles: Vec<String> = std::fs::read_dir(&web)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect();
    // Names that a deployment commonly has, whether or not this checkout does.
    dotfiles.extend([".env", ".env.local", ".env.production", ".git"].map(str::to_owned));
    for name in dotfiles {
        let reply = h.get(&format!("/{name}")).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "/{name} was served");
    }
}

// covers: REQ-OPS-002
#[tokio::test]
async fn the_api_is_not_shadowed_by_the_static_server() {
    let web = web_dir();
    let h = serving(&web);
    assert_eq!(h.get("/api/health").await.json()["ok"], true);
    let missing = h.get("/api/not-a-route").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json()["error"]["code"], "not_found");
    // Only GET and HEAD reach files.
    let reply = h.post_empty("/assets/app.js").await;
    assert_ne!(reply.status, StatusCode::OK);
}
