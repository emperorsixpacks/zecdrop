//! Connection settings. Nothing is hard-coded: the caller supplies the endpoint.

use std::time::Duration;

use drop_core::Network;
use tonic::codegen::http::Uri;

use crate::client::ChainError;

/// Where to connect and what to expect there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainConfig {
    /// The gRPC endpoint, `http://host:port` or `https://host:port`.
    pub endpoint: String,
    /// The network the endpoint must serve.
    pub network: Network,
    /// Time allowed to establish a connection.
    pub connect_timeout: Duration,
    /// Time allowed for each request.
    pub request_timeout: Duration,
}

impl ChainConfig {
    /// A configuration with default timeouts (10 s to connect, 30 s per request).
    pub fn new(endpoint: impl Into<String>, network: Network) -> Self {
        ChainConfig {
            endpoint: endpoint.into(),
            network,
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(30),
        }
    }

    /// Whether the endpoint uses TLS.
    pub fn uses_tls(&self) -> bool {
        self.endpoint.starts_with("https://")
    }

    /// Checks the endpoint is an `https` URL with a host (or plain `http` to a loopback host,
    /// e.g. a local node), and returns it. Plain `http` to any other host is refused: chain
    /// data must not be readable or alterable in transit.
    pub fn uri(&self) -> Result<Uri, ChainError> {
        let uri: Uri = self.endpoint.parse().map_err(|_| ChainError::BadEndpoint)?;
        let has_host = uri.host().is_some_and(|h| !h.is_empty());
        let no_credentials = !uri.authority().is_some_and(|a| a.as_str().contains('@'));
        if !has_host || !no_credentials {
            return Err(ChainError::BadEndpoint);
        }
        match uri.scheme_str() {
            Some("https") => Ok(uri),
            Some("http") if uri.host().is_some_and(is_loopback_host) => Ok(uri),
            Some("http") => Err(ChainError::InsecureEndpoint),
            _ => Err(ChainError::BadEndpoint),
        }
    }
}

/// `localhost`, `127.0.0.0/8` or `::1`.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_endpoints_with_a_host() {
        for ok in [
            "https://testnet.example.org:443",
            "http://127.0.0.1:9067",
            "http://localhost:9067",
            "http://[::1]:9067",
            "https://lwd.example.org",
        ] {
            assert!(ChainConfig::new(ok, Network::Testnet).uri().is_ok(), "{ok}");
        }
        assert!(ChainConfig::new("https://x.example", Network::Testnet).uses_tls());
        assert!(!ChainConfig::new("http://127.0.0.1:9067", Network::Testnet).uses_tls());
    }

    #[test]
    fn plain_http_is_refused_unless_the_host_is_loopback() {
        for bad in [
            "http://testnet.example.org:9067",
            "http://10.0.0.5:9067",
            "http://192.168.1.2:9067",
            "http://localhost.example.org:9067",
        ] {
            let err = ChainConfig::new(bad, Network::Testnet).uri().unwrap_err();
            assert_eq!(err, ChainError::InsecureEndpoint, "{bad}");
            assert!(err.to_string().contains("loopback"), "{err}");
        }
        // Credentials are refused first, and no error message ever echoes the endpoint.
        let with_secret = "http://user:s3cret@lwd.example.org:9067";
        let err = ChainConfig::new(with_secret, Network::Testnet)
            .uri()
            .unwrap_err();
        assert_eq!(err, ChainError::BadEndpoint);
        assert!(!err.to_string().contains("s3cret"));
        assert!(!ChainError::InsecureEndpoint.to_string().contains("example"));
    }

    #[test]
    fn rejects_everything_else() {
        for bad in [
            "",
            "testnet.example.org:443",
            "ftp://x.example",
            "file:///etc/passwd",
            "https://",
            "https://user:pass@x.example",
            "not a url",
        ] {
            assert_eq!(
                ChainConfig::new(bad, Network::Testnet).uri().unwrap_err(),
                ChainError::BadEndpoint,
                "{bad:?}"
            );
        }
    }
}
