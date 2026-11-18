//! Shared test fixtures. Only compiled in tests via `#[cfg(test)]`
//! gating at the call sites, but kept in a regular module so the
//! `static` Mutex has a single canonical definition.

use std::sync::{Arc, Mutex};

/// Mutex tests must hold while mutating `HOME` / `USERPROFILE`.
/// Multiple modules' tests touch these env vars; serialising on a
/// single static keeps them from racing each other.
pub fn home_lock() -> &'static std::sync::Mutex<()> {
    static M: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(()))
}

/// Everything logged on this thread while it lives, as plain text. Tests
/// use it to pin what a log line says, and what it never says.
pub struct LogCapture {
    lines: Arc<Mutex<Vec<u8>>>,
    _guard: tracing::subscriber::DefaultGuard,
}

impl LogCapture {
    pub fn start() -> Self {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || CaptureWriter(Arc::clone(&sink)))
            .finish();
        Self {
            lines,
            _guard: tracing::subscriber::set_default(subscriber),
        }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.lines.lock().unwrap()).into_owned()
    }
}

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
