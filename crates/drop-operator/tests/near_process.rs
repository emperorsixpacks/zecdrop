//! The real `drop-operator` binary talking to a stand-in NEAR service over a real socket: that
//! `--near-base-url` is honoured, that the API key (from the environment only) is sent but never
//! comes back out, and that a bad URL stops the start-up before any link is printed.
//!
//! The stand-in is on 127.0.0.1 and answers from recorded fixtures. Nothing reaches the internet.

#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::near::{serve, Script, USDC};
use common::*;

const SENTINEL_JWT: &str = "SENTINEL-JWT-eyJhbGciOiJIUzI1NiJ9.c2VjcmV0.c2ln";

struct Served {
    child: Child,
    port: u16,
    token: String,
    stderr: Arc<Mutex<String>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start(dir: &Path, near_url: &str, jwt: Option<&str>) -> Served {
    let mut command = Command::new(env!("CARGO_BIN_EXE_drop-operator"));
    command
        .env("ZECDROP_PASSPHRASE", PASSPHRASE)
        .env_remove("ZECDROP_CONFIRM_MAINNET")
        .env_remove("NEAR_INTENTS_JWT")
        .args(["--mock-chain", "--bind", "127.0.0.1:0", "--db"])
        .arg(dir.join("operator.sqlite"))
        .arg("--state-dir")
        .arg(dir.join("state"))
        .args(["--near-base-url", near_url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(jwt) = jwt {
        command.env("NEAR_INTENTS_JWT", jwt);
    }
    let mut child = command.spawn().unwrap();
    let stderr = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&stderr);
    let mut err = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(n) = err.read(&mut buffer) {
            if n == 0 {
                break;
            }
            sink.lock()
                .unwrap()
                .push_str(&String::from_utf8_lossy(&buffer[..n]));
        }
    });
    let mut served = Served {
        child,
        port: 0,
        token: String::new(),
        stderr,
    };
    let mut lines = BufReader::new(served.child.stdout.take().unwrap()).lines();
    while let Some(Ok(line)) = lines.next() {
        if let Some(url) = line.trim().strip_prefix("open:") {
            let url = url.trim().strip_prefix("http://").unwrap();
            let (address, token) = url.split_once("/#token=").unwrap();
            served.port = address.rsplit_once(':').unwrap().1.parse().unwrap();
            served.token = token.to_owned();
            std::thread::spawn(move || for _ in lines {});
            return served;
        }
    }
    panic!(
        "the operator did not start: {}",
        served.stderr.lock().unwrap()
    );
}

impl Served {
    fn request(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n",
            self.port, self.token
        );
        if let Some(body) = body {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ));
        }
        request.push_str("\r\n");
        request.push_str(body.unwrap_or(""));
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = String::new();
        let _ = stream.read_to_string(&mut raw);
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap();
        (status, body.to_owned())
    }
}

// covers: REQ-FUND-001
#[test]
fn the_operator_talks_to_the_service_it_is_pointed_at_and_sends_no_key_it_was_not_given() {
    let dir = tempfile::tempdir().unwrap();
    let (url, seen) = serve(Script::default());
    let served = start(dir.path(), &url, None);

    let (status, body) = served.request("GET", "/api/near/tokens", None);
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(USDC));

    let (status, body) = served.request(
        "POST",
        "/api/near/preview",
        Some(&format!(
            r#"{{"origin_asset_id":"{USDC}","amount_zat":545000}}"#
        )),
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"preview\":true"));

    let seen = seen.lock().unwrap().clone();
    let routes: Vec<(&str, &str)> = seen
        .iter()
        .map(|(m, p, _, _)| (m.as_str(), p.as_str()))
        .collect();
    assert_eq!(routes, vec![("GET", "/v0/tokens"), ("POST", "/v0/quote")]);
    assert!(
        seen.iter().all(|(_, _, auth, _)| auth.is_none()),
        "no key was given, none is sent"
    );
    assert!(
        seen[1].3.contains("\"dry\":true"),
        "the only quote asked for is a dry one"
    );
    assert!(!seen
        .iter()
        .any(|(_, _, _, body)| body.contains("\"dry\":false")));
}

// covers: REQ-FUND-001, REQ-PRIV-002
#[test]
fn the_api_key_is_sent_to_the_service_and_never_comes_back_out() {
    let dir = tempfile::tempdir().unwrap();
    // A service that refuses and, as some do, repeats the credentials it was shown.
    let (url, seen) = serve(Script {
        fail_with: Some((400, "go away".into())),
        ..Script::default()
    });
    let served = start(dir.path(), &url, Some(SENTINEL_JWT));

    let mut answers = Vec::new();
    answers.push(served.request("GET", "/api/near/tokens", None));
    answers.push(served.request(
        "POST",
        "/api/near/preview",
        Some(&format!(
            r#"{{"origin_asset_id":"{USDC}","amount_zat":545000}}"#
        )),
    ));
    for (status, body) in &answers {
        assert_eq!(*status, 502, "{body}");
        assert!(body.contains("near_rejected"), "{body}");
        assert!(
            !body.contains("SENTINEL"),
            "the key is not in a response: {body}"
        );
        assert!(
            !body.contains("go away"),
            "nor is the service's own text: {body}"
        );
    }
    // It did reach the service, as a bearer credential.
    let seen = seen.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(seen
        .iter()
        .all(|(_, _, auth, _)| auth.as_deref() == Some(&format!("Bearer {SENTINEL_JWT}"))));

    // And it is nowhere in the operator's log.
    std::thread::sleep(Duration::from_millis(300));
    let log = served.stderr.lock().unwrap().clone();
    assert!(
        !log.contains("SENTINEL") && !log.contains("eyJhbGci"),
        "{log}"
    );
    assert!(
        log.contains("near error: rejected"),
        "the log says what kind of failure: {log}"
    );
}

// covers: REQ-FUND-001
#[test]
fn a_near_url_that_is_not_a_plain_http_url_stops_the_start_up_before_any_link() {
    for bad in [
        "ftp://example.org",
        "not a url",
        "http://user:password@example.org",
        "",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_drop-operator"))
            .env("ZECDROP_PASSPHRASE", PASSPHRASE)
            .args(["--mock-chain", "--bind", "127.0.0.1:0", "--db"])
            .arg(dir.path().join("operator.sqlite"))
            .arg("--state-dir")
            .arg(dir.path().join("state"))
            .args(["--near-base-url", bad])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{bad:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stdout.contains("open:") && !stdout.contains("token"),
            "{bad:?}: {stdout}"
        );
        assert!(stderr.contains("--near-base-url"), "{bad:?}: {stderr}");
        assert!(
            !stderr.contains("password"),
            "{bad:?}: the credentials are not repeated: {stderr}"
        );
    }
}
