//! The embedded backend this process starts: its one parsed port, whether
//! it has bound (the only condition under which the shell sends it secrets),
//! and the wait for its health route before the boot warm-up talks to it.
//!
//! The health wait used to poll `/health`, which the backend never served,
//! so every launch sat out the whole timeout. It now polls the backend's own
//! health route, `fleetify_backend::HEALTH_PATH`, and counts the backend up
//! when that answers `{"status":"ok"}`. The warm-up no longer runs anyway
//! when it times out, nor before the backend has reported its bind.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::watch;

use crate::shell::ui_files::UiDirError;

/// How long one poll may take. The backend answers its health route at
/// once; this only bounds a port that accepts and never answers.
const POLL_TIMEOUT: Duration = Duration::from_millis(500);

// ── The backend this process starts ──
//
// The shell sends the backend secrets: provider and router keys, and the
// internal secret on every internal call. They go only to the backend this
// process started, and only once it has reported its bind. Before that, or
// after a failed bind, whatever answers on the port is something else
// (AnkiConnect listens on 127.0.0.1:8765 by default), and the backend sets
// FLEETIFY_INTERNAL_SECRET before it binds, so that variable proves nothing.

/// What the embedded backend's task has reported about its start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendStart {
    /// No report yet: `serve_with_routing_setup` is still running.
    Pending,
    /// It returned `Ok`: the backend listens on its port.
    Bound,
    /// It didn't start, and won't: see [`StartFailure`].
    Failed(StartFailure),
}

/// Why the embedded backend didn't start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartFailure {
    /// `serve_with_routing_setup` returned `Err` (the error and its causes),
    /// or its task ended without a report.
    Backend(String),
    /// A release build found no UI files to serve, so the backend was never
    /// started: it would have served a blank window (see `shell::ui_files`).
    UiFilesMissing(UiDirError),
    /// The window's app origin couldn't be granted its IPC permissions (the
    /// error, or the panic's message), so the backend was never started: the
    /// release UI could call none of the app's commands (see
    /// `startup_window::grant_app_origin`).
    Permissions(String),
}

/// The embedded backend's port when `FLEETIFY_BACKEND_PORT` is unset or not
/// a port.
pub const DEFAULT_PORT: u16 = 8765;

/// The port the embedded backend binds, from `FLEETIFY_BACKEND_PORT`'s
/// value: [`DEFAULT_PORT`] when it is unset or not a port. A typo'd port is
/// logged rather than ignored: it otherwise looks like "the backend won't
/// connect". lib.rs reads the variable once and passes it here; everything
/// else gets the port from [`bound_port`].
pub fn port_from_env(value: Option<&str>) -> u16 {
    match value {
        None => DEFAULT_PORT,
        Some(value) => value.parse().unwrap_or_else(|_| {
            tracing::warn!(
                value = %value,
                "FLEETIFY_BACKEND_PORT is not a valid port; falling back to {DEFAULT_PORT}"
            );
            DEFAULT_PORT
        }),
    }
}

/// Where secrets may go given the backend's start: its `port` once it has
/// reported its bind, nowhere before that or after a failed start.
pub fn secrets_port(start: &BackendStart, port: u16) -> Option<u16> {
    (*start == BackendStart::Bound).then_some(port)
}

/// The URL of `path` on the backend at `port`.
pub fn backend_url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{port}{path}")
}

/// The backend this process starts: the port it binds, and its start
/// reports.
#[derive(Debug)]
pub struct TrackedBackend {
    port: u16,
    start: watch::Receiver<BackendStart>,
}

impl TrackedBackend {
    /// Its port while it is bound (see [`secrets_port`]).
    pub fn bound_port(&self) -> Option<u16> {
        secrets_port(&self.start.borrow(), self.port)
    }
}

/// The backend this process starts. Set once, at setup.
static BACKEND: OnceLock<TrackedBackend> = OnceLock::new();

/// Records the backend this process starts: the port it binds (from
/// [`port_from_env`]) and the receiver of its start reports. Called once, in
/// setup, before anything could send it a secret.
pub fn track(port: u16, start: watch::Receiver<BackendStart>) {
    let _ = BACKEND.set(TrackedBackend { port, start });
}

/// The port to send secrets to: the app's own backend's, once it has
/// reported its bind. `None` before that, after a failed start, or when no
/// backend is tracked. Every sender returns without sending on `None`.
pub fn bound_port() -> Option<u16> {
    BACKEND.get().and_then(TrackedBackend::bound_port)
}

/// Waits for the backend's start to be decided: true once it reports its
/// bind, false when it fails or its task ends without reporting (it
/// panicked). The boot warm-up runs only on true.
pub async fn wait_until_bound(mut start: watch::Receiver<BackendStart>) -> bool {
    loop {
        match &*start.borrow_and_update() {
            BackendStart::Bound => return true,
            BackendStart::Failed(_) => return false,
            BackendStart::Pending => {}
        }
        // Err only once the sender is gone with nothing new: no bind came.
        if start.changed().await.is_err() {
            return false;
        }
    }
}

/// The backend's health URL on `port`.
pub fn health_url(port: &str) -> String {
    format!("http://127.0.0.1:{port}{}", fleetify_backend::HEALTH_PATH)
}

/// Polls `url` up to `attempts` times, `interval` apart, until the backend
/// answers. True once it did; false when the time ran out.
pub async fn wait_for_backend(url: &str, attempts: u32, interval: Duration) -> bool {
    let client = reqwest::Client::builder()
        .timeout(POLL_TIMEOUT)
        .build()
        .unwrap_or_default();
    for _ in 0..attempts {
        if answers_ok(&client, url).await {
            return true;
        }
        tokio::time::sleep(interval).await;
    }
    false
}

/// True when `url` answers 2xx with the backend's `{"status":"ok"}`: a
/// 200 from something else on the port doesn't count.
async fn answers_ok(client: &reqwest::Client, url: &str) -> bool {
    let Ok(response) = client.get(url).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .await
        .is_ok_and(|body| body["status"] == "ok")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// How a stub server answers each request.
    #[derive(Clone, Copy)]
    enum Stub {
        /// As the backend does: `{"status":"ok",…}` on its health route,
        /// 404 elsewhere.
        Backend,
        /// 200 with a web page on every path: something else on the port.
        WebPage,
        /// Accepts the connection and never answers.
        Silent,
    }

    /// A local HTTP server answering like `stub`. Returns its port and a
    /// count of the requests it got.
    async fn serve(stub: Stub) -> (u16, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let count = Arc::clone(&count);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    count.fetch_add(1, Ordering::SeqCst);
                    let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
                    let (status, body) = match stub {
                        Stub::Silent => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            return;
                        }
                        Stub::Backend if path == "/healthz" => {
                            ("200 OK", r#"{"status":"ok","version":"0.1.0"}"#)
                        }
                        Stub::Backend => ("404 Not Found", ""),
                        Stub::WebPage => ("200 OK", "<!doctype html><title>other</title>"),
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (port, requests)
    }

    #[test]
    fn polls_the_route_the_backend_serves() {
        assert_eq!(health_url("8765"), "http://127.0.0.1:8765/healthz");
        assert!(health_url("8765").ends_with(fleetify_backend::HEALTH_PATH));
    }

    #[tokio::test]
    async fn returns_as_soon_as_the_backend_answers() {
        let (port, requests) = serve(Stub::Backend).await;
        let started = std::time::Instant::now();
        let ready = wait_for_backend(
            &health_url(&port.to_string()),
            5,
            Duration::from_millis(200),
        )
        .await;
        assert!(ready, "the backend answered, so the wait must end ready");
        assert_eq!(requests.load(Ordering::SeqCst), 1, "one poll was enough");
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_200_from_something_else_is_not_the_backend() {
        let (port, requests) = serve(Stub::WebPage).await;
        let ready =
            wait_for_backend(&health_url(&port.to_string()), 3, Duration::from_millis(10)).await;
        assert!(!ready);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn gives_up_after_its_attempts_when_the_health_route_is_missing() {
        // The old startup polled /health, which the backend never served:
        // every launch waited out the whole timeout. Here the stub serves
        // only /healthz and the wait asks a path it doesn't serve.
        let (port, requests) = serve(Stub::Backend).await;
        let ready = wait_for_backend(
            &format!("http://127.0.0.1:{port}/health"),
            3,
            Duration::from_millis(10),
        )
        .await;
        assert!(!ready);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_backend_that_never_answers_is_given_up_on() {
        let (port, _) = serve(Stub::Silent).await;
        let url = health_url(&port.to_string());
        let wait = wait_for_backend(&url, 2, Duration::from_millis(10));
        let ready = tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .expect("each poll must time out on its own");
        assert!(!ready);
    }

    // ── The backend this process starts ──

    fn tracked(port: u16, start: BackendStart) -> (watch::Sender<BackendStart>, TrackedBackend) {
        let (tx, rx) = watch::channel(start);
        (tx, TrackedBackend { port, start: rx })
    }

    #[test]
    fn secrets_go_only_to_a_backend_that_reported_its_bind() {
        // Before the bind, or after a failed one, whatever answers on the
        // port is something else (AnkiConnect listens on 127.0.0.1:8765).
        assert_eq!(secrets_port(&BackendStart::Pending, 8765), None);
        let failed = BackendStart::Failed(StartFailure::Backend(
            "Address already in use (os error 98)".into(),
        ));
        assert_eq!(secrets_port(&failed, 8765), None);
        assert_eq!(secrets_port(&ui_files_missing(), 8765), None);
        assert_eq!(secrets_port(&BackendStart::Bound, 8765), Some(8765));
    }

    /// The report when a release build has no UI files: the backend is
    /// never started.
    fn ui_files_missing() -> BackendStart {
        BackendStart::Failed(StartFailure::UiFilesMissing(UiDirError::NoIndexHtml(
            "/usr/lib/Fleetify/dist".into(),
        )))
    }

    #[test]
    fn the_reloads_send_nothing_until_the_backend_reports_its_bind() {
        // What every sender asks before it sends: pending, nothing is sent.
        let (tx, backend) = tracked(8899, BackendStart::Pending);
        assert_eq!(backend.bound_port(), None);
        // Bound: the reload runs, to the backend's own port.
        tx.send(BackendStart::Bound).unwrap();
        assert_eq!(backend.bound_port(), Some(8899));

        let (tx, backend) = tracked(8899, BackendStart::Pending);
        tx.send(BackendStart::Failed(StartFailure::Backend(
            "database is locked".into(),
        )))
        .unwrap();
        assert_eq!(backend.bound_port(), None, "failed: nothing is sent");
        drop(tx);
        assert_eq!(backend.bound_port(), None);
    }

    #[test]
    fn nothing_is_sent_while_no_backend_is_tracked() {
        // No test tracks a backend: setup does, once, in the app.
        assert_eq!(bound_port(), None);
    }

    #[tokio::test]
    async fn the_warm_up_waits_for_the_bind() {
        let (tx, rx) = watch::channel(BackendStart::Pending);
        let wait = tokio::spawn(wait_until_bound(rx));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!wait.is_finished(), "still pending: no warm-up yet");
        tx.send(BackendStart::Bound).unwrap();
        assert!(wait.await.unwrap(), "bound: the warm-up runs");
    }

    #[tokio::test]
    async fn the_warm_up_is_skipped_when_the_backend_fails_to_start() {
        let (tx, rx) = watch::channel(BackendStart::Pending);
        let wait = tokio::spawn(wait_until_bound(rx));
        tx.send(BackendStart::Failed(StartFailure::Backend(
            "Address already in use (os error 98)".into(),
        )))
        .unwrap();
        assert!(!wait.await.unwrap());
    }

    #[tokio::test]
    async fn the_warm_up_is_skipped_when_the_ui_files_are_missing() {
        // The backend's task reports it and ends without starting it.
        let (tx, rx) = watch::channel(BackendStart::Pending);
        let wait = tokio::spawn(wait_until_bound(rx));
        tx.send(ui_files_missing()).unwrap();
        drop(tx);
        assert!(!wait.await.unwrap());
    }

    #[tokio::test]
    async fn the_warm_up_is_skipped_when_the_backend_never_reports() {
        // Its task panicked: the sender went away with the start pending.
        let (tx, rx) = watch::channel(BackendStart::Pending);
        drop(tx);
        let bound = tokio::time::timeout(Duration::from_secs(5), wait_until_bound(rx))
            .await
            .expect("the wait ends once nothing can report any more");
        assert!(!bound);
    }

    #[tokio::test]
    async fn a_bind_reported_just_before_the_task_ended_still_counts() {
        let (tx, rx) = watch::channel(BackendStart::Pending);
        tx.send(BackendStart::Bound).unwrap();
        drop(tx);
        assert!(wait_until_bound(rx).await);
    }

    // ── One parsed port ──

    #[test]
    fn the_port_comes_from_the_env_value_with_8765_as_the_fallback() {
        assert_eq!(port_from_env(None), 8765);
        assert_eq!(port_from_env(Some("8899")), 8899);
        for invalid in ["", "not-a-port", "70000", "-1", " 8899"] {
            assert_eq!(port_from_env(Some(invalid)), 8765, "{invalid:?}");
        }
    }

    #[test]
    fn an_invalid_port_sends_every_caller_to_the_port_the_backend_binds() {
        // lib.rs binds port_from_env(FLEETIFY_BACKEND_PORT) and tracks that
        // same port; every sender takes it from bound_port() and builds its
        // URL with backend_url.
        let (_tx, backend) = tracked(port_from_env(Some("not-a-port")), BackendStart::Bound);
        let port = backend.bound_port().unwrap();
        assert_eq!(port, 8765);
        for path in [
            "/api/internal/providers/reload",
            "/api/internal/accounts/http",
            "/api/internal/providers/warm-health",
            "/api/internal/routing/reload",
        ] {
            assert_eq!(
                backend_url(port, path),
                format!("http://127.0.0.1:8765{path}")
            );
        }
    }

    #[test]
    fn only_lib_rs_reads_the_backend_port_from_the_environment() {
        // Built at run time so this test's own source doesn't match.
        let read = format!("env::var(\"{}\")", "FLEETIFY_BACKEND_PORT");
        for (file, source) in [
            (
                "shell/providers_setup.rs",
                include_str!("providers_setup.rs"),
            ),
            ("shell/routing_setup.rs", include_str!("routing_setup.rs")),
            ("shell/migration.rs", include_str!("migration.rs")),
            ("shell/startup_window.rs", include_str!("startup_window.rs")),
            ("shell/backend_ready.rs", include_str!("backend_ready.rs")),
            ("shell/ipc/mod.rs", include_str!("ipc/mod.rs")),
        ] {
            assert!(
                !source.contains(&read),
                "{file} reads the port itself: use backend_ready::bound_port()"
            );
        }
        assert_eq!(
            include_str!("../lib.rs").matches(&read).count(),
            1,
            "lib.rs reads FLEETIFY_BACKEND_PORT once, into port_from_env"
        );
    }
}
