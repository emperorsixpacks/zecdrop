//! A tiny line logger. Lines carry the route template, status and counts only:
//! never a query string, a header, a transaction id from the request or anything a
//! caller sent. Tests capture the lines to prove it.

use std::fmt;
use std::sync::{Arc, Mutex};

/// Where log lines go.
pub trait LogSink: Send + Sync {
    /// Writes one line.
    fn write_line(&self, line: &str);
}

struct StderrSink;

impl LogSink for StderrSink {
    fn write_line(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// Collects lines in memory, for tests.
#[derive(Clone, Default)]
pub struct CaptureSink(Arc<Mutex<Vec<String>>>);

impl CaptureSink {
    /// Every line logged so far.
    pub fn lines(&self) -> Vec<String> {
        self.0.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

impl LogSink for CaptureSink {
    fn write_line(&self, line: &str) {
        if let Ok(mut lines) = self.0.lock() {
            lines.push(line.to_owned());
        }
    }
}

/// A cloneable logger.
#[derive(Clone)]
pub struct Logger(Arc<dyn LogSink>);

impl Logger {
    /// Logs to standard error.
    pub fn stderr() -> Self {
        Logger(Arc::new(StderrSink))
    }

    /// Logs into the returned sink.
    pub fn capture() -> (Self, CaptureSink) {
        let sink = CaptureSink::default();
        (Logger(Arc::new(sink.clone())), sink)
    }

    /// Writes an informational line.
    pub fn info(&self, message: fmt::Arguments<'_>) {
        self.0.write_line(&format!("[info] {message}"));
    }

    /// Writes a warning line.
    pub fn warn(&self, message: fmt::Arguments<'_>) {
        self.0.write_line(&format!("[warn] {message}"));
    }
}

impl fmt::Debug for Logger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Logger")
    }
}
