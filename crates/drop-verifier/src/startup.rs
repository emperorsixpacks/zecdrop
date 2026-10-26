//! Fail closed at startup: the verifier does not start serving until each configured chain
//! endpoint has answered and serves the expected network. An unreachable endpoint is retried
//! with exponential backoff for a bounded time; then the process exits with an error.

use std::future::Future;
use std::time::Duration;

use drop_chain::{ChainError, ChainInfo};
use tokio::time::Instant;

/// Why the endpoint could not be confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StartupError {
    /// The endpoint serves another network: retrying cannot help.
    #[error("the endpoint serves a different network than configured")]
    WrongNetwork,
    /// The endpoint is unusable as configured.
    #[error("the endpoint is not usable: {0}")]
    Unusable(ChainError),
    /// The endpoint did not answer in time.
    #[error("the endpoint did not answer within {0:?}")]
    TimedOut(Duration),
}

/// Calls `check` until it succeeds, retrying unavailability with exponential backoff (starting
/// at `first_backoff`, doubling, at most 10 s) until `timeout` has passed.
pub async fn wait_for_chain<F, Fut>(
    mut check: F,
    timeout: Duration,
    first_backoff: Duration,
) -> Result<ChainInfo, StartupError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<ChainInfo, ChainError>>,
{
    let deadline = Instant::now() + timeout;
    let mut backoff = first_backoff;
    loop {
        match check().await {
            Ok(info) => return Ok(info),
            Err(ChainError::WrongNetwork) => return Err(StartupError::WrongNetwork),
            Err(error @ (ChainError::BadEndpoint | ChainError::InsecureEndpoint)) => {
                return Err(StartupError::Unusable(error))
            }
            Err(ChainError::Unavailable | ChainError::Invalid) => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(StartupError::TimedOut(timeout));
        }
        tokio::time::sleep(backoff.min(deadline - now)).await;
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use drop_core::Network;

    use super::*;

    fn info() -> ChainInfo {
        ChainInfo {
            network: Network::Testnet,
            tip_height: 4_476_000,
            consensus_branch_id: 0x7719_0ad9,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_endpoint_that_comes_up_is_waited_for() {
        let calls = AtomicUsize::new(0);
        let result = wait_for_chain(
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 3 {
                        Err(ChainError::Unavailable)
                    } else {
                        Ok(info())
                    }
                }
            },
            Duration::from_secs(60),
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(result, Ok(info()));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn an_endpoint_that_never_answers_fails_closed_after_the_timeout() {
        let start = Instant::now();
        let result = wait_for_chain(
            || async { Err::<ChainInfo, _>(ChainError::Unavailable) },
            Duration::from_secs(30),
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(result, Err(StartupError::TimedOut(Duration::from_secs(30))));
        let waited = start.elapsed();
        assert!(
            waited >= Duration::from_secs(30) && waited < Duration::from_secs(31),
            "{waited:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_wrong_network_fails_at_once() {
        let calls = AtomicUsize::new(0);
        let result = wait_for_chain(
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err::<ChainInfo, _>(ChainError::WrongNetwork) }
            },
            Duration::from_secs(60),
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(result, Err(StartupError::WrongNetwork));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
