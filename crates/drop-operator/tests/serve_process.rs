//! The real `drop-operator` binary serving on a real socket: that `main` wires the account
//! registry, the Host check against the port actually bound, and the private store file.
//!
//! The in-process tests drive the router directly; these confirm nothing was lost between
//! the router and the process.

#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use common::*;

struct Served {
    child: Child,
    port: u16,
    token: String,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Reply {
    status: u16,
    headers: String,
    body: String,
}

fn operator(passphrase: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_drop-operator"));
    command
        .env("ZECDROP_PASSPHRASE", passphrase)
        .env_remove("ZECDROP_CONFIRM_MAINNET")
        .env_remove("ZECDROP_STATE_DIR");
    command
}

/// Starts the operator on the mock chain on a port the system picks, and waits for its banner.
fn serve(dir: &Path, extra: &[&str]) -> Served {
    let child = operator(PASSPHRASE)
        .args(["--mock-chain", "--bind", "127.0.0.1:0", "--db"])
        .arg(dir.join("operator.sqlite"))
        .arg("--state-dir")
        .arg(dir.join("state"))
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // From here on the child is killed and reaped when `served` goes out of scope.
    let mut served = Served {
        child,
        port: 0,
        token: String::new(),
    };
    let mut lines = BufReader::new(served.child.stdout.take().unwrap()).lines();
    while let Some(Ok(line)) = lines.next() {
        if let Some(url) = line.trim().strip_prefix("open:") {
            let url = url.trim().strip_prefix("http://").unwrap();
            let (address, token) = url.split_once("/#token=").unwrap();
            served.port = address.rsplit_once(':').unwrap().1.parse().unwrap();
            served.token = token.to_owned();
            // Keep draining so the child never blocks on a full pipe.
            std::thread::spawn(move || for _ in lines {});
            return served;
        }
    }
    let mut err = String::new();
    let _ = served.child.stderr.take().unwrap().read_to_string(&mut err);
    panic!("the operator did not start: {err}");
}

impl Served {
    fn request(
        &self,
        method: &str,
        path: &str,
        host: Option<&str>,
        authorized: bool,
        body: Option<&str>,
    ) -> Reply {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
        if let Some(host) = host {
            request.push_str(&format!("Host: {host}\r\n"));
        }
        if authorized {
            request.push_str(&format!("Authorization: Bearer {}\r\n", self.token));
        }
        if let Some(body) = body {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ));
        }
        request.push_str("\r\n");
        if let Some(body) = body {
            request.push_str(body);
        }
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let raw = String::from_utf8_lossy(&raw).into_owned();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap();
        Reply {
            status,
            headers: head.to_ascii_lowercase(),
            body: body.to_owned(),
        }
    }

    fn create_campaign(&self) -> Reply {
        let host = format!("127.0.0.1:{}", self.port);
        self.request(
            "POST",
            "/api/campaigns",
            Some(&host),
            true,
            Some(&create_body().to_string()),
        )
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn registry_files(state: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(state)
        .map(|entries| {
            entries
                .map(|e| e.unwrap().path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("accounts-") && n.ends_with(".json"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

// covers: REQ-AUD-002, REQ-SEC-002
#[test]
fn the_running_operator_keeps_its_registry_in_the_state_dir_and_its_store_private() {
    let dir = tempfile::tempdir().unwrap();
    let served = serve(dir.path(), &[]);

    let reply = served.create_campaign();
    assert_eq!(reply.status, 201, "{}", reply.body);
    let state = dir.path().join("state");
    let files = registry_files(&state);
    assert_eq!(files.len(), 1, "{files:?}");
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert_eq!(record, serde_json::json!({ "version": 1, "highest": 0 }));
    assert_eq!(mode(&files[0]), 0o600);
    assert_eq!(mode(&state), 0o700);

    assert_eq!(served.create_campaign().status, 201);
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert_eq!(record["highest"], 1, "the second campaign took account 1");

    // The store file, and anything SQLite keeps beside it, is the owner's alone.
    let db = dir.path().join("operator.sqlite");
    assert_eq!(mode(&db), 0o600);
    for suffix in ["-journal", "-wal", "-shm"] {
        let beside = dir.path().join(format!("operator.sqlite{suffix}"));
        if beside.exists() {
            assert_eq!(mode(&beside), 0o600, "{suffix}");
        }
    }
}

// covers: REQ-OPS-002
#[test]
fn the_running_operator_answers_only_to_loopback_names_on_its_own_port() {
    let dir = tempfile::tempdir().unwrap();
    let served = serve(dir.path(), &[]);
    let port = served.port;

    for host in [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ] {
        let reply = served.request("GET", "/api/health", Some(&host), false, None);
        assert_eq!(reply.status, 200, "{host}: {}", reply.body);
        assert!(reply
            .headers
            .contains("content-security-policy: default-src 'self'"));
    }
    for host in [
        Some("evil.example".to_owned()),
        Some(format!("evil.example:{port}")),
        Some(format!("127.0.0.1:{}", port.wrapping_add(1))),
        Some("127.0.0.1:1".to_owned()),
        Some("127.0.0.1".to_owned()),
        None,
    ] {
        let reply = served.request("GET", "/api/health", host.as_deref(), false, None);
        assert_eq!(reply.status, 421, "{host:?}: {}", reply.body);
        assert!(reply.body.contains("host_not_allowed"));
        // The refusal gives a page that tricked the browser nothing, the token included.
        assert!(!reply.body.contains(&served.token));
    }
    // The token is still required for a good name.
    let host = format!("127.0.0.1:{port}");
    assert_eq!(
        served
            .request("GET", "/api/campaigns", Some(&host), false, None)
            .status,
        401
    );
}

// covers: REQ-OPS-002
#[test]
fn the_running_operator_does_not_serve_dotfiles_from_its_web_directory() {
    let dir = tempfile::tempdir().unwrap();
    let web = dir.path().join("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), "<title>INDEX</title>").unwrap();
    std::fs::write(web.join(".env"), "SECRET_ENV_VALUE=hunter2").unwrap();
    let served = serve(dir.path(), &["--web-dir", web.to_str().unwrap()]);
    let host = format!("127.0.0.1:{}", served.port);

    let index = served.request("GET", "/", Some(&host), false, None);
    assert_eq!(index.status, 200);
    assert!(index.body.contains("INDEX"));
    for path in ["/.env", "/%2eenv", "/..%2f.env"] {
        let reply = served.request("GET", path, Some(&host), false, None);
        assert!(!reply.body.contains("SECRET_ENV_VALUE"), "{path}");
        assert_ne!(reply.status, 200, "{path}");
    }
}

// covers: REQ-SEC-002
#[test]
fn a_new_store_is_refused_a_short_passphrase_and_nothing_is_created() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("new.sqlite");
    let output = operator("elevenchars")
        .args(["--db"])
        .arg(&db)
        .arg("init-wallet")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("at least 12 characters"), "{stderr}");
    assert!(
        !stderr.contains("elevenchars"),
        "the passphrase is not repeated"
    );
    assert!(!db.exists(), "no store was created");

    // Twelve characters work, and the store is private to its owner.
    let output = operator("twelve chars")
        .args(["--db"])
        .arg(&db)
        .arg("init-wallet")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(mode(&db), 0o600);
}

/// Runs the operator and waits for it to exit by itself; fails the test if it keeps running.
fn run_to_exit(dir: &Path) -> (std::process::ExitStatus, String, String) {
    let mut child = operator(PASSPHRASE)
        .args(["--mock-chain", "--bind", "127.0.0.1:0", "--db"])
        .arg(dir.join("operator.sqlite"))
        .arg("--state-dir")
        .arg(dir.join("state"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the operator did not exit: it is serving a damaged store");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let (mut out, mut err) = (String::new(), String::new());
    let _ = child.stdout.take().unwrap().read_to_string(&mut out);
    let _ = child.stderr.take().unwrap().read_to_string(&mut err);
    (status, out, err)
}

// covers: REQ-SEC-002, REQ-OPS-002
#[test]
fn a_damaged_store_ends_the_start_up_before_any_link_is_printed() {
    let dir = tempfile::tempdir().unwrap();
    {
        // A sound store with a campaign in it.
        let served = serve(dir.path(), &[]);
        assert_eq!(served.create_campaign().status, 201);
    }
    // A sound store starts, prints its link, and checks out.
    {
        let served = serve(dir.path(), &[]);
        assert!(!served.token.is_empty());
    }

    // Edited outside the operator: it refuses, says why, and never prints a link or a token.
    let db = dir.path().join("operator.sqlite");
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute("UPDATE campaigns SET account = account + 1", [])
        .unwrap();
    let (status, stdout, stderr) = run_to_exit(dir.path());
    assert!(!status.success());
    assert!(stderr.contains("tampered"), "{stderr}");
    assert!(
        !stdout.contains("open:") && !stdout.contains("token"),
        "{stdout}"
    );
    assert!(!stderr.contains("token="), "{stderr}");
}
