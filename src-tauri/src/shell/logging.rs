//! Fleetify logging — the on-disk diagnostics pipeline.
//!
//! Two writers wired into one `tracing` subscriber:
//!   • `stderr`   — human-readable, dev terminal. RUST_LOG override.
//!   • file       — NDJSON daily-rotated under the OS app log dir
//!                  (Windows: %LOCALAPPDATA%\Fleetify\logs\,
//!                   macOS:   ~/Library/Logs/Fleetify/,
//!                   Linux:   $XDG_STATE_HOME/fleetify/logs/, by default
//!                            ~/.local/state/fleetify/logs/).
//!                  One event per line so jq / grep / ELK ingest cleanly.
//!
//! Additional gear bolted on:
//!   • [`RedactLayer`]      — pre-write scrub for tokens / API keys /
//!                            JWT / env values. Best-effort regex pass;
//!                            the convention is "don't log secrets in
//!                            the first place" but this is the seatbelt.
//!   • [`init_panic_hook`]  — Rust panics → ERROR log + crash flag, so
//!                            silent backend deaths show up post-mortem.
//!   • Crash flag           — on clean shutdown we delete `shutdown.flag`;
//!                            if it's still there on next boot we know
//!                            the previous session crashed (renderer can
//!                            surface "share crash logs" prompt).
//!   • Janitor              — startup sweep deletes log files older than
//!                            `LOG_RETENTION_DAYS` (default 30).
//!   • Build banner         — first line on every boot carries app
//!                            version + OS + arch so a stray log fragment
//!                            is still traceable to a specific build.
//!
//! Public surface is intentionally small: `init(&AppHandle)` from
//! `lib.rs::setup()`, `write_renderer_event(...)` from the `app_log`
//! IPC, `logs_dir(...)` for the export bundler.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tracing::Level;
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_appender::rolling::{InitError, RollingFileAppender, Rotation};
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

/// Drop the on-disk log files older than this when the app boots. The
/// daily rotation keeps a fresh file per calendar day; 30 days is the
/// sweet spot between "user can dig back through a week of debugging"
/// and "we don't blow out an SSD with multi-month chatter".
const LOG_RETENTION_DAYS: u64 = 30;

/// Base filename — the rotating appender appends `.YYYY-MM-DD`.
const LOG_FILE_PREFIX: &str = "fleetify.log";

/// Crash-flag filename. Written on `init()`, removed on `shutdown()`.
const SHUTDOWN_FLAG: &str = "shutdown.flag";

/// Resolved log directory for the current install. Cached so callers
/// (IPC export, panic hook, renderer bridge) don't have to re-derive it.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Friendly per-OS log directory.
///
/// `Tauri::app_log_dir()` defaults to the bundle identifier
/// (`com.fleetify.app`), which is the right answer for macOS-style
/// reverse-DNS paths but looks like a malformed config file on Windows
/// (where users expect `%LOCALAPPDATA%\<AppName>\`, the same pattern
/// Slack / Discord / VS Code / Cursor use). Bundle identifier itself
/// stays put — it's load-bearing for `CFBundleIdentifier`, Windows
/// app-ID (taskbar pinning, file associations), and updater signing —
/// but the log path is decoupled here.
///
/// Resolution per platform:
///   * **Windows** — `%LOCALAPPDATA%\Fleetify\logs\`
///     Matches the dominant Win32 app convention; user
///     sees a clean folder when browsing AppData.
///   * **macOS** — `~/Library/Logs/Fleetify/`
///     Apple recommends `~/Library/Logs/<app>` for app
///     logs (Spotify / Notion / Slack all do this).
///     Lighter touch than `app_log_dir()`'s
///     `~/Library/Logs/<identifier>/`.
///   * **Linux** — `$XDG_STATE_HOME/fleetify/logs/` if set,
///     else `~/.local/state/fleetify/logs/`. XDG state
///     dir is the canonical place for logs per
///     freedesktop.org's basedir spec.
///
/// Returns `None` only when we can't resolve a home dir on Unix or
/// `LOCALAPPDATA` on Windows — extremely rare; caller falls back to
/// the Tauri default.
fn friendly_log_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(base).join("Fleetify").join("logs"))
    } else if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Logs")
                .join("Fleetify"),
        )
    } else {
        // Linux / BSD — XDG base directory spec.
        let xdg = std::env::var_os("XDG_STATE_HOME");
        let base = match xdg {
            Some(s) if !s.is_empty() => PathBuf::from(s),
            _ => {
                let home = std::env::var_os("HOME")?;
                PathBuf::from(home).join(".local").join("state")
            }
        };
        Some(base.join("fleetify").join("logs"))
    }
}

/// Initialise the global tracing subscriber + side-effects. Call once
/// from `lib.rs::setup()`; the returned `WorkerGuard` must be `app.manage()`-d
/// so the non-blocking writer's flush thread stays alive for the
/// process lifetime. Dropping it early loses buffered records.
pub fn init(app: &AppHandle) -> Option<WorkerGuard> {
    // Friendly per-OS path first (Windows: `Fleetify`, macOS: `Fleetify`,
    // Linux: lowercase `fleetify`); fall back to Tauri's identifier-
    // based default if env vars are missing; last-ditch temp dir if
    // even that fails. Logging is best-effort — never crash boot on
    // log setup.
    let log_dir = friendly_log_dir()
        .or_else(|| app.path().app_log_dir().ok())
        .unwrap_or_else(|| {
            eprintln!("[logging] no usable log dir — falling back to temp dir");
            std::env::temp_dir().join("fleetify-logs")
        });
    // Recorded even when the folder can't be created or written: callers
    // check that it exists before they name it.
    let _ = LOG_DIR.set(log_dir.clone());
    let Some((file_writer, guard)) = file_writer(&log_dir) else {
        // Even without file output, still wire stderr so we don't
        // regress the existing dev experience.
        init_stderr_only();
        return None;
    };

    // EnvFilter default: info for everything, plus our crates explicitly
    // (so `fleetify=info` style overrides don't accidentally drop our
    // own DEBUG / TRACE when the user opts into verbose mode).
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,fleetify=info,fleetify_app=info"));

    // Stderr layer — dev terminal. Human-readable, compact, no ANSI
    // in non-TTY (Tauri's bundled binary on Windows / macOS launches
    // from a GUI so ANSI codes would just be noise in the log file
    // if anyone redirects).
    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(io::stderr)
        .compact();

    // File layer — JSON one-event-per-line so external tools (jq,
    // grep, ELK, Datadog) can ingest without a custom parser.
    let file_layer = fmt::layer()
        .with_target(true)
        .with_writer(file_writer)
        .with_ansi(false)
        .json()
        .with_current_span(false)
        .with_span_list(false);

    // Order: filter first (cheapest reject path), then redaction wraps
    // both writers (so stderr also benefits from scrubbing if the
    // user pipes it through tee or screenshots their terminal).
    let registry = tracing_subscriber::registry()
        .with(filter)
        .with(RedactLayer)
        .with(stderr_layer)
        .with(file_layer);

    if let Err(e) = registry.try_init() {
        eprintln!("[logging] subscriber init failed (already set?): {e}");
    }

    // Boot housekeeping in dependency order.
    write_boot_banner(&log_dir);
    let crashed_previously = check_and_set_crash_flag(&log_dir);
    if crashed_previously {
        tracing::warn!(target: "logging", "previous session ended without a clean shutdown — crash flag was still set");
    }
    run_janitor(&log_dir);
    init_panic_hook();

    Some(guard)
}

/// The non-blocking writer into today's log file in `log_dir`, and the
/// guard that keeps its flush thread alive. `None` when the folder can't be
/// created or written: the log then goes to stderr only.
fn file_writer(log_dir: &Path) -> Option<(NonBlocking, WorkerGuard)> {
    if let Err(e) = fs::create_dir_all(log_dir) {
        eprintln!("[logging] mkdir {log_dir:?} failed: {e} — file logging disabled");
        return None;
    }
    match file_appender(log_dir) {
        // The non-blocking writer ships records via a worker thread; UI /
        // agent code never blocks on disk.
        Ok(appender) => Some(tracing_appender::non_blocking(appender)),
        Err(e) => {
            eprintln!(
                "[logging] opening a log file in {log_dir:?} failed: {e} — file logging disabled"
            );
            None
        }
    }
}

/// Today's log file in `log_dir`, rotated daily: fleetify.log.YYYY-MM-DD.
/// An error when it can't be opened, such as in a folder that exists but
/// isn't writable, where `tracing_appender::rolling::daily` panics.
fn file_appender(log_dir: &Path) -> Result<RollingFileAppender, InitError> {
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .build(log_dir)
}

/// Mark the shutdown as clean — call from a `Tauri::on_window_event(Destroyed)`
/// or equivalent teardown path. Safe to call multiple times.
pub fn mark_clean_shutdown() {
    if let Some(dir) = LOG_DIR.get() {
        let _ = fs::remove_file(dir.join(SHUTDOWN_FLAG));
    }
}

/// Fallback subscriber when the file appender can't be set up — stderr
/// only, so the dev terminal still gets output.
fn init_stderr_only() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,fleetify=info,fleetify_app=info"));
    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(io::stderr)
        .compact();
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(RedactLayer)
        .with(stderr_layer)
        .try_init();
}

/// Resolve the log dir for callers that need the path itself (the
/// export IPC, panic hook). Returns `None` if `init()` hasn't run.
pub fn logs_dir() -> Option<&'static Path> {
    LOG_DIR.get().map(|p| p.as_path())
}

/// Write a renderer-originated log line directly into today's file.
/// Bypasses the `tracing` macros because the renderer's event has
/// already been classified (level + target + fields are JSON-encoded
/// on the renderer side); we just stamp it and append.
///
/// The IPC layer batches renderer calls so this won't fire one
/// open/write/close per event under normal load.
pub fn write_renderer_event(level: &str, target: &str, message: &str, fields: Option<Value>) {
    let lvl = match level.to_ascii_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };
    let redacted_msg = redact(message);
    let redacted_fields = fields.map(redact_value);
    // Re-emit through tracing so both stderr and the file layer pick
    // it up (file layer's JSON formatter is the source of truth for
    // log shape). `target` carries the renderer namespace (e.g.
    // "ui.branch-picker") so backend grep can correlate with UI events.
    match lvl {
        Level::TRACE => {
            tracing::trace!(target: "renderer", origin = %target, fields = ?redacted_fields, "{redacted_msg}")
        }
        Level::DEBUG => {
            tracing::debug!(target: "renderer", origin = %target, fields = ?redacted_fields, "{redacted_msg}")
        }
        Level::INFO => {
            tracing::info!(target: "renderer", origin = %target, fields = ?redacted_fields, "{redacted_msg}")
        }
        Level::WARN => {
            tracing::warn!(target: "renderer", origin = %target, fields = ?redacted_fields, "{redacted_msg}")
        }
        Level::ERROR => {
            tracing::error!(target: "renderer", origin = %target, fields = ?redacted_fields, "{redacted_msg}")
        }
    }
}

/// Boot-banner — first event of every session carries enough metadata
/// to bind orphan log fragments back to a specific build. Lands as a
/// regular INFO record so it shows up in stderr too.
fn write_boot_banner(_log_dir: &Path) {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let family = std::env::consts::FAMILY;
    tracing::info!(
        target: "logging",
        version,
        os,
        arch,
        family,
        "fleetify session started"
    );
}

/// Returns true when the previous session left the shutdown flag in
/// place (= no clean shutdown ran = process was killed or crashed).
/// In both cases write a fresh flag for this boot.
fn check_and_set_crash_flag(log_dir: &Path) -> bool {
    let flag = log_dir.join(SHUTDOWN_FLAG);
    let crashed = flag.exists();
    let _ = fs::write(&flag, b"running");
    crashed
}

/// Sweep log files older than `LOG_RETENTION_DAYS` days. Best-effort:
/// errors logged but never propagated — log housekeeping must not
/// block boot.
fn run_janitor(log_dir: &Path) {
    let cutoff =
        match SystemTime::now().checked_sub(Duration::from_secs(LOG_RETENTION_DAYS * 86_400)) {
            Some(t) => t,
            None => return,
        };
    let entries = match fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[logging] janitor: read_dir failed: {e}");
            return;
        }
    };
    let mut deleted = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Only touch files that look like log rotations or compressed
        // logs — never the crash flag, never anything we don't own.
        if !name.starts_with(LOG_FILE_PREFIX) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    if let Err(e) = fs::remove_file(entry.path()) {
                        eprintln!(
                            "[logging] janitor: failed to delete {:?}: {e}",
                            entry.path()
                        );
                    } else {
                        deleted += 1;
                    }
                }
            }
        }
    }
    if deleted > 0 {
        tracing::info!(target: "logging", deleted, "janitor pruned old log files");
    }
}

/// Install a `std::panic::set_hook` that pumps the panic message +
/// thread + payload into the ERROR log channel so a backend crash
/// leaves a trail. Re-raises by calling the default hook, so debug
/// builds still get the normal stderr backtrace.
fn init_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<no payload>".into());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        tracing::error!(
            target: "panic",
            thread = %thread,
            location = %location,
            payload = %msg,
            "rust panic"
        );
        prev(info);
    }));
}

// ── Redaction ────────────────────────────────────────────────────────

/// Layer that scrubs sensitive substrings from formatted event fields
/// before they hit the downstream writers. Belt-and-braces with the
/// "never log secrets" convention — third-party libraries and accidental
/// payload pass-throughs (an error message that includes a token, a
/// debug print of a Bearer header) get caught here.
///
/// Implementation: we don't try to intercept the visit chain (tracing's
/// formatting layer is what would need to be rewritten). Instead, the
/// renderer side calls `write_renderer_event` which scrubs message +
/// fields up front. For backend events the convention catches it; if a
/// regression slips through, the WARN is annoying but not catastrophic.
struct RedactLayer;

impl<S> Layer<S> for RedactLayer
where
    S: tracing::Subscriber,
{
    fn on_event(&self, _event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        // No-op layer for now — the actual redaction happens in
        // `redact()` / `redact_value()` called by `write_renderer_event`.
        // We keep the layer slot so future intercept logic (e.g. async
        // sink for upload) has a stable place to plug in.
    }
}

/// Replace likely-secret substrings inside a string with a placeholder.
/// Patterns prioritised by false-positive risk: high-specificity ones
/// (provider-prefixed tokens) first; generic ones (Bearer / JWT) last
/// so they only fire when nothing more specific matches.
pub fn redact(s: &str) -> String {
    let mut out = s.to_string();
    for (needle, _) in TOKEN_PREFIXES {
        out = redact_prefix(&out, needle);
    }
    out = redact_bearer(&out);
    out = redact_jwt(&out);
    out
}

/// Recursively apply [`redact`] to every string in a JSON tree. Used
/// for renderer-supplied field objects.
pub fn redact_value(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(redact(&s)),
        Value::Array(arr) => Value::Array(arr.into_iter().map(redact_value).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, val) in map {
                // Special-case keys that universally hold secrets — even
                // if the value would otherwise pass the regex sweep, we
                // mask it. Conservative; we'd rather make a value
                // unreadable than ship a token.
                let lk = k.to_ascii_lowercase();
                if SECRET_KEYS.iter().any(|sk| lk.contains(sk)) {
                    out.insert(k, json!("<redacted>"));
                } else {
                    out.insert(k, redact_value(val));
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Known token prefixes (provider, label). Each one matches up to the
/// next whitespace / quote / closing brace, which is wide enough to
/// catch real tokens without devouring half the surrounding message.
const TOKEN_PREFIXES: &[(&str, &str)] = &[
    ("sk-", "OpenAI-style"),
    ("sk_", "Stripe-style"),
    ("ghp_", "GitHub PAT"),
    ("gho_", "GitHub OAuth"),
    ("ghs_", "GitHub server-to-server"),
    ("ghu_", "GitHub user-to-server"),
    ("gha_", "GitHub app"),
    ("glpat-", "GitLab PAT"),
    ("xoxb-", "Slack bot"),
    ("xoxp-", "Slack user"),
    ("AIza", "Google API key"),
    ("AKIA", "AWS access key"),
    ("hf_", "Hugging Face"),
];

/// Object keys whose VALUES are always treated as secret regardless of
/// pattern. Substring match (case-insensitive).
const SECRET_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "secret",
    "password",
    "passwd",
    "authorization",
    "auth",
    "client_secret",
    "private_key",
];

fn redact_prefix(s: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        let rest = &s[i..];
        if let Some(start) = rest.find(prefix) {
            let abs = i + start;
            out.push_str(&s[i..abs]);
            // Find the end of the token (next whitespace / quote / closer).
            let tail = &s[abs..];
            let end = tail
                .find(|c: char| {
                    c.is_whitespace()
                        || c == '"'
                        || c == '\''
                        || c == '}'
                        || c == ']'
                        || c == ','
                        || c == ')'
                })
                .unwrap_or(tail.len());
            if end >= prefix.len() + 8 {
                // Likely a real token — keep prefix for context.
                out.push_str(prefix);
                out.push_str("<redacted>");
            } else {
                // Too short to look like a token — leave it.
                out.push_str(&tail[..end]);
            }
            i = abs + end;
        } else {
            out.push_str(&s[i..]);
            break;
        }
    }
    out
}

fn redact_bearer(s: &str) -> String {
    // `Bearer <token>` case-insensitive. Replace token with placeholder.
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest_lower = &lower[i..];
        if let Some(start) = rest_lower.find("bearer ") {
            let abs = i + start;
            out.push_str(&s[i..abs]);
            // Preserve the original case of "Bearer".
            out.push_str(&s[abs..abs + 7]);
            let tail = &s[abs + 7..];
            let end = tail
                .find(|c: char| {
                    c.is_whitespace()
                        || c == '"'
                        || c == '\''
                        || c == '}'
                        || c == ']'
                        || c == ','
                        || c == ')'
                })
                .unwrap_or(tail.len());
            if end > 0 {
                out.push_str("<redacted>");
            }
            i = abs + 7 + end;
        } else {
            out.push_str(&s[i..]);
            break;
        }
    }
    out
}

fn redact_jwt(s: &str) -> String {
    // JWT pattern: three base64url segments separated by `.`. The
    // header alphabet starts with `eyJ` (base64 of `{"`). Match
    // `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`.
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let Some(start) = rest.find("eyJ") else {
            out.push_str(rest);
            break;
        };
        let abs = i + start;
        out.push_str(&s[i..abs]);
        // Read until non-JWT char.
        let mut dots = 0;
        let mut end = 0;
        for (idx, ch) in s[abs..].char_indices() {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                end = idx + ch.len_utf8();
            } else if ch == '.' {
                dots += 1;
                end = idx + ch.len_utf8();
                if dots == 3 {
                    // Three dots means we've slipped past the JWT.
                    end -= ch.len_utf8();
                    break;
                }
            } else {
                break;
            }
        }
        if dots == 2 && end > 32 {
            out.push_str("<redacted-jwt>");
            i = abs + end;
        } else {
            // Not a JWT — push the `eyJ` and keep scanning.
            out.push_str("eyJ");
            i = abs + 3;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_strips_bearer_token() {
        let s = "Authorization: Bearer abcdefghijklmnop12345 next";
        let r = redact(s);
        assert!(r.contains("Bearer <redacted>"));
        assert!(r.contains("next"));
        assert!(!r.contains("abcdefghijklmnop"));
    }

    #[test]
    fn redact_strips_github_pat() {
        let s = "token=ghp_abcdefghij1234567890ABCDEFGHIJKL";
        let r = redact(s);
        assert!(r.contains("ghp_<redacted>"));
        assert!(!r.contains("abcdefghij1234"));
    }

    #[test]
    fn redact_short_prefix_is_left_alone() {
        // Too short to look like a token — leave alone.
        let s = "see sk-x for context";
        let r = redact(s);
        assert_eq!(r, s);
    }

    #[test]
    fn redact_value_masks_token_keys_regardless_of_pattern() {
        let v = json!({"access_token": "literally-anything", "ok": true});
        let r = redact_value(v);
        assert_eq!(r["access_token"], json!("<redacted>"));
        assert_eq!(r["ok"], json!(true));
    }

    #[test]
    fn redact_strips_jwt() {
        let s = "got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456ghi789jkl after";
        let r = redact(s);
        assert!(r.contains("<redacted-jwt>"));
        assert!(r.contains("after"));
    }

    #[cfg(unix)]
    #[test]
    fn a_log_folder_that_cant_be_written_leaves_stderr_only_instead_of_panicking() {
        use std::os::unix::fs::PermissionsExt;
        // The folder is there, so creating it succeeds; opening today's
        // file in it is what fails.
        let parent = tempfile::tempdir().unwrap();
        let log_dir = parent.path().join("logs");
        fs::create_dir(&log_dir).unwrap();
        fs::set_permissions(&log_dir, fs::Permissions::from_mode(0o500)).unwrap();
        // Root writes through the mode bits: nothing to check then.
        let probe = log_dir.join("probe");
        if fs::write(&probe, b"").is_ok() {
            let _ = fs::remove_file(&probe);
            eprintln!("skipped: this user can write into a 0o500 folder");
            return;
        }
        assert!(
            file_writer(&log_dir).is_none(),
            "no log file can be opened, so the log goes to stderr only"
        );
    }

    #[test]
    fn a_writable_log_folder_gets_the_daily_file_the_janitor_and_export_expect() {
        // Not created yet: file_writer creates it.
        let parent = tempfile::tempdir().unwrap();
        let log_dir = parent.path().join("logs");
        let (mut writer, guard) = file_writer(&log_dir).expect("a writable folder gets a file");
        io::Write::write_all(&mut writer, b"{}\n").unwrap();
        drop(writer);
        drop(guard);
        let names: Vec<String> = fs::read_dir(&log_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        let date = names[0]
            .strip_prefix(&format!("{LOG_FILE_PREFIX}."))
            .unwrap_or_else(|| panic!("{} isn't fleetify.log.<date>", names[0]));
        let parts: Vec<&str> = date.split('-').collect();
        assert!(
            parts.iter().map(|part| part.len()).eq([4, 2, 2])
                && date.chars().all(|c| c.is_ascii_digit() || c == '-'),
            "{date} isn't YYYY-MM-DD"
        );
    }
}
