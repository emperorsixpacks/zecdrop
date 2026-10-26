//! Guards in front of everything the operator serves (REQ-OPS-002).
//!
//! * **Host header.** The API is loopback-only and token-protected, but a web page on another
//!   site can make a browser send requests to `127.0.0.1` under that page's own name ("DNS
//!   rebinding"), which defeats the same-origin policy. Such a request carries the attacker's
//!   name in `Host`, so the operator answers only to the names a person would type to reach it
//!   locally, with the port it is actually bound to.
//! * **Static files.** The web directory is served read-only, but only what belongs to the web
//!   app: nothing whose name starts with a dot (`.env`, `.git`), and nothing whose real path,
//!   after resolving symbolic links, is outside the directory.
//! * **Content-Security-Policy** for what the browser may do with what it was served.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::http::ApiError;

/// What the browser may load and do with the operator's pages: only its own files, no frames,
/// no plug-ins, no `<base>` rewriting.
pub const CONTENT_SECURITY_POLICY: &str =
    "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

/// The names that reach this machine's loopback interface.
const LOOPBACK_NAMES: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// Whether a `Host` header value names this server: a loopback name, with the port the server
/// is bound to (which may be left out only if that is the default HTTP port).
pub fn host_allowed(host: &str, bound_port: u16) -> bool {
    let (name, port) = if let Some(rest) = host.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return false;
        };
        (&host[..end + 2], &rest[end + 1..])
    } else {
        match host.rfind(':') {
            Some(at) => (&host[..at], &host[at..]),
            None => (host, ""),
        }
    };
    let name = name.to_ascii_lowercase();
    if !LOOPBACK_NAMES.contains(&name.as_str()) {
        return false;
    }
    match port.strip_prefix(':') {
        None if port.is_empty() => bound_port == 80,
        None => false,
        Some(digits) => {
            !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit())
                && digits.parse::<u16>().is_ok_and(|p| p == bound_port)
        }
    }
}

/// Refuses a request whose `Host` is not a loopback name with this server's port.
pub async fn require_loopback_host(
    State(bound_port): State<u16>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| request.uri().authority().map(|a| a.as_str()));
    if host.is_some_and(|h| host_allowed(h, bound_port)) {
        return next.run(request).await;
    }
    ApiError::new(
        StatusCode::MISDIRECTED_REQUEST,
        "host_not_allowed",
        "this server answers only to localhost, 127.0.0.1 and [::1] on the port it listens on",
    )
    .into_response()
}

/// The directory the web UI is served from, resolved once.
#[derive(Debug, Clone)]
pub struct StaticRoot {
    root: PathBuf,
}

impl StaticRoot {
    /// Resolves `dir`. `None` unless it holds an `index.html` that really is inside it.
    pub fn new(dir: &Path) -> Option<StaticRoot> {
        let root = dir.canonicalize().ok()?;
        let index = root.join("index.html").canonicalize().ok()?;
        (index.starts_with(&root) && index.is_file()).then_some(StaticRoot { root })
    }

    /// The resolved directory.
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Whether the file the request path names may be served. A path that names nothing is
    /// allowed (the single-page app answers it with its index).
    pub fn allows(&self, request_path: &str) -> bool {
        let Some(decoded) = percent_decode(request_path) else {
            return false;
        };
        let mut candidate = self.root.clone();
        for part in decoded.split('/').filter(|p| !p.is_empty()) {
            // Dotfiles, `.` and `..`, and characters no web file name needs.
            if part.starts_with('.') || part.contains(['\\', '\0']) {
                return false;
            }
            candidate.push(part);
        }
        match candidate.canonicalize() {
            Ok(real) => {
                if !real.starts_with(&self.root) {
                    return false;
                }
                // A directory is answered with its index file, which must be inside as well.
                if real.is_dir() {
                    return match real.join("index.html").canonicalize() {
                        Ok(index) => index.starts_with(&self.root),
                        Err(_) => true,
                    };
                }
                true
            }
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        }
    }
}

/// Answers 404 for a static request the web root does not allow.
pub async fn guard_static(
    State(root): State<Arc<StaticRoot>>,
    request: Request,
    next: Next,
) -> Response {
    if root.allows(request.uri().path()) {
        next.run(request).await
    } else {
        (StatusCode::NOT_FOUND, "not found").into_response()
    }
}

/// Decodes `%XX` escapes once; `None` for a broken escape or bytes that are not UTF-8.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = bytes.get(i + 1..i + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            let value = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-OPS-002
    #[test]
    fn only_loopback_names_with_the_bound_port_are_allowed() {
        for ok in [
            "127.0.0.1:8787",
            "localhost:8787",
            "LOCALHOST:8787",
            "LocalHost:8787",
            "[::1]:8787",
        ] {
            assert!(host_allowed(ok, 8787), "{ok}");
        }
        for bad in [
            "",
            "evil.example",
            "evil.example:8787",
            "127.0.0.1:8788",
            "127.0.0.1:87870",
            "127.0.0.1:",
            "127.0.0.1",
            "localhost",
            "[::1]",
            "127.0.0.1:+8787",
            "127.0.0.1:08787x",
            "127.0.0.1:8787:8787",
            "localhost.evil.example:8787",
            "127.0.0.1.evil.example:8787",
            "evil.example:8787@127.0.0.1:8787",
            "127.0.0.1:8787@evil.example",
            "user@127.0.0.1:8787",
            "127.0.0.2:8787",
            "0.0.0.0:8787",
            "[::]:8787",
            "[::1:8787",
            "[::1]x:8787",
            "[::1]8787",
            " 127.0.0.1:8787",
            "127.0.0.1:8787 ",
            "127.0.0.1:8787/",
        ] {
            assert!(!host_allowed(bad, 8787), "{bad:?} was allowed");
        }
    }

    // covers: REQ-OPS-002
    #[test]
    fn the_port_may_be_left_out_only_for_the_default_http_port() {
        assert!(host_allowed("localhost", 80));
        assert!(host_allowed("127.0.0.1", 80));
        assert!(host_allowed("[::1]", 80));
        assert!(host_allowed("localhost:80", 80));
        assert!(!host_allowed("localhost", 8787));
        assert!(!host_allowed("localhost:80", 8787));
        // Port 0 is never a real port to be addressed at.
        assert!(!host_allowed("localhost:0", 8787));
    }

    fn web() -> (tempfile::TempDir, StaticRoot) {
        let dir = tempfile::tempdir().unwrap();
        let web = dir.path().join("web");
        std::fs::create_dir_all(web.join("sub")).unwrap();
        std::fs::write(web.join("index.html"), "index").unwrap();
        std::fs::write(web.join("app.js"), "app").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
        let root = StaticRoot::new(&web).unwrap();
        (dir, root)
    }

    // covers: REQ-OPS-002
    #[test]
    fn what_the_static_root_will_and_will_not_name() {
        let (_dir, root) = web();
        for ok in [
            "/",
            "/index.html",
            "/app.js",
            "/sub",
            "/sub/",
            "/not/a/file",
            "//app.js",
        ] {
            assert!(root.allows(ok), "{ok}");
        }
        for bad in [
            "/.env",
            "/sub/.hidden",
            "/..",
            "/../secret.txt",
            "/%2e%2e/secret.txt",
            "/app.js/..",
            // A file used as a directory cannot be resolved: that is not "does not exist".
            "/app.js/x",
            "/index.html/x/y",
            // Characters no web file name needs.
            "/a%5cb",
            "/a\\b",
            "/a%00b",
            "/%ff",
            "/%zz",
        ] {
            assert!(!root.allows(bad), "{bad:?} was allowed");
        }
    }

    // covers: REQ-OPS-002
    #[cfg(unix)]
    #[test]
    fn links_are_followed_only_inside_the_root() {
        use std::os::unix::fs::symlink;
        let (dir, root) = web();
        let web = root.path().to_owned();
        symlink("app.js", web.join("inside")).unwrap();
        symlink(dir.path().join("secret.txt"), web.join("outside")).unwrap();
        symlink("loop", web.join("loop")).unwrap();
        // A sub-directory whose index points out of the root: asking for the directory serves it.
        symlink(dir.path().join("secret.txt"), web.join("sub/index.html")).unwrap();
        assert!(root.allows("/inside"));
        assert!(!root.allows("/outside"));
        assert!(!root.allows("/loop"), "a link loop cannot be resolved");
        assert!(!root.allows("/sub"));
        assert!(!root.allows("/sub/"));
        // Its own file is not the index, and stays out of reach as a name too.
        assert!(!root.allows("/sub/index.html"));
    }

    // covers: REQ-OPS-002
    #[test]
    fn a_web_root_needs_an_index_that_is_really_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        assert!(StaticRoot::new(&dir.path().join("missing")).is_none());
        assert!(StaticRoot::new(dir.path()).is_none(), "no index.html");
        #[cfg(unix)]
        {
            let web = dir.path().join("web");
            std::fs::create_dir_all(&web).unwrap();
            std::fs::write(dir.path().join("elsewhere.html"), "x").unwrap();
            std::os::unix::fs::symlink(dir.path().join("elsewhere.html"), web.join("index.html"))
                .unwrap();
            assert!(StaticRoot::new(&web).is_none());
        }
    }

    // covers: REQ-OPS-002
    #[test]
    fn percent_escapes_are_decoded_once_and_broken_ones_are_refused() {
        assert_eq!(percent_decode("/a%2Fb").as_deref(), Some("/a/b"));
        assert_eq!(percent_decode("/%2e%2e/x").as_deref(), Some("/../x"));
        assert_eq!(percent_decode("/%252e").as_deref(), Some("/%2e"));
        assert_eq!(percent_decode("/plain").as_deref(), Some("/plain"));
        assert_eq!(percent_decode("/%c3%a9").as_deref(), Some("/é"));
        for bad in ["/%", "/%2", "/%zz", "/%2g", "/%+1", "/%ff", "/%c3"] {
            assert_eq!(percent_decode(bad), None, "{bad}");
        }
    }
}
