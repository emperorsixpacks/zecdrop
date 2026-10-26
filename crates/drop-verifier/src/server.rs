//! The listener: HTTP/1.1 with a header-read timeout and a connection cap, so half-open sockets
//! and slow-header clients cannot hold the service. (`axum::serve` exposes neither.)
//!
//! * a connection over `max_connections` is closed at once, before anything is read;
//! * a client that does not finish sending a request's headers within `header_read_timeout`
//!   (including one that sends nothing) is disconnected.
//!
//! HTTP/1.1 only: protocol auto-detection would wait for the first bytes with no timeout.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

use crate::log::Logger;

/// Connection-level limits.
#[derive(Clone, Copy, Debug)]
pub struct ServeLimits {
    /// Most open connections.
    pub max_connections: usize,
    /// Time a client may take to send a request's headers.
    pub header_read_timeout: Duration,
}

/// Serves `router` on `listener` until `shutdown` resolves.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    limits: ServeLimits,
    logger: Logger,
    shutdown: impl Future<Output = ()>,
) {
    let connections = Arc::new(Semaphore::new(limits.max_connections));
    tokio::pin!(shutdown);
    loop {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _peer)) => stream,
                Err(_) => {
                    // E.g. out of file descriptors: back off instead of spinning.
                    logger.warn(format_args!("accept failed; backing off"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            () = &mut shutdown => return,
        };
        let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
            drop(stream); // over the cap: close at once
            continue;
        };
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .serve_connection(TokioIo::new(stream), service);
            let _ = connection.await;
            drop(permit);
        });
    }
}
