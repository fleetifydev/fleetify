//! The main window at startup: what it shows before the app can load, and
//! when it loads the app and shows itself.
//!
//! The window used to load the app's URL the moment it was built. When the
//! embedded backend was not listening yet, the engine showed its error page
//! ("Could not connect to 127.0.0.1: Connection refused") and never retried,
//! so a slow start left a dead window. Now the window starts, hidden, on a
//! placeholder page that Tauri serves itself (scheme [`PLACEHOLDER_SCHEME`]).
//! It loads the app once the embedded backend has reported its bind and the
//! app's URL answers, and is shown when the app page has finished loading. If
//! the app is not ready within [`SLOW_START`], the window is shown with the
//! placeholder, "Starting Fleetify…", and the app loads as soon as it can. If
//! the backend can't start at all, or a release build has no UI files to
//! serve (see `shell::ui_files`), an error dialog says why and the app quits.
//!
//! It also works out the app's origin ([`app_origin`]) and, when that origin
//! is remote, the capability that grants it IPC at setup
//! ([`runtime_remote_origin`], [`runtime_capability`]).
//! `capabilities/default.json` covers local origins only, so the app's own
//! origin is the one remote origin that can call anything.

use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::http::{header, Response, StatusCode};
use tauri::ipc::CapabilityBuilder;
use tauri::utils::config::FrontendDist;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::{watch, Notify};

use crate::shell::backend_ready::{BackendStart, StartFailure};
use crate::shell::ui_files::UiFilesMissing;

/// Label of the main window.
pub const MAIN_WINDOW: &str = "main";

/// Label of the main window's webview: a webview window's webview takes the
/// window's label (`WebviewWindowBuilder::new`). The browser panel is another
/// webview in the same window, with a label of its own.
pub const MAIN_WEBVIEW: &str = MAIN_WINDOW;

/// The custom URI scheme the placeholder page is served on. Tauri registers
/// a scheme for every webview; only the main window is served the page.
pub const PLACEHOLDER_SCHEME: &str = "fleetify-startup";

/// The placeholder page's URL. Windows has no custom schemes: wry loads this
/// first URL as `http://fleetify-startup.localhost/` there.
pub const PLACEHOLDER_URL: &str = "fleetify-startup://localhost/";

/// How long the app may take to answer before the window is shown with the
/// placeholder. It is the cap the old reveal waited before showing the
/// window regardless.
pub const SLOW_START: Duration = Duration::from_secs(15);

/// How long the window waits for the app page to finish loading before it is
/// shown anyway, so a missed page-load event can never leave it hidden.
pub const PAGE_LOAD_FALLBACK: Duration = Duration::from_secs(5);

/// How often the app's URL is polled.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// How long one poll may take: bounds a port that accepts and never answers.
const POLL_TIMEOUT: Duration = Duration::from_millis(500);

/// Pause between the app page loading and the window showing, so the first
/// React frame paints before the window appears.
const PAINT_GRACE: Duration = Duration::from_millis(120);

/// The page the main window shows until the app loads. It loads nothing:
/// inline styles only, colours from the system scheme (the app's own light
/// theme and its default dark theme, from `src/globals.css`).
pub const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Fleetify</title>
<style>
html, body { height: 100%; margin: 0; }
body {
  display: flex;
  align-items: center;
  justify-content: center;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, sans-serif;
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}
@media (prefers-color-scheme: light) {
  body { background: #ffffff; color: #111111; }
}
@media (prefers-color-scheme: dark) {
  body { background: #0c0c0c; color: #d8d8d8; }
}
</style>
</head>
<body>
<p>Starting Fleetify…</p>
</body>
</html>
"#;

/// The placeholder's Content-Security-Policy: its inline styles and nothing
/// else, so the engine itself refuses any resource.
const PLACEHOLDER_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'";

/// The placeholder scheme's answer to a request from `webview_label`: the
/// page for the main window, an empty 404 for any other webview (the
/// embedded browser panel included).
pub fn placeholder_response(webview_label: &str) -> Response<Vec<u8>> {
    let response = if webview_label == MAIN_WINDOW {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, PLACEHOLDER_CSP)
            .body(PLACEHOLDER_HTML.as_bytes().to_vec())
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
    };
    // Only fixed, valid status codes and headers go in above.
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}

/// True when `page` is a page of the app at `app_url`: same origin. The
/// placeholder never is (it has its own scheme, or its own host on Windows).
pub fn is_app_page(page: &Url, app_url: &Url) -> bool {
    page.origin() == app_url.origin()
}

/// Tells a finished load of the app from the engine's other load events.
///
/// Only a `Finished` for an app page that follows a `Started` for one counts.
/// WebKitGTK reports a cancelled navigation as load-failed and then
/// `Finished`, with the URL already the app's but no `Started` (Committed):
/// that one must not show a window the app hasn't painted. wry reports
/// `Started` at commit on every engine (WebKitGTK Committed, WebView2
/// ContentLoading, WKWebView didCommitNavigation).
#[derive(Debug, Default)]
pub struct AppLoadGuard {
    /// Whether the load in progress began with a `Started` for an app page.
    app_load_started: AtomicBool,
}

impl AppLoadGuard {
    /// Takes one page-load event, for an app page or not. True when it
    /// finishes a load of the app that began with a `Started` for it. Each
    /// `Finished` ends the load in progress, so the next one needs a new
    /// `Started`.
    pub fn finished_app_load(&self, event: PageLoadEvent, app_page: bool) -> bool {
        match event {
            PageLoadEvent::Started => {
                self.app_load_started.store(app_page, Ordering::SeqCst);
                false
            }
            PageLoadEvent::Finished => {
                let started = self.app_load_started.swap(false, Ordering::SeqCst);
                app_page && started
            }
        }
    }
}

/// A page-load handler for the main window: signals `app_page_loaded` each
/// time a page of the app at `app_url` finishes loading, as
/// [`AppLoadGuard`] tells it. A signal sent before anyone waits is kept, so
/// an early load is never missed.
pub fn signal_app_page_loaded(
    app_url: Url,
    app_page_loaded: Arc<Notify>,
) -> impl Fn(WebviewWindow, PageLoadPayload<'_>) + Send + Sync + 'static {
    let guard = AppLoadGuard::default();
    move |_window, payload| {
        if guard.finished_app_load(payload.event(), is_app_page(payload.url(), &app_url)) {
            app_page_loaded.notify_one();
        }
    }
}

/// The backend's start as the startup task sees it: `reported` is the last
/// report, and `reporter_gone` says its task has ended. A task that ended
/// without a report (it panicked) counts as failed, or the wait would never
/// end.
pub fn backend_start_seen(reported: &BackendStart, reporter_gone: bool) -> BackendStart {
    match reported {
        BackendStart::Pending if reporter_gone => BackendStart::Failed(StartFailure::Backend(
            "its startup task stopped before it reported".to_string(),
        )),
        other => other.clone(),
    }
}

/// The two reads the startup task makes of the backend's start reports.
trait StartReports {
    /// Whether the reporting task has ended.
    fn reporter_gone(&self) -> bool;
    /// The last report.
    fn last_report(&self) -> BackendStart;
}

impl StartReports for watch::Receiver<BackendStart> {
    fn reporter_gone(&self) -> bool {
        self.has_changed().is_err()
    }

    fn last_report(&self) -> BackendStart {
        self.borrow().clone()
    }
}

/// The backend's start now, from `reports`: whether the reporter is gone,
/// read first, then its last report. The other order could read a pending
/// report, then find the task gone because it reported its bind and ended in
/// between: a false "can't start". Read this way, a reporter seen gone has
/// sent all it ever will, so the report read after is final.
fn observe_start(reports: &impl StartReports) -> BackendStart {
    let gone = reports.reporter_gone();
    let last = reports.last_report();
    backend_start_seen(&last, gone)
}

/// Title of the dialog shown when the backend can't start.
pub const BACKEND_FAILURE_TITLE: &str = "Fleetify can't start";

/// The text of that dialog: what failed (`error`, with its causes), on which
/// port, and where the log files are: `logs_dir`, from
/// `shell::logging::logs_dir()`, when that folder exists; otherwise it says
/// the logs could not be written.
pub fn backend_failure_message(error: &str, port: u16, logs_dir: Option<&Path>) -> String {
    let logs = logs_line(logs_dir);
    format!("Fleetify couldn't start its local server on port {port}:\n\n{error}\n\n{logs}")
}

/// The text of that dialog when a release build has no UI files to serve
/// (`missing`, from `shell::ui_files`): reinstall, what is missing, and
/// where the log files are, as [`backend_failure_message`] says it.
pub fn ui_files_missing_message(missing: &UiFilesMissing, logs_dir: Option<&Path>) -> String {
    let what = match missing {
        UiFilesMissing::NotEmbedded => "This copy of Fleetify was built without them.",
        UiFilesMissing::NoIndexHtml => {
            "The interface files built into this copy of Fleetify have no index.html."
        }
    };
    let logs = logs_line(logs_dir);
    format!(
        "Fleetify's interface files are missing. Please reinstall Fleetify.\n\n{what}\n\n{logs}"
    )
}

/// The text of the dialog for a start that failed: the backend's error
/// ([`backend_failure_message`]), no UI files to serve
/// ([`ui_files_missing_message`]), or no IPC permissions for the window's
/// app origin ([`permissions_failure_message`]).
pub fn start_failure_message(failure: &StartFailure, port: u16, logs_dir: Option<&Path>) -> String {
    match failure {
        StartFailure::Backend(error) => backend_failure_message(error, port, logs_dir),
        StartFailure::UiFilesMissing(missing) => ui_files_missing_message(missing, logs_dir),
        StartFailure::Permissions(error) => permissions_failure_message(error, logs_dir),
    }
}

/// The text of that dialog when the window's app origin couldn't get its
/// IPC permissions (`error`, from [`grant_app_origin`]): what went wrong, and
/// where the log files are, as [`backend_failure_message`] says it.
pub fn permissions_failure_message(error: &str, logs_dir: Option<&Path>) -> String {
    let logs = logs_line(logs_dir);
    format!("Fleetify couldn't give its interface the permissions it needs:\n\n{error}\n\n{logs}")
}

/// The dialogs' last line: where the log files are (`logs_dir`, from
/// `shell::logging::logs_dir()`) when that folder exists, otherwise that
/// they could not be written.
fn logs_line(logs_dir: Option<&Path>) -> String {
    // logging::init records its folder even when creating it failed: name it
    // only when it is there.
    match logs_dir.filter(|dir| dir.is_dir()) {
        Some(dir) => format!("The log files are in {}", dir.display()),
        None => "Fleetify could not write its log files.".to_string(),
    }
}

/// What the startup task does after one poll of the app's URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The backend is bound and the app answered: load it in the window.
    LoadApp,
    /// The app is slow to answer: show the window with the placeholder.
    ShowPlaceholder,
    /// The backend can't start: stop polling and say so.
    ReportFailure,
    /// Poll again.
    KeepWaiting,
}

/// The next step after one poll: the backend's start, whether the app
/// answered, how long the task has waited, and whether the placeholder is on
/// screen already.
///
/// The app loads only once the backend has reported its bind *and* the app
/// answers: before the bind, an answer comes from something else on the port.
/// A backend that failed to start ends the wait. Otherwise polling has no
/// cap: past [`SLOW_START`] the placeholder goes up once, and the app still
/// loads the moment it can.
pub fn next_step(
    backend: &BackendStart,
    app_answered: bool,
    waited: Duration,
    placeholder_shown: bool,
) -> Step {
    match backend {
        BackendStart::Failed(_) => Step::ReportFailure,
        BackendStart::Bound if app_answered => Step::LoadApp,
        _ if waited >= SLOW_START && !placeholder_shown => Step::ShowPlaceholder,
        _ => Step::KeepWaiting,
    }
}

/// Loads the app in `window` once the embedded backend has bound and
/// `app_url` answers, then shows the window.
///
/// The window was built hidden on the placeholder page. `backend` carries the
/// backend task's report (see [`BackendStart`]); `app_url` is polled only
/// once it reports the bind, and any HTTP answer counts then, as before: even
/// a 404 lets the renderer show the failure. The window then loads the app
/// and is shown when the app page has finished loading (`app_page_loaded`,
/// from [`signal_app_page_loaded`]), or after [`PAGE_LOAD_FALLBACK`]. Past
/// [`SLOW_START`] it is shown with the placeholder, and the app loads once it
/// can. If the backend can't start, or has no UI files to serve, polling
/// stops and an error dialog says so; the app quits when it is dismissed.
///
/// The poll never goes through a proxy (`fleetify_core::loopback`): a proxy
/// in the environment that isn't running would otherwise keep the window on
/// the placeholder for good.
pub async fn load_app_when_ready(
    window: WebviewWindow,
    app_url: Url,
    app_page_loaded: Arc<Notify>,
    backend: watch::Receiver<BackendStart>,
    backend_port: u16,
    boot_start: Instant,
) {
    let client = fleetify_core::loopback::http_client_builder()
        .timeout(POLL_TIMEOUT)
        .build()
        .inspect_err(|e| {
            tracing::error!(
                target: "fleetify::startup",
                "can't build the HTTP client that polls {app_url} ({e}); \
                 loading the app once the backend reports its bind"
            );
        })
        .ok();
    let started = Instant::now();
    let mut placeholder_shown = false;
    loop {
        // observe_start clones the report at once: a watch borrow must not
        // be held across an await.
        let start = observe_start(&backend);
        let answered = start == BackendStart::Bound && app_answers(client.as_ref(), &app_url).await;
        match next_step(&start, answered, started.elapsed(), placeholder_shown) {
            Step::LoadApp => break,
            Step::ReportFailure => {
                // No "Starting Fleetify…" behind the error: the start is over.
                // The dialog has no parent, so it shows without the window.
                if let Err(e) = window.hide() {
                    tracing::warn!("hide main window failed: {e}");
                }
                if let BackendStart::Failed(failure) = &start {
                    report_start_failure(&window, failure, backend_port);
                }
                return;
            }
            Step::ShowPlaceholder => {
                tracing::warn!(
                    target: "fleetify::startup",
                    waited_ms = started.elapsed().as_millis() as u64,
                    backend_bound = start == BackendStart::Bound,
                    "the app is not ready at {app_url} yet; showing the startup placeholder"
                );
                reveal(&window, boot_start);
                placeholder_shown = true;
            }
            Step::KeepWaiting => {}
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    if let Err(e) = window.navigate(app_url.clone()) {
        tracing::warn!("loading {app_url} in the main window failed: {e}");
    }
    if placeholder_shown {
        tracing::info!(
            target: "fleetify::startup",
            app_ready_ms = boot_start.elapsed().as_millis() as u64,
            "{app_url} answered after a slow start; loading the app"
        );
        return;
    }
    if tokio::time::timeout(PAGE_LOAD_FALLBACK, app_page_loaded.notified())
        .await
        .is_err()
    {
        tracing::warn!(
            target: "fleetify::startup",
            "the app page did not report loading; showing the main window anyway"
        );
    }
    tokio::time::sleep(PAINT_GRACE).await;
    reveal(&window, boot_start);
}

/// Whether `app_url` gives any HTTP answer, asked with `client`. Without a
/// client (one that can't be built, which only a TLS backend that can't start
/// causes) nothing can be asked, and the backend's bind has to do.
async fn app_answers(client: Option<&reqwest::Client>, app_url: &Url) -> bool {
    match client {
        Some(client) => client.get(app_url.as_str()).send().await.is_ok(),
        None => true,
    }
}

/// Says the backend can't start, that there are no UI files to serve, or
/// that the interface couldn't get its permissions, then quits: a native
/// error dialog with the text from [`start_failure_message`], and the app
/// exits once it is dismissed.
/// Without the backend the app can't work, and a placeholder that never ends
/// would hide why.
///
/// The quit is a handled one, so it marks the shutdown clean: exiting skips
/// the main window's `Destroyed` event, which otherwise does, and the next
/// launch would report a crash. Tauri 2.11.2's wry runtime ends the event
/// loop with `ControlFlow::Exit` whatever code `exit` gets, so the process
/// status is 0 even though 1 is asked for.
fn report_start_failure(window: &WebviewWindow, failure: &StartFailure, port: u16) {
    let what = match failure {
        StartFailure::Backend(_) => "the embedded backend can't start",
        StartFailure::UiFilesMissing(_) => "the UI files are missing",
        StartFailure::Permissions(_) => "the interface couldn't get its permissions",
    };
    tracing::error!(
        target: "fleetify::startup",
        port,
        "{what}; showing the error, then quitting"
    );
    let app = window.app_handle().clone();
    let on_dismiss = app.clone();
    app.dialog()
        .message(start_failure_message(
            failure,
            port,
            crate::shell::logging::logs_dir(),
        ))
        .title(BACKEND_FAILURE_TITLE)
        .kind(MessageDialogKind::Error)
        .show(move |_| {
            crate::shell::logging::mark_clean_shutdown();
            on_dismiss.exit(1);
        });
}

/// Shows and focuses the window, and logs the cold start: setup() entry to
/// the first reveal.
fn reveal(window: &WebviewWindow, boot_start: Instant) {
    if let Err(e) = window.show() {
        tracing::warn!("show main window failed: {e}");
    } else {
        tracing::info!(
            target: "fleetify::startup",
            cold_start_ms = boot_start.elapsed().as_millis() as u64,
            "main window revealed"
        );
    }
    let _ = window.set_focus();
}

// ── IPC from the app's origin ──
//
// `capabilities/default.json` covers local origins only: the ones Tauri
// treats as the app's own (`devUrl` in dev mode, its custom schemes). The
// origin the main window loads the app from, when it is remote, gets the same
// permissions at setup, for that origin alone. No other remote origin can
// call anything: the main webview has no navigation guard, so a page it ends
// up on elsewhere must find no IPC.

/// The permissions `capabilities/default.json` grants: the core ones, and
/// every app command (the `app-commands` set, `permissions/app-commands.toml`).
const IPC_PERMISSIONS: [&str; 4] = [
    "core:default",
    "core:event:default",
    "dialog:allow-open",
    "app-commands",
];

/// Identifier of the capability added at runtime for the app's origin.
const RUNTIME_CAPABILITY: &str = "app-origin";

/// The origin the main window loads the app from. Debug builds load the Vite
/// dev server (`VITE_PORT`, default 3000); release builds load the embedded
/// backend serving the bundled dist (`FLEETIFY_BACKEND_PORT`, default 8765).
/// Honouring the ports is what lets the `dev:tauri:wt` script (and the
/// parallel-worktree workflow it enables) run two app instances side by side.
pub fn app_origin(release: bool, backend_port: u16, vite_port: u16) -> String {
    if release {
        format!("http://127.0.0.1:{backend_port}")
    } else {
        format!("http://localhost:{vite_port}")
    }
}

/// The http(s) URL Tauri treats as the app's own, local origin, besides its
/// `tauri://` assets and custom schemes: `devUrl` in dev mode (`dev` is
/// `tauri::is_dev()`: a build without Tauri's `custom-protocol` feature, such
/// as `tauri dev`), and otherwise `frontendDist` when it is a URL. It mirrors
/// Tauri's `get_app_url`, which `Webview::is_local_url` checks an IPC
/// request's origin against.
pub fn local_app_url(config: &tauri::Config, dev: bool) -> Option<Url> {
    if dev {
        config.build.dev_url.clone()
    } else {
        match &config.build.frontend_dist {
            Some(FrontendDist::Url(url)) => Some(url.clone()),
            _ => None,
        }
    }
}

/// The origin setup grants IPC at runtime: the one the main window loads the
/// app from ([`app_origin`]), unless it is the origin of `local_app_url` (see
/// [`local_app_url`]), which Tauri treats as local and `default.json` covers.
/// A release build always gets one, for its embedded backend on
/// `http://127.0.0.1:<backend port>`. A debug build gets one only when Vite is
/// not the local `devUrl`.
pub fn runtime_remote_origin(
    release: bool,
    backend_port: u16,
    vite_port: u16,
    local_app_url: Option<&Url>,
) -> Option<String> {
    let origin = app_origin(release, backend_port, vite_port);
    let local = match (local_app_url, Url::parse(&origin)) {
        (Some(local), Ok(app)) => local.origin() == app.origin(),
        _ => false,
    };
    (!local).then_some(origin)
}

/// Grants `origin` its IPC permissions ([`runtime_capability`]), at setup,
/// before the window is built. A release build has no other grant, so a
/// failure stops the start (`StartFailure::Permissions`). It comes back as
/// its text, from an `Err` or from a panic: tauri 2.11.2 panics instead of
/// erring when it can't resolve the capability (`ipc/authority.rs`). The app
/// exits right after, so the lock that panic poisons is never used again.
pub fn grant_app_origin<R: tauri::Runtime>(
    manager: &impl Manager<R>,
    origin: &str,
) -> Result<(), String> {
    grant_outcome(std::panic::catch_unwind(AssertUnwindSafe(|| {
        manager.add_capability(runtime_capability(origin))
    })))
}

/// The grant's outcome, from what `add_capability` returned or how it
/// panicked: `Ok`, or what went wrong, as text.
pub fn grant_outcome(caught: std::thread::Result<tauri::Result<()>>) -> Result<(), String> {
    match caught {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(panic) => Err(panic_message(panic.as_ref())),
    }
}

/// A panic's message: its payload when that is text.
fn panic_message(panic: &(dyn Any + Send)) -> String {
    match (panic.downcast_ref::<&str>(), panic.downcast_ref::<String>()) {
        (Some(message), _) => (*message).to_string(),
        (None, Some(message)) => message.clone(),
        (None, None) => "it panicked without a message".to_string(),
    }
}

/// What `capabilities/default.json` grants, for `origin` alone and the main
/// webview only, as there: a window scope would also match the browser
/// panel, a child webview in the main window. Added at setup, before the
/// window is built.
pub fn runtime_capability(origin: &str) -> CapabilityBuilder {
    IPC_PERMISSIONS.iter().fold(
        CapabilityBuilder::new(RUNTIME_CAPABILITY)
            .remote(origin.to_string())
            .local(false)
            .webview(MAIN_WEBVIEW),
        |capability, permission| capability.permission(*permission),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    /// The CSS rules inside the `@media (prefers-color-scheme: …)` block for
    /// `scheme`.
    fn scheme_block(scheme: &str) -> &'static str {
        let start = format!("@media (prefers-color-scheme: {scheme})");
        let at = PLACEHOLDER_HTML
            .find(&start)
            .unwrap_or_else(|| panic!("no {start} block"));
        let rest = &PLACEHOLDER_HTML[at + start.len()..];
        let open = rest.find('{').expect("block opens");
        let mut depth = 0;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &rest[open..open + i + 1];
                    }
                }
                _ => {}
            }
        }
        panic!("{start} block never closes");
    }

    #[test]
    fn the_placeholder_says_fleetify_is_starting() {
        assert!(PLACEHOLDER_HTML.contains("Starting Fleetify…"));
        // The ellipsis is not ASCII: the page declares its encoding.
        assert!(PLACEHOLDER_HTML.contains(r#"<meta charset="utf-8">"#));
    }

    #[test]
    fn the_placeholder_loads_nothing() {
        for reference in [
            "http://", "https://", "//", "src=", "href=", "url(", "@import",
        ] {
            assert!(
                !PLACEHOLDER_HTML.contains(reference),
                "the placeholder references a resource: {reference}"
            );
        }
    }

    #[test]
    fn the_placeholder_colours_follow_the_system_colour_scheme() {
        // The app's background and foreground: the light theme, and the
        // default dark theme (zinc), from src/globals.css.
        let light = scheme_block("light");
        assert!(light.contains("background: #ffffff"), "{light}");
        assert!(light.contains("color: #111111"), "{light}");
        let dark = scheme_block("dark");
        assert!(dark.contains("background: #0c0c0c"), "{dark}");
        assert!(dark.contains("color: #d8d8d8"), "{dark}");
    }

    #[test]
    fn the_main_window_gets_the_placeholder_page() {
        let response = placeholder_response(MAIN_WINDOW);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        // The engine itself refuses anything but the inline styles.
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; style-src 'unsafe-inline'"
        );
        assert_eq!(response.body().as_slice(), PLACEHOLDER_HTML.as_bytes());
    }

    #[test]
    fn other_webviews_get_nothing_from_the_placeholder_scheme() {
        // The scheme is registered for every webview, the embedded browser
        // panel included; only the main window is served.
        let response = placeholder_response("browser-embed-1");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.body().is_empty());
    }

    #[test]
    fn the_placeholder_url_uses_the_placeholder_scheme() {
        let placeholder = url(PLACEHOLDER_URL);
        assert_eq!(placeholder.scheme(), PLACEHOLDER_SCHEME);
        assert_eq!(placeholder.host_str(), Some("localhost"));
    }

    #[test]
    fn app_pages_are_told_apart_from_the_placeholder() {
        let app = url("http://127.0.0.1:8765");
        assert!(is_app_page(&url("http://127.0.0.1:8765/"), &app));
        assert!(is_app_page(
            &url("http://127.0.0.1:8765/settings?tab=privacy#top"),
            &app
        ));
        // The placeholder, as Linux and macOS load it and as Windows does.
        assert!(!is_app_page(&url(PLACEHOLDER_URL), &app));
        assert!(!is_app_page(
            &url("http://fleetify-startup.localhost/"),
            &app
        ));
        assert!(!is_app_page(&url("http://127.0.0.1:8899/"), &app));
        assert!(!is_app_page(&url("about:blank"), &app));
        let dev = url("http://localhost:3000");
        assert!(is_app_page(&url("http://localhost:3000/"), &dev));
        assert!(!is_app_page(&url("http://127.0.0.1:3000/"), &dev));
    }

    #[test]
    fn the_app_loads_as_soon_as_it_answers() {
        let bound = BackendStart::Bound;
        let soon = Duration::from_millis(300);
        assert_eq!(next_step(&bound, true, soon, false), Step::LoadApp);
        assert_eq!(
            next_step(&bound, true, SLOW_START * 4, false),
            Step::LoadApp
        );
        // After the placeholder went up, too.
        assert_eq!(next_step(&bound, true, SLOW_START * 4, true), Step::LoadApp);
    }

    #[test]
    fn the_window_stays_hidden_while_startup_is_quick() {
        for backend in [BackendStart::Pending, BackendStart::Bound] {
            assert_eq!(
                next_step(&backend, false, Duration::from_millis(300), false),
                Step::KeepWaiting
            );
            assert_eq!(
                next_step(
                    &backend,
                    false,
                    SLOW_START - Duration::from_millis(1),
                    false
                ),
                Step::KeepWaiting
            );
        }
    }

    #[test]
    fn a_slow_start_shows_the_placeholder_once_and_keeps_waiting() {
        // Slow either way: the backend still binding (a keychain prompt), or
        // bound while the app doesn't answer yet (Vite in debug builds).
        for backend in [BackendStart::Pending, BackendStart::Bound] {
            assert_eq!(
                next_step(&backend, false, SLOW_START, false),
                Step::ShowPlaceholder
            );
            assert_eq!(
                next_step(&backend, false, SLOW_START + Duration::from_secs(1), false),
                Step::ShowPlaceholder
            );
            // Already on screen: no cap, just keep polling.
            assert_eq!(
                next_step(&backend, false, SLOW_START, true),
                Step::KeepWaiting
            );
            assert_eq!(
                next_step(&backend, false, Duration::from_secs(600), true),
                Step::KeepWaiting
            );
        }
    }

    #[test]
    fn the_slow_start_threshold_is_the_old_reveal_cap() {
        assert_eq!(SLOW_START, Duration::from_secs(15));
    }

    // ── the backend's start ──

    #[test]
    fn an_answer_before_the_backend_reports_its_bind_is_not_the_app() {
        // Something else on the port answers before, or instead of, the
        // backend: AnkiConnect listens on 127.0.0.1:8765 by default.
        let pending = BackendStart::Pending;
        assert_eq!(
            next_step(&pending, true, Duration::from_millis(300), false),
            Step::KeepWaiting
        );
        assert_eq!(
            next_step(&pending, true, SLOW_START, false),
            Step::ShowPlaceholder
        );
        assert_eq!(
            next_step(&pending, true, SLOW_START * 4, true),
            Step::KeepWaiting
        );
    }

    #[test]
    fn a_backend_that_fails_to_start_ends_the_wait() {
        let failed = BackendStart::Failed(StartFailure::Backend(
            "Address already in use (os error 98)".into(),
        ));
        for (answered, waited, placeholder_shown) in [
            (false, Duration::ZERO, false),
            (true, Duration::from_millis(300), false),
            (false, SLOW_START, false),
            (false, SLOW_START * 40, true),
        ] {
            assert_eq!(
                next_step(&failed, answered, waited, placeholder_shown),
                Step::ReportFailure,
                "answered {answered}, waited {waited:?}, placeholder {placeholder_shown}"
            );
        }
    }

    /// The report when a release build has no UI files to serve.
    fn ui_files_missing() -> BackendStart {
        BackendStart::Failed(StartFailure::UiFilesMissing(UiFilesMissing::NoIndexHtml))
    }

    #[test]
    fn missing_ui_files_end_the_wait_like_a_backend_that_fails() {
        // The same path: the error dialog, then the app quits. Nothing is
        // loaded, and a report outlives the task that sent it.
        let missing = ui_files_missing();
        for (answered, waited, placeholder_shown) in [
            (false, Duration::ZERO, false),
            (false, SLOW_START, false),
            (false, SLOW_START * 40, true),
        ] {
            assert_eq!(
                next_step(&missing, answered, waited, placeholder_shown),
                Step::ReportFailure,
                "waited {waited:?}, placeholder {placeholder_shown}"
            );
        }
        assert_eq!(backend_start_seen(&missing, true), missing);
    }

    #[test]
    fn a_backend_task_that_ends_without_reporting_counts_as_failed() {
        // Its task panicked: the sender went away with the start still pending.
        let BackendStart::Failed(StartFailure::Backend(error)) =
            backend_start_seen(&BackendStart::Pending, true)
        else {
            panic!("a start nobody can report any more is a failed one");
        };
        assert!(!error.is_empty());
        assert_eq!(
            backend_start_seen(&BackendStart::Pending, false),
            BackendStart::Pending
        );
        // A report outlives the task that sent it.
        assert_eq!(
            backend_start_seen(&BackendStart::Bound, true),
            BackendStart::Bound
        );
        let failed = BackendStart::Failed(StartFailure::Backend("database is locked".into()));
        assert_eq!(backend_start_seen(&failed, true), failed);
    }

    #[test]
    fn the_failure_message_names_the_error_the_port_and_the_logs() {
        let logs = tempfile::tempdir().unwrap();
        let message = backend_failure_message(
            "Address already in use (os error 98)",
            8765,
            Some(logs.path()),
        );
        assert!(
            message.contains("Address already in use (os error 98)"),
            "{message}"
        );
        assert!(message.contains("8765"), "{message}");
        assert!(
            message.contains(&format!("The log files are in {}", logs.path().display())),
            "{message}"
        );
    }

    #[test]
    fn the_failure_message_without_a_log_folder_still_names_the_error_and_port() {
        // logging::init records its folder even when creating it failed: a
        // folder that isn't there is never named.
        let parent = tempfile::tempdir().unwrap();
        let never_created = parent.path().join("logs");
        for logs_dir in [Some(never_created.as_path()), None] {
            let message = backend_failure_message("loading config: invalid TOML", 8899, logs_dir);
            assert!(
                message.contains("loading config: invalid TOML"),
                "{message}"
            );
            assert!(message.contains("8899"), "{message}");
            assert!(
                message.contains("Fleetify could not write its log files."),
                "{message}"
            );
            assert!(!message.contains("The log files are in"), "{message}");
            assert!(!message.contains("None"), "{message}");
        }
    }

    /// The first line of the dialog when the UI files are missing.
    const REINSTALL: &str = "Fleetify's interface files are missing. Please reinstall Fleetify.";

    #[test]
    fn the_missing_ui_files_message_says_to_reinstall_and_what_is_missing_and_the_logs() {
        let logs = tempfile::tempdir().unwrap();
        let message = ui_files_missing_message(&UiFilesMissing::NoIndexHtml, Some(logs.path()));
        assert!(message.starts_with(REINSTALL), "{message}");
        assert!(
            message.contains(
                "The interface files built into this copy of Fleetify have no index.html."
            ),
            "{message}"
        );
        assert!(
            message.contains(&format!("The log files are in {}", logs.path().display())),
            "{message}"
        );
        // Not the backend's message: no server, no port.
        assert!(!message.contains("local server"), "{message}");
    }

    #[test]
    fn the_missing_ui_files_message_for_a_build_without_them_and_no_log_folder() {
        let parent = tempfile::tempdir().unwrap();
        let never_created = parent.path().join("logs");
        for logs_dir in [Some(never_created.as_path()), None] {
            let message = ui_files_missing_message(&UiFilesMissing::NotEmbedded, logs_dir);
            assert!(message.starts_with(REINSTALL), "{message}");
            assert!(
                message.contains("This copy of Fleetify was built without them."),
                "{message}"
            );
            assert!(
                message.contains("Fleetify could not write its log files."),
                "{message}"
            );
            assert!(!message.contains("The log files are in"), "{message}");
        }
    }

    #[test]
    fn each_start_failure_gets_its_own_message() {
        let logs = tempfile::tempdir().unwrap();
        let error = "Address already in use (os error 98)";
        assert_eq!(
            start_failure_message(
                &StartFailure::Backend(error.into()),
                8765,
                Some(logs.path())
            ),
            backend_failure_message(error, 8765, Some(logs.path()))
        );
        let missing = UiFilesMissing::NoIndexHtml;
        assert_eq!(
            start_failure_message(
                &StartFailure::UiFilesMissing(missing.clone()),
                8765,
                Some(logs.path())
            ),
            ui_files_missing_message(&missing, Some(logs.path()))
        );
        assert_eq!(
            start_failure_message(
                &StartFailure::Permissions("app-commands not found".into()),
                8765,
                Some(logs.path())
            ),
            permissions_failure_message("app-commands not found", Some(logs.path()))
        );
    }

    // ── a failed grant ──

    #[test]
    fn a_grant_that_works_lets_the_start_go_on() {
        assert_eq!(grant_outcome(Ok(Ok(()))), Ok(()));
    }

    #[test]
    fn a_grant_that_fails_is_a_start_failure_with_its_error() {
        let error = grant_outcome(Ok(Err(tauri::Error::AssetNotFound("app-origin".into()))))
            .expect_err("an Err from add_capability");
        assert!(error.contains("app-origin"), "{error}");
    }

    #[test]
    fn a_grant_that_panics_is_a_start_failure_with_the_panic_message() {
        // tauri 2.11.2 panics, not errs, when it can't resolve a capability
        // (ipc/authority.rs: `Resolved::resolve(..).unwrap()`).
        let caught = std::panic::catch_unwind(|| -> tauri::Result<()> {
            panic!("UnknownPermission: app-commands")
        });
        let error = grant_outcome(caught).expect_err("a panic");
        assert!(error.contains("UnknownPermission: app-commands"), "{error}");
        let caught = std::panic::catch_unwind(|| -> tauri::Result<()> {
            panic!("{} not found", "app-commands")
        });
        let error = grant_outcome(caught).expect_err("a formatted panic");
        assert!(error.contains("app-commands not found"), "{error}");
        // A panic whose payload isn't text still stops the start.
        let caught =
            std::panic::catch_unwind(|| -> tauri::Result<()> { std::panic::panic_any(7_u8) });
        assert!(grant_outcome(caught).is_err());
    }

    #[test]
    fn a_failed_grant_ends_the_wait_like_a_backend_that_fails() {
        // The same path: the backend never starts, the window never loads
        // the app, and the error dialog shows before the app quits.
        let failed = BackendStart::Failed(StartFailure::Permissions("resolve failed".into()));
        for (answered, waited, placeholder_shown) in [
            (false, Duration::ZERO, false),
            (true, Duration::from_millis(300), false),
            (false, SLOW_START * 40, true),
        ] {
            assert_eq!(
                next_step(&failed, answered, waited, placeholder_shown),
                Step::ReportFailure,
                "answered {answered}, waited {waited:?}, placeholder {placeholder_shown}"
            );
        }
        assert_eq!(backend_start_seen(&failed, true), failed);
    }

    #[test]
    fn the_failed_grant_message_names_the_error_and_the_logs() {
        let logs = tempfile::tempdir().unwrap();
        let message = permissions_failure_message("resolve failed", Some(logs.path()));
        assert!(
            message.starts_with("Fleetify couldn't give its interface the permissions it needs"),
            "{message}"
        );
        assert!(message.contains("\n\nresolve failed\n\n"), "{message}");
        assert!(
            message.contains(&format!("The log files are in {}", logs.path().display())),
            "{message}"
        );
        // Not the backend's message: no server, no port.
        assert!(!message.contains("local server"), "{message}");
        let without_logs = permissions_failure_message("resolve failed", None);
        assert!(
            without_logs.ends_with("Fleetify could not write its log files."),
            "{without_logs}"
        );
    }

    // ── reading the backend's start ──

    /// Start reports that change between the startup task's two reads: the
    /// backend reports its bind, and its task ends, right after the first.
    struct BindsBetweenTheReads(std::cell::Cell<bool>);

    impl BindsBetweenTheReads {
        /// True for the first read only.
        fn first_read(&self) -> bool {
            !self.0.replace(true)
        }
    }

    impl StartReports for BindsBetweenTheReads {
        fn reporter_gone(&self) -> bool {
            !self.first_read()
        }

        fn last_report(&self) -> BackendStart {
            if self.first_read() {
                BackendStart::Pending
            } else {
                BackendStart::Bound
            }
        }
    }

    #[test]
    fn a_bind_reported_between_the_two_reads_is_not_a_failed_start() {
        // Liveness is read first: the reporter was alive then, so the report
        // read after it, the bind, stands. Read the other way round, the
        // pending report and the ended task would make a false "can't start".
        let reports = BindsBetweenTheReads(std::cell::Cell::new(false));
        assert_eq!(observe_start(&reports), BackendStart::Bound);
    }

    #[test]
    fn the_start_is_read_from_the_reports_as_they_stand() {
        let (tx, rx) = watch::channel(BackendStart::Pending);
        assert_eq!(observe_start(&rx), BackendStart::Pending);
        tx.send(BackendStart::Bound).unwrap();
        drop(tx);
        assert_eq!(
            observe_start(&rx),
            BackendStart::Bound,
            "a bind outlives its task"
        );
        let (tx, rx) = watch::channel(BackendStart::Pending);
        drop(tx);
        assert!(
            matches!(observe_start(&rx), BackendStart::Failed(_)),
            "a task that ended without a report never bound"
        );
    }

    // ── the app page's load ──

    #[test]
    fn a_finished_load_of_the_app_after_it_started_counts() {
        let guard = AppLoadGuard::default();
        assert!(!guard.finished_app_load(PageLoadEvent::Started, true));
        assert!(guard.finished_app_load(PageLoadEvent::Finished, true));
    }

    #[test]
    fn a_cancelled_navigation_to_the_app_does_not_count() {
        // WebKitGTK reports it as load-failed, then Finished with the URL
        // already the app's, and no Started (Committed) for it.
        let guard = AppLoadGuard::default();
        assert!(!guard.finished_app_load(PageLoadEvent::Finished, true));
        // After the placeholder's own load, too.
        let guard = AppLoadGuard::default();
        assert!(!guard.finished_app_load(PageLoadEvent::Started, false));
        assert!(!guard.finished_app_load(PageLoadEvent::Finished, false));
        assert!(!guard.finished_app_load(PageLoadEvent::Finished, true));
    }

    #[test]
    fn each_finished_load_of_the_app_needs_its_own_start() {
        let guard = AppLoadGuard::default();
        assert!(!guard.finished_app_load(PageLoadEvent::Started, true));
        assert!(guard.finished_app_load(PageLoadEvent::Finished, true));
        assert!(!guard.finished_app_load(PageLoadEvent::Finished, true));
        // A load of another page started since: its Finished isn't the app's.
        assert!(!guard.finished_app_load(PageLoadEvent::Started, true));
        assert!(!guard.finished_app_load(PageLoadEvent::Started, false));
        assert!(!guard.finished_app_load(PageLoadEvent::Finished, true));
    }

    // ── IPC from the app's origin ──

    use std::collections::{BTreeMap, BTreeSet};

    use tauri::ipc::{Origin, RuntimeAuthority, RuntimeCapability};
    use tauri::utils::acl::capability::{Capability, CapabilityFile};
    use tauri::utils::acl::manifest::Manifest;
    use tauri::utils::acl::resolved::Resolved;
    use tauri::utils::acl::APP_ACL_KEY;
    use tauri::utils::platform::Target;

    use crate::app_commands::APP_COMMANDS;
    use crate::shell::ipc::BROWSER_EMBED_LABEL;

    /// `capabilities/default.json`, which the runtime capability mirrors.
    fn default_capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap()
    }

    /// The app's `tauri.conf.json`.
    fn app_config() -> tauri::Config {
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap()
    }

    /// Its `devUrl`.
    fn dev_url() -> Url {
        url("http://localhost:3000")
    }

    fn remote(s: &str) -> Origin {
        Origin::Remote { url: url(s) }
    }

    /// The ACL tauri-build compiled for this crate, as `generate_context!`
    /// embeds it: the plugin and app manifests, and the capability files.
    fn compiled_acl() -> (BTreeMap<String, Manifest>, BTreeMap<String, Capability>) {
        let manifests = include_str!(concat!(env!("OUT_DIR"), "/acl-manifests.json"));
        let capabilities = include_str!(concat!(env!("OUT_DIR"), "/capabilities.json"));
        (
            serde_json::from_str(manifests).unwrap(),
            serde_json::from_str(capabilities).unwrap(),
        )
    }

    /// The IPC authority of one app run: the compiled ACL, resolved and built
    /// the way `generate_context!` does it (`runtime_authority!`), plus the
    /// capability setup adds for `runtime_origin`, when there is one.
    fn authority_with(runtime_origin: Option<String>) -> RuntimeAuthority {
        let (acl, capabilities) = compiled_acl();
        let resolved = Resolved::resolve(&acl, capabilities, Target::current()).unwrap();
        let mut authority = tauri::runtime_authority!(acl, resolved);
        if let Some(origin) = runtime_origin {
            authority
                .add_capability(runtime_capability(&origin))
                .unwrap();
        }
        authority
    }

    /// A release build with its backend on `backend_port`, as setup sets up
    /// its IPC.
    fn release_authority(backend_port: u16) -> RuntimeAuthority {
        authority_with(runtime_remote_origin(true, backend_port, 3000, None))
    }

    /// Each way the app runs: its IPC authority, and the origin its main
    /// webview loads the app from.
    fn app_runs() -> Vec<(&'static str, RuntimeAuthority, Origin)> {
        let debug =
            |vite| authority_with(runtime_remote_origin(false, 8765, vite, Some(&dev_url())));
        vec![
            ("debug, Vite on devUrl", debug(3000), Origin::Local),
            (
                "debug, Vite on another port",
                debug(3017),
                remote("http://localhost:3017/"),
            ),
            (
                "release",
                release_authority(8765),
                remote("http://127.0.0.1:8765/"),
            ),
            (
                "release, backend on another port",
                release_authority(8899),
                remote("http://127.0.0.1:8899/settings"),
            ),
        ]
    }

    /// Checked by name on top of every app command: commands the UI can't do
    /// without, and core ones from `default.json`'s other permissions.
    const SPOT_CHECKS: [&str; 6] = [
        "auth_sign_in",
        "config_get",
        "window_start_dragging",
        "plugin:app|version",
        "plugin:event|listen",
        "plugin:dialog|open",
    ];

    /// `allow-<command>`: the permission tauri-build generates for an app
    /// command, underscores turned into hyphens.
    fn allow_permission(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    #[test]
    fn the_app_loads_from_the_backend_in_release_and_from_vite_in_debug() {
        assert_eq!(app_origin(true, 8765, 3000), "http://127.0.0.1:8765");
        assert_eq!(app_origin(true, 8899, 3017), "http://127.0.0.1:8899");
        assert_eq!(app_origin(false, 8765, 3000), "http://localhost:3000");
        assert_eq!(app_origin(false, 8899, 3017), "http://localhost:3017");
    }

    #[test]
    fn a_release_build_gets_its_backend_origin_on_every_port() {
        // Flipped from Task 14: the default port gets the runtime capability
        // too, now that default.json allows no remote origin.
        assert_eq!(
            runtime_remote_origin(true, 8765, 3000, None),
            Some("http://127.0.0.1:8765".to_string())
        );
        assert_eq!(
            runtime_remote_origin(true, 8899, 3017, None),
            Some("http://127.0.0.1:8899".to_string())
        );
        // A release build without Tauri's custom-protocol feature (`cargo
        // build --release`) treats devUrl as local; the backend isn't it.
        assert_eq!(
            runtime_remote_origin(true, 8765, 3000, Some(&dev_url())),
            Some("http://127.0.0.1:8765".to_string())
        );
    }

    #[test]
    fn a_debug_build_on_the_local_dev_url_needs_no_runtime_capability() {
        // Tauri treats devUrl as local, and default.json covers local origins.
        assert_eq!(
            runtime_remote_origin(false, 8765, 3000, Some(&dev_url())),
            None
        );
        assert_eq!(
            runtime_remote_origin(false, 8899, 3000, Some(&url("http://localhost:3000/"))),
            None
        );
        // dev:tauri:wt moves devUrl to the worktree's Vite port.
        assert_eq!(
            runtime_remote_origin(false, 8765, 3017, Some(&url("http://localhost:3017"))),
            None
        );
    }

    #[test]
    fn a_debug_build_off_the_local_dev_url_gets_its_vite_origin() {
        assert_eq!(
            runtime_remote_origin(false, 8765, 3017, Some(&dev_url())),
            Some("http://localhost:3017".to_string())
        );
        // No local devUrl: a debug build of the bundle (`tauri build --debug`).
        assert_eq!(
            runtime_remote_origin(false, 8765, 3000, None),
            Some("http://localhost:3000".to_string())
        );
        // The same port on another host is another origin.
        assert_eq!(
            runtime_remote_origin(false, 8765, 3000, Some(&url("http://127.0.0.1:3000"))),
            Some("http://localhost:3000".to_string())
        );
    }

    #[test]
    fn the_runtime_origin_is_where_the_window_loads_the_app() {
        for (release, backend, vite, local) in [
            (true, 8765, 3000, None),
            (true, 8899, 3000, None),
            (false, 8765, 3017, Some(dev_url())),
            (true, 9000, 4000, None),
        ] {
            let origin = runtime_remote_origin(release, backend, vite, local.as_ref()).unwrap();
            assert_eq!(origin, app_origin(release, backend, vite));
            let app_url: Url = origin.parse().unwrap();
            assert!(is_app_page(&app_url.join("/settings").unwrap(), &app_url));
        }
    }

    #[test]
    fn the_local_app_url_is_dev_url_in_dev_mode_only() {
        // Mirrors Tauri's get_app_url, which is_local_url checks origins
        // against: devUrl in dev mode, a frontendDist URL otherwise.
        let mut config = app_config();
        assert_eq!(local_app_url(&config, true), Some(dev_url()));
        // A release bundle serves the bundled dist (`../dist`) on tauri://.
        assert_eq!(local_app_url(&config, false), None);
        config.build.frontend_dist = Some(FrontendDist::Url(url("http://127.0.0.1:9000")));
        assert_eq!(
            local_app_url(&config, false),
            Some(url("http://127.0.0.1:9000"))
        );
    }

    #[test]
    fn the_runtime_capability_is_default_json_for_one_origin() {
        let default = default_capability();
        let CapabilityFile::Capability(capability) =
            runtime_capability("http://127.0.0.1:8899").build()
        else {
            panic!("a single capability");
        };
        assert_eq!(
            capability.remote.map(|remote| remote.urls),
            Some(vec!["http://127.0.0.1:8899".to_string()])
        );
        assert!(!capability.local, "it allows that one remote origin only");
        assert_eq!(serde_json::json!(capability.webviews), default["webviews"]);
        assert_eq!(capability.webviews, [MAIN_WEBVIEW]);
        assert!(
            capability.windows.is_empty(),
            "scoped by webview, as default.json is: {:?}",
            capability.windows
        );
        let permissions: Vec<&str> = capability
            .permissions
            .iter()
            .map(|permission| permission.identifier().get())
            .collect();
        assert_eq!(serde_json::json!(permissions), default["permissions"]);
        assert_ne!(
            serde_json::json!(capability.identifier),
            default["identifier"]
        );
    }

    #[test]
    fn default_json_grants_the_core_permissions_and_the_app_commands() {
        let default = default_capability();
        let permissions = default["permissions"].as_array().unwrap();
        for permission in [
            "core:default",
            "core:event:default",
            "dialog:allow-open",
            "app-commands",
        ] {
            assert!(
                permissions.contains(&serde_json::json!(permission)),
                "default.json doesn't grant {permission}: {permissions:?}"
            );
        }
        assert_eq!(default["permissions"], serde_json::json!(IPC_PERMISSIONS));
    }

    #[test]
    fn default_json_applies_to_the_main_webview_only() {
        let default = default_capability();
        assert_eq!(default["webviews"], serde_json::json!([MAIN_WEBVIEW]));
        // A window scope matches every webview in that window: the browser
        // panel's child webview in the main window too.
        assert!(
            default.get("windows").is_none(),
            "default.json is scoped by window: {}",
            default["windows"]
        );
    }

    #[test]
    fn default_json_allows_local_origins_only() {
        let default = default_capability();
        // No remote origin at all: setup grants the app's own at runtime
        // (runtime_capability), and nothing else is ever allowed.
        assert!(
            default.get("remote").is_none(),
            "default.json allows remote origins: {}",
            default["remote"]
        );
        // Local origins (devUrl in dev mode) are covered: with an app
        // manifest, Tauri checks app commands from them too.
        let capability: Capability = serde_json::from_value(default).unwrap();
        assert!(capability.remote.is_none());
        assert!(capability.local);
    }

    #[test]
    fn the_app_commands_set_allows_exactly_the_app_commands() {
        let (acl, _) = compiled_acl();
        let app = acl
            .get(APP_ACL_KEY)
            .expect("build.rs declares the app's ACL manifest");
        let set = app
            .permission_sets
            .get("app-commands")
            .expect("permissions/app-commands.toml defines the app-commands set");
        let listed: BTreeSet<String> = set.permissions.iter().cloned().collect();
        assert_eq!(
            listed.len(),
            set.permissions.len(),
            "the app-commands set lists a permission twice"
        );
        let expected: BTreeSet<String> = APP_COMMANDS.iter().map(|c| allow_permission(c)).collect();
        let missing: Vec<_> = expected.difference(&listed).collect();
        let extra: Vec<_> = listed.difference(&expected).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "permissions/app-commands.toml must list allow-<command> for exactly APP_COMMANDS.\n\
             missing: {missing:?}\n\
             not an app command: {extra:?}"
        );
        for command in APP_COMMANDS {
            let permission = &app.permissions[&allow_permission(command)];
            assert_eq!(permission.commands.allow, [command.to_string()]);
            assert!(permission.commands.deny.is_empty());
        }
    }

    #[test]
    fn the_main_webview_can_call_every_app_command_from_the_app_origin() {
        for (run, authority, origin) in app_runs() {
            for command in SPOT_CHECKS.iter().chain(APP_COMMANDS) {
                assert!(
                    authority
                        .resolve_access(command, MAIN_WINDOW, MAIN_WEBVIEW, &origin)
                        .is_some(),
                    "{run}: {command} is refused to the main webview from {origin}"
                );
            }
        }
    }

    #[test]
    fn the_browser_panel_can_call_no_command_at_all() {
        // The browser panel is a child webview in the main window. Even on a
        // page from the app's own origin it gets nothing: no app command and
        // no core one.
        for (run, authority, origin) in app_runs() {
            for command in SPOT_CHECKS.iter().chain(APP_COMMANDS) {
                assert!(
                    authority
                        .resolve_access(command, MAIN_WINDOW, BROWSER_EMBED_LABEL, &origin)
                        .is_none(),
                    "{run}: {command} is allowed to the browser panel from {origin}"
                );
            }
        }
    }

    #[test]
    fn a_release_build_refuses_the_dev_server_origin() {
        // The main webview has no navigation guard: a page it ends up on at
        // http://localhost:3000, a user's own dev server say, gets nothing.
        let authority = release_authority(8765);
        let refused = |origin: &Origin| {
            authority
                .resolve_access("pty_spawn", MAIN_WINDOW, MAIN_WEBVIEW, origin)
                .is_none()
        };
        assert!(refused(&remote("http://localhost:3000/")));
        // Its own origin still gets it: the refusal is about the origin.
        assert!(!refused(&remote("http://127.0.0.1:8765/")));
    }

    #[test]
    fn a_release_build_on_another_port_refuses_the_default_backend_origin() {
        // Something else may answer on 8765 (AnkiConnect listens there).
        let authority = release_authority(8899);
        let refused = |origin: &Origin| {
            authority
                .resolve_access("pty_spawn", MAIN_WINDOW, MAIN_WEBVIEW, origin)
                .is_none()
        };
        assert!(refused(&remote("http://127.0.0.1:8765/")));
        assert!(!refused(&remote("http://127.0.0.1:8899/")));
    }

    // ── IPC from frames inside the app (WebKitGTK postMessage) ──
    //
    // wry's WebKitGTK backend tags every postMessage IPC request with the
    // main frame's URL, whichever frame sent it, and Tauri checks the ACL
    // against that URL. A cross-origin frame in the main webview holding the
    // invoke key (the Preview pane) would get the app page's permissions.
    // The vendored runtime gives those requests an origin no capability
    // matches (vendor/tauri-runtime-wry/FLEETIFY_PATCH.md).

    use tauri_runtime_wry::{postmessage_ipc_request, POSTMESSAGE_IPC_ORIGIN, WEBKITGTK};

    /// A postMessage IPC request as wry's WebKitGTK backend hands it over:
    /// the main frame's URL, and the message the page posted.
    fn posted_request(main_frame_url: &str, body: &str) -> tauri::http::Request<String> {
        tauri::http::Request::builder()
            .uri(main_frame_url)
            .body(body.to_string())
            .unwrap()
    }

    /// A message with the invoke key, as `ipc-protocol.js` posts it.
    const POSTED_PTY_SPAWN: &str = r#"{"cmd":"pty_spawn","callback":1,"error":2,"payload":{},"options":{},"__TAURI_INVOKE_KEY__":"key"}"#;

    /// Where Tauri takes an IPC request's origin from: the request's URI
    /// (`ipc/protocol.rs`, `handle_ipc_message`).
    fn request_url(request: &tauri::http::Request<String>) -> Url {
        Url::parse(&request.uri().to_string()).unwrap()
    }

    /// The origin Tauri checks an IPC request from `url` as, for an http URL
    /// (`Webview::is_local_url`): local when it shares the origin of the
    /// run's local app URL (`devUrl` in dev mode), remote otherwise.
    fn acl_origin(url: &Url, local_app_url: Option<&Url>) -> Origin {
        match local_app_url {
            Some(local) if local.origin() == url.origin() => Origin::Local,
            _ => Origin::Remote { url: url.clone() },
        }
    }

    #[test]
    fn postmessage_ipc_requests_get_an_origin_of_their_own_on_webkitgtk() {
        let rewritten = postmessage_ipc_request(
            posted_request("http://127.0.0.1:8765/settings", POSTED_PTY_SPAWN),
            true,
        );
        assert_eq!(rewritten.uri().to_string(), POSTMESSAGE_IPC_ORIGIN);
        assert_eq!(
            rewritten.body(),
            POSTED_PTY_SPAWN,
            "the message is untouched"
        );

        // wry reports the sending frame's own URL on macOS, and iframes
        // can't post at all on Windows: nothing changes there.
        let kept = postmessage_ipc_request(
            posted_request("http://127.0.0.1:8765/settings", POSTED_PTY_SPAWN),
            false,
        );
        assert_eq!(kept.uri().to_string(), "http://127.0.0.1:8765/settings");
        assert_eq!(kept.body(), POSTED_PTY_SPAWN);

        // This build: WebKitGTK on Linux and the BSDs (wry's gtk targets).
        let gtk = cfg!(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        ));
        assert_eq!(WEBKITGTK, gtk);
        let here = postmessage_ipc_request(
            posted_request("http://localhost:3000/", POSTED_PTY_SPAWN),
            WEBKITGTK,
        );
        let expected = if gtk {
            POSTMESSAGE_IPC_ORIGIN
        } else {
            "http://localhost:3000/"
        };
        assert_eq!(here.uri().to_string(), expected);
    }

    #[test]
    fn a_frame_cant_borrow_the_app_pages_permissions_through_postmessage_ipc() {
        // The origin is never one Tauri treats as the app's own: not its
        // tauri:// or custom schemes, not devUrl, and `.invalid` never
        // resolves (RFC 6761), so no page can ever have it.
        let sentinel = url(POSTMESSAGE_IPC_ORIGIN);
        assert_eq!(sentinel.scheme(), "http");
        assert_eq!(sentinel.host_str(), Some("postmessage-ipc.invalid"));
        assert_ne!(sentinel.origin(), dev_url().origin());
        // pty_spawn, the command that runs a shell, is checked with the rest.
        assert!(APP_COMMANDS.contains(&"pty_spawn"));

        let debug =
            |vite| authority_with(runtime_remote_origin(false, 8765, vite, Some(&dev_url())));
        // Each way the app runs: its authority, the main page's URL (what
        // wry tags a frame's message with) and the run's local app URL.
        let runs = [
            (
                "debug, Vite on devUrl",
                debug(3000),
                "http://localhost:3000/",
                Some(dev_url()),
            ),
            (
                "debug, Vite on another port",
                debug(3017),
                "http://localhost:3017/",
                Some(dev_url()),
            ),
            (
                "release",
                release_authority(8765),
                "http://127.0.0.1:8765/",
                None,
            ),
            (
                "release, backend on another port",
                release_authority(8899),
                "http://127.0.0.1:8899/settings",
                None,
            ),
        ];
        for (run, authority, main_frame_url, local_app_url) in runs {
            // As on WebKitGTK, whatever this test runs on: which builds
            // rewrite is the test above's and the next one's business.
            let request =
                postmessage_ipc_request(posted_request(main_frame_url, POSTED_PTY_SPAWN), true);
            let origin = acl_origin(&request_url(&request), local_app_url.as_ref());
            for webview in [MAIN_WEBVIEW, BROWSER_EMBED_LABEL] {
                for command in SPOT_CHECKS.iter().chain(APP_COMMANDS) {
                    assert!(
                        authority
                            .resolve_access(command, MAIN_WINDOW, webview, &origin)
                            .is_none(),
                        "{run}: a postMessage request from a frame on {main_frame_url} \
                         can call {command} in webview {webview:?} (origin {origin})"
                    );
                }
            }
        }
    }

    #[test]
    fn the_vendored_runtime_rewrites_every_postmessage_ipc_request() {
        // A re-vendor must keep the patch: the handler wry calls for every
        // postMessage request hands Tauri the rewritten request. (A Windows
        // checkout may have CRLF line endings.)
        let runtime =
            include_str!("../../../vendor/tauri-runtime-wry/src/lib.rs").replace("\r\n", "\n");
        let start = runtime
            .find("fn create_ipc_handler")
            .expect("the vendored runtime has create_ipc_handler");
        let handler = &runtime[start..];
        let handler = &handler[..handler.find("\n}\n").expect("the function ends")];
        assert!(
            handler.contains("postmessage_ipc_request(request, WEBKITGTK)"),
            "create_ipc_handler must pass every request through \
             postmessage_ipc_request(request, WEBKITGTK):\n{handler}"
        );
    }
}
