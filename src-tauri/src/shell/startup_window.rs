//! The main window at startup: what it shows before the app can load, and
//! when it loads the app and shows itself.
//!
//! The window used to load the app's URL the moment it was built. When the
//! embedded backend was not listening yet, the engine showed its error page
//! ("Could not connect to 127.0.0.1: Connection refused") and never retried,
//! so a slow start left a dead window. Now the window starts, hidden, on a
//! placeholder page that Tauri serves itself (scheme [`PLACEHOLDER_SCHEME`]).
//! It loads the app once the app's URL answers and is shown when the app page
//! has finished loading. If the app has not answered within [`SLOW_START`],
//! the window is shown with the placeholder, "Starting Fleetify…", and the
//! app loads as soon as it answers.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::http::{header, Response, StatusCode};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Url, WebviewWindow};
use tokio::sync::Notify;

/// Label of the main window.
pub const MAIN_WINDOW: &str = "main";

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

/// A page-load handler for the main window: signals `app_page_loaded` each
/// time a page of the app at `app_url` finishes loading. A signal sent
/// before anyone waits is kept, so an early load is never missed.
pub fn signal_app_page_loaded(
    app_url: Url,
    app_page_loaded: Arc<Notify>,
) -> impl Fn(WebviewWindow, PageLoadPayload<'_>) + Send + Sync + 'static {
    move |_window, payload| {
        if payload.event() == PageLoadEvent::Finished && is_app_page(payload.url(), &app_url) {
            app_page_loaded.notify_one();
        }
    }
}

/// What the startup task does after one poll of the app's URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The app answered: load it in the window.
    LoadApp,
    /// The app is slow to answer: show the window with the placeholder.
    ShowPlaceholder,
    /// Poll again.
    KeepWaiting,
}

/// The next step after one poll: whether the app answered, how long the task
/// has waited, and whether the placeholder is on screen already. Polling has
/// no cap: past [`SLOW_START`] the placeholder goes up once, and the app
/// still loads the moment it answers.
pub fn next_step(app_answered: bool, waited: Duration, placeholder_shown: bool) -> Step {
    if app_answered {
        Step::LoadApp
    } else if waited >= SLOW_START && !placeholder_shown {
        Step::ShowPlaceholder
    } else {
        Step::KeepWaiting
    }
}

/// Loads the app in `window` once `app_url` answers, then shows the window.
///
/// The window was built hidden on the placeholder page. Any HTTP answer from
/// `app_url` counts, as before: even a 404 lets the renderer show the
/// failure. The window then loads the app and is shown when the app page has
/// finished loading (`app_page_loaded`, from [`signal_app_page_loaded`]), or
/// after [`PAGE_LOAD_FALLBACK`]. Past [`SLOW_START`] without an answer it is
/// shown with the placeholder, and the app loads once it answers.
pub async fn load_app_when_ready(
    window: WebviewWindow,
    app_url: Url,
    app_page_loaded: Arc<Notify>,
    boot_start: Instant,
) {
    let client = reqwest::Client::builder()
        .timeout(POLL_TIMEOUT)
        .build()
        .unwrap_or_default();
    let started = Instant::now();
    let mut placeholder_shown = false;
    loop {
        let answered = client.get(app_url.as_str()).send().await.is_ok();
        match next_step(answered, started.elapsed(), placeholder_shown) {
            Step::LoadApp => break,
            Step::ShowPlaceholder => {
                tracing::warn!(
                    target: "fleetify::startup",
                    waited_ms = started.elapsed().as_millis() as u64,
                    "{app_url} has not answered yet; showing the startup placeholder"
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
        let soon = Duration::from_millis(300);
        assert_eq!(next_step(true, soon, false), Step::LoadApp);
        assert_eq!(next_step(true, SLOW_START * 4, false), Step::LoadApp);
        // After the placeholder went up, too.
        assert_eq!(next_step(true, SLOW_START * 4, true), Step::LoadApp);
    }

    #[test]
    fn the_window_stays_hidden_while_startup_is_quick() {
        assert_eq!(
            next_step(false, Duration::from_millis(300), false),
            Step::KeepWaiting
        );
        assert_eq!(
            next_step(false, SLOW_START - Duration::from_millis(1), false),
            Step::KeepWaiting
        );
    }

    #[test]
    fn a_slow_start_shows_the_placeholder_once_and_keeps_waiting() {
        assert_eq!(next_step(false, SLOW_START, false), Step::ShowPlaceholder);
        assert_eq!(
            next_step(false, SLOW_START + Duration::from_secs(1), false),
            Step::ShowPlaceholder
        );
        // Already on screen: no cap, just keep polling.
        assert_eq!(next_step(false, SLOW_START, true), Step::KeepWaiting);
        assert_eq!(
            next_step(false, Duration::from_secs(600), true),
            Step::KeepWaiting
        );
    }

    #[test]
    fn the_slow_start_threshold_is_the_old_reveal_cap() {
        assert_eq!(SLOW_START, Duration::from_secs(15));
    }
}
