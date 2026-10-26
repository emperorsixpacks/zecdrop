//! A tiny line logger.
//!
//! The operator logs only fixed-shape messages: HTTP method, path (never the
//! query string), status, batch indices, counts and transaction ids. Request
//! headers, bodies, tokens, seeds and recipient data are never passed to it.
//! Tests install a capturing sink to prove that.

use std::fmt;
use std::sync::{Arc, Mutex};

/// Where log lines go.
pub trait LogSink: Send + Sync {
    /// Writes one line (without a trailing newline).
    fn write_line(&self, line: &str);
}

struct StderrSink;

impl LogSink for StderrSink {
    fn write_line(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// Collects log lines in memory, for tests.
#[derive(Clone, Default)]
pub struct CaptureSink {
    lines: Arc<Mutex<Vec<String>>>,
}

impl CaptureSink {
    /// A copy of every line logged so far.
    pub fn lines(&self) -> Vec<String> {
        self.lines.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

impl LogSink for CaptureSink {
    fn write_line(&self, line: &str) {
        if let Ok(mut lines) = self.lines.lock() {
            lines.push(line.to_owned());
        }
    }
}

/// A cloneable handle to a [`LogSink`].
#[derive(Clone)]
pub struct Logger {
    sink: Arc<dyn LogSink>,
}

impl Logger {
    /// Logs to standard error.
    pub fn stderr() -> Self {
        Logger {
            sink: Arc::new(StderrSink),
        }
    }

    /// Logs into the returned [`CaptureSink`].
    pub fn capture() -> (Self, CaptureSink) {
        let sink = CaptureSink::default();
        (
            Logger {
                sink: Arc::new(sink.clone()),
            },
            sink,
        )
    }

    /// Discards everything.
    pub fn silent() -> Self {
        Logger::capture().0
    }

    /// Logs an informational line.
    pub fn info(&self, message: fmt::Arguments<'_>) {
        self.sink.write_line(&format!("[info] {message}"));
    }

    /// Logs a warning line.
    pub fn warn(&self, message: fmt::Arguments<'_>) {
        self.sink.write_line(&format!("[warn] {message}"));
    }
}

impl fmt::Debug for Logger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Logger")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_sink_collects_lines_in_order() {
        let (log, sink) = Logger::capture();
        log.info(format_args!("one {}", 1));
        log.warn(format_args!("two"));
        assert_eq!(sink.lines(), vec!["[info] one 1", "[warn] two"]);
    }
}
