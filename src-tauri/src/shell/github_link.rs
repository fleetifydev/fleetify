//! GitHub link manager = the Electron `github-link.cjs`.
//!
//! Per-Fleetify-user OAuth fallback for PR creation when the `gh` CLI
//! isn't on the machine. Keychain entries are scoped to the current
//! Fleetify user (service `"Fleetify-GitHub"`, account = `sub` from the
//! OIDC userinfo); the token NEVER crosses IPC to the renderer. REST
//! calls use the link's access_token directly from this module.
//!
//! Surface (5 IPC commands + 2 events):
//!   - `github:getLink`           → `{ ok, link, error? }`
//!   - `github:beginOAuth`        → `{ ok, link? , code? , error? }`
//!   - `github:refreshLink`       → `{ ok, link? , code? , error? }`
//!   - `github:disconnect`        → `{ ok }`
//!   - `github:openInstallation`  → `{ ok }`
//!   - events: `github-link-changed { link }`,
//!     `github-link-browser-fallback { url }`
//!
//! Faithful with the Electron flow: ping `/api/integrations/github/
//! link/{begin,poll,refresh}` on the Fleetify cloud, supersede earlier
//! beginOAuth attempts via an AbortHandle, copy-URL fallback if the
//! browser can't launch, and stable per-device id at
//! `<app_data>/device-id`.

use std::collections::HashMap;
use std::error::Error as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::shell::auth;

const KEYCHAIN_SVC: &str = "Fleetify-GitHub";

fn api_base() -> String {
    auth::issuer()
}

// ── Per-attempt supersede (one in-flight beginOAuth per Fleetify user) ─
struct Attempt {
    aborted: std::sync::atomic::AtomicBool,
    bell: Notify,
}
impl Attempt {
    fn new() -> Self {
        Self {
            aborted: std::sync::atomic::AtomicBool::new(false),
            bell: Notify::new(),
        }
    }
    fn abort(&self) {
        self.aborted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.bell.notify_waiters();
    }
    fn is_aborted(&self) -> bool {
        self.aborted.load(std::sync::atomic::Ordering::SeqCst)
    }
}

static INFLIGHT: OnceLock<Mutex<HashMap<String, std::sync::Arc<Attempt>>>> = OnceLock::new();
fn inflight() -> &'static Mutex<HashMap<String, std::sync::Arc<Attempt>>> {
    INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── Keychain helpers (Fleetify-GitHub / <user_sub>) ──────────────
fn entry(user_id: &str) -> keyring::Entry {
    keyring::Entry::new(KEYCHAIN_SVC, user_id).expect("keychain entry for Fleetify-GitHub")
}

pub async fn get_link() -> Option<Value> {
    let uid = auth::get_user_id().await?;
    let raw = entry(&uid).get_password().ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

async fn write_link(payload: &Value) -> anyhow::Result<()> {
    let uid = auth::get_user_id()
        .await
        .ok_or_else(|| anyhow::anyhow!("no fleetify user id"))?;
    let s = serde_json::to_string(payload)?;
    entry(&uid)
        .set_password(&s)
        .map_err(|e| anyhow::anyhow!("keychain: {e}"))
}

async fn delete_link() {
    if let Some(uid) = auth::get_user_id().await {
        let _ = entry(&uid).delete_credential();
    }
}

// ── Device id (stable per machine) ────────────────────────────────
static DEVICE_ID: OnceLock<String> = OnceLock::new();
fn random_hex16() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect::<String>()
}
fn get_device_id(app: &AppHandle) -> String {
    if let Some(s) = DEVICE_ID.get() {
        return s.clone();
    }
    let dir = match tauri::Manager::path(app).app_data_dir() {
        Ok(d) => d,
        Err(_) => PathBuf::from("."),
    };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("device-id");
    let id = std::fs::read_to_string(&file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let id = random_hex16();
            let _ = std::fs::write(&file, &id);
            id
        });
    let _ = DEVICE_ID.set(id.clone());
    id
}

// ── Broadcast (Tauri emit ≡ Electron broadcastLinkChanged) ────────
fn broadcast_link_changed(app: &AppHandle, link: Option<&Value>) {
    let _ = app.emit("github-link-changed", json!({ "link": link }));
}
fn broadcast_browser_fallback(app: &AppHandle, url: &str) {
    let _ = app.emit("github-link-browser-fallback", json!({ "url": url }));
}

fn fail(code: &str, error: &str) -> Value {
    json!({ "ok": false, "code": code, "error": error })
}

// Log target used by every span in this module. Filter the live log
// stream with `RUST_LOG=github-link=debug` (or `=trace` for poll
// iteration noise) to scope output to the OAuth bridge only.
const LOG_TARGET: &str = "github-link";

// ── beginOAuth ───────────────────────────────────────────────────
pub async fn begin_oauth(app: AppHandle) -> Value {
    let poll_interval = Duration::from_millis(2000);
    let max_duration = Duration::from_secs(5 * 60);

    let issuer = api_base();
    tracing::info!(target: LOG_TARGET, %issuer, "begin_oauth: entry");

    let Some(uid) = auth::get_user_id().await else {
        tracing::warn!(target: LOG_TARGET, "begin_oauth: NO_USER (auth::get_user_id() = None)");
        return fail("NO_USER", "Fleetify sign-in required.");
    };
    tracing::debug!(target: LOG_TARGET, uid = %uid, "begin_oauth: resolved Fleetify user id");

    // 1. /begin
    let bearer = match auth::get_access_token(false).await {
        Some(v) => v.get("token").and_then(|t| t.as_str()).map(String::from),
        None => None,
    };
    let Some(bearer) = bearer else {
        tracing::warn!(target: LOG_TARGET, "begin_oauth: NO_TOKEN (auth::get_access_token() returned no usable token)");
        return fail("NO_TOKEN", "No Fleetify access token.");
    };
    // bearer length is safe to log — token itself never is.
    tracing::debug!(target: LOG_TARGET, bearer_len = bearer.len(), "begin_oauth: bearer acquired");

    let device_id = get_device_id(&app);
    let begin_url = format!("{}/api/integrations/github/link/begin", issuer);
    tracing::info!(
        target: LOG_TARGET,
        url = %begin_url,
        device_id = %device_id,
        "begin_oauth: POST /begin"
    );

    let begin: Value = match reqwest::Client::new()
        .post(&begin_url)
        .bearer_auth(&bearer)
        .json(&json!({ "device_id": device_id }))
        .send()
        .await
    {
        Ok(r) => {
            let status = r.status();
            // Capture body as text first so we can log it on failure
            // regardless of whether it was actually JSON. Many gateways
            // return HTML or plain text on 502/504 and the prior code
            // would silently coerce that to `{}` and surface the
            // generic "Begin failed." message with no clue why.
            let body_text = r.text().await.unwrap_or_default();
            let body: Value = serde_json::from_str(&body_text).unwrap_or_else(|_| json!({}));
            if !status.is_success() {
                let code = body
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or("BEGIN_FAILED")
                    .to_string();
                let msg = body
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Begin failed.")
                    .to_string();
                // Truncate large HTML error pages so the log line stays
                // grep-able. Full body is still in the renderer's
                // network panel if the user wants the rest.
                let body_preview: String = body_text.chars().take(512).collect();
                tracing::warn!(
                    target: LOG_TARGET,
                    status = status.as_u16(),
                    code = %code,
                    message = %msg,
                    body_preview = %body_preview,
                    "begin_oauth: /begin returned non-2xx"
                );
                return fail(&code, &msg);
            }
            tracing::info!(
                target: LOG_TARGET,
                status = status.as_u16(),
                "begin_oauth: /begin returned 2xx"
            );
            body
        }
        Err(e) => {
            // Source chain teases out the underlying transport error
            // (DNS failure, connection refused, TLS handshake, etc.) —
            // reqwest's top-level Display often just says "error sending
            // request" without the actual cause.
            let source = e.source().map(|s| s.to_string()).unwrap_or_default();
            tracing::error!(
                target: LOG_TARGET,
                url = %begin_url,
                error = %e,
                source = %source,
                "begin_oauth: /begin transport error"
            );
            return fail("BEGIN_FAILED", &e.to_string());
        }
    };

    let authorize_url = begin
        .get("authorize_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = begin
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if authorize_url.is_empty() || state.is_empty() {
        tracing::warn!(
            target: LOG_TARGET,
            authorize_url_present = !authorize_url.is_empty(),
            state_present = !state.is_empty(),
            body_keys = ?begin.as_object().map(|o| o.keys().collect::<Vec<_>>()),
            "begin_oauth: BAD_BEGIN (server returned 2xx but missing authorize_url/state)"
        );
        return fail("BAD_BEGIN", "Server didn't return authorize_url/state.");
    }
    tracing::info!(
        target: LOG_TARGET,
        state_len = state.len(),
        "begin_oauth: authorize_url + state received, opening browser"
    );

    // 2. Open browser (clipboard fallback). We surface the URL via a
    //    broadcast event so the dialog can show a copy-link toast.
    let open_ok = ::open::that(&authorize_url).is_ok();
    if !open_ok {
        tracing::warn!(target: LOG_TARGET, "begin_oauth: browser launch failed, falling back to clipboard");
        let clip_ok = arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(authorize_url.clone()))
            .is_ok();
        if !clip_ok {
            tracing::error!(target: LOG_TARGET, "begin_oauth: clipboard fallback also failed");
            return fail(
                "BROWSER_OPEN_FAILED",
                "Couldn't launch a browser and couldn't copy the URL either.",
            );
        }
        broadcast_browser_fallback(&app, &authorize_url);
    } else {
        tracing::debug!(target: LOG_TARGET, "begin_oauth: browser launched");
    }

    // 3. Poll loop with per-attempt supersede.
    let attempt = std::sync::Arc::new(Attempt::new());
    {
        let mut map = inflight().lock().unwrap();
        if let Some(prior) = map.insert(uid.clone(), attempt.clone()) {
            tracing::info!(target: LOG_TARGET, "begin_oauth: superseding earlier in-flight attempt for this user");
            prior.abort();
        }
    }

    let started = Instant::now();
    let poll_timeout = Duration::from_secs(10);
    let client = reqwest::Client::builder()
        .timeout(poll_timeout)
        .build()
        .unwrap_or_default();
    let poll_url_template = format!("{}/api/integrations/github/link/poll", issuer);
    tracing::info!(
        target: LOG_TARGET,
        poll_url = %poll_url_template,
        max_duration_s = max_duration.as_secs(),
        "begin_oauth: entering poll loop"
    );

    let mut poll_n: u32 = 0;
    let result = loop {
        if attempt.is_aborted() {
            tracing::info!(target: LOG_TARGET, polls = poll_n, "begin_oauth: aborted by supersede or caller");
            break fail("ABORTED", "Connect was cancelled.");
        }
        if started.elapsed() >= max_duration {
            tracing::warn!(target: LOG_TARGET, polls = poll_n, "begin_oauth: TIMEOUT (5min cap exceeded)");
            break fail("TIMEOUT", "Authorization timed out. Try again.");
        }

        // Sleep that wakes early on abort.
        tokio::select! {
            _ = tokio::time::sleep(poll_interval) => {}
            _ = attempt.bell.notified() => {
                tracing::info!(target: LOG_TARGET, polls = poll_n, "begin_oauth: aborted mid-sleep");
                break fail("ABORTED", "Connect was cancelled.");
            }
        }

        poll_n += 1;

        // Fresh bearer in case the access token rolled mid-flow.
        let fresh = auth::get_access_token(false)
            .await
            .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(String::from));
        let Some(fresh) = fresh else {
            tracing::debug!(target: LOG_TARGET, poll = poll_n, "begin_oauth: poll skipped — no fresh bearer this tick");
            continue;
        };

        let r = client
            .get(format!(
                "{}?state={}",
                poll_url_template,
                urlencoding_minimal(&state),
            ))
            .bearer_auth(&fresh)
            .send()
            .await;
        let r = match r {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(target: LOG_TARGET, poll = poll_n, error = %e, "begin_oauth: poll transport error (will retry)");
                continue;
            }
        };
        let status = r.status().as_u16();
        tracing::trace!(target: LOG_TARGET, poll = poll_n, status, "begin_oauth: poll response");
        if status == 202 {
            continue;
        }
        if status == 410 {
            tracing::warn!(target: LOG_TARGET, poll = poll_n, "begin_oauth: poll returned 410 EXPIRED");
            break fail("EXPIRED", "Link request expired.");
        }
        if status == 403 {
            tracing::warn!(target: LOG_TARGET, poll = poll_n, "begin_oauth: poll returned 403 FORBIDDEN (state/user mismatch)");
            break fail("FORBIDDEN", "State/user mismatch.");
        }
        if !(200..=299).contains(&status) {
            tracing::debug!(target: LOG_TARGET, poll = poll_n, status, "begin_oauth: poll non-2xx, retrying");
            continue;
        }
        let body: Value = r.json().await.unwrap_or_else(|_| json!({}));
        let status_field = body.get("status").and_then(|v| v.as_str()).unwrap_or("");
        match status_field {
            "pending" => continue,
            "expired" => {
                tracing::warn!(target: LOG_TARGET, poll = poll_n, "begin_oauth: body.status == expired");
                break fail("EXPIRED", "Link request expired.");
            }
            "complete" => {
                let payload = match body.get("payload") {
                    Some(p) => p.clone(),
                    None => {
                        tracing::debug!(target: LOG_TARGET, poll = poll_n, "begin_oauth: complete without payload, retrying");
                        continue;
                    }
                };
                let mut link = payload;
                link["connected_at"] = Value::String(chrono::Utc::now().to_rfc3339());
                if let Err(e) = write_link(&link).await {
                    tracing::error!(target: LOG_TARGET, error = %e, "begin_oauth: KEYCHAIN write failed");
                    break fail("KEYCHAIN", &e.to_string());
                }
                broadcast_link_changed(&app, Some(&link));
                tracing::info!(
                    target: LOG_TARGET,
                    polls = poll_n,
                    elapsed_s = started.elapsed().as_secs(),
                    "begin_oauth: completed successfully"
                );
                break json!({ "ok": true, "link": link });
            }
            other => {
                tracing::debug!(target: LOG_TARGET, poll = poll_n, status = %other, "begin_oauth: unknown body.status, retrying");
                continue;
            }
        }
    };

    // Clear the map entry only if it still points at *this* attempt.
    {
        let mut map = inflight().lock().unwrap();
        if let Some(cur) = map.get(&uid) {
            if std::sync::Arc::ptr_eq(cur, &attempt) {
                map.remove(&uid);
            }
        }
    }
    result
}

// ── cancelOAuth ──────────────────────────────────────────────────
// Best-effort abort of the in-flight `begin_oauth` for the current
// Fleetify user. The in-progress poll loop wakes via `Attempt::abort`
// → it breaks out with `fail("ABORTED", ...)` on its next tick, the
// awaiting renderer promise settles, and the Connect buttons re-enable.
//
// Idempotent: if no attempt is in flight (user already finished, browser
// fallback timed out, second click), this is a no-op and still returns
// ok. The renderer should always be safe to call this on cleanup paths
// without checking whether an OAuth is actually running.
pub async fn cancel_oauth() -> Value {
    let Some(uid) = auth::get_user_id().await else {
        // No signed-in user → no attempt could exist; treat as cancelled.
        tracing::debug!(target: LOG_TARGET, "cancel_oauth: no user, no-op");
        return json!({ "ok": true });
    };
    let attempt = {
        let map = inflight().lock().unwrap();
        map.get(&uid).cloned()
    };
    match attempt {
        Some(a) => {
            a.abort();
            tracing::info!(target: LOG_TARGET, "cancel_oauth: aborted in-flight attempt");
        }
        None => {
            tracing::debug!(target: LOG_TARGET, "cancel_oauth: no in-flight attempt for user");
        }
    }
    json!({ "ok": true })
}

/// Refresh the GitHub access_token using the link's refresh_token.
pub async fn refresh_link(app: AppHandle) -> Value {
    let Some(current) = get_link().await else {
        return fail("NOT_LINKED", "No GitHub link to refresh.");
    };
    let bearer = auth::get_access_token(false)
        .await
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(String::from));
    let Some(bearer) = bearer else {
        return fail("NO_TOKEN", "No Fleetify access token.");
    };
    let rt = current
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let r = reqwest::Client::new()
        .post(format!(
            "{}/api/integrations/github/link/refresh",
            api_base()
        ))
        .bearer_auth(&bearer)
        .json(&json!({ "refresh_token": rt }))
        .send()
        .await;
    let r = match r {
        Ok(r) => r,
        Err(e) => return fail("REFRESH_FAILED", &e.to_string()),
    };
    let status = r.status();
    let body: Value = r.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let code = body
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("REFRESH_FAILED")
            .to_string();
        let msg = body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Refresh failed.")
            .to_string();
        return fail(&code, &msg);
    }
    let now_s = chrono::Utc::now().timestamp();
    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let new_refresh = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| rt.clone());
    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(28_800);
    let new_access_expires = chrono::DateTime::<chrono::Utc>::from_timestamp(now_s + expires_in, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default();
    let new_refresh_expires = body
        .get("refresh_token_expires_in")
        .and_then(|v| v.as_i64())
        .and_then(|s| chrono::DateTime::<chrono::Utc>::from_timestamp(now_s + s, 0))
        .map(|dt| dt.to_rfc3339())
        .or_else(|| {
            current
                .get("refresh_expires_at")
                .and_then(|v| v.as_str())
                .map(String::from)
        });

    let mut updated = current.clone();
    updated["access_token"] = Value::String(access_token);
    updated["refresh_token"] = Value::String(new_refresh);
    updated["access_expires_at"] = Value::String(new_access_expires);
    if let Some(s) = new_refresh_expires {
        updated["refresh_expires_at"] = Value::String(s);
    }
    if let Err(e) = write_link(&updated).await {
        return fail("KEYCHAIN", &e.to_string());
    }
    broadcast_link_changed(&app, Some(&updated));
    json!({ "ok": true, "link": updated })
}

pub async fn disconnect(app: AppHandle) {
    if let Some(uid) = auth::get_user_id().await {
        if let Some(prior) = inflight().lock().unwrap().get(&uid).cloned() {
            prior.abort();
        }
    }
    delete_link().await;
    broadcast_link_changed(&app, None);
}

pub async fn open_installation() -> Value {
    let url = match get_link().await {
        Some(l) => l
            .get("installation_id")
            .and_then(|v| {
                v.as_i64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(String::from))
            })
            .map(|id| format!("https://github.com/settings/installations/{id}"))
            .unwrap_or_else(|| "https://github.com/settings/installations".to_string()),
        None => "https://github.com/settings/installations".to_string(),
    };
    match ::open::that(&url) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// Tiny percent-encoder for the poll state param. Faithful with
// encodeURIComponent's safe set (A–Z, a–z, 0–9, `-._~`). Avoids pulling
// the full `urlencoding` crate.
fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let safe = matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_matches_js_encodeuricomponent() {
        assert_eq!(urlencoding_minimal("abc-_.~"), "abc-_.~");
        assert_eq!(urlencoding_minimal(" "), "%20");
        assert_eq!(urlencoding_minimal("/?&="), "%2F%3F%26%3D");
        // Lowercase letters preserved as-is — no double-encode.
        assert_eq!(urlencoding_minimal("foo"), "foo");
    }

    #[test]
    fn random_hex16_is_32_hex_chars() {
        let id = random_hex16();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
