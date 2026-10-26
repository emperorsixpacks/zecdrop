//! The hosted verifier under load and against slow or half-open clients, over real TCP with the
//! real listener (`drop_verifier::server::serve`). The chain is an in-memory fake that answers
//! slowly, so receipts occupy their slots for a known time.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use drop_core::Txid;
use drop_verifier::api::{build_router, Sources, VerifierState};
use drop_verifier::config::Settings;
use drop_verifier::log::Logger;
use drop_verifier::server::{serve, ServeLimits};
use drop_verify::{ChainSource, FetchedTx, SourceError};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A chain that takes `delay` to answer anything, then reports itself unavailable.
struct SlowChain {
    delay: Duration,
}

impl ChainSource for SlowChain {
    async fn transaction(&self, _: &Txid) -> Result<Option<FetchedTx>, SourceError> {
        tokio::time::sleep(self.delay).await;
        Err(SourceError::Unavailable)
    }

    async fn tip_height(&self) -> Result<u32, SourceError> {
        tokio::time::sleep(self.delay).await;
        Err(SourceError::Unavailable)
    }
}

async fn start(settings: Settings, chain_delay: Duration) -> SocketAddr {
    let (logger, _logs) = Logger::capture();
    let limits = ServeLimits {
        max_connections: settings.max_connections,
        header_read_timeout: settings.header_read_timeout,
    };
    let state = Arc::new(VerifierState {
        sources: Sources {
            testnet: Some(SlowChain { delay: chain_delay }),
            mainnet: None,
        },
        settings,
        logger: logger.clone(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(
        listener,
        build_router(state),
        limits,
        logger,
        std::future::pending(),
    ));
    addr
}

const RECEIPT: &str = "/v1/receipt?network=testnet&tx=1111111111111111111111111111111111111111111111111111111111111111&commitment=aade9fd18f7c48dc3b04ead6a7ee2211640d0fa5948dfd14b5a356463c841491&declared_total=1";

struct Reply {
    status: u16,
    body: String,
    took: Duration,
}

/// One HTTP/1.1 GET over a fresh connection.
async fn get(addr: SocketAddr, path: &str) -> Reply {
    let start = Instant::now();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: verifier\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    tokio::time::timeout(
        Duration::from_secs(20),
        stream.read_to_string(&mut response),
    )
    .await
    .expect("reply within 20 s")
    .unwrap();
    let status = response
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Reply {
        status,
        body: response,
        took: start.elapsed(),
    }
}

/// Waits until the server closes `stream` (read returns EOF or an error); returns how long.
async fn closed_within(mut stream: TcpStream, limit: Duration) -> Option<Duration> {
    let start = Instant::now();
    let mut buf = [0u8; 64];
    match tokio::time::timeout(limit, stream.read(&mut buf)).await {
        Ok(Ok(0) | Err(_)) => Some(start.elapsed()),
        _ => None,
    }
}

fn settings(max_concurrency: usize, max_queue: usize, request_timeout: Duration) -> Settings {
    Settings {
        max_concurrency,
        max_queue,
        request_timeout,
        ..Settings::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn health_stays_responsive_while_receipts_are_saturated_and_excess_is_shed() {
    let addr = start(
        settings(1, 1, Duration::from_secs(15)),
        Duration::from_secs(2),
    )
    .await;

    // Four receipts at once: one runs, one queues, two are shed.
    let receipts: Vec<_> = (0..4)
        .map(|_| tokio::spawn(async move { get(addr, RECEIPT).await }))
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let health = get(addr, "/v1/health").await;
    assert_eq!(health.status, 200, "{}", health.body);
    assert!(
        health.took < Duration::from_millis(500),
        "health took {:?} while receipts were saturated",
        health.took
    );

    let mut shed = 0;
    for receipt in receipts {
        let reply = receipt.await.unwrap();
        if reply.body.contains("\"overloaded\"") {
            shed += 1;
            assert_eq!(reply.status, 503);
            assert!(reply.body.to_ascii_lowercase().contains("retry-after: 1"));
            assert!(
                reply.took < Duration::from_millis(500),
                "shed at once, took {:?}",
                reply.took
            );
        } else {
            // Ran (or queued, then ran) and got the chain's answer.
            assert_eq!(reply.status, 503, "{}", reply.body);
            assert!(reply.body.contains("chain_unavailable"), "{}", reply.body);
        }
    }
    assert_eq!(
        shed, 2,
        "max_concurrency 1 + max_queue 1 admits two of four"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn time_spent_queued_counts_toward_the_request_timeout() {
    let addr = start(
        settings(1, 5, Duration::from_secs(1)),
        Duration::from_secs(5),
    )
    .await;
    let first = tokio::spawn(async move { get(addr, RECEIPT).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let queued = get(addr, RECEIPT).await;
    assert_eq!(queued.status, 504, "{}", queued.body);
    assert!(
        queued.took < Duration::from_millis(1_800),
        "the timeout includes queue time; took {:?}",
        queued.took
    );
    assert_eq!(first.await.unwrap().status, 504);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn half_open_and_slow_header_clients_are_disconnected() {
    let addr = start(
        Settings {
            header_read_timeout: Duration::from_secs(1),
            ..Settings::default()
        },
        Duration::ZERO,
    )
    .await;

    // Connects and sends nothing.
    let silent = TcpStream::connect(addr).await.unwrap();
    // Sends a request line, then stalls before finishing the headers.
    let mut slow = TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET /v1/health HTTP/1.1\r\nHost: v")
        .await
        .unwrap();

    let silent = tokio::spawn(closed_within(silent, Duration::from_secs(4)));
    let slow = tokio::spawn(closed_within(slow, Duration::from_secs(4)));
    for (name, closed) in [
        ("silent", silent.await.unwrap()),
        ("slow", slow.await.unwrap()),
    ] {
        let took = closed.unwrap_or_else(|| panic!("{name} client was never disconnected"));
        assert!(took >= Duration::from_millis(800), "{name}: {took:?}");
    }
    assert_eq!(get(addr, "/v1/health").await.status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connections_over_the_cap_are_closed_at_once() {
    let addr = start(
        Settings {
            max_connections: 3,
            header_read_timeout: Duration::from_secs(10),
            ..Settings::default()
        },
        Duration::ZERO,
    )
    .await;

    let idle: Vec<TcpStream> = futures_connect(addr, 3).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut over = TcpStream::connect(addr).await.unwrap();
    let _ = over
        .write_all(b"GET /v1/health HTTP/1.1\r\nHost: v\r\nConnection: close\r\n\r\n")
        .await;
    let took = closed_within(over, Duration::from_secs(2))
        .await
        .expect("the connection over the cap is closed");
    assert!(took < Duration::from_millis(500), "{took:?}");

    // Freeing the idle connections frees the slots.
    drop(idle);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(get(addr, "/v1/health").await.status, 200);
}

async fn futures_connect(addr: SocketAddr, n: usize) -> Vec<TcpStream> {
    let mut streams = Vec::with_capacity(n);
    for _ in 0..n {
        streams.push(TcpStream::connect(addr).await.unwrap());
    }
    streams
}
