//! Starting the server and the one-time startup banner.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;

use drop_core::Network;
use tokio::net::TcpListener;

use crate::api::build_router;
use crate::auth::Token;
use crate::state::AppState;

/// Serves the API and web UI on `listener` until `shutdown` completes.
pub async fn serve(
    listener: TcpListener,
    state: AppState,
    web_dir: Option<PathBuf>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let bound = listener.local_addr()?;
    axum::serve(listener, build_router(state, web_dir, bound))
        .with_graceful_shutdown(shutdown)
        .await
}

/// The text printed once at startup. The token is in the URL *fragment*, so
/// browsers keep it out of requests, server logs and `Referer` headers.
pub fn startup_banner(address: SocketAddr, token: &Token, network: Network, mock: bool) -> String {
    let chain = if mock {
        "MOCK chain (fake transactions, nothing is sent to Zcash)"
    } else {
        "Zcash"
    };
    format!(
        "ZecDrop operator\n  network: {network}\n  chain:   {chain}\n  open:    http://{address}/#token={}\n  \
         The token is new on every start. It lives in the URL fragment and is never sent to the server in the URL.",
        token.reveal()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-OPS-002
    #[test]
    fn the_banner_puts_the_token_in_the_fragment_not_the_query() {
        let token = Token::from_hex(&"ab".repeat(32));
        let banner = startup_banner(
            "127.0.0.1:8787".parse().unwrap(),
            &token,
            Network::Testnet,
            true,
        );
        let link = banner
            .lines()
            .find_map(|l| l.trim().strip_prefix("open:"))
            .unwrap()
            .trim();
        assert_eq!(
            link,
            format!("http://127.0.0.1:8787/#token={}", "ab".repeat(32))
        );
        assert!(!link.contains('?'), "no query string");
        assert_eq!(banner.matches(token.reveal()).count(), 1, "printed once");
        assert!(banner.contains("MOCK"));
        assert!(banner.contains("testnet"));
    }
}
