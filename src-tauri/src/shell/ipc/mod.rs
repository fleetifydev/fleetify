//! Tauri command layer = the Electron `ipcMain.handle` surface. Phase 1b
//! ships the 5 `window.fleetify` auth commands; the ~51 `window.electronAPI`
//! commands (fs/git/pty/github/window/dialog/…) land in Phase 1c+.

use std::path::PathBuf;

use tauri::{Emitter, Manager};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::shell::startup_window::MAIN_WINDOW;
use crate::shell::{
    ai_git, auth, config, feedback, git, github_link, head_watcher, logging, pty, voice,
};

#[tauri::command]
pub async fn auth_sign_in() -> serde_json::Value {
    match auth::sign_in().await {
        Ok(t) => {
            let user = auth::userinfo().await.ok();
            serde_json::json!({ "ok": true, "user": user, "expiresAt": t.expires_at })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.message, "kind": e.kind }),
    }
}

#[tauri::command]
pub async fn auth_sign_out() -> serde_json::Value {
    auth::sign_out().await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn auth_userinfo() -> serde_json::Value {
    auth::userinfo().await.unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub async fn auth_get_access_token(force: Option<bool>) -> serde_json::Value {
    match auth::get_access_token(force.unwrap_or(false)).await {
        Some(v) => v,
        None => serde_json::Value::Null,
    }
}

#[tauri::command]
pub async fn auth_get_state() -> serde_json::Value {
    auth::get_state().await
}

// ── window.fleetify.getApiToken ───────────────────────────────────
// This run's backend API token: setup (lib.rs) generates it, manages it and
// passes it to the embedded backend. The renderer asks for it here.

#[tauri::command]
pub fn backend_api_token(token: tauri::State<'_, fleetify_backend::access::ApiToken>) -> String {
    token.as_str().to_owned()
}

// ── window.electronAPI.{getConfig,setConfig} ──────────────────────
// Persisted under Tauri's per-app data dir (parity with the Electron
// `electron-store`-style JSON-on-disk the original used).

#[tauri::command]
pub async fn config_get(app: tauri::AppHandle) -> serde_json::Value {
    match app.path().app_data_dir() {
        Ok(dir) => config::load_config_from(&dir),
        Err(_) => serde_json::json!({}),
    }
}

/// Replaces `fleet.config.json` with `config`, except the `telemetry`
/// section: that keeps what the file holds, since only the privacy switches
/// save it (`config::replace_config_keeping_telemetry`). A failed save
/// answers `{ ok: false, error }`.
#[tauri::command]
pub async fn config_set(app: tauri::AppHandle, config: serde_json::Value) -> serde_json::Value {
    let saved = match app.path().app_data_dir() {
        Ok(dir) => config::replace_config_keeping_telemetry(&dir, config)
            .map_err(|e| format!("Couldn't save Fleetify's settings: {e}")),
        Err(e) => Err(format!("Couldn't find Fleetify's settings folder: {e}")),
    };
    match saved {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(error) => {
            tracing::warn!(error = %error, "settings not saved");
            serde_json::json!({ "ok": false, "error": error })
        }
    }
}

// ── Telemetry config (PostHog + Fleetify cloud sync) ──────────────
// Renderer fetches `{ distinct_id, posthog_enabled, cloud_enabled,
// cloud_choice }` at boot; `distinct_id` initialises posthog-js with the
// same device_id the Rust backend uses, so frontend + backend events flow
// to one PostHog person. Each setter both persists its flag AND flips the
// matching backend runtime gate live, so the PostHog worker / the cloud WS
// loop stops or starts without a restart.

#[tauri::command]
pub async fn telemetry_get_config(app: tauri::AppHandle) -> serde_json::Value {
    let device = fleetify_backend::services::telemetry::device_id::get_or_create();
    let config_dir = app.path().app_data_dir().ok();
    telemetry_config_now(device.device_id, config_dir.as_deref())
}

/// The two `_enabled` flags are the backend's live gates, not the saved
/// choices. They differ after a failed save (the gate still follows the
/// switch for this session), and the Settings card has to show what is
/// actually on. The shell sets both gates from the saved choices as soon as
/// it starts (lib.rs), before the warm-up, so the renderer's launch read
/// sees them.
///
/// `cloud_choice` is the dashboard sync choice saved in `config_dir`
/// (`config::saved_cloud_choice`): `true` or `false`, or `null` when there
/// is none. The renderer asks the dashboard question once while it is
/// `null` (`DashboardSyncNotice`), and the gate stays closed until then. A
/// settings folder that can't be found counts as a settings file that
/// can't be read: off.
fn telemetry_config_now(
    distinct_id: String,
    config_dir: Option<&std::path::Path>,
) -> serde_json::Value {
    let cloud_choice = config_dir.map_or(Some(false), config::saved_cloud_choice);
    serde_json::json!({
        "distinct_id": distinct_id,
        "posthog_enabled": fleetify_backend::services::telemetry::posthog::is_enabled(),
        "cloud_enabled": fleetify_backend::services::telemetry::cloud_enabled(),
        "cloud_choice": cloud_choice,
    })
}

/// Whether the user has set cloud sync since launch, in Settings or by
/// answering the dashboard question (`telemetry_set_cloud_enabled`). The
/// startup restore (lib.rs) runs at the end of the boot warm-up task: after
/// the backend has reported its start, a wait with no time limit, and once
/// it has bound, after the health wait (up to 14 s) and the provider
/// warm-up. The clone-token push runs in a task of its own and isn't waited
/// for. The restore can end long after launch, and must not undo a choice
/// the user made meanwhile, including one whose save failed. The setter and
/// the restore both hold this lock while they touch the gate, so whichever
/// runs second sees the other.
static CLOUD_SYNC_SET_SINCE_LAUNCH: tokio::sync::Mutex<bool> = tokio::sync::Mutex::const_new(false);

/// The user's change to the cloud gate: records that the user chose, then
/// applies it.
async fn set_cloud_sync(set_since_launch: &tokio::sync::Mutex<bool>, enabled: bool) {
    let mut set = set_since_launch.lock().await;
    *set = true;
    fleetify_backend::services::telemetry::set_cloud_enabled(enabled).await;
}

/// The end of the startup restore. It can only close the gate: when no
/// saved choice says on (closing also purges what is still queued), and
/// only if the user hasn't set it since launch. It never opens the gate;
/// the early restore already opened it when the saved choice is on.
async fn finish_cloud_sync_restore_with(
    set_since_launch: &tokio::sync::Mutex<bool>,
    saved_on: bool,
) {
    let set = set_since_launch.lock().await;
    if !*set && !saved_on {
        fleetify_backend::services::telemetry::set_cloud_enabled(false).await;
    }
}

pub(crate) async fn finish_cloud_sync_restore(saved_on: bool) {
    finish_cloud_sync_restore_with(&CLOUD_SYNC_SET_SINCE_LAUNCH, saved_on).await;
}

/// Settings → Privacy's Fleetify-cloud sync switch, and the dashboard
/// question's buttons. Saves the choice (`config::persist_cloud_choice`),
/// then sets the backend gate: turning it off purges anything still queued
/// and drops the dashboard socket.
///
/// The gate follows the switch for this session even when the save fails,
/// but the saved choice then still decides the next launch, so the failure
/// is reported: `{ ok: false, error }`.
#[tauri::command]
pub async fn telemetry_set_cloud_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> serde_json::Value {
    let saved = match app.path().app_data_dir() {
        Ok(dir) => config::persist_cloud_choice(&dir, enabled),
        Err(e) => Err(format!("Couldn't find Fleetify's settings folder: {e}")),
    };
    if let Err(error) = &saved {
        tracing::warn!(
            error = %error,
            enabled,
            "cloud sync setting not saved; it applies until Fleetify restarts"
        );
    }
    set_cloud_sync(&CLOUD_SYNC_SET_SINCE_LAUNCH, enabled).await;
    match saved {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": format!("{error}. The change applies until Fleetify restarts."),
        }),
    }
}

/// Settings → Privacy's product analytics (PostHog) switch. Saves the
/// choice (`config::persist_posthog_choice`), then flips the backend's
/// PostHog gate live.
///
/// The gate follows the switch for this session even when the save fails,
/// but the saved choice then still decides the next launch, so the failure
/// is reported: `{ ok: false, error }`.
#[tauri::command]
pub async fn telemetry_set_posthog_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> serde_json::Value {
    let saved = match app.path().app_data_dir() {
        Ok(dir) => config::persist_posthog_choice(&dir, enabled),
        Err(e) => Err(format!("Couldn't find Fleetify's settings folder: {e}")),
    };
    if let Err(error) = &saved {
        tracing::warn!(
            error = %error,
            enabled,
            "product analytics setting not saved; it applies until Fleetify restarts"
        );
    }
    fleetify_backend::services::telemetry::posthog::set_enabled(enabled);
    match saved {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": format!("{error}. The change applies until Fleetify restarts."),
        }),
    }
}

// ── shell ─────────────────────────────────────────────────────────
/// What the renderer is told for a link `shell_open_external` won't open:
/// anything but a web or email link (see `fleetify_backend::open_external`).
const LINK_REFUSED: &str = "This link can't be opened: only web and email links are supported.";

#[tauri::command]
pub async fn shell_open_external(url: String) -> serde_json::Value {
    use fleetify_backend::open_external::{open_url, OpenError};
    match open_url(&url) {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(OpenError::Rejected(_)) => serde_json::json!({ "ok": false, "error": LINK_REFUSED }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

/// What the renderer is told for a path `shell_open_path` won't open.
const PATH_REFUSED: &str = "This file can't be opened from Fleetify.";

/// Opens a local folder, or a document file, with the system's default
/// handler: Library → "Open raw file" and the "Open in" menu's "Open folder".
/// `open_external::open_ui_path` resolves the path and opens it only when it
/// is an existing folder, or a file with a document extension: on Windows,
/// ShellExecute runs executables, scripts and shortcuts. A Windows network
/// path is refused before anything looks at it.
#[tauri::command]
pub async fn shell_open_path(path: String) -> serde_json::Value {
    use fleetify_backend::open_external::{open_ui_path, OpenPathError};
    match open_ui_path(std::path::Path::new(&path)) {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(OpenPathError::Refused(_)) => serde_json::json!({ "ok": false, "error": PATH_REFUSED }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub async fn shell_show_item_in_folder(path: String) -> serde_json::Value {
    // Reveal the item in the OS file manager with the file *selected* —
    // matches Electron's `shell.showItemInFolder` semantics every caller
    // here was written against. The previous implementation called
    // `open::that(parent_dir)` which only opened the folder; the user
    // then had to scroll/search to find the freshly-written file (and
    // for the diagnostics zip in a tmp dir, that meant scanning hundreds
    // of unrelated entries).
    //
    // Per-OS handlers:
    //   * Windows: `explorer.exe /select,<path>` — Explorer pops with
    //     the item highlighted. Path must be canonical; UNC + spaces
    //     are handled by Command's automatic argv quoting (NOT a shell).
    //   * macOS:   `open -R <path>` — Finder reveals the item.
    //   * Linux:   `dbus-send` to `org.freedesktop.FileManager1.ShowItems`
    //     which Nautilus/Nemo/Dolphin/Caja all implement. Falls back to
    //     `xdg-open <parent>` (no selection) when the D-Bus service is
    //     unavailable — better than failing entirely on a minimal WM.
    //
    // The path is checked and resolved first (`open_external::path_to_reveal`):
    // a Windows network path is refused before anything looks at it, since
    // even checking that it exists signs in to the host, and the file manager
    // is handed the item itself in its resolved folder (a symlink, not its
    // target).
    use fleetify_backend::open_external::{path_to_reveal, PathRefused};
    let p = match path_to_reveal(std::path::Path::new(&path)) {
        Ok(resolved) => resolved,
        Err(PathRefused::Unresolvable(_)) => {
            return serde_json::json!({
                "ok": false,
                "error": format!("path does not exist: {path}")
            });
        }
        Err(_) => return serde_json::json!({ "ok": false, "error": PATH_REFUSED }),
    };
    let result = reveal_in_file_manager(&p);
    match result {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer.exe returns a non-zero exit code (1) even on a
        // successful /select,<path> reveal — quirky but documented.
        // Treat spawn success as the success signal; ignore status.
        let arg = format!("/select,{}", path.display());
        fleetify_core::process::command("explorer.exe")
            .arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer /select: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        fleetify_core::process::command("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open -R: {e}"))
    }
    #[cfg(target_os = "linux")]
    {
        // FileManager1 is the freedesktop standard; every mainstream
        // Linux file manager (Nautilus / Nemo / Dolphin / Caja / Thunar
        // ≥4.18) registers it. The `array:string` payload is a list of
        // file URIs to select within their parent dirs.
        let uri = format!("file://{}", path.display());
        let dbus = fleetify_core::process::command("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{uri}"),
                "string:",
            ])
            .status();
        match dbus {
            Ok(s) if s.success() => Ok(()),
            _ => {
                // Fall back to opening the parent dir — better than
                // erroring out on a box without a FileManager1
                // implementation (sway+thunar<4.18, headless CI, etc.).
                let parent = path.parent().unwrap_or(path);
                fleetify_backend::open_external::open_path(parent)
                    .map_err(|e| format!("dbus-send unavailable and xdg-open fallback failed: {e}"))
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        fleetify_backend::open_external::open_path(path.parent().unwrap_or(path))
            .map_err(|e| e.to_string())
    }
}

// ── open in editor ────────────────────────────────────────────────
/// Editors we can launch a project folder in, in menu order.
/// (renderer id, PATH binary, display label). The renderer sends `id`
/// back to `open_in_editor`; we map it to the binary here so the wire
/// never carries a raw executable name.
const EDITOR_CANDIDATES: &[(&str, &str, &str)] = &[
    ("vscode", "code", "VS Code"),
    ("vscode-insiders", "code-insiders", "VS Code Insiders"),
    ("cursor", "cursor", "Cursor"),
    ("vs", "devenv", "Visual Studio"),
    ("sublime", "subl", "Sublime Text"),
    ("intellij", "idea", "IntelliJ IDEA"),
];

/// Map a renderer editor id to its PATH binary. Pure — unit-tested.
fn editor_bin(id: &str) -> Option<&'static str> {
    EDITOR_CANDIDATES
        .iter()
        .find(|(eid, _, _)| *eid == id)
        .map(|(_, bin, _)| *bin)
}

/// List editors installed on PATH, in menu order. `which` resolves
/// platform suffixes (e.g. `code.cmd` on Windows) so this matches what
/// `open_in_editor` will later be able to launch.
#[tauri::command]
pub async fn detect_editors() -> serde_json::Value {
    let editors: Vec<serde_json::Value> = EDITOR_CANDIDATES
        .iter()
        .filter(|(_, bin, _)| which::which(bin).is_ok())
        .map(|(id, _, label)| serde_json::json!({ "id": id, "label": label }))
        .collect();
    serde_json::json!({ "editors": editors })
}

/// The path to open in an editor, checked and resolved the way Reveal checks
/// it (`open_external::path_to_reveal`), or the message the renderer is told
/// when it is refused. It must be absolute and exist, and a Windows network
/// or device path is refused before anything looks at it, since even
/// checking that it exists signs in to the host.
fn editor_target(path: &str) -> Result<std::path::PathBuf, String> {
    use fleetify_backend::open_external::{path_to_reveal, PathRefused};
    path_to_reveal(std::path::Path::new(path)).map_err(|refused| match refused {
        PathRefused::Unresolvable(_) => format!("path does not exist: {path}"),
        _ => PATH_REFUSED.to_string(),
    })
}

/// Launch the project directory in the chosen editor. The path is checked
/// first (`editor_target`), then the resolved absolute binary is spawned
/// with the resolved path as its sole argument — same detached-spawn
/// pattern as `reveal_in_file_manager`, no shell.
#[tauri::command]
pub async fn open_in_editor(editor_id: String, path: String) -> serde_json::Value {
    let Some(bin) = editor_bin(&editor_id) else {
        return serde_json::json!({ "ok": false, "error": format!("unknown editor: {editor_id}") });
    };
    let target = match editor_target(&path) {
        Ok(target) => target,
        Err(error) => return serde_json::json!({ "ok": false, "error": error }),
    };
    let exe = match which::which(bin) {
        Ok(e) => e,
        Err(e) => {
            return serde_json::json!({ "ok": false, "error": format!("{bin} not found: {e}") })
        }
    };
    match fleetify_core::process::command(exe).arg(&target).spawn() {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("launch {bin}: {e}") }),
    }
}

// ── clipboard ─────────────────────────────────────────────────────
#[tauri::command]
pub async fn clipboard_write(text: String) -> serde_json::Value {
    match arboard::Clipboard::new().and_then(|mut c| c.set_text(text)) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

// ── browser EMBED (native child webview, IN-PANEL) ──────────────────
// A real native WKWebView overlaid INSIDE the main window at the Browser
// panel's rectangle. Same window — no separate OS window. A real (non-
// headless) engine ⇒ sharp on retina, fast, and no bot captcha. The React
// panel reports its slot's logical rect; we position the child webview
// there and keep it in sync on scroll / resize. Login state + a site's
// remembered theme PERSIST across launches via a fixed profile id.
/// The Browser panel's webview label. The vendored runtime builds the webview
/// with this label without Tauri IPC (`IPC_FREE_WEBVIEW_LABEL`, see
/// vendor/tauri-runtime-wry/FLEETIFY_PATCH.md), so the two must stay equal;
/// the startup_window tests check it.
pub(crate) const BROWSER_EMBED_LABEL: &str = "browser-embed";
const BROWSER_EMBED_PROFILE: [u8; 16] = *b"fleetbrowser0001";
// A CURRENT Safari UA so sites (Google) serve their MODERN layout instead of
// the legacy fallback the bare WKWebView UA gets. Kept as Safari (NOT Chrome)
// so it matches the real WKWebView engine — no fingerprint mismatch, no bot
// captcha.
const BROWSER_EMBED_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
// URL-fragment marker the content script uses to hand a picked element back to
// the app (read in on_navigation, never via page IPC).
// The content script hands data back by navigating to `https://fleet.internal/
// <kind>/<payload>`; on_navigation matches the marker, reads the payload, and
// cancels the navigation. A full navigation reliably fires the navigation
// delegate (WKWebView does NOT fire it for same-document hash changes).
const PICK_MARKER: &str = "fleet.internal/pick/";
const META_MARKER: &str = "fleet.internal/meta/";
const READ_MARKER: &str = "fleet.internal/read/";
// Element-select overlay, injected at document-start on every page. Exposes
// window.__fleetStartSelect(mode)/__fleetStopSelect(); modes are 'ask' (a
// press opens an action box: copy CSS/XPath/HTML, add the element to the
// chat, or write a prompt and Send — Send dispatches the agent turn
// immediately via submit:true) and 'copy:<kind>' (every press copies that
// representation and the picker stays armed). Picking triggers on
// window-capture pointerdown — see PRESS_EVT inside for why. Right-click in either mode opens a one-off menu
// (ask / copy css / xpath / component / html / text). Every capture carries a
// rich payload (selector, xpath, rect, attrs, curated computed styles,
// React/Vue component + dev source when detectable). Everything posts back
// via the fragment sentinel; {action:"copy"|"dismiss"} messages ride the
// same channel.
// Its first line is the marker the vendored runtime keeps it by: the panel
// gets no Tauri initialization scripts, only the app's marked ones
// (`IPC_FREE_SCRIPT_MARKER`).
pub(crate) const SELECT_JS: &str = r#"/* fleetify:browser-embed */
(function () {
  if (window.__fleetSelInit) return; window.__fleetSelInit = true;
  var active = false, mode = 'ask', box = null, last = null, promptHost = null, menuHost = null, bubbleHost = null, swallowClick = false, promptKey = null, cursorStyle = null;
  // Press beats click: pages like YouTube and Google sign-in install their
  // own document-level delegation long before the user arms Select, and
  // same-node capture listeners run in registration order — a late
  // document-level click listener loses that race (stopImmediatePropagation
  // in their handlers kills it outright). Window capture runs before any
  // document listener regardless of when it registered, and reacting on the
  // press also survives pages that re-render on mousedown.
  var PRESS_EVT = window.PointerEvent ? 'pointerdown' : 'mousedown';
  // Force the crosshair on EVERY element while picking: body.style.cursor
  // alone loses to any element's own cursor CSS (links, buttons, :hover
  // rules). Our box/menu live in shadow roots, which document styles never
  // reach, so they keep their normal cursors. The body fallback below stays
  // for pages whose CSP blocks injected <style> elements.
  function applyCursor() {
    if (cursorStyle) return;
    try {
      cursorStyle = document.createElement('style');
      cursorStyle.textContent = '*, *:hover { cursor: crosshair !important; }';
      (document.head || document.documentElement).appendChild(cursorStyle);
    } catch (_) { cursorStyle = null; }
  }
  function clearCursor() {
    if (cursorStyle) { try { cursorStyle.remove(); } catch (_) {} cursorStyle = null; }
  }
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c8dff;background:rgba(76,141,255,0.18);border-radius:3px;transition:left .08s ease,top .08s ease,width .08s ease,height .08s ease;display:none;left:0;top:0;width:0;height:0;box-shadow:0 0 0 1px rgba(76,141,255,0.5);';
    (document.documentElement || document.body).appendChild(box);
    return box;
  }
  function cssPath(el) {
    if (!el) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      var sel = el.nodeName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        var c = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (c) sel += '.' + c;
      }
      var p = el.parentNode;
      if (p && p.children) {
        var sibs = Array.prototype.filter.call(p.children, function (s) { return s.nodeName === el.nodeName; });
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
      }
      parts.unshift(sel);
      el = el.parentNode;
    }
    return parts.join(' > ');
  }
  function xPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [], anchored = false;
    while (el && el.nodeType === 1) {
      if (el.id) { parts.unshift('*[@id="' + el.id + '"]'); anchored = true; break; }
      var idx = 1, sib = el.previousElementSibling;
      while (sib) { if (sib.nodeName === el.nodeName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(el.nodeName.toLowerCase() + '[' + idx + ']');
      el = el.parentElement;
    }
    return (anchored ? '//' : '/') + parts.join('/');
  }
  function attrInfo(el) {
    try {
      var out = {}, keep = ['id', 'class', 'data-testid', 'aria-label', 'role', 'name', 'type', 'placeholder', 'href', 'src', 'alt', 'title', 'for'];
      for (var i = 0; i < keep.length; i++) {
        var v = el.getAttribute && el.getAttribute(keep[i]);
        if (v) out[keep[i]] = String(v).slice(0, 200);
      }
      if (el.tagName === 'INPUT' && el.type !== 'password' && el.value) out.value = String(el.value).slice(0, 120);
      return out;
    } catch (_) { return null; }
  }
  // Curated computed styles — the ones that explain how the element looks.
  // Defaults are filtered so a plain <div> contributes almost nothing.
  function styleInfo(el) {
    try {
      var cs = getComputedStyle(el), out = {};
      var keys = ['display', 'position', 'width', 'height', 'padding', 'margin', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'text-align', 'border', 'border-radius', 'gap', 'flex-direction', 'justify-content', 'align-items', 'opacity', 'overflow', 'z-index'];
      for (var i = 0; i < keys.length; i++) {
        var v = cs.getPropertyValue(keys[i]);
        if (!v || v === 'auto' || v === 'normal' || v === 'none' || v === 'visible' || v === 'static' || v === 'stretch' || v === '1' || v === '0px' || v === 'rgba(0, 0, 0, 0)' || v.indexOf('0px none') === 0 || v.indexOf('0px 0px') === 0) continue;
        out[keys[i]] = v;
      }
      return out;
    } catch (_) { return null; }
  }
  // Framework sniffing, best effort and dev-leaning: React fibers hang off a
  // __reactFiber$ key on the DOM node (component names survive any build that
  // keeps function names; file:line only in dev via _debugSource); Vue 3
  // exposes __vueParentComponent. Never throws on plain pages — every miss
  // just returns null and the payload stays selector-only.
  function frameworkInfo(el) {
    try {
      var node = el, key = null, hop = 0, k;
      while (node && hop < 4 && !key) {
        for (k in node) { if (k.indexOf('__reactFiber$') === 0) { key = k; break; } }
        if (!key) { node = node.parentElement; hop++; }
      }
      if (key) {
        var f = node[key], names = [], src = null, guard = 0, t, n, s, fn, i2;
        while (f && guard < 60) {
          t = f.type; n = null;
          if (typeof t === 'function') n = t.displayName || t.name || null;
          else if (t && typeof t === 'object') n = t.displayName || (t.render && (t.render.displayName || t.render.name)) || null;
          if (n && n !== 'Fragment' && names.indexOf(n) < 0 && names.length < 6) names.push(n);
          if (!src && f._debugSource) {
            s = f._debugSource; fn = String(s.fileName || '').replace(/\\/g, '/');
            i2 = fn.indexOf('/src/');
            if (i2 >= 0) fn = fn.slice(i2 + 1);
            src = fn + (s.lineNumber ? ':' + s.lineNumber : '');
          }
          f = f.return; guard++;
        }
        if (names.length || src) return { component: names[0] || null, tree: names, source: src };
      }
      var v = el.__vueParentComponent || (el.parentElement && el.parentElement.__vueParentComponent);
      if (v) {
        var vn = [], c = v, g = 0, ty, n2, vsrc = null;
        while (c && g < 10) {
          ty = c.type || {}; n2 = ty.name || ty.__name || null;
          if (n2 && vn.indexOf(n2) < 0 && vn.length < 6) vn.push(n2);
          if (!vsrc && ty.__file) vsrc = ty.__file;
          c = c.parent; g++;
        }
        if (vn.length || vsrc) return { component: vn[0] || null, tree: vn, source: vsrc };
      }
    } catch (_) {}
    return null;
  }
  function buildInfo(el) {
    var r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var info = {
      selector: cssPath(el),
      xpath: xPath(el),
      tag: el ? el.nodeName.toLowerCase() : '',
      text: el ? (el.innerText || el.textContent || '').trim().slice(0, 2000) : '',
      url: location.href, t: Date.now(),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      html: el ? String(el.outerHTML || '').slice(0, 1500) : ''
    };
    if (el) {
      var a = attrInfo(el); if (a && Object.keys(a).length) info.attrs = a;
      var st = styleInfo(el); if (st && Object.keys(st).length) info.styles = st;
      var fw = frameworkInfo(el);
      if (fw) {
        if (fw.component) info.component = fw.component;
        if (fw.tree && fw.tree.length) info.componentTree = fw.tree;
        if (fw.source) info.source = fw.source;
      }
    }
    return info;
  }
  function highlightEl(el) {
    var r = el.getBoundingClientRect(), b = ensureBox();
    b.style.display = 'block';
    b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
    b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
  }
  function onMove(e) {
    if (!active) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === last) return;
    if (el === menuHost || el === promptHost || el === bubbleHost) return;
    last = el;
    highlightEl(el);
  }
  function send(info) {
    try { location.href = 'https://fleet.internal/pick/' + encodeURIComponent(JSON.stringify(info)); } catch (_) {}
  }
  var KIND_LABEL = { css: 'CSS selector', xpath: 'XPath', component: 'component', html: 'HTML', text: 'text' };
  function copyValue(kind, info, el) {
    if (kind === 'css') return info.selector;
    if (kind === 'xpath') return info.xpath;
    if (kind === 'html') return String((el && el.outerHTML) || info.html || '').slice(0, 20000);
    if (kind === 'text') return info.text || '';
    if (kind === 'component') {
      if (info.source) return info.source;
      var t = (info.componentTree || []).slice();
      t.reverse();
      return t.join(' > ');
    }
    return '';
  }
  function hideBubble() {
    if (bubbleHost) { try { bubbleHost.remove(); } catch (_) {} bubbleHost = null; }
  }
  // Cursor-anchored toast for the box-less copy paths (copy mode + the
  // right-click menu) — confirmation without opening any UI.
  function showBubble(x, y, label) {
    hideBubble();
    bubbleHost = document.createElement('div');
    bubbleHost.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
    (document.documentElement || document.body).appendChild(bubbleHost);
    var root = bubbleHost.attachShadow ? bubbleHost.attachShadow({ mode: 'open' }) : bubbleHost;
    var b = document.createElement('div');
    var left = Math.max(8, Math.min(x + 12, window.innerWidth - 180));
    var top = Math.max(8, y - 34);
    b.setAttribute('style', 'position:fixed;left:' + left + 'px;top:' + top + 'px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11.5px -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;background:#1c1c1c;color:#d9d9d9;border:1px solid #3a3a3a;border-radius:7px;padding:5px 9px;box-shadow:0 6px 20px rgba(0,0,0,0.4);opacity:1;transition:opacity .25s ease .8s;');
    b.textContent = label;
    root.appendChild(b);
    setTimeout(function () { try { b.style.opacity = '0'; } catch (_) {} }, 30);
    setTimeout(hideBubble, 1200);
  }
  // Copy in THIS document — it owns the OS focus and the user gesture while
  // the user interacts with the embedded page, so the app's document is
  // unfocused and its async Clipboard API would reject (NotAllowedError).
  // Order: sync execCommand inside the gesture (works on any origin, plain
  // http included) → this page's navigator.clipboard (secure contexts) →
  // a caught last-resort message to the app.
  function copyToClipboard(value) {
    var v = String(value == null ? '' : value);
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = v;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, v.length);
      ok = !!(document.execCommand && document.execCommand('copy'));
      ta.remove();
    } catch (_) { ok = false; }
    if (ok) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).catch(function () { send({ action: 'copy', kind: 'fallback', value: v }); });
        return;
      }
    } catch (_) {}
    send({ action: 'copy', kind: 'fallback', value: v });
  }
  function doCopy(kind, info, el, x, y) {
    copyToClipboard(String(copyValue(kind, info, el) || ''));
    showBubble(x, y, '✓ Copied ' + (KIND_LABEL[kind] || kind));
  }
  function hideMenu() {
    if (menuHost) { try { menuHost.remove(); } catch (_) {} menuHost = null; }
  }
  // Right-click menu: one-off actions at the cursor, independent of the
  // sticky mode. Copy items leave the picker armed.
  function showMenu(info, el, x, y) {
    hideMenu(); hidePrompt();
    menuHost = document.createElement('div');
    menuHost.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
    (document.documentElement || document.body).appendChild(menuHost);
    var root = menuHost.attachShadow ? menuHost.attachShadow({ mode: 'open' }) : menuHost;
    var wrap = document.createElement('div');
    var W = 214;
    var left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
    var top = Math.max(8, Math.min(y, window.innerHeight - 236));
    wrap.setAttribute('style', 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:' + W + 'px;font:12.5px -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;background:#1c1c1c;color:#d9d9d9;border:1px solid #3a3a3a;border-radius:9px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,0.45);box-sizing:border-box;');
    wrap.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    var head = document.createElement('div');
    head.setAttribute('style', 'font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#4c8dff;padding:4px 8px 6px;border-bottom:1px solid #2c2c2c;margin:0 0 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    head.textContent = info.selector || info.tag || 'element';
    wrap.appendChild(head);
    function item(label, fn) {
      var it = document.createElement('button');
      it.textContent = label;
      it.setAttribute('style', 'display:block;width:100%;text-align:left;font:inherit;background:transparent;border:none;color:#d9d9d9;padding:5px 8px;border-radius:6px;cursor:pointer;');
      it.addEventListener('mouseenter', function () { it.style.background = 'rgba(255,255,255,0.07)'; });
      it.addEventListener('mouseleave', function () { it.style.background = 'transparent'; });
      it.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); fn(); });
      wrap.appendChild(it);
    }
    item('Ask about element…', function () {
      hideMenu();
      var rect = el ? el.getBoundingClientRect() : { left: 20, top: 20, bottom: 20 };
      stopPicking(true);
      showPrompt(info, rect, el);
    });
    item('Copy CSS selector', function () { hideMenu(); doCopy('css', info, el, x, y); });
    item('Copy XPath', function () { hideMenu(); doCopy('xpath', info, el, x, y); });
    if (info.component || info.source) item('Copy component', function () { hideMenu(); doCopy('component', info, el, x, y); });
    item('Copy outer HTML', function () { hideMenu(); doCopy('html', info, el, x, y); });
    if (info.text) item('Copy text', function () { hideMenu(); doCopy('text', info, el, x, y); });
    root.appendChild(wrap);
    // No outside-close listener needed: any press outside the menu host is
    // handled by onPress, which closes the menu without picking.
  }
  // Element action box, anchored at the picked element. Lives in a shadow
  // root so the host page's CSS cannot restyle it and ours cannot leak out.
  // It has to be injected INTO the page rather than drawn in the app: the
  // native webview renders above the app's DOM, so a React box at these
  // coordinates would be hidden behind the page. One box, three intents:
  // copy a representation (CSS/XPath/HTML), add the element straight to the
  // chat, or write a prompt and send both.
  function hidePrompt() {
    if (promptKey) { document.removeEventListener('keydown', promptKey, true); promptKey = null; }
    if (promptHost) { try { promptHost.remove(); } catch (_) {} promptHost = null; }
  }
  function showPrompt(info, rect, el) {
    hidePrompt();
    promptHost = document.createElement('div');
    promptHost.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
    (document.documentElement || document.body).appendChild(promptHost);
    var root = promptHost.attachShadow ? promptHost.attachShadow({ mode: 'open' }) : promptHost;
    var wrap = document.createElement('div');
    // Clamp into the viewport: an element near the right or bottom edge must
    // not push the composer off-screen.
    var W = 324, H = 128;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8));
    var top = rect.bottom + 8;
    if (top + H > window.innerHeight - 8) top = Math.max(8, rect.top - H - 8);
    wrap.setAttribute('style', 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:' + W + 'px;' +
      'font:13px -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;' +
      'background:#1c1c1c;color:#e8e8e8;border:1px solid #3a3a3a;border-radius:10px;' +
      'box-shadow:0 10px 30px rgba(0,0,0,0.45);padding:9px;box-sizing:border-box;');
    var ta = document.createElement('textarea');
    // Send = dispatch the agent turn immediately (submit:true; the composer
    // falls back to staging when it can't safely send). Add = stage only.
    function finish() { info.prompt = ta.value.trim(); info.submit = true; hidePrompt(); if (box) box.style.display = 'none'; send(info); }
    function addOnly() { info.prompt = ''; info.submit = false; hidePrompt(); if (box) box.style.display = 'none'; send(info); }
    // Dismissing must also un-arm the app's Select pill — the picking
    // listeners are already gone, so without telling the app the pill would
    // stay lit until the next manual toggle. Idempotent: the document-level
    // Escape below and the textarea's own Escape can both fire for one key.
    function dismiss() {
      if (!promptHost) return;
      hidePrompt(); if (box) box.style.display = 'none';
      try { location.href = 'https://fleet.internal/pick/' + encodeURIComponent(JSON.stringify({ action: 'dismiss' })); } catch (_) {}
    }
    // Box-wide Escape, focus-independent: the picking listeners are gone once
    // the box opens, so without a document-level handler Esc only worked
    // while the textarea kept focus. Removed again in hidePrompt.
    promptKey = function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); dismiss(); }
    };
    document.addEventListener('keydown', promptKey, true);
    var head = document.createElement('div');
    head.setAttribute('style', 'display:flex;align-items:center;gap:6px;margin:0 0 6px;');
    var tag = document.createElement('div');
    tag.setAttribute('style', 'flex:1;min-width:0;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#4c8dff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    tag.textContent = info.selector || info.tag || 'element';
    tag.setAttribute('title', info.selector || '');
    head.appendChild(tag);
    if (info.component) {
      var badge = document.createElement('div');
      badge.setAttribute('style', 'flex-shrink:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#9a9a9a;border:1px solid #333;border-radius:4px;padding:1px 5px;');
      badge.textContent = '<' + info.component + '>';
      badge.setAttribute('title', (info.componentTree || []).join(' < ') + (info.source ? '\n' + info.source : ''));
      head.appendChild(badge);
    }
    var closeB = document.createElement('button');
    closeB.textContent = '×';
    closeB.setAttribute('title', 'Dismiss (Esc)');
    closeB.setAttribute('style', 'flex-shrink:0;background:transparent;border:none;color:#8a8a8a;font-size:15px;line-height:1;cursor:pointer;padding:0 2px;');
    closeB.addEventListener('click', dismiss);
    head.appendChild(closeB);
    ta.setAttribute('placeholder', 'Ask about this element…');
    ta.setAttribute('style', 'width:100%;height:44px;resize:none;box-sizing:border-box;background:#111;color:#e8e8e8;' +
      'border:1px solid #333;border-radius:6px;padding:6px 8px;font:inherit;font-size:12.5px;outline:none;');
    var row = document.createElement('div');
    row.setAttribute('style', 'display:flex;align-items:center;gap:4px;margin-top:7px;');
    // Copy buttons copy in-page (see copyToClipboard — the app's document is
    // unfocused while the user is in this webview, so its Clipboard API
    // would reject). The box stays open so copying and asking aren't
    // mutually exclusive; focus returns to the textarea afterwards.
    function mkCopy(label, get, title) {
      var b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('title', title);
      b.setAttribute('style', 'font:inherit;font-size:11px;padding:3px 7px;border-radius:5px;cursor:pointer;background:transparent;color:#9a9a9a;border:1px solid #333;');
      b.addEventListener('click', function () {
        copyToClipboard(String(get() || ''));
        try { ta.focus(); } catch (_) {}
        b.textContent = '✓';
        setTimeout(function () { b.textContent = label; }, 900);
      });
      return b;
    }
    var copies = document.createElement('div');
    copies.setAttribute('style', 'display:flex;gap:4px;margin-right:auto;');
    copies.appendChild(mkCopy('CSS', function () { return info.selector; }, 'Copy CSS selector'));
    copies.appendChild(mkCopy('XPath', function () { return info.xpath; }, 'Copy XPath'));
    copies.appendChild(mkCopy('HTML', function () { return String((el && el.outerHTML) || info.html || '').slice(0, 20000); }, 'Copy outer HTML'));
    row.appendChild(copies);
    function mkBtn(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('style', 'font:inherit;font-size:12px;padding:4px 12px;border-radius:6px;cursor:pointer;' +
        (primary ? 'background:#4c8dff;color:#fff;border:1px solid #4c8dff;' : 'background:transparent;color:#aaa;border:1px solid #3a3a3a;'));
      return b;
    }
    var add = mkBtn('Add', false), submit = mkBtn('Send', true);
    add.setAttribute('title', 'Add element to the chat without a prompt');
    submit.setAttribute('title', 'Send to the agent now (Enter)');
    // Send icon built node-by-node, never from an HTML string: YouTube and
    // the Google sign-in pages enforce Trusted Types
    // (require-trusted-types-for 'script'), where assigning a plain string
    // as element markup THROWS — it aborted showPrompt mid-way and the box
    // never appeared on those sites. Guarded by a test that bans the setter
    // outright.
    var svgNS = 'http://www.w3.org/2000/svg';
    var icon = document.createElementNS(svgNS, 'svg');
    icon.setAttribute('width', '12'); icon.setAttribute('height', '12');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
    var iconPath1 = document.createElementNS(svgNS, 'path');
    iconPath1.setAttribute('d', 'm22 2-7 20-4-9-9-4Z');
    var iconPath2 = document.createElementNS(svgNS, 'path');
    iconPath2.setAttribute('d', 'M22 2 11 13');
    icon.appendChild(iconPath1); icon.appendChild(iconPath2);
    var sendLabel = document.createElement('span');
    sendLabel.textContent = 'Send';
    submit.textContent = '';
    submit.appendChild(icon); submit.appendChild(sendLabel);
    submit.style.display = 'inline-flex'; submit.style.alignItems = 'center'; submit.style.gap = '5px';
    add.addEventListener('click', addOnly);
    submit.addEventListener('click', finish);
    // Enter sends, Shift+Enter is a newline, Escape cancels — the composer
    // convention the rest of the app already uses.
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); dismiss(); }
      ev.stopPropagation();
    }, true);
    // Escape must also work when a copy/action button holds focus.
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); dismiss(); }
      ev.stopPropagation();
    });
    row.appendChild(add); row.appendChild(submit);
    wrap.appendChild(head); wrap.appendChild(ta); wrap.appendChild(row);
    root.appendChild(wrap);
    try { ta.focus(); } catch (_) {}
  }
  // The pick trigger (see PRESS_EVT above for why press, why window).
  function onPress(e) {
    if (!active) return;
    // Events over our own shadow hosts (menu / box / toast) retarget to the
    // host — never treat them as page picks, and never swallow their input.
    if (e.target === menuHost || e.target === promptHost || e.target === bubbleHost) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else e.stopPropagation();
    // Eat the click this press composes so the page never acts on a pick.
    swallowClick = true;
    // A press outside the open right-click menu closes it without picking.
    if (menuHost) { hideMenu(); return; }
    // A page-specific throw anywhere below would otherwise die silently and
    // read as "clicking does nothing" — surface it to the app's log instead.
    try {
      var el = document.elementFromPoint(e.clientX, e.clientY) || last;
      var info = buildInfo(el);
      if (mode !== 'ask') {
        var kind = mode.slice(5);
        if (kind === 'component' && !info.component && !info.source) {
          copyToClipboard(info.selector);
          showBubble(e.clientX, e.clientY, 'No component — copied CSS selector');
        } else {
          doCopy(kind, info, el, e.clientX, e.clientY);
        }
        return; // stay armed — copy mode is for collecting several in a row
      }
      var rect = el ? el.getBoundingClientRect() : { left: 20, top: 20, bottom: 20 };
      // Keep the highlight up so the user can still see what they picked
      // while typing; only the picking listeners go away.
      stopPicking(true);
      showPrompt(info, rect, el);
    } catch (err) {
      send({ action: 'error', message: 'pick failed: ' + String((err && err.message) || err) });
    }
  }
  // Permanent window-capture click swallower: consumes the click composed
  // from a handled press — including the one trailing an ask-pick, which
  // arrives after picking already stopped. No-ops whenever idle.
  function onClickSwallow(e) {
    if (!active && !swallowClick) return;
    if (e.target === menuHost || e.target === promptHost || e.target === bubbleHost) return;
    swallowClick = false;
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else e.stopPropagation();
  }
  window.addEventListener('click', onClickSwallow, true);
  function onContext(e) {
    if (!active) return;
    e.preventDefault(); e.stopPropagation();
    if (e.target === menuHost || e.target === promptHost || e.target === bubbleHost) return;
    try {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      last = el;
      highlightEl(el);
      showMenu(buildInfo(el), el, e.clientX, e.clientY);
    } catch (err) {
      send({ action: 'error', message: 'menu failed: ' + String((err && err.message) || err) });
    }
  }
  function onKey(e) {
    if (!active) return;
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (menuHost) { hideMenu(); return; }
    stop();
    // Un-arm the app's Select pill too — the listeners are already gone.
    send({ action: 'dismiss' });
  }
  function start(m) {
    // Mode is applied even when already active — the app live-switches by
    // re-invoking with the new mode.
    mode = typeof m === 'string' && m ? m : 'ask';
    if (active) return;
    active = true;
    hidePrompt(); hideMenu();
    window.addEventListener(PRESS_EVT, onPress, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('keydown', onKey, true);
    applyCursor();
    if (document.body) document.body.style.cursor = 'crosshair';
  }
  function stopPicking(keepHighlight) {
    active = false; last = null;
    hideMenu();
    clearCursor();
    window.removeEventListener(PRESS_EVT, onPress, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('contextmenu', onContext, true);
    window.removeEventListener('keydown', onKey, true);
    if (box && !keepHighlight) box.style.display = 'none';
    if (document.body) document.body.style.cursor = '';
  }
  function stop() { stopPicking(false); hidePrompt(); hideMenu(); hideBubble(); }
  window.__fleetStartSelect = start;
  window.__fleetStopSelect = stop;
  var metaSent = false;
  function postMeta() {
    if (metaSent) return; metaSent = true;
    try {
      location.href = 'https://fleet.internal/meta/' + encodeURIComponent(JSON.stringify({ title: document.title || '', url: location.href }));
    } catch (e) {}
  }
  if (document.readyState === 'complete') postMeta();
  else window.addEventListener('load', postMeta);
})();"#;

#[tauri::command]
pub async fn browser_embed_create(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> serde_json::Value {
    use tauri::{
        webview::WebviewBuilder, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
    };
    let pos = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    // Reuse if already present → just navigate + reposition.
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        if let Ok(u) = url.parse() {
            let _ = wv.navigate(u);
        }
        let _ = wv.set_position(pos);
        let _ = wv.set_size(size);
        return serde_json::json!({ "ok": true, "reused": true });
    }
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("bad url: {e}") }),
    };
    let window = match app.get_window("main") {
        Some(w) => w,
        None => return serde_json::json!({ "ok": false, "error": "no main window" }),
    };
    let app_nav = app.clone();
    let app_pick = app.clone();
    let builder = WebviewBuilder::new(BROWSER_EMBED_LABEL, WebviewUrl::External(parsed))
        .data_store_identifier(BROWSER_EMBED_PROFILE)
        .user_agent(BROWSER_EMBED_UA)
        // Element-select content script (see SELECT_JS). Runs at document
        // start on every page; the picked element is handed back via a URL
        // fragment sentinel which we read in on_navigation below. It is the
        // only script this webview gets: the vendored runtime gives it no
        // Tauri IPC (see BROWSER_EMBED_LABEL).
        .initialization_script(SELECT_JS)
        .on_navigation(move |url| {
            // The content script hands data back by NAVIGATING to a sentinel
            // host; we read it here and CANCEL the navigation (return false) so
            // the page never actually changes. A full navigation reliably fires
            // this delegate — same-document hash changes do NOT on WKWebView.
            let s = url.as_str();
            for (marker, event) in [
                (PICK_MARKER, "browser-embed:pick"),
                (META_MARKER, "browser-embed:meta"),
                (READ_MARKER, "browser-embed:read"),
            ] {
                if let Some(idx) = s.find(marker) {
                    let enc = &s[idx + marker.len()..];
                    let _ = app_pick.emit(event, enc.to_string());
                    return false;
                }
            }
            true
        })
        .on_page_load(move |wv, _payload| {
            if let Ok(u) = wv.url() {
                // Strip our internal sentinel fragments so they never reach the
                // URL bar / history / agent-browser mirror.
                let mut s = u.to_string();
                if let Some(i) = s.find("#__fleet") {
                    s.truncate(i);
                }
                let _ = app_nav.emit("browser-embed:url", s);
            }
        });
    match window.add_child(builder, pos, size) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("add_child: {e}") }),
    }
}

#[tauri::command]
pub async fn browser_embed_navigate(app: tauri::AppHandle, url: String) -> serde_json::Value {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        match url.parse() {
            Ok(u) => {
                let _ = wv.navigate(u);
                serde_json::json!({ "ok": true })
            }
            Err(e) => serde_json::json!({ "ok": false, "error": format!("bad url: {e}") }),
        }
    } else {
        serde_json::json!({ "ok": false, "error": "no embed webview" })
    }
}

#[tauri::command]
pub async fn browser_embed_set_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> serde_json::Value {
    use tauri::{LogicalPosition, LogicalSize, Manager};
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        // One set_bounds instead of set_position + set_size: each message is
        // a full webview relayout on Linux (GTK allocate cascade), and the
        // renderer pushes bounds from a per-frame loop while the panel
        // resizes — the pair doubled that cost for no benefit.
        let _ = wv.set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        });
    }
    serde_json::json!({ "ok": true })
}

/// Read the OPEN panel page's rendered text straight from the native webview —
/// the exact page the user sees (a real browser engine, so it has whatever the
/// user loaded). Returns None if no page is open or it doesn't answer in time.
/// The backend's `read_page` calls this (via `set_embedded_reader`) so the
/// agent reads what's actually on screen, not the separate headless CDP page.
pub async fn read_embedded_page(
    app: tauri::AppHandle,
) -> Option<fleetify_backend::services::browser::EmbeddedPage> {
    use base64::Engine as _;
    use tauri::{Listener, Manager};
    let wv = app.get_webview(BROWSER_EMBED_LABEL)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    let id = app.once("browser-embed:read", move |event| {
        if let Ok(mut g) = tx.lock() {
            if let Some(tx) = g.take() {
                let _ = tx.send(event.payload().to_string());
            }
        }
    });
    // Capture innerText, UTF-8-safe + URL-safe base64 it (btoa alone chokes on
    // non-Latin1 like Chinese; +/ would get mangled in a URL fragment), and
    // hand it back through the swallowed-hash channel read in on_navigation.
    let js = "(function(){try{var t=document.body?(document.body.innerText||''):'';\
var d={url:location.href,title:document.title||'',text:t.slice(0,30000)};\
var b=btoa(unescape(encodeURIComponent(JSON.stringify(d)))).replace(/\\+/g,'-').replace(/\\//g,'_');\
location.href='https://fleet.internal/read/'+b;\
}catch(e){}})()";
    if wv.eval(js).is_err() {
        app.unlisten(id);
        return None;
    }
    let payload = match tokio::time::timeout(std::time::Duration::from_secs(4), rx).await {
        Ok(Ok(p)) => p,
        _ => {
            app.unlisten(id);
            return None;
        }
    };
    app.unlisten(id);
    // event.payload() is the emitted value JSON-serialized → a quoted string.
    let b64: String = serde_json::from_str(&payload).unwrap_or(payload);
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(b64.trim())
        .ok()?;
    let json = String::from_utf8(bytes).ok()?;
    let v: serde_json::Value = serde_json::from_str(&json).ok()?;
    Some(fleetify_backend::services::browser::EmbeddedPage {
        url: v
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
        title: v
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
        text: v
            .get("text")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Navigate the OPEN panel webview and wait for it to load — lets the agent's
/// `navigate` browse like the user (real engine, no WAF block). Returns the
/// loaded URL + title, or None if no page is open / it doesn't load in time.
pub async fn navigate_embedded_page(
    app: tauri::AppHandle,
    url: String,
) -> Option<(String, String)> {
    use tauri::{Listener, Manager};
    let parsed: tauri::Url = url.parse().ok()?;
    let wv = app.get_webview(BROWSER_EMBED_LABEL)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    let id = app.once("browser-embed:url", move |event| {
        if let Ok(mut g) = tx.lock() {
            if let Some(tx) = g.take() {
                let _ = tx.send(event.payload().to_string());
            }
        }
    });
    if wv.navigate(parsed).is_err() {
        app.unlisten(id);
        return None;
    }
    let loaded = tokio::time::timeout(std::time::Duration::from_secs(8), rx)
        .await
        .ok()
        .and_then(|r| r.ok());
    app.unlisten(id);
    // The browser-embed:url payload is a JSON-serialized string.
    let loaded_url = loaded
        .and_then(|p| serde_json::from_str::<String>(&p).ok())
        .unwrap_or(url);
    // Give late-rendering pages a moment before a follow-up read.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    Some((loaded_url, String::new()))
}

#[tauri::command]
pub async fn browser_embed_set_select(
    app: tauri::AppHandle,
    on: bool,
    mode: Option<String>,
) -> serde_json::Value {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        let js = if on {
            // The mode string is interpolated into page JS — never pass a
            // caller-controlled value through; unknown modes fall back to ask.
            let mode = match mode.as_deref() {
                Some("copy:css") => "copy:css",
                Some("copy:xpath") => "copy:xpath",
                Some("copy:component") => "copy:component",
                Some("copy:html") => "copy:html",
                Some("copy:text") => "copy:text",
                _ => "ask",
            };
            format!("window.__fleetStartSelect && window.__fleetStartSelect('{mode}')")
        } else {
            "window.__fleetStopSelect && window.__fleetStopSelect()".to_string()
        };
        let _ = wv.eval(&js);
    }
    serde_json::json!({ "ok": true })
}

/// Browser history / reload controls. `action` ∈ "back" | "forward" |
/// "reload". Driven through the page's own history so it works across origins
/// (the webview's session history list).
#[tauri::command]
pub async fn browser_embed_nav(app: tauri::AppHandle, action: String) -> serde_json::Value {
    use tauri::Manager;
    let js = match action.as_str() {
        "back" => "window.history.back()",
        "forward" => "window.history.forward()",
        "reload" => "window.location.reload()",
        other => return serde_json::json!({ "ok": false, "error": format!("bad action: {other}") }),
    };
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        let _ = wv.eval(js);
    }
    serde_json::json!({ "ok": true })
}

/// Open the embedded webview's developer tools (dev/debug builds only).
#[tauri::command]
pub async fn browser_embed_devtools(app: tauri::AppHandle) -> serde_json::Value {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        #[cfg(any(debug_assertions, feature = "devtools"))]
        wv.open_devtools();
        #[cfg(not(any(debug_assertions, feature = "devtools")))]
        let _ = wv;
    }
    serde_json::json!({ "ok": true })
}

/// Clear the embedded webview's cookies + cache + local storage.
#[tauri::command]
pub async fn browser_embed_clear_data(app: tauri::AppHandle) -> serde_json::Value {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        match wv.clear_all_browsing_data() {
            Ok(_) => serde_json::json!({ "ok": true }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        }
    } else {
        serde_json::json!({ "ok": false, "error": "no embed webview" })
    }
}

#[tauri::command]
pub async fn browser_embed_close(app: tauri::AppHandle) -> serde_json::Value {
    use tauri::Manager;
    if let Some(wv) = app.get_webview(BROWSER_EMBED_LABEL) {
        let _ = wv.close();
    }
    serde_json::json!({ "ok": true })
}

// ── window controls ──────────────────────────────────────────────
/// The main window, for the window controls below. Looked up as a window:
/// `get_webview_window` finds a window only while every webview in it has
/// the window's label, so not while the Browser panel's child webview is
/// attached.
fn main_window(app: &tauri::AppHandle) -> Option<tauri::Window> {
    app.get_window(MAIN_WINDOW)
}

#[tauri::command]
pub async fn window_start_dragging(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.start_dragging();
    }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn window_minimize(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.minimize();
    }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn window_maximize(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = if w.is_maximized().unwrap_or(false) {
            w.unmaximize()
        } else {
            w.maximize()
        };
    }
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn window_close(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.close();
    }
    serde_json::json!({ "ok": true })
}

/// Logical top-left that centers a `width`×`height` window on a monitor whose
/// logical origin is (`mon_x`,`mon_y`) and logical size is (`mon_w`,`mon_h`).
///
/// Centers using the **target** size, not the window's current size. On
/// Linux/X11 `set_size()` is asynchronous, so a `WebviewWindow::center()`
/// issued immediately after a resize reads the still-stale outer size and
/// places a just-grown window to the bottom-right. Computing placement from
/// the size we're about to apply makes it correct regardless of when the GTK
/// resize lands. Clamps non-negative so a window larger than the monitor pins
/// to the monitor origin rather than running off the top-left.
///
/// macOS centers with the window's own `center()` instead (`window_set_size`),
/// so there only the tests call this.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn centered_top_left(
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    mon_h: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    (
        mon_x + ((mon_w - width) / 2.0).max(0.0),
        mon_y + ((mon_h - height) / 2.0).max(0.0),
    )
}

#[tauri::command]
pub async fn window_set_size(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    center: Option<bool>,
) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
        // Each screen mode has its own size (760×740 onboarding vs 1500×960
        // main), so the window must recenter on every resize or it stays
        // pinned to its previous top-left.
        if center.unwrap_or(false) {
            // macOS keeps decorations (custom traffic lights) and isn't
            // subject to the async-resize race below, so its built-in
            // center() — which accounts for the title bar — stays.
            #[cfg(target_os = "macos")]
            {
                let _ = w.center();
            }
            // Linux/Windows run decorationless (inner == outer). On Linux/X11
            // set_size() above is async, so w.center() would read the stale
            // pre-resize size and shove the grown window into the bottom-right
            // corner. Center on the current monitor using the TARGET size.
            #[cfg(not(target_os = "macos"))]
            {
                match w.current_monitor() {
                    Ok(Some(monitor)) => {
                        let scale = monitor.scale_factor();
                        let mpos = monitor.position().to_logical::<f64>(scale);
                        let msize = monitor.size().to_logical::<f64>(scale);
                        let (x, y) = centered_top_left(
                            mpos.x,
                            mpos.y,
                            msize.width,
                            msize.height,
                            width,
                            height,
                        );
                        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
                    }
                    // No monitor info (rare) — fall back to the built-in.
                    _ => {
                        let _ = w.center();
                    }
                }
            }
        }
    }
    serde_json::json!({ "ok": true })
}

// ── taskbar icon (system-theme-aware swap) ───────────────────────
// Light system theme ⇒ light OS taskbar ⇒ use the DARK logo (visible
// against light). Dark system theme ⇒ dark taskbar ⇒ use the LIGHT
// logo. The renderer detects via `matchMedia("(prefers-color-scheme:
// dark)")` and calls this on mount + on change.
//
// PNGs are embedded at compile time so the swap doesn't depend on
// the app's working directory or the bundle's resource layout.
const ICON_LIGHT_PNG: &[u8] = include_bytes!("../../../icons/logo-mark-light.png");
const ICON_DARK_PNG: &[u8] = include_bytes!("../../../icons/logo-mark-dark.png");

/// Whether closing the main window keeps Fleetify running here, as the
/// close handler decides it (shell::lifecycle::can_keep_running): on
/// Windows only while the notification-area icon is there, on macOS
/// always, on Linux never. Settings → General → Window says where Fleetify
/// stays, or, when the icon couldn't be added, that closing the window
/// quits.
#[tauri::command]
pub async fn window_can_keep_running() -> bool {
    crate::shell::lifecycle::can_keep_running(
        crate::shell::lifecycle::PLATFORM,
        crate::shell::tray::ready(),
    )
}

#[tauri::command]
pub async fn window_set_taskbar_icon(app: tauri::AppHandle, variant: String) -> serde_json::Value {
    let bytes: &[u8] = match variant.as_str() {
        "light" => ICON_LIGHT_PNG,
        "dark" => ICON_DARK_PNG,
        other => {
            return serde_json::json!({
                "ok": false,
                "error": format!("unknown variant: {other} (expected 'light' or 'dark')")
            });
        }
    };
    let Some(w) = main_window(&app) else {
        return serde_json::json!({ "ok": false, "error": "main window not found" });
    };
    let image = match tauri::image::Image::from_bytes(bytes) {
        Ok(img) => img,
        Err(e) => {
            return serde_json::json!({ "ok": false, "error": format!("decode failed: {e}") });
        }
    };
    match w.set_icon(image) {
        Ok(()) => serde_json::json!({ "ok": true, "variant": variant }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

// ── fs ───────────────────────────────────────────────────────────
// Renderer wire shape (parity with Electron preload):
//   readDirectory → { dirs: [{name, isDir}], error? }
//   readFile      → { content: <string>, error? }
//   getExtension  → <ext-no-dot>
//   getProjectRoot→ <abs path>

pub fn read_directory_impl(dir: &std::path::Path) -> serde_json::Value {
    match std::fs::read_dir(dir) {
        Ok(rd) => {
            let mut items: Vec<serde_json::Value> = rd
                .filter_map(|e| e.ok())
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    serde_json::json!({ "name": name, "isDir": is_dir })
                })
                .collect();
            items.sort_by(|a, b| {
                let ad = a["isDir"].as_bool().unwrap_or(false);
                let bd = b["isDir"].as_bool().unwrap_or(false);
                bd.cmp(&ad).then_with(|| {
                    let an = a["name"].as_str().unwrap_or("");
                    let bn = b["name"].as_str().unwrap_or("");
                    an.to_lowercase().cmp(&bn.to_lowercase())
                })
            });
            serde_json::json!({ "dirs": items })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

pub fn read_file_impl(path: &std::path::Path) -> serde_json::Value {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::json!({ "content": s }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

pub fn extension_no_dot(path: &std::path::Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn fs_read_directory(dir_path: String) -> serde_json::Value {
    read_directory_impl(std::path::Path::new(&dir_path))
}

#[tauri::command]
pub async fn fs_read_file(file_path: String) -> serde_json::Value {
    read_file_impl(std::path::Path::new(&file_path))
}

#[tauri::command]
pub async fn fs_get_extension(file_path: String) -> String {
    extension_no_dot(std::path::Path::new(&file_path))
}

// ── fs::scaffoldPlugin (faithful main.cjs `fs:scaffoldPlugin`) ──────
fn is_kebab_slug(s: &str) -> bool {
    let mut it = s.chars();
    let Some(first) = it.next() else { return false };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn scaffold_plugin_impl(
    parent_folder: &str,
    plugin_slug: &str,
    files: &HashMap<String, String>,
) -> serde_json::Value {
    use serde_json::json;
    if parent_folder.is_empty() {
        return json!({ "error": "parentFolder is required" });
    }
    if !is_kebab_slug(plugin_slug) {
        return json!({
            "error": "pluginSlug must be kebab-case (lowercase + digits + hyphens)"
        });
    }
    let parent = std::path::Path::new(parent_folder);
    if !parent.exists() || !parent.is_dir() {
        return json!({ "error": "parentFolder does not exist or is not a directory" });
    }
    let plugin_path = parent.join(plugin_slug);
    if plugin_path.exists() {
        return json!({
            "error": format!("'{plugin_slug}' already exists in that folder. Pick a different name or location.")
        });
    }
    if let Err(e) = std::fs::create_dir_all(&plugin_path) {
        return json!({ "error": e.to_string() });
    }

    let mut written: Vec<String> = Vec::new();
    for (rel, content) in files {
        // Refuse traversal: `..` segment or absolute path.
        let rel_path = std::path::Path::new(rel);
        if rel.contains("..") || rel_path.is_absolute() {
            return json!({ "error": format!("unsafe path in scaffold: {rel}") });
        }
        let target = plugin_path.join(rel_path);
        // Belt-and-braces: ensure the resolved path stays inside plugin_path
        // even after lexical traversal in the relative path.
        let normalized = target
            .components()
            .fold(std::path::PathBuf::new(), |mut acc, c| {
                acc.push(c);
                acc
            });
        if !normalized.starts_with(&plugin_path) {
            return json!({ "error": format!("unsafe path in scaffold: {rel}") });
        }
        if let Some(p) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(p) {
                return json!({ "error": e.to_string() });
            }
        }
        if let Err(e) = std::fs::write(&target, content) {
            return json!({ "error": e.to_string() });
        }
        written.push(rel.clone());
    }
    serde_json::json!({ "path": plugin_path.to_string_lossy(), "written": written })
}

#[tauri::command]
pub async fn fs_scaffold_plugin(
    parent_folder: String,
    plugin_slug: String,
    files: HashMap<String, String>,
) -> serde_json::Value {
    scaffold_plugin_impl(&parent_folder, &plugin_slug, &files)
}

#[tauri::command]
pub async fn fs_get_project_root() -> String {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_default()
}

// ── git ──────────────────────────────────────────────────────────
#[tauri::command]
pub async fn git_get_context(folder: String) -> serde_json::Value {
    git::get_context(&PathBuf::from(folder)).await
}
/// Cheap, pollable working-tree diff (branch + uncommitted +/-) for the
/// sidebar hover preview. Two git calls vs `git_get_context`'s five-plus.
#[tauri::command]
pub async fn git_working_diff(folder: String) -> serde_json::Value {
    git::working_diff(&PathBuf::from(folder)).await
}
/// gh CLI status probe. Reads from the integrations cache primed by
/// `warm_at_boot`; falls back to a live probe (three subprocesses) when
/// the cache is cold, then stores the fresh snapshot so subsequent
/// reads from Settings → Integrations return without the spinner.
/// Passing `refresh: true` skips the cache and re-probes — used by the
/// post-auth refresh path in the renderer.
#[tauri::command]
pub async fn git_has_gh_cli(refresh: Option<bool>) -> serde_json::Value {
    if !refresh.unwrap_or(false) {
        if let Some(cached) = crate::shell::integrations_cache::get_gh_cli() {
            return cached;
        }
    }
    let fresh = git::has_gh_cli().await;
    crate::shell::integrations_cache::set_gh_cli(fresh.clone());
    fresh
}
#[tauri::command]
pub async fn git_has_git() -> serde_json::Value {
    git::has_git().await
}
#[tauri::command]
pub async fn git_list_branches(folder: String) -> serde_json::Value {
    git::list_branches(&PathBuf::from(folder)).await
}
#[tauri::command]
pub async fn git_set_base_branch(folder: String, branch: String) -> serde_json::Value {
    git::set_base_branch(&PathBuf::from(folder), &branch).await
}
#[tauri::command]
pub async fn git_checkout(
    folder: String,
    branch: String,
    force: Option<bool>,
) -> serde_json::Value {
    git::checkout(&PathBuf::from(folder), &branch, force.unwrap_or(false)).await
}
#[tauri::command]
pub async fn git_commit(folder: String, message: String) -> serde_json::Value {
    git::commit(&PathBuf::from(folder), &message).await
}
#[tauri::command]
pub async fn git_push(folder: String) -> serde_json::Value {
    git::push(&PathBuf::from(folder)).await
}
#[tauri::command]
pub async fn git_ensure_repo(
    folder: String,
    name: Option<String>,
    email: Option<String>,
) -> serde_json::Value {
    git::ensure_repo(&PathBuf::from(folder), name.as_deref(), email.as_deref()).await
}
#[tauri::command]
pub async fn git_pull_latest(folder: String, base_branch: String) -> serde_json::Value {
    git::pull_latest(&PathBuf::from(folder), &base_branch).await
}
#[tauri::command]
pub async fn git_diff_summary(folder: String, base_branch: String) -> serde_json::Value {
    git::diff_summary(&PathBuf::from(folder), &base_branch).await
}
#[tauri::command]
pub async fn git_open_pr(folder: String, pr_number: Option<i64>) -> serde_json::Value {
    git::open_pr(&PathBuf::from(folder), pr_number).await
}
/// IPC: create a pull request. `method` selects the auth path:
/// "gh" | "cli" → GitHub CLI only, "oauth" | "link" → Fleetify OAuth
/// link only, omitted → legacy gh-first / link-fallback. Renderer
/// pulls the value from `localStorage["fleet:github-auth-method"]`
/// so the onboarding choice is honoured exactly.
// 9 args is two over the default 7; refactor to a struct is out of scope for this cleanup.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_create_pr(
    app: tauri::AppHandle,
    folder: String,
    title: String,
    body: Option<String>,
    base: Option<String>,
    draft: Option<bool>,
    #[allow(non_snake_case)] featureBranch: Option<String>,
    tool: Option<String>,
    method: Option<String>,
) -> serde_json::Value {
    // Settings → General → Attribution, read fresh for every PR so a change
    // applies without a restart. No data dir → the default (on).
    let attribution = app
        .path()
        .app_data_dir()
        .map(|dir| config::git_attribution_from(&config::load_config_from(&dir)))
        .unwrap_or(true);
    git::create_pr(
        &PathBuf::from(folder),
        &title,
        body.as_deref(),
        base.as_deref(),
        draft.unwrap_or(false),
        featureBranch.as_deref(),
        tool.as_deref(),
        method.as_deref(),
        attribution,
    )
    .await
}
// PR list/status/ready/merge route through `git_host`, which picks the gh or
// REST backend from the user's auth method. `auth_method` is the renderer's
// explicit choice ("gh"|"oauth"); `auth_stored` is the remembered choice. Both
// optional — absent → probe-based routing (OAuth link over gh). Renderer wires
// them in Plan B; existing callers keep working as None.
#[tauri::command]
pub async fn git_get_pr_status(
    folder: String,
    pr_number: Option<u64>,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_get_pr_status(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        pr_number,
    )
    .await
}

#[tauri::command]
pub async fn git_list_prs(
    folder: String,
    limit: Option<u32>,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_list_prs(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        limit.unwrap_or(50),
    )
    .await
}
#[tauri::command]
pub async fn git_merge_pr(
    folder: String,
    pr_number: u64,
    method: Option<String>,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_merge_pr(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        pr_number,
        method.as_deref().unwrap_or("merge"),
    )
    .await
}

#[tauri::command]
pub async fn git_delete_remote_branch(
    folder: String,
    branch: String,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_delete_remote_branch(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        &branch,
    )
    .await
}

#[tauri::command]
pub async fn git_pr_ready(
    folder: String,
    pr_number: u64,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_pr_ready(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        pr_number,
    )
    .await
}
#[tauri::command]
pub async fn git_rerun_check_job(
    folder: String,
    job_id: u64,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_rerun_check_job(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        job_id,
    )
    .await
}

#[tauri::command]
pub async fn git_rerun_failed_checks(
    folder: String,
    run_ids: Vec<u64>,
    auth_method: Option<String>,
    auth_stored: Option<String>,
) -> serde_json::Value {
    crate::shell::git_host::host_rerun_failed_checks(
        &PathBuf::from(folder),
        auth_method.as_deref(),
        auth_stored.as_deref(),
        &run_ids,
    )
    .await
}

#[tauri::command]
pub async fn git_sync_main(folder: String, base_branch: String) -> serde_json::Value {
    git::sync_main(&PathBuf::from(folder), &base_branch).await
}
#[tauri::command]
pub async fn git_fetch_base(folder: String, base_branch: String) -> serde_json::Value {
    git::fetch_base(&PathBuf::from(folder), &base_branch).await
}
#[tauri::command]
pub async fn git_carve_next_round(
    folder: String,
    branch: String,
    base_branch: String,
) -> serde_json::Value {
    git::carve_next_round(&PathBuf::from(folder), &branch, &base_branch).await
}
#[tauri::command]
pub async fn git_preflight_check(folder: String) -> serde_json::Value {
    git::preflight_check(&PathBuf::from(folder)).await
}

// ── AI git helpers (Quick Commit / PR Summary / Review) ─────────
#[tauri::command]
pub async fn git_generate_commit_message(
    folder: String,
    tool: Option<String>,
    is_initial: Option<bool>,
) -> serde_json::Value {
    ai_git::generate_commit_message(folder, tool, is_initial.unwrap_or(false)).await
}

#[tauri::command]
pub async fn git_generate_pr_summary(
    folder: String,
    base_branch: Option<String>,
    tool: Option<String>,
) -> serde_json::Value {
    ai_git::generate_pr_summary(folder, base_branch, tool).await
}

#[tauri::command]
pub async fn git_review_diff(
    folder: String,
    base_branch: Option<String>,
    tool: Option<String>,
) -> serde_json::Value {
    ai_git::review_diff(folder, base_branch, tool).await
}

// ── Recovery + preflight (sad-path) ─────────────────────────────
#[tauri::command]
pub async fn git_diagnose_failure(
    folder: String,
    error_message: String,
    tool: Option<String>,
    context: Option<String>,
    base_branch: Option<String>,
) -> serde_json::Value {
    ai_git::diagnose_failure(folder, error_message, tool, context, base_branch).await
}

#[tauri::command]
pub async fn git_apply_recovery(
    folder: String,
    action: String,
    base_branch: Option<String>,
    command: Option<String>,
) -> serde_json::Value {
    use serde_json::json;
    let folder_pb = PathBuf::from(&folder);
    let base = base_branch.unwrap_or_else(|| "main".to_string());

    if !ai_git::RECOVERY_ACTIONS.iter().any(|a| *a == action) || action == "manual" {
        return json!({ "ok": false, "error": format!("unsupported recovery action: {action}") });
    }

    let (bin, argv): (String, Vec<String>) = match action.as_str() {
        "pull-rebase" => (
            "git".into(),
            vec![
                "pull".into(),
                "--rebase".into(),
                "origin".into(),
                base.clone(),
            ],
        ),
        "force-with-lease" => (
            "git".into(),
            vec![
                "push".into(),
                "--force-with-lease".into(),
                "origin".into(),
                "HEAD".into(),
            ],
        ),
        "set-upstream" => (
            "git".into(),
            vec!["push".into(), "-u".into(), "origin".into(), "HEAD".into()],
        ),
        "custom-command" => {
            let Some(cmd) = command.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
                return json!({ "ok": false, "error": "custom-command requires a command string" });
            };
            if ai_git::has_shell_meta(cmd) {
                return json!({
                    "ok": false,
                    "error": "command contains shell metacharacters (refused)"
                });
            }
            let tokens = ai_git::tokenize_command(cmd);
            if tokens.is_empty() {
                return json!({ "ok": false, "error": "command parsed to zero tokens" });
            }
            let head = tokens[0].clone();
            if !ai_git::RECOVERY_BINARIES.contains(&head.as_str()) {
                return json!({
                    "ok": false,
                    "error": format!("binary not allowed: {head}. Only {} are supported.", ai_git::RECOVERY_BINARIES.join(", "))
                });
            }
            (head, tokens[1..].to_vec())
        }
        _ => {
            return json!({ "ok": false, "error": format!("unsupported recovery action: {action}") })
        }
    };

    let args_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    let (rc, out, err) = git::run(
        &bin,
        &args_ref,
        &folder_pb,
        std::time::Duration::from_secs(30),
    )
    .await;
    if rc != 0 {
        let msg = if err.is_empty() {
            format!("{bin} {} failed", argv.join(" "))
        } else {
            err.trim().to_string()
        };
        return json!({ "ok": false, "error": msg });
    }
    json!({ "ok": true, "output": out })
}

#[tauri::command]
pub async fn git_apply_preflight_fix(
    folder: String,
    action: String,
    data: Option<serde_json::Value>,
) -> serde_json::Value {
    use serde_json::json;
    let folder_pb = PathBuf::from(&folder);

    if action == "nest-ignore" {
        let rel = data
            .as_ref()
            .and_then(|d| d.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or("");
        if rel.is_empty() {
            return json!({ "ok": false, "error": "nest-ignore requires data.path" });
        }
        let rule = format!("{}/", rel.trim_end_matches('/'));
        // Append-if-missing to .gitignore. Idempotent.
        let gi_path = folder_pb.join(".gitignore");
        let existing = std::fs::read_to_string(&gi_path).unwrap_or_default();
        let lines: Vec<String> = existing
            .split('\n')
            .map(|l| l.trim_end_matches('\r').trim().to_string())
            .collect();
        let already = lines.iter().any(|l| l == &rule);
        let wrote = if !already {
            let body = if existing.is_empty() || existing.ends_with('\n') {
                format!("{existing}{rule}\n")
            } else {
                format!("{existing}\n{rule}\n")
            };
            if let Err(e) = std::fs::write(&gi_path, body) {
                return json!({ "ok": false, "error": e.to_string() });
            }
            true
        } else {
            false
        };
        // Drop any existing index entry for the nested dir so a stale
        // gitlink doesn't keep the failure alive across retries.
        let _ = git::run(
            "git",
            &["rm", "--cached", "-rf", "--ignore-unmatch", rel],
            &folder_pb,
            std::time::Duration::from_secs(15),
        )
        .await;
        let out = if wrote {
            format!("Added \"{rule}\" to .gitignore")
        } else {
            format!("\"{rule}\" already in .gitignore")
        };
        return json!({ "ok": true, "output": out });
    }

    if action == "abort-rebase" {
        let (rc, out, err) = git::run(
            "git",
            &["rebase", "--abort"],
            &folder_pb,
            std::time::Duration::from_secs(15),
        )
        .await;
        if rc != 0 {
            return json!({
                "ok": false,
                "error": if err.is_empty() { "git rebase --abort failed".to_string() } else { err.trim().to_string() }
            });
        }
        let _ = out;
        return json!({ "ok": true, "output": "Rebase aborted." });
    }

    json!({ "ok": false, "error": format!("unsupported preflight action: {action}") })
}

#[tauri::command]
pub async fn git_diff_summary_simple(
    folder: String,
    base_branch: Option<String>,
) -> serde_json::Value {
    use serde_json::json;
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let folder_pb = PathBuf::from(&folder);
    let range_dot3 = format!("{base}...HEAD");
    let range_dot2 = format!("{base}..HEAD");
    let (rc_f, files, _) = git::run(
        "git",
        &["diff", "--name-status", &range_dot3],
        &folder_pb,
        std::time::Duration::from_secs(5),
    )
    .await;
    let (rc_l, log, _) = git::run(
        "git",
        &["log", "--oneline", "--no-decorate", &range_dot2],
        &folder_pb,
        std::time::Duration::from_secs(5),
    )
    .await;
    let (rc_s, stat, _) = git::run(
        "git",
        &["diff", "--shortstat", &range_dot3],
        &folder_pb,
        std::time::Duration::from_secs(5),
    )
    .await;
    json!({
        "ok": true,
        "files": if rc_f == 0 { files } else { String::new() },
        "log":   if rc_l == 0 { log } else { String::new() },
        "stat":  if rc_s == 0 { stat } else { String::new() },
    })
}

// ── GitHub link (Fleetify cloud OAuth fallback) ──────────────────
#[tauri::command]
pub async fn github_get_link() -> serde_json::Value {
    match github_link::get_link().await {
        Some(l) => serde_json::json!({ "ok": true, "link": l }),
        None => serde_json::json!({ "ok": true, "link": null }),
    }
}

#[tauri::command]
pub async fn github_begin_oauth(app: tauri::AppHandle, mode: Option<String>) -> serde_json::Value {
    // "connect" (default) → link identity / instant relink.
    // "install" → add another org/account via the install picker.
    let mode = mode.unwrap_or_else(|| "connect".to_string());
    let r = github_link::begin_oauth(app, &mode).await;
    // Refresh the backend clone token now that a link may exist.
    github_link::push_clone_token().await;
    // A link may now exist → the auto-detected PR-auth backend can change.
    crate::shell::integrations_cache::invalidate_auth_method();
    r
}

#[tauri::command]
pub async fn github_cancel_oauth() -> serde_json::Value {
    github_link::cancel_oauth().await
}

#[tauri::command]
pub async fn github_refresh_link(app: tauri::AppHandle) -> serde_json::Value {
    let r = github_link::refresh_link(app).await;
    github_link::push_clone_token().await;
    // Token rotated — re-resolve the PR-auth backend on the next op.
    crate::shell::integrations_cache::invalidate_auth_method();
    r
}

#[tauri::command]
pub async fn github_disconnect(app: tauri::AppHandle) -> serde_json::Value {
    github_link::disconnect(app).await;
    // Clear the backend clone token — no link anymore.
    github_link::push_clone_token().await;
    // Link gone → drop the cached auth method so PR ops re-resolve.
    crate::shell::integrations_cache::invalidate_auth_method();
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn github_open_installation() -> serde_json::Value {
    github_link::open_installation().await
}

#[tauri::command]
pub async fn github_list_repos(app: tauri::AppHandle) -> serde_json::Value {
    github_link::list_repos(app).await
}

#[tauri::command]
pub async fn github_list_installations(app: tauri::AppHandle) -> serde_json::Value {
    github_link::list_installations(app).await
}

// ── Voice dictation ───────────────────────────────────────────────
// Native cpal capture: renderer calls start_recording / stop_recording;
// audio never crosses IPC — only the final transcript returns.
// The legacy voice_transcribe command is kept for backward compat.

#[tauri::command]
pub fn voice_list_devices() -> serde_json::Value {
    let devs = voice::capture::list_devices();
    serde_json::json!({
        "ok": true,
        "devices": devs.iter().map(|d| serde_json::json!({ "id": &d.id, "name": &d.name })).collect::<Vec<_>>()
    })
}

#[tauri::command]
pub async fn voice_start_recording(
    app: tauri::AppHandle,
    device_name: Option<String>,
) -> serde_json::Value {
    // Clone the Arc before any await so State<'_> never crosses an await point.
    let mutex = std::sync::Arc::clone(&app.state::<voice::VoiceCaptureState>().0);
    let mut lock = mutex.lock().await;
    if lock.is_some() {
        return serde_json::json!({ "ok": false, "code": "ALREADY_RECORDING", "error": "A recording is already in progress." });
    }
    match voice::capture::start(device_name.as_deref()) {
        Ok(rec) => {
            *lock = Some(rec);
            serde_json::json!({ "ok": true })
        }
        Err(e) => serde_json::json!({ "ok": false, "code": "CAPTURE_FAILED", "error": e }),
    }
}

#[tauri::command]
pub async fn voice_stop_recording(
    app: tauri::AppHandle,
    engine: String,
    language: String,
    model: String,
    prompt: String,
) -> serde_json::Value {
    // Clone Arc, release lock before await so State<'_> doesn't enter the future.
    let mutex = std::sync::Arc::clone(&app.state::<voice::VoiceCaptureState>().0);
    let rec = mutex.lock().await.take();
    let Some(rec) = rec else {
        return serde_json::json!({ "ok": false, "code": "NOT_RECORDING", "error": "No active recording." });
    };
    let wav = voice::capture::stop_and_encode(rec);
    voice::transcribe_bytes(wav, engine, language, model, prompt).await
}

#[tauri::command]
pub async fn voice_transcribe(
    audio_base64: String,
    engine: String,
    language: String,
    model: String,
    prompt: String,
) -> serde_json::Value {
    voice::transcribe(audio_base64, engine, language, model, prompt).await
}

#[tauri::command]
pub fn voice_set_byok_key(provider: String, key: String) -> serde_json::Value {
    voice::set_byok_key(&provider, &key)
}

#[tauri::command]
pub fn voice_has_byok_key(provider: String) -> serde_json::Value {
    voice::has_byok_key(&provider)
}

#[tauri::command]
pub fn voice_list_models() -> serde_json::Value {
    voice::list_models()
}

#[tauri::command]
pub async fn voice_download_model(app: tauri::AppHandle, id: String) -> serde_json::Value {
    voice::download_model(app, id).await
}

#[tauri::command]
pub fn voice_cancel_download(app: tauri::AppHandle) -> serde_json::Value {
    voice::cancel_download(app)
}

// ── .git/HEAD watcher (renderer branch strip) ────────────────────
#[tauri::command]
pub async fn git_watch_head(
    app: tauri::AppHandle,
    folder: String,
    key: String,
) -> serde_json::Value {
    head_watcher::watch(app, &folder, &key).await
}

#[tauri::command]
pub async fn git_unwatch_head(key: String) -> serde_json::Value {
    head_watcher::unwatch(&key)
}

// ── shell:* installers + GitHub auth check ──────────────────────
// `window.electronAPI.checkGithubAuth()` → `{ ok, login? , error? }`.
// `installProvider(toolKey)` shells out to `npm install -g <pkg>`.
// `installOllama()` runs the platform's official installer; on any
// failure we open https://ollama.com/download in the browser so the
// user has a path forward (matches main.cjs's graceful fallback).
// Launch `gh auth login --web` in a fresh shell window so the user can
// complete the device-code flow interactively. Tauri-spawned processes
// don't surface stdin/stdout to the user, so the shell window is the
// least-friction way to let `gh` drive its own prompts. The renderer
// polls `git_has_gh_cli` afterwards to detect when auth finishes.
#[tauri::command]
pub async fn gh_auth_login_launch() -> serde_json::Value {
    let cmdline = "gh auth login --web --hostname github.com --git-protocol https";
    let spawn_result = if cfg!(windows) {
        // `start` gives the inner `cmd` a new console, window included; only
        // this outer `cmd`, which exits at once, runs without one.
        fleetify_core::process::tokio_command("cmd")
            .args([
                "/c",
                "start",
                "\"GitHub authentication\"",
                "cmd",
                "/k",
                cmdline,
            ])
            .spawn()
    } else if cfg!(target_os = "macos") {
        fleetify_core::process::tokio_command("osascript")
            .args([
                "-e",
                &format!("tell application \"Terminal\" to do script \"{cmdline}\""),
            ])
            .spawn()
    } else {
        // Best-effort Linux: try x-terminal-emulator, then xterm.
        fleetify_core::process::tokio_command("x-terminal-emulator")
            .args(["-e", "bash", "-c", &format!("{cmdline}; exec bash")])
            .spawn()
            .or_else(|_| {
                fleetify_core::process::tokio_command("xterm")
                    .args(["-e", "bash", "-c", &format!("{cmdline}; exec bash")])
                    .spawn()
            })
    };
    match spawn_result {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({
            "ok": false,
            "error": format!("failed to launch terminal: {e}")
        }),
    }
}

// In-process gh-auth flow that surfaces the one-time device code in the
// app itself. Spawns `gh auth login --web` under a real PTY so gh sees a
// terminal, parses output for the code + verification URL, auto-presses
// Enter so gh opens the browser, and emits `gh-auth-event` updates as it
// progresses:
//   • { phase: "code", code: "XXXX-XXXX" } — one-time device code
//   • { phase: "url",  url:  "https://…" } — verification URL
//   • { phase: "log",  line: "…" }         — verbatim line (debug)
//   • { phase: "done", ok, login?, error? } — process exit + resolved user
// The renderer should listen to `gh-auth-event` to drive its UI and treat
// the `done` payload as the source of truth. The currently-running child
// is stashed in `GH_AUTH_CHILD` so `gh_auth_login_cancel` can kill it.
static GH_AUTH_CHILD: OnceLock<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>> =
    OnceLock::new();
fn gh_auth_child_slot() -> &'static Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>> {
    GH_AUTH_CHILD.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn gh_auth_login_capture(app: tauri::AppHandle) -> serde_json::Value {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    // Kill any leftover child from a previous (cancelled) run so we never
    // race two `gh auth login` processes against the same OAuth slot.
    if let Ok(mut g) = gh_auth_child_slot().lock() {
        if let Some(mut prev) = g.take() {
            let _ = prev.kill();
        }
    }

    // Resolve gh once so portable-pty gets an absolute path. CommandBuilder
    // on Windows would only auto-append ".exe" via CreateProcess; macOS
    // GUI launches strip /opt/homebrew/bin from PATH. Doing the lookup
    // ourselves (via the shared resolver in shell::git) makes the spawn
    // behave the same on Win / macOS / Linux.
    let gh_bin = match git::resolve_gh() {
        Some(p) => p,
        None => {
            let err = "GitHub CLI (gh) wasn't found. Install it from \
                       https://cli.github.com/ and re-open Fleet.";
            let _ = app.emit(
                "gh-auth-event",
                serde_json::json!({
                    "phase": "done",
                    "ok": false,
                    "error": err,
                }),
            );
            return serde_json::json!({ "ok": false, "error": err });
        }
    };

    let app_inner = app.clone();
    let gh_bin_inner = gh_bin.clone();
    let pump = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let mut cmd = CommandBuilder::new(gh_bin_inner.as_os_str());
        cmd.args([
            "auth",
            "login",
            "--web",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
        ]);
        // gh checks $TERM to decide whether to colorize / animate. Force a
        // sane value so its prompts render predictably regardless of the
        // host shell's environment (and so ConPTY-spawned children on
        // Windows don't fall back to a TERM-less "dumb" mode).
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            format!("Couldn't launch gh: {e}. Is the GitHub CLI installed and on PATH?")
        })?;
        drop(pair.slave);

        // Stash the child so gh_auth_login_cancel can reach it.
        if let Ok(mut slot) = gh_auth_child_slot().lock() {
            *slot = Some(child);
        }

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {e}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {e}"))?;

        let mut buf = [0u8; 4096];
        let mut carry = String::new();
        let mut sent_enter = false;
        let mut emitted_code = false;

        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(idx) = carry.find(['\n', '\r']) {
                        let raw: String = carry.drain(..=idx).collect();
                        let line = strip_ansi(raw.trim_end_matches(['\n', '\r']).trim());
                        if line.is_empty() {
                            continue;
                        }

                        let _ = app_inner.emit(
                            "gh-auth-event",
                            serde_json::json!({ "phase": "log", "line": &line }),
                        );

                        if !emitted_code {
                            if let Some(code) = parse_device_code(&line) {
                                let _ = app_inner.emit(
                                    "gh-auth-event",
                                    serde_json::json!({ "phase": "code", "code": code }),
                                );
                                emitted_code = true;
                            }
                        }
                        if let Some(url) = parse_verification_url(&line) {
                            let _ = app_inner.emit(
                                "gh-auth-event",
                                serde_json::json!({ "phase": "url", "url": url }),
                            );
                        }
                        // gh prints "Press Enter to open …" once the code is
                        // ready. Auto-confirm so the browser pops without the
                        // user having to interact with a hidden terminal.
                        if !sent_enter && line.to_lowercase().contains("press enter") {
                            let _ = std::io::Write::write_all(&mut writer, b"\r\n");
                            sent_enter = true;
                        }
                    }
                }
                Err(_) => break,
            }
        }

        // Reclaim the child to wait on it.
        let mut child = match gh_auth_child_slot().lock() {
            Ok(mut slot) => match slot.take() {
                Some(c) => c,
                None => return Err("gh process disappeared".into()),
            },
            Err(_) => return Err("gh child slot poisoned".into()),
        };
        let status = child.wait().map_err(|e| format!("wait: {e}"))?;
        if !status.success() {
            return Err(format!(
                "gh auth login exited with code {}",
                status.exit_code()
            ));
        }
        Ok(())
    })
    .await;

    let pump_result: Result<(), String> = match pump {
        Ok(r) => r,
        Err(e) => Err(format!("join: {e}")),
    };

    let (ok, error) = match pump_result {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e)),
    };

    let login = if ok {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        // Use the same resolved gh path so the post-login probe doesn't
        // diverge from the spawn (matters on macOS where the GUI app's
        // PATH may not include the binary's actual install location).
        let gh_str = gh_bin.to_str().unwrap_or("gh");
        let (rc, name, _) = git::run(
            gh_str,
            &["api", "user", "--jq", ".login"],
            &cwd,
            std::time::Duration::from_secs(5),
        )
        .await;
        if rc == 0 {
            let n = name.trim().to_string();
            if n.is_empty() {
                None
            } else {
                Some(n)
            }
        } else {
            None
        }
    } else {
        None
    };

    let _ = app.emit(
        "gh-auth-event",
        serde_json::json!({
            "phase": "done",
            "ok": ok,
            "login": login,
            "error": error,
        }),
    );

    // Auth state changed — drop the cached gh-cli snapshot so the next
    // `git_has_gh_cli` re-probes and reflects the new authed/login pair, and
    // drop the auth-resolution cache so PR ops re-resolve the backend.
    if ok {
        crate::shell::integrations_cache::invalidate_gh_cli();
        crate::shell::integrations_cache::invalidate_auth_method();
    }

    if ok {
        serde_json::json!({ "ok": true, "login": login })
    } else {
        serde_json::json!({ "ok": false, "error": error })
    }
}

#[tauri::command]
pub async fn gh_auth_login_cancel() -> serde_json::Value {
    if let Ok(mut slot) = gh_auth_child_slot().lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
        }
    }
    serde_json::json!({ "ok": true })
}

// ── helpers for gh_auth_login_capture ─────────────────────────────
// gh decorates its prompts with ANSI colours; strip CSI sequences so
// pattern matches on the cleaned text don't need to know about escapes.
fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 2;
            while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// One-time device codes are formatted "XXXX-XXXX" — 4 alphanumerics, a
// dash, then 4 more. gh prints them after "code:" so we anchor on that.
fn parse_device_code(line: &str) -> Option<String> {
    // ASCII-only lowercasing keeps every byte offset, so `pos` is valid in
    // `line` too. Unicode lowercasing can change lengths (`İ` 2 → 3 bytes).
    let lower = line.to_ascii_lowercase();
    let pos = lower.find("code:")?;
    let rest = &line[pos + 5..];
    let candidate: String = rest
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take(9)
        .collect();
    if candidate.chars().count() != 9 {
        return None;
    }
    let b = candidate.as_bytes();
    if b[4] != b'-' {
        return None;
    }
    if !b[..4].iter().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    if !b[5..].iter().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(candidate.to_uppercase())
}

fn parse_verification_url(line: &str) -> Option<String> {
    line.split_whitespace()
        .map(|t| t.trim_matches(|c: char| c == '"' || c == '\'' || c == '.' || c == ','))
        .find(|t| t.starts_with("https://github.com/login/device"))
        .map(|s| s.to_string())
}

#[tauri::command]
pub async fn shell_check_github_auth() -> serde_json::Value {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let (rc, _out, _) = git::run(
        "gh",
        &["auth", "status"],
        &cwd,
        std::time::Duration::from_secs(5),
    )
    .await;
    if rc != 0 {
        return serde_json::json!({
            "ok": false,
            "error": "gh CLI not signed in (or not installed)"
        });
    }
    let (rc2, name, _) = git::run(
        "gh",
        &["api", "user", "--jq", ".login"],
        &cwd,
        std::time::Duration::from_secs(5),
    )
    .await;
    if rc2 == 0 {
        serde_json::json!({ "ok": true, "login": name.trim() })
    } else {
        serde_json::json!({ "ok": true, "login": serde_json::Value::Null })
    }
}

const NPM_PROVIDER_PKG: &[(&str, &str)] = &[
    // Key is the provider id ("claude-code"); the npm package name keeps its
    // own spelling. The installed binary is still `claude`.
    ("claude-code", "@anthropic-ai/claude-code"),
    ("codex-cli", "@openai/codex"),
    ("kimi-code", "@moonshot-ai/kimi-code"),
    // OpenCode and GitHub Copilot both ship cross-platform npm packages —
    // `npm install -g` is the documented all-OS install for each.
    ("opencode", "opencode-ai"),
    ("github-copilot", "@github/copilot"),
];

/// Map a spawned shell-installer's `Output` into the renderer's
/// `{success, ...}` envelope. Shared by the script-based CLI installers
/// (Cursor, Hermes) that ship outside npm.
fn shell_installer_result(
    res: std::io::Result<std::process::Output>,
    label: &str,
) -> serde_json::Value {
    match res {
        Ok(o) if o.status.success() => serde_json::json!({
            "success": true,
            "out": String::from_utf8_lossy(&o.stdout).trim().to_string()
        }),
        Ok(o) => serde_json::json!({
            "success": false,
            "error": String::from_utf8_lossy(&o.stderr).trim().to_string()
        }),
        Err(e) => serde_json::json!({
            "success": false,
            "error": format!("{label} installer spawn failed: {e}")
        }),
    }
}

#[tauri::command]
pub async fn shell_install_provider(tool_key: String) -> serde_json::Value {
    // Antigravity SDK installs via pip — a different runner than every
    // other provider in the catalog. We invoke `pip install --user
    // google-antigravity` against the SAME Python interpreter the bridge
    // will later spawn for dispatch, so install + dispatch agree on the
    // site-packages set. `--user` is what makes this work without an
    // elevated shell on Windows AND without tripping PEP 668's "externally
    // managed" guard on recent macOS / Debian / Ubuntu Pythons.
    if tool_key == "antigravity-sdk" {
        // Phase 1: system Python only. `FLEETIFY_EMBEDDED_PYTHON` is a
        // manual override the bridge already honours; we honour it here
        // too so the two halves can never disagree on the interpreter.
        let python: Option<String> = match std::env::var("FLEETIFY_EMBEDDED_PYTHON") {
            Ok(p) if std::path::Path::new(&p).exists() => Some(p),
            _ => ["python3", "python"]
                .iter()
                .find_map(|name| which::which(name).ok().map(|p| p.display().to_string())),
        };
        let Some(py) = python else {
            return serde_json::json!({
                "success": false,
                "error": "No Python interpreter found. Install Python 3.10+ first, then click Install again."
            });
        };
        let res = fleetify_core::process::tokio_command(&py)
            .args([
                "-m",
                "pip",
                "install",
                "--user",
                "--upgrade",
                "google-antigravity",
            ])
            .output()
            .await;
        return match res {
            Ok(o) if o.status.success() => serde_json::json!({
                "success": true,
                "out": String::from_utf8_lossy(&o.stdout).trim().to_string()
            }),
            Ok(o) => serde_json::json!({
                "success": false,
                "error": String::from_utf8_lossy(&o.stderr).trim().to_string()
            }),
            Err(e) => serde_json::json!({
                "success": false,
                "error": format!("pip spawn failed: {e}. Python path: {py}")
            }),
        };
    }
    // Antigravity ships as a Go binary outside npm — its installer is a
    // per-OS shell script (irm on Windows, curl|bash elsewhere). Mirror
    // the `shell_install_ollama` pattern so the renderer's Install button
    // works for it without an npm package.
    if tool_key == "antigravity-cli" {
        let res = if cfg!(windows) {
            fleetify_core::process::tokio_command("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "iex (irm https://antigravity.google/cli/install.ps1)",
                ])
                .output()
                .await
        } else {
            fleetify_core::process::tokio_command("sh")
                .args([
                    "-c",
                    "curl -fsSL https://antigravity.google/cli/install.sh | bash",
                ])
                .output()
                .await
        };
        return match res {
            Ok(o) if o.status.success() => serde_json::json!({
                "success": true,
                "out": String::from_utf8_lossy(&o.stdout).trim().to_string()
            }),
            Ok(o) => serde_json::json!({
                "success": false,
                "error": String::from_utf8_lossy(&o.stderr).trim().to_string()
            }),
            Err(e) => serde_json::json!({
                "success": false,
                "error": format!("antigravity installer spawn failed: {e}")
            }),
        };
    }
    // Cursor CLI ships a shell installer (no npm). Windows runs the
    // PowerShell one-liner with the win32 flag; macOS/Linux run the
    // curl|bash script. Commands mirror the catalog's cursor `install_hints`
    // so the Install button and the Settings-displayed command agree.
    if tool_key == "cursor-cli" {
        let res = if cfg!(windows) {
            fleetify_core::process::tokio_command("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "irm 'https://cursor.com/install?win32=true' | iex",
                ])
                .output()
                .await
        } else {
            fleetify_core::process::tokio_command("sh")
                .args(["-c", "curl https://cursor.com/install -fsS | bash"])
                .output()
                .await
        };
        return shell_installer_result(res, "cursor-cli");
    }
    // Hermes Agent installs via the official scripts at
    // hermes-agent.nousresearch.com (irm|iex on Windows, curl|bash on
    // Unix). Mirrors the catalog's hermes `install_hints`.
    if tool_key == "hermes-agent" {
        let res = if cfg!(windows) {
            fleetify_core::process::tokio_command("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
                ])
                .output()
                .await
        } else {
            fleetify_core::process::tokio_command("sh")
                .args([
                    "-c",
                    "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
                ])
                .output()
                .await
        };
        return shell_installer_result(res, "hermes-agent");
    }
    let pkg = NPM_PROVIDER_PKG
        .iter()
        .find(|(k, _)| *k == tool_key)
        .map(|(_, p)| *p);
    let Some(pkg) = pkg else {
        return serde_json::json!({
            "success": false,
            "error": format!("unknown provider: {tool_key}")
        });
    };
    // Windows resolves `npm.cmd`; Unix resolves `npm` (no shell needed —
    // tokio::process honors PATHEXT on Windows for explicit `.cmd`).
    let bin = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let res = fleetify_core::process::tokio_command(bin)
        .args(["install", "--global", pkg])
        .output()
        .await;
    match res {
        Ok(o) if o.status.success() => serde_json::json!({
            "success": true,
            "out": String::from_utf8_lossy(&o.stdout).trim().to_string()
        }),
        Ok(o) => serde_json::json!({
            "success": false,
            "error": String::from_utf8_lossy(&o.stderr).trim().to_string()
        }),
        Err(e) => serde_json::json!({
            "success": false,
            "error": format!("npm spawn failed: {e}. Install Node.js / npm first.")
        }),
    }
}

#[tauri::command]
pub async fn shell_install_ollama() -> serde_json::Value {
    let download_url = "https://ollama.com/download";
    let res = if cfg!(windows) {
        fleetify_core::process::tokio_command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "iex (irm https://ollama.com/install.ps1)",
            ])
            .output()
            .await
    } else {
        fleetify_core::process::tokio_command("sh")
            .args(["-c", "curl -fsSL https://ollama.com/install.sh | sh"])
            .output()
            .await
    };
    match res {
        Ok(o) if o.status.success() => serde_json::json!({ "ok": true }),
        _ => {
            let _ = fleetify_backend::open_external::open_url(download_url);
            serde_json::json!({
                "ok": false,
                "error": "installer did not complete; opened ollama.com/download"
            })
        }
    }
}

/// Probe whether Python is installed and report its version. Used by
/// the renderer to render a "Python required" affordance on the
/// Antigravity SDK tile before offering Setup.
#[tauri::command]
pub async fn shell_check_python_runtime() -> serde_json::Value {
    // Share the locator with `bridges::antigravity_sdk::resolve_python`
    // so the renderer's probe and the bridge's spawn agree on the same
    // interpreter — across PATH lookup, Windows Store reparse-shim
    // filtering, and platform-specific install-prefix fallbacks
    // (Homebrew, pyenv, %LOCALAPPDATA%\Programs\Python, etc.).
    let Some(py_path) = fleetify_backend::services::python_runtime::locate_python() else {
        return serde_json::json!({ "installed": false, "version": null, "path": null });
    };
    let py = py_path.display().to_string();
    // 3s timeout — `--version` is instant on every healthy Python; a
    // hang here usually means Windows Store python launcher, which we
    // treat as not-installed for our purposes (it never resolves a
    // real interpreter without an interactive install dialog).
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        fleetify_core::process::tokio_command(&py)
            .arg("--version")
            .output(),
    )
    .await;
    let version: Option<String> = match res {
        Ok(Ok(o)) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let s = if s.is_empty() {
                String::from_utf8_lossy(&o.stderr).trim().to_string()
            } else {
                s
            };
            s.strip_prefix("Python ").map(|v| v.to_string()).or(Some(s))
        }
        _ => None,
    };
    serde_json::json!({
        "installed": version.is_some(),
        "version": version,
        "path": py
    })
}

// ── PTY ──────────────────────────────────────────────────────────
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> serde_json::Value {
    match pty::spawn(app, shell, cwd, env, cols, rows) {
        Ok(id) => serde_json::json!({ "ok": true, "id": id }),
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[tauri::command]
pub async fn pty_write(id: String, data: String) -> serde_json::Value {
    match pty::write(&id, &data) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub async fn pty_resize(id: String, cols: u16, rows: u16) -> serde_json::Value {
    match pty::resize(&id, cols, rows) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub async fn pty_kill(id: String) -> serde_json::Value {
    let _ = pty::kill(&id);
    serde_json::json!({ "ok": true })
}

/// All output a PTY has emitted so far. The in-chat login card polls this to
/// recover the device-OAuth URL/code that a child prints in the first few ms —
/// before an async `pty:data:<id>` listener has finished registering, so those
/// events would otherwise be dropped. `ok:false` once the child has exited.
#[tauri::command]
pub async fn pty_buffer(id: String) -> serde_json::Value {
    match pty::snapshot(&id) {
        Some(data) => serde_json::json!({ "ok": true, "data": data }),
        None => serde_json::json!({ "ok": false, "data": "" }),
    }
}

// ── dialog ───────────────────────────────────────────────────────
// `window.electronAPI.openFolderDialog()` → `Promise<string | null>`.
// Renderer (new-agent-dialog.tsx, session-toolbar.tsx) treats the
// awaited value as a single path string and gates on `if (p)`. An
// array would always be truthy and break the `if` check.
// `window.electronAPI.openFileDialog(opts)` → `Promise<string | null>`.
// Same single-path contract as the folder dialog. `extensions` filters the
// dialog when given (e.g. ["yml","yaml"] for compose files); a Dockerfile
// has no extension, so callers picking one pass no filter at all rather
// than an unmatchable one. `default_dir` opens the dialog in the session's
// project folder so the pick starts where the file almost certainly is.
#[tauri::command]
pub async fn dialog_open_file(
    app: tauri::AppHandle,
    default_dir: Option<String>,
    extensions: Option<Vec<String>>,
    title: Option<String>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    let mut dlg = app.dialog().file();
    if let Some(dir) = default_dir.filter(|d| !d.trim().is_empty()) {
        dlg = dlg.set_directory(dir);
    }
    if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
        dlg = dlg.set_title(t);
    }
    if let Some(exts) = extensions.filter(|e| !e.is_empty()) {
        let refs: Vec<&str> = exts.iter().map(|e| e.as_str()).collect();
        dlg = dlg.add_filter("Supported files", &refs);
    }
    dlg.pick_file(move |fp| {
        let _ = tx.send(fp);
    });
    match rx.await {
        Ok(Some(fp)) => fp.into_path().ok().map(|p| p.to_string_lossy().to_string()),
        _ => None,
    }
}

#[tauri::command]
pub async fn dialog_open_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog().file().pick_folder(move |fp| {
        let _ = tx.send(fp);
    });
    match rx.await {
        Ok(Some(fp)) => fp.into_path().ok().map(|p| p.to_string_lossy().to_string()),
        _ => None,
    }
}

// ── Logging IPC ──────────────────────────────────────────────────────
// Three commands:
//   • `app_log`         — renderer routes structured events into the
//                         backend's tracing pipeline. Both stderr and
//                         the on-disk file pick them up.
//   • `logs_export`     — bundle the last N days of logs + a system
//                         info JSON + a sanitized config snapshot into
//                         a single .zip the user can attach to a bug
//                         report. Returns the absolute path.
//   • `logs_open_folder` — reveal the log directory in Explorer /
//                          Finder / xdg-open. Power-user shortcut.

#[tauri::command]
pub fn app_log(
    level: String,
    target: String,
    message: String,
    fields: Option<serde_json::Value>,
) -> serde_json::Value {
    logging::write_renderer_event(&level, &target, &message, fields);
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn logs_export(app: tauri::AppHandle) -> serde_json::Value {
    use tauri_plugin_dialog::DialogExt;

    let Some(log_dir) = logging::logs_dir() else {
        return serde_json::json!({
            "ok": false,
            "error": "logging not initialised"
        });
    };

    // Default the dialog to ~/Downloads with a stamped filename. The user
    // can navigate elsewhere — the dialog also remembers their last
    // location for next time. Falls back to no preset dir if neither
    // USERPROFILE nor HOME resolves a Downloads folder (uncommon — Tauri
    // dialog still opens at the OS default in that case).
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let suggested_name = format!("fleetify-diagnostics-{stamp}.zip");
    let default_dir = default_downloads_dir();

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    {
        let mut builder = app
            .dialog()
            .file()
            .set_title("Save diagnostics bundle")
            .set_file_name(&suggested_name)
            .add_filter("Zip archive", &["zip"]);
        if let Some(dir) = default_dir.as_ref() {
            builder = builder.set_directory(dir);
        }
        builder.save_file(move |fp| {
            let _ = tx.send(fp);
        });
    }

    let chosen: PathBuf = match rx.await {
        Ok(Some(fp)) => match fp.into_path() {
            Ok(p) => p,
            Err(e) => {
                return serde_json::json!({
                    "ok": false,
                    "error": format!("invalid save target: {e}")
                })
            }
        },
        // Two cancel paths: the user closed the dialog (`Ok(None)`) or
        // the channel dropped before a callback fired (shouldn't happen,
        // but treat it the same — no error toast for either).
        _ => {
            return serde_json::json!({
                "ok": false,
                "cancelled": true,
            })
        }
    };

    let log_dir_owned = log_dir.to_path_buf();
    let out_path_clone = chosen.clone();
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let sys_info = build_system_info(&version);

    // zip / fs work happens on a blocking thread so the IPC future
    // doesn't stall the tokio runtime on a slow disk.
    let result = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        write_diagnostics_zip(&log_dir_owned, &out_path_clone, sys_info)
    })
    .await;

    match result {
        Ok(Ok(bytes)) => serde_json::json!({
            "ok": true,
            "path": chosen.to_string_lossy(),
            "bytes": bytes,
        }),
        Ok(Err(e)) => serde_json::json!({ "ok": false, "error": e }),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("join: {e}") }),
    }
}

fn default_downloads_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let downloads = home.join("Downloads");
    downloads.is_dir().then_some(downloads)
}

/// `window.fleetify.sendFeedback({ comment, email?, attachments? })`.
/// Wire format mirrors the Electron build's IPC: comment + optional
/// email + repeated `{ name, data_url }` image attachments. The Rust
/// side decodes, validates, multiparts, and POSTs to `<issuer>/api/feedback`.
#[tauri::command]
pub async fn feedback_send(body: serde_json::Value) -> serde_json::Value {
    let parsed: feedback::FeedbackBody = match serde_json::from_value(body) {
        Ok(b) => b,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "error": format!("Invalid feedback payload: {e}"),
                "code": "VALIDATION",
                "status": -1,
            });
        }
    };
    feedback::send_feedback(parsed).await
}

#[tauri::command]
pub fn logs_open_folder() -> serde_json::Value {
    let Some(log_dir) = logging::logs_dir() else {
        return serde_json::json!({
            "ok": false,
            "error": "logging not initialised"
        });
    };
    // Reuse the same OS-correct opener `shell_show_item_in_folder`
    // uses for files: passing the directory reveals it.
    let path_str = log_dir.to_string_lossy().to_string();
    if let Err(e) = fleetify_backend::open_external::open_path(log_dir) {
        return serde_json::json!({
            "ok": false,
            "error": format!("open log folder: {e}")
        });
    }
    serde_json::json!({ "ok": true, "path": path_str })
}

fn build_system_info(version: &str) -> serde_json::Value {
    serde_json::json!({
        "app_version": version,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
        "captured_at": chrono::Utc::now().to_rfc3339(),
    })
}

/// Walk the log dir, copy every `fleetify.log.*` file into the zip
/// alongside `system-info.json`. Returns the final byte size of the
/// zip so the renderer can show "X MB" in the toast / UI hint.
fn write_diagnostics_zip(
    log_dir: &std::path::Path,
    out_path: &std::path::Path,
    sys_info: serde_json::Value,
) -> Result<u64, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let f = std::fs::File::create(out_path).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(f);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 1. system-info.json — first entry so a tail-only viewer still
    //    sees build context.
    zip.start_file("system-info.json", opts)
        .map_err(|e| format!("zip start_file: {e}"))?;
    let info_bytes =
        serde_json::to_vec_pretty(&sys_info).map_err(|e| format!("system-info serialize: {e}"))?;
    zip.write_all(&info_bytes)
        .map_err(|e| format!("zip write: {e}"))?;

    // 2. Every log file under the log dir. Skip the crash flag and
    //    anything that doesn't look like a log rotation — the dir
    //    might pick up unrelated junk over time (manual exports the
    //    user dropped in there, etc.) which we don't want to ship.
    let entries = std::fs::read_dir(log_dir).map_err(|e| format!("read_dir {log_dir:?}: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.starts_with("fleetify.log") {
            continue;
        }
        let archive_name = format!("logs/{name}");
        zip.start_file(&archive_name, opts)
            .map_err(|e| format!("zip start_file {archive_name}: {e}"))?;
        let mut src = std::fs::File::open(&path).map_err(|e| format!("open {path:?}: {e}"))?;
        std::io::copy(&mut src, &mut zip).map_err(|e| format!("copy {path:?}: {e}"))?;
    }

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    let bytes = std::fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);
    Ok(bytes)
}

// ── Routers (Settings → Routers tile management) ───────────────────

#[derive(serde::Serialize)]
pub struct RouterTileMetadata {
    pub id: String,
    pub display_name: String,
    pub capabilities: Vec<&'static str>,
    /// Connection modes the router accepts. Empty = no credentials needed
    /// (`builtin`, `none-proxy`). `"managed"` = there's a default hosted
    /// endpoint and the user just provides an API key. `"self_hosted"` =
    /// the user must provide their own base URL alongside the key.
    pub modes: Vec<&'static str>,
    pub connected: bool,
    pub active_for_decision: bool,
    pub active_for_proxy: bool,
    /// User-supplied non-secret metadata (currently just `base_url` for
    /// self-hosted routers). Lets the renderer pre-populate the Edit form
    /// without round-tripping the IPC layer for each field.
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[tauri::command]
pub async fn routers_list_routers(app: tauri::AppHandle) -> serde_json::Value {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => {
            return serde_json::json!({ "ok": false, "error": "no app data dir", "tiles": [], "enabled": false })
        }
    };
    let cfg = config::load_config_from(&dir);
    let routing = config::routing_from(&cfg);

    // TODO(v1.1): replace this hardcoded list with a query against the
    // live `RoutingOrchestrator`'s `DecisionRouterRegistry::list()` and
    // `ProxyGatewayRegistry::list()`. The orchestrator owns the source
    // of truth for which routers are actually registered, but it lives
    // inside the embedded backend process and isn't directly reachable
    // from this Tauri IPC layer — fixing this requires a backend HTTP
    // endpoint (e.g. `GET /api/routing/registered`) and an internal
    // fetch from here. Day-1 simplification: keep the list in sync with
    // the four known routers + the direct gateway. See
    // `docs/superpowers/test-plans/2026-05-22-provider-router-e2e.md`
    // "Known Day-1 limitations" for the user-facing caveat.
    // (id, display_name, capabilities, modes)
    //   - capabilities: which dropdowns the router shows up in
    //   - modes: which credential flavors the router accepts. Drives the
    //     UI's "Managed / Self-hosted" radio in the Routers settings.
    type RouterCatalogEntry = (
        &'static str,
        &'static str,
        &'static [&'static str],
        &'static [&'static str],
    );
    let known: &[RouterCatalogEntry] = &[
        ("builtin", "Built-in (Fleetify)", &["decision"], &[]),
        ("notdiamond", "Not Diamond", &["decision"], &["managed"]),
        (
            "weave",
            "Weave Router",
            &["decision", "proxy"],
            &["managed", "self_hosted"],
        ),
        ("litellm", "LiteLLM", &["proxy"], &["self_hosted"]),
        ("none-proxy", "None / Direct", &["proxy"], &[]),
    ];

    let tiles: Vec<RouterTileMetadata> = known
        .iter()
        .map(|(id, name, caps, modes)| {
            let always_present = *id == "builtin" || *id == "none-proxy";
            let connected = always_present
                || routing
                    .connected_routers
                    .get(*id)
                    .map(|r| r.connected)
                    .unwrap_or(false);
            let metadata = routing
                .connected_routers
                .get(*id)
                .map(|r| r.metadata.clone())
                .unwrap_or(serde_json::Value::Null);
            RouterTileMetadata {
                id: (*id).to_string(),
                display_name: (*name).to_string(),
                capabilities: caps.to_vec(),
                modes: modes.to_vec(),
                connected,
                active_for_decision: routing.active_decision_router == *id,
                active_for_proxy: routing.active_proxy_gateway == *id,
                metadata,
            }
        })
        .collect();

    serde_json::json!({ "ok": true, "tiles": tiles, "enabled": routing.enabled })
}

#[tauri::command]
pub async fn routers_connect(
    app: tauri::AppHandle,
    id: String,
    secret: String,
    metadata: serde_json::Value,
) -> serde_json::Value {
    let Some(uid) = auth::get_user_id().await else {
        return serde_json::json!({ "ok": false, "code": "NO_USER", "error": "Fleetify sign-in required" });
    };
    if let Err(e) = crate::shell::routers_link::store_secret(&id, &uid, &secret) {
        return serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e });
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let saved = config::update_config(&dir, |cfg| {
            let mut routing = config::routing_from(cfg);
            routing.connected_routers.insert(
                id.clone(),
                config::ConnectedRouter {
                    connected: true,
                    metadata,
                },
            );
            config::routing_set(cfg, &routing);
        });
        if let Err(e) = saved {
            return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
        }
    }
    // Hot-reload the orchestrator so the new credentials are usable on the
    // very next chat / dispatch turn (vs. waiting until next app boot).
    crate::shell::routing_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn routers_disconnect(app: tauri::AppHandle, id: String) -> serde_json::Value {
    if let Some(uid) = auth::get_user_id().await {
        let _ = crate::shell::routers_link::delete_secret(&id, &uid);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = config::update_config(&dir, |cfg| {
            let mut routing = config::routing_from(cfg);
            routing.connected_routers.remove(&id);
            if routing.active_decision_router == id {
                routing.active_decision_router = "builtin".into();
            }
            if routing.active_proxy_gateway == id {
                routing.active_proxy_gateway = "none-proxy".into();
            }
            config::routing_set(cfg, &routing);
        });
    }
    crate::shell::routing_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn routers_set_active(
    app: tauri::AppHandle,
    category: String,
    id: String,
) -> serde_json::Value {
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    // Checked before anything is saved.
    let decision = match category.as_str() {
        "decision" => true,
        "proxy" => false,
        _ => return serde_json::json!({ "ok": false, "error": "invalid category" }),
    };
    let _ = config::update_config(&dir, |cfg| {
        let mut routing = config::routing_from(cfg);
        if decision {
            routing.active_decision_router = id;
        } else {
            routing.active_proxy_gateway = id;
        }
        config::routing_set(cfg, &routing);
    });
    crate::shell::routing_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn routers_set_master_toggle(app: tauri::AppHandle, enabled: bool) -> serde_json::Value {
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    let _ = config::update_config(&dir, |cfg| {
        let mut routing = config::routing_from(cfg);
        routing.enabled = enabled;
        config::routing_set(cfg, &routing);
    });
    crate::shell::routing_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

/// Returns a masked preview of the stored API key for a connected router
/// (e.g. `sk-…1234`). The full secret never crosses the IPC boundary —
/// only the first 3 and last 4 visible characters do. Lets the renderer
/// show the user "yes, you have a key on file" + an Edit link, without
/// surfacing the actual credential in renderer memory.
fn mask_secret(s: &str) -> String {
    let total = s.chars().count();
    if total <= 8 {
        return "•".repeat(total.max(4));
    }
    let prefix: String = s.chars().take(3).collect();
    let suffix: String = {
        let v: Vec<char> = s.chars().collect();
        v.iter().rev().take(4).rev().collect::<String>()
    };
    format!("{prefix}•••{suffix}")
}

#[tauri::command]
pub async fn routers_get_key_preview(id: String) -> serde_json::Value {
    if id == "builtin" || id == "none-proxy" {
        return serde_json::json!({ "ok": true, "preview": null });
    }
    let Some(uid) = auth::get_user_id().await else {
        return serde_json::json!({ "ok": false, "code": "NO_USER" });
    };
    match crate::shell::routers_link::read_secret(&id, &uid) {
        Ok(Some(secret)) => {
            serde_json::json!({ "ok": true, "preview": mask_secret(&secret) })
        }
        Ok(None) => serde_json::json!({ "ok": true, "preview": null }),
        Err(e) => serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e }),
    }
}

#[tauri::command]
pub async fn routers_test_router(id: String) -> serde_json::Value {
    if id == "builtin" || id == "none-proxy" {
        return serde_json::json!({ "ok": true, "always_available": true });
    }
    let Some(uid) = auth::get_user_id().await else {
        return serde_json::json!({ "ok": false, "code": "NO_USER" });
    };
    match crate::shell::routers_link::read_secret(&id, &uid) {
        Ok(Some(_)) => serde_json::json!({ "ok": true, "has_secret": true }),
        Ok(None) => serde_json::json!({ "ok": false, "code": "NO_SECRET" }),
        Err(e) => serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e }),
    }
}

// ── Providers (Settings → Models + Agents tile management) ─────────────
//
// Schema mirrors the routers_* block above: list/setKey/deleteKey return
// `{ ok, ... }` envelopes; secrets cross IPC only on setKey + testConnection
// (which carries a *draft* key the user just typed — the saved key is read
// from the keychain server-side). list returns spec + per-tile state so the
// renderer can render the whole Settings page from a single round-trip.

#[derive(serde::Serialize)]
pub struct ProviderTilePayload {
    pub spec: &'static fleetify_backend::providers::ProviderSpec,
    pub connected: bool,
    pub has_key: bool,
    pub enabled_models: Vec<String>,
    /// True when this tile is the current Fleet default — chat
    /// composer's `openComposer` pre-seeds `tool` and `model_name`
    /// from the matching `defaultProvider` / `defaultModel` keys in
    /// `fleet.config.json`. The renderer surfaces a "DEFAULT" badge
    /// and the per-tile "Make default" action gates off this bit.
    pub is_default: bool,
    /// Native permission + effort capability for this provider/its models.
    /// Drives the composer's capability-aware pickers (Phase 2).
    pub capabilities: fleetify_backend::providers::capabilities::TileCapabilities,
}

#[tauri::command]
pub async fn providers_list_catalog(app: tauri::AppHandle) -> serde_json::Value {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => {
            return serde_json::json!({ "ok": false, "error": "no app data dir", "tiles": [] })
        }
    };
    let cfg = config::load_config_from(&dir);
    let providers_cfg = config::providers_from(&cfg);
    // `defaultProvider` lives at the top level of fleet.config.json
    // (alongside `defaultModel` / `theme` / `apiKeys`) — kept there
    // so the renderer's `app-store.openComposer` can keep reading
    // it without a struct migration. The catalog tile builder just
    // includes the boolean per row.
    let default_provider_id = cfg
        .get("defaultProvider")
        .and_then(|v| v.as_str())
        .map(String::from);

    // has_key lookup is best-effort: skip it when the user isn't signed in
    // so we don't surface a confusing NO_USER on every Settings render.
    // Renderer treats has_key as a hint, not the source of truth.
    let uid = auth::get_user_id().await;

    let tiles: Vec<ProviderTilePayload> = fleetify_backend::providers::CATALOG
        .iter()
        .map(|spec| {
            let has_key = match (uid.as_deref(), spec.id) {
                (Some(u), id) => {
                    matches!(
                        crate::shell::providers_link::read_secret(id, u),
                        Ok(Some(_))
                    )
                }
                _ => false,
            };
            // `tile.connected` is the master "enabled in Fleet" bit. The
            // user can toggle it independently via providers_set_enabled
            // — that writes an explicit override into `connected[id]`.
            // When no override exists we fall back to a sensible auto
            // default per provider kind: API → only enabled when a key
            // is saved; CLI / LocalHttp → enabled by default (their
            // install/auth state is surfaced by separate scans, not by
            // this bit). Disconnect / delete-key still flips the entry
            // to `false` so existing flows are unaffected.
            let auto_default = match spec.kind {
                fleetify_backend::providers::ProviderKind::Api => has_key,
                fleetify_backend::providers::ProviderKind::Cli
                | fleetify_backend::providers::ProviderKind::LocalHttp => true,
            };
            let connected = providers_cfg
                .connected
                .get(spec.id)
                .copied()
                .unwrap_or(auto_default);
            let enabled_models = providers_cfg
                .enabled_models
                .get(spec.id)
                .cloned()
                .unwrap_or_default();
            let is_default = default_provider_id.as_deref() == Some(spec.id);
            let capabilities = fleetify_backend::providers::capabilities::tile_capabilities(spec);
            ProviderTilePayload {
                spec,
                connected,
                has_key,
                enabled_models,
                is_default,
                capabilities,
            }
        })
        .collect();

    serde_json::json!({ "ok": true, "tiles": tiles })
}

#[tauri::command]
pub async fn providers_set_key(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> serde_json::Value {
    if fleetify_backend::providers::find_provider(&id).is_none() {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER", "error": format!("unknown provider {id}") });
    }
    let Some(uid) = auth::get_user_id().await else {
        return serde_json::json!({ "ok": false, "code": "NO_USER", "error": "Fleetify sign-in required" });
    };
    if let Err(e) = crate::shell::providers_link::store_secret(&id, &uid, &key) {
        return serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e });
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let saved = config::update_config(&dir, |cfg| {
            let mut providers = config::providers_from(cfg);
            providers.connected.insert(id.clone(), true);
            config::providers_set(cfg, &providers);
        });
        if let Err(e) = saved {
            return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
        }
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    fleetify_backend::services::telemetry::emitters::emit_provider_connected(&id).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn providers_get_key_preview(id: String) -> serde_json::Value {
    // Validate the provider id. Local providers (ollama) may now carry an
    // optional key (e.g. an authenticated remote rig), so they fall through
    // to the normal masked-preview path — which still returns null when no
    // key is stored.
    if fleetify_backend::providers::find_provider(&id).is_none() {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER" });
    }
    let Some(uid) = auth::get_user_id().await else {
        return serde_json::json!({ "ok": false, "code": "NO_USER" });
    };
    match crate::shell::providers_link::read_secret(&id, &uid) {
        Ok(Some(secret)) => serde_json::json!({ "ok": true, "preview": mask_secret(&secret) }),
        Ok(None) => serde_json::json!({ "ok": true, "preview": null }),
        Err(e) => serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e }),
    }
}

#[tauri::command]
pub async fn providers_delete_key(app: tauri::AppHandle, id: String) -> serde_json::Value {
    if let Some(uid) = auth::get_user_id().await {
        let _ = crate::shell::providers_link::delete_secret(&id, &uid);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = config::update_config(&dir, |cfg| {
            let mut providers = config::providers_from(cfg);
            providers.connected.insert(id.clone(), false);
            config::providers_set(cfg, &providers);
        });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    fleetify_backend::services::telemetry::emitters::emit_provider_disconnected(&id).await;
    serde_json::json!({ "ok": true })
}

// ── Multi-account: per-account keychain keys (HTTP) + PTY login (CLI) ──────

/// Store an API key for a specific HTTP provider *account* (keychain account
/// field = the account id, vs. the OIDC sub used for the System key). Then
/// reloads the backend so the labeled key is live on the next chat turn.
#[tauri::command]
pub async fn providers_set_account_key(
    app: tauri::AppHandle,
    id: String,
    account_id: String,
    key: String,
) -> serde_json::Value {
    if fleetify_backend::providers::find_provider(&id).is_none() {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER" });
    }
    if let Err(e) = crate::shell::providers_link::store_secret(&id, &account_id, &key) {
        return serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

/// Read a masked preview of an HTTP account's stored key (or null when none).
#[tauri::command]
pub async fn providers_get_account_key_preview(
    id: String,
    account_id: String,
) -> serde_json::Value {
    match crate::shell::providers_link::read_secret(&id, &account_id) {
        Ok(Some(secret)) => serde_json::json!({ "ok": true, "preview": mask_secret(&secret) }),
        Ok(None) => serde_json::json!({ "ok": true, "preview": null }),
        Err(e) => serde_json::json!({ "ok": false, "code": "KEYCHAIN", "error": e }),
    }
}

/// Delete an HTTP account's keychain key (called after the account row is
/// removed via the REST `DELETE /accounts` endpoint), then reload.
#[tauri::command]
pub async fn providers_delete_account_key(
    app: tauri::AppHandle,
    id: String,
    account_id: String,
) -> serde_json::Value {
    let _ = crate::shell::providers_link::delete_secret(&id, &account_id);
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

/// Launch a CLI agent's own login flow inside a PTY whose HOME (+XDG/Windows
/// equivalents) point at the account's isolated dir, so the agent writes its
/// credentials into that account's home. Returns a `pty_id` the renderer binds
/// to a terminal view (the user completes the OAuth / device-code flow there);
/// on exit the renderer refreshes the agent scan so the account flips to
/// "Detected". CLI agents only — HTTP providers use `providers_set_account_key`.
#[tauri::command]
pub async fn providers_open_account_login(
    app: tauri::AppHandle,
    id: String,
    account_id: String,
) -> serde_json::Value {
    let Some(spec) = fleetify_backend::providers::find_agent(&id) else {
        return serde_json::json!({ "ok": false, "code": "NOT_CLI_AGENT", "error": format!("{id} is not a CLI agent") });
    };
    // The login command comes straight from the catalog's login_hint
    // (e.g. "claude login", "opencode auth login"). Empty ⇒ interactive bin.
    let tokens: Vec<String> = if spec.login_hint.trim().is_empty() {
        vec![spec.bin.to_string()]
    } else {
        spec.login_hint
            .split_whitespace()
            .map(String::from)
            .collect()
    };
    if tokens.is_empty() {
        return serde_json::json!({ "ok": false, "code": "NO_LOGIN", "error": "no login command for this agent" });
    }
    // Resolve the binary to an absolute path, sharing the bridges' per-agent
    // resolvers so off-PATH installs (cursor/hermes/copilot) are found.
    let program = match spec.id {
        "cursor-cli" => fleetify_backend::bridges::cursor::resolve_cursor_bin(),
        "hermes-agent" => fleetify_backend::bridges::hermes::resolve_hermes_bin(),
        "github-copilot" => fleetify_backend::bridges::github_copilot::resolve_copilot_bin(),
        _ => which::which(&tokens[0])
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
    .unwrap_or_else(|| tokens[0].clone());
    let args: Vec<String> = tokens[1..].to_vec();

    // Resolve the account's config dir. A discovered account (`dir:.claude-2`)
    // points at the existing `~/.claude-2`; a managed account gets a dir under
    // ~/.fleetify/accounts/. Create it so the login flow has somewhere to write.
    let home = match account_id.strip_prefix("dir:") {
        Some(name) => fleetify_core::user_home().join(name),
        None => fleetify_backend::services::accounts::account_home_dir(&id, &account_id),
    };
    if let Err(e) = std::fs::create_dir_all(&home) {
        return serde_json::json!({ "ok": false, "code": "MKDIR", "error": e.to_string() });
    }
    // Config-dir agents (claude/codex) isolate via their native env var
    // (CLAUDE_CONFIG_DIR / CODEX_HOME) pointed at this dir; others get the full
    // HOME/XDG bundle. Matches services::accounts::resolve_env at dispatch.
    let mut env: HashMap<String, String> =
        match fleetify_backend::services::accounts::config_dir_spec(&id) {
            Some((env_var, _)) => {
                std::iter::once((env_var.to_string(), home.to_string_lossy().into_owned()))
                    .collect()
            }
            None => fleetify_backend::services::accounts::account_env(&home)
                .into_iter()
                .collect(),
        };
    // Force a sane TERM so the agent's prompts render predictably under ConPTY.
    env.insert("TERM".into(), "xterm-256color".into());

    match pty::spawn_argv(
        app,
        program,
        args,
        Some(home.to_string_lossy().into_owned()),
        Some(env),
        None,
        None,
    ) {
        Ok(pty_id) => serde_json::json!({ "ok": true, "pty_id": pty_id }),
        Err(e) => serde_json::json!({ "ok": false, "code": "SPAWN", "error": e }),
    }
}

/// Launch a CLI agent's own login flow against the user's REAL home — the
/// System/default credential store. Unlike [`providers_open_account_login`]
/// (which relocates HOME to an isolated per-account dir for the Settings
/// "add account" flow), this inherits the real environment, so the agent
/// writes its credentials exactly where the chat bridge will read them
/// (`accounts::resolve_env` returns an empty env for the System account, i.e.
/// the bridge runs in the real HOME too). Powers the in-chat login-recovery
/// card: e.g. Grok's `session/new` `-32000 Authentication required` triggers
/// `grok login` here, then the original prompt resumes once login succeeds.
/// Returns a `pty_id` the renderer binds to via `pty:data`/`pty:exit`.
#[tauri::command]
pub async fn agent_login_default(app: tauri::AppHandle, id: String) -> serde_json::Value {
    let Some(spec) = fleetify_backend::providers::find_agent(&id) else {
        return serde_json::json!({ "ok": false, "code": "NOT_CLI_AGENT", "error": format!("{id} is not a CLI agent") });
    };
    // The login command comes from the catalog's login_hint (e.g. "grok login",
    // "claude login"). Empty ⇒ the interactive bin itself.
    let tokens: Vec<String> = if spec.login_hint.trim().is_empty() {
        vec![spec.bin.to_string()]
    } else {
        spec.login_hint
            .split_whitespace()
            .map(String::from)
            .collect()
    };
    if tokens.is_empty() {
        return serde_json::json!({ "ok": false, "code": "NO_LOGIN", "error": "no login command for this agent" });
    }
    // Resolve the binary to an absolute path, sharing the bridges' per-agent
    // resolvers so off-PATH installs are found (grok writes ~/.local/bin/grok).
    let program = match spec.id {
        "grok-build" => fleetify_backend::bridges::grok_cli::resolve_grok_bin(),
        "cursor-cli" => fleetify_backend::bridges::cursor::resolve_cursor_bin(),
        "hermes-agent" => fleetify_backend::bridges::hermes::resolve_hermes_bin(),
        "github-copilot" => fleetify_backend::bridges::github_copilot::resolve_copilot_bin(),
        _ => which::which(&tokens[0])
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    }
    .unwrap_or_else(|| tokens[0].clone());
    let args: Vec<String> = tokens[1..].to_vec();
    let cwd = fleetify_core::user_home().to_string_lossy().into_owned();

    // Piped (NOT a PTY): a device-OAuth login writes its URL/code to stderr and
    // needs no TTY, and piped output is clean — a ConPTY wraps it in cursor
    // escape codes that mangle the URL. `env: None` ⇒ inherit the real
    // environment (real HOME/PATH); NO per-account HOME override, so the login
    // and the chat bridge share one credential store.
    match pty::spawn_piped(app, program, args, Some(cwd), None) {
        Ok(pty_id) => serde_json::json!({ "ok": true, "pty_id": pty_id }),
        Err(e) => serde_json::json!({ "ok": false, "code": "SPAWN", "error": e }),
    }
}

/// Flip a provider's "enabled in Fleet" bit independently of the
/// keychain entry. Writes an explicit override to
/// `ProvidersConfig.connected[id]` so the user can hide a provider
/// from the chat composer's picker without deleting the saved key
/// (or surface a CLI agent that's installed but they hadn't yet
/// opted in). Emits a connect/disconnect telemetry event so the
/// boot warm-up and Settings → Models pill cache stay in sync.
#[tauri::command]
pub async fn providers_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> serde_json::Value {
    if fleetify_backend::providers::find_provider(&id).is_none() {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER", "error": format!("unknown provider {id}") });
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let saved = config::update_config(&dir, |cfg| {
            let mut providers = config::providers_from(cfg);
            providers.connected.insert(id.clone(), enabled);
            config::providers_set(cfg, &providers);
        });
        if let Err(e) = saved {
            return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
        }
    } else {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": "no app data dir" });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    if enabled {
        fleetify_backend::services::telemetry::emitters::emit_provider_connected(&id).await;
    } else {
        fleetify_backend::services::telemetry::emitters::emit_provider_disconnected(&id).await;
    }
    serde_json::json!({ "ok": true })
}

/// Bulk-write provider enabled state in a single config save + one
/// backend reload. Onboarding calls this once after the user confirms
/// their selection so we don't fan out one `providers_set_enabled` per
/// provider (each of which reloads the backend). `connected` is a full
/// id→bool map applied verbatim onto `ProvidersConfig.connected`.
/// `enabled_agents`, when `Some`, REPLACES the CLI-agent shortlist
/// (Settings → Agents' "Active" section + the New Agent dialog) so the
/// Agents page agrees with the toggles. We validate every id up front
/// and reject the whole batch on the first unknown one, so a typo never
/// writes a half-applied map.
#[tauri::command]
pub async fn providers_set_connected_bulk(
    app: tauri::AppHandle,
    connected: std::collections::HashMap<String, bool>,
    enabled_agents: Option<Vec<String>>,
) -> serde_json::Value {
    for id in connected.keys() {
        if fleetify_backend::providers::find_provider(id).is_none() {
            return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER", "error": format!("unknown provider {id}") });
        }
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": "no app data dir" });
    };
    let saved = config::update_config(&dir, |cfg| {
        let mut providers = config::providers_from(cfg);
        for (id, on) in &connected {
            providers.connected.insert(id.clone(), *on);
        }
        if let Some(agents) = enabled_agents {
            providers.enabled_agents = agents;
        }
        config::providers_set(cfg, &providers);
    });
    if let Err(e) = saved {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

/// Pick the Fleet default provider. Writes both the top-level
/// `defaultProvider` (provider id) AND `defaultModel` (best model
/// from the catalog) into `fleet.config.json` — the renderer's
/// `app-store.openComposer` reads both when seeding a new chat, so
/// keeping the model paired with the provider here prevents the
/// classic mismatch (pick Codex, composer still uses
/// `claude-sonnet-4-6`). For CLI agents the catalog ships an empty
/// `default_models` (models live inside each binary), so we only
/// write the provider id and let the composer's CLI baseline fill
/// in the model name.
#[tauri::command]
pub async fn providers_set_default(
    app: tauri::AppHandle,
    id: String,
    model: Option<String>,
) -> serde_json::Value {
    let Some(spec) = fleetify_backend::providers::find_provider(&id) else {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER", "error": format!("unknown provider {id}") });
    };
    // An explicit model from the caller (onboarding's model step) wins.
    // Falling back to the catalog's first model keeps every existing
    // caller — Settings → Models / Agents "Make default" — unchanged
    // (they pass no model; CLI agents ship an empty default_models → None).
    let default_model: Option<String> = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .or_else(|| spec.default_models.first().map(|m| m.id.to_string()));

    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": "no app data dir" });
    };
    let saved = config::update_config(&dir, |cfg| match cfg {
        serde_json::Value::Object(map) => {
            map.insert(
                "defaultProvider".into(),
                serde_json::Value::String(id.clone()),
            );
            if let Some(model) = default_model.clone() {
                map.insert("defaultModel".into(), serde_json::Value::String(model));
            }
        }
        _ => {
            *cfg = serde_json::json!({
                "defaultProvider": id.clone(),
                "defaultModel": default_model.clone(),
            });
        }
    });
    if let Err(e) = saved {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    // No backend reload needed — `defaultProvider` is consumed
    // renderer-side only (the embedded backend dispatches by
    // `session.tool`, which is seeded from this default at session
    // create time).
    serde_json::json!({ "ok": true, "default_model": default_model })
}

/// Probe the provider's `/models` endpoint with the supplied draft key.
/// Returns `{ok, latency_ms, model_count?}` on success or
/// `{ok: false, code: "AUTH|NETWORK|TIMEOUT|NOT_FOUND", error}` on
/// failure. The draft key is consumed in-process only and never persisted
/// — the renderer is responsible for calling `providers_set_key`
/// separately when the user clicks Save.
///
/// Phase 1 keeps the check to `GET <base>/models`; Phase 3 may add a
/// 1-token completion fallback for providers (Perplexity) that don't
/// expose a models endpoint. Until then, those providers report
/// NOT_FOUND and the user can still Save without testing.
#[tauri::command]
pub async fn providers_test_connection(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> serde_json::Value {
    let Some(spec) = fleetify_backend::providers::find_provider(&id) else {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER", "error": format!("unknown provider {id}") });
    };
    if matches!(
        spec.kind,
        fleetify_backend::providers::ProviderKind::LocalHttp
    ) {
        return serde_json::json!({ "ok": false, "code": "USE_PROBE", "error": "Use providers_ollama_probe for local providers" });
    }

    // Empty key means "use the saved keychain key" — lets the renderer
    // launch-time health scan validate every saved-key tile without
    // needing the user's plaintext key in JS memory.
    let effective_key = if key.is_empty() {
        match auth::get_user_id().await {
            Some(uid) => match crate::shell::providers_link::read_secret(&id, &uid) {
                Ok(Some(secret)) => secret,
                Ok(None) => {
                    return serde_json::json!({ "ok": false, "code": "AUTH", "error": "no saved key for this provider" })
                }
                Err(e) => return serde_json::json!({ "ok": false, "code": "AUTH", "error": e }),
            },
            None => {
                return serde_json::json!({ "ok": false, "code": "AUTH", "error": "Fleetify sign-in required" })
            }
        }
    } else {
        key
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({ "ok": false, "code": "NETWORK", "error": e.to_string() })
        }
    };
    // Workers AI has no OpenAI-compat `/models` and an account-templated base
    // URL; probe the account-independent token-verify endpoint instead so the
    // Test/health path doesn't fire an authenticated request at a malformed
    // URL (mirrors providers_health::probe_one).
    let url = if id == "cloudflare-workers-ai" {
        "https://api.cloudflare.com/client/v4/user/tokens/verify".to_string()
    } else if id == "ollama-cloud" {
        // Ollama's catalog lives at `/api/tags`, not OpenAI's `/models`
        // (`https://ollama.com/models` is the HTML site, not an API).
        // NOTE: ollama.com /api/tags is unauthenticated (lists cloud models
        // without a key), so this validates reachability, not the key. A wrong
        // key may still 200. Authenticated key-check (minimal /api/chat) is
        // gated on Task 16 E2E.
        //
        // Honor the configurable `providers.ollama_cloud_base_url` override the
        // same way dispatch + discovery do. Falls back to the catalog default
        // (`spec.default_base_url` == `https://ollama.com`) when unset, so this
        // is a no-op for users who never set one.
        let base = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| config::providers_from(&config::load_config_from(&dir)))
            .and_then(|p| p.ollama_cloud_base_url)
            .unwrap_or_else(|| spec.default_base_url.to_string());
        format!("{}/api/tags", base.trim_end_matches('/'))
    } else {
        format!("{}/models", spec.default_base_url.trim_end_matches('/'))
    };
    let started = std::time::Instant::now();
    let result = client
        .get(&url)
        .header("Authorization", format!("Bearer {effective_key}"))
        .send()
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let outcome = match result {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                let model_count = resp.json::<serde_json::Value>().await.ok().and_then(|v| {
                    v.get("data")
                        .and_then(|d| d.as_array())
                        .map(|a| a.len())
                        // Ollama's /api/tags returns `{models:[...]}` (cloud catalog).
                        .or_else(|| v.get("models").and_then(|m| m.as_array()).map(|a| a.len()))
                        // Some providers (e.g. Ollama-compat shims) return the bare array.
                        .or_else(|| v.as_array().map(|a| a.len()))
                });
                serde_json::json!({ "ok": true, "latency_ms": elapsed_ms, "model_count": model_count })
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                serde_json::json!({ "ok": false, "code": "AUTH", "error": format!("HTTP {status}"), "latency_ms": elapsed_ms })
            } else if status.as_u16() == 404 {
                serde_json::json!({ "ok": false, "code": "NOT_FOUND", "error": format!("HTTP {status} at {url}"), "latency_ms": elapsed_ms })
            } else if status.as_u16() == 400 {
                // Gemini's OpenAI-compat /models rejects bad keys with
                // HTTP 400 + an API_KEY_INVALID error envelope instead
                // of 401/403. Inspect the body before falling back to
                // the generic NETWORK bucket so the onboarding pill
                // actually flags the key as rejected.
                let body = resp.text().await.unwrap_or_default();
                if fleetify_backend::services::providers_health::is_key_rejection_body(&body) {
                    serde_json::json!({ "ok": false, "code": "AUTH", "error": "API key rejected by the provider", "latency_ms": elapsed_ms })
                } else {
                    serde_json::json!({ "ok": false, "code": "NETWORK", "error": format!("HTTP {status}"), "latency_ms": elapsed_ms })
                }
            } else {
                serde_json::json!({ "ok": false, "code": "NETWORK", "error": format!("HTTP {status}"), "latency_ms": elapsed_ms })
            }
        }
        Err(e) if e.is_timeout() => {
            serde_json::json!({ "ok": false, "code": "TIMEOUT", "error": e.to_string() })
        }
        Err(e) => {
            serde_json::json!({ "ok": false, "code": "NETWORK", "error": e.to_string() })
        }
    };
    let ok = outcome.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
    let code = outcome.get("code").and_then(|c| c.as_str());
    fleetify_backend::services::telemetry::emitters::emit_provider_test_connection(
        &id,
        ok,
        code,
        Some(elapsed_ms),
    )
    .await;
    outcome
}

/// Format the optional Ollama bearer header. Shared by the ollama probe/ps/pull/delete commands.
fn ollama_bearer(key: Option<String>) -> Option<String> {
    key.map(|k| format!("Bearer {k}"))
}

/// Probe an Ollama server for the model catalog. `base_url` falls back to the
/// user's configured value, then `$OLLAMA_HOST`, then the IPv4 loopback
/// default (see `fleetify_core::resolve_ollama_base_url` for why not
/// `localhost`). Returns the model list verbatim so the renderer can drive
/// checkbox state.
#[tauri::command]
pub async fn providers_ollama_probe(
    app: tauri::AppHandle,
    base_url: Option<String>,
) -> serde_json::Value {
    let configured = base_url.or_else(|| {
        app.path()
            .app_data_dir()
            .ok()
            .map(|d| config::providers_from(&config::load_config_from(&d)))
            .and_then(|p| p.ollama_base_url)
    });
    let resolved = fleetify_core::resolve_ollama_base_url(
        configured.as_deref(),
        std::env::var("OLLAMA_HOST").ok().as_deref(),
    );

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": e.to_string(), "base_url": resolved })
        }
    };
    let url = format!("{}/api/tags", resolved.trim_end_matches('/'));
    // Optional saved key — a secured/reverse-proxied daemon needs it; keyless
    // localhost works unchanged (no user or no saved key ⇒ no header).
    let key = match auth::get_user_id().await {
        Some(uid) => crate::shell::providers_link::read_secret("ollama", &uid)
            .ok()
            .flatten(),
        None => None,
    };
    let mut req = client.get(&url);
    if let Some(h) = ollama_bearer(key) {
        req = req.header("Authorization", h);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                let models = body
                    .get("models")
                    .and_then(|m| m.as_array())
                    .cloned()
                    .unwrap_or_default();
                serde_json::json!({ "ok": true, "running": true, "base_url": resolved, "models": models })
            }
            Err(e) => {
                serde_json::json!({ "ok": false, "running": true, "code": "PARSE", "error": e.to_string(), "base_url": resolved })
            }
        },
        Ok(resp) => {
            let status = resp.status();
            // 401/403 (or 407 proxy auth) ⇒ the daemon answered but rejected
            // the request: a secured / reverse-proxied rig that needs an API
            // key, not a network fault. Surface it as AUTH (running: the server
            // IS reachable) so the card can prompt for a key ("Needs API key")
            // instead of a misleading "can't reach the daemon".
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
                || status == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED
            {
                serde_json::json!({ "ok": false, "running": true, "code": "AUTH", "error": format!("HTTP {status}"), "base_url": resolved })
            } else {
                serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": format!("HTTP {status}"), "base_url": resolved })
            }
        }
        Err(e) if e.is_timeout() => {
            serde_json::json!({ "ok": false, "running": false, "code": "TIMEOUT", "error": e.to_string(), "base_url": resolved })
        }
        Err(e) => {
            serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": e.to_string(), "base_url": resolved })
        }
    }
}

/// Pass through the running-model fields from Ollama's `/api/ps` payload.
/// Absent keys serialize as JSON `null`, which the renderer tolerates.
fn ollama_ps_models(body: &serde_json::Value) -> serde_json::Value {
    let models = body
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "name": m.get("name"),
                "size": m.get("size"),
                "size_vram": m.get("size_vram"),
                "expires_at": m.get("expires_at"),
                "context_length": m.get("context_length"),
                "details": m.get("details"),
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!(models)
}

/// Per-layer accumulator for `/api/pull` NDJSON progress. Ollama streams one
/// line per layer keyed by `digest`; the percentage is `Σcompleted / Σtotal`
/// recomputed every line, so the denominator grows as new layers begin. Pure
/// (no I/O) — Task 9's streaming loop folds each decoded line through `update`.
#[derive(Default)]
pub struct OllamaPullProgress {
    layers: HashMap<String, (u64, u64)>,
} // digest -> (completed, total)

impl OllamaPullProgress {
    /// Fold one NDJSON line; returns (completed_total, total_total, percent 0..100).
    pub fn update(&mut self, line: &serde_json::Value) -> (u64, u64, f64) {
        if let (Some(d), Some(total)) = (
            line.get("digest").and_then(|d| d.as_str()),
            line.get("total").and_then(|t| t.as_u64()),
        ) {
            let completed = line.get("completed").and_then(|c| c.as_u64()).unwrap_or(0);
            self.layers.insert(d.to_string(), (completed, total));
        }
        let completed: u64 = self.layers.values().map(|(c, _)| *c).sum();
        let total: u64 = self.layers.values().map(|(_, t)| *t).sum();
        let pct = if total > 0 {
            (completed as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        (completed, total, pct)
    }
    pub fn is_done(line: &serde_json::Value) -> bool {
        line.get("status").and_then(|s| s.as_str()) == Some("success")
    }
    pub fn is_error(line: &serde_json::Value) -> Option<String> {
        line.get("error").and_then(|e| e.as_str()).map(String::from)
    }
}

/// List the models Ollama currently holds in memory via `/api/ps`. Mirrors
/// `providers_ollama_probe` (same base resolution, optional saved key, 2s
/// client, error taxonomy) but reads the running set rather than the catalog.
#[tauri::command]
pub async fn providers_ollama_ps(
    app: tauri::AppHandle,
    base_url: Option<String>,
) -> serde_json::Value {
    let resolved = base_url
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|d| config::providers_from(&config::load_config_from(&d)))
                .and_then(|p| p.ollama_base_url)
        })
        .unwrap_or_else(|| "http://localhost:11434".into());

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": e.to_string(), "base_url": resolved })
        }
    };
    let url = format!("{}/api/ps", resolved.trim_end_matches('/'));
    // Optional saved key — a secured/reverse-proxied daemon needs it; keyless
    // localhost works unchanged (no user or no saved key ⇒ no header).
    let key = match auth::get_user_id().await {
        Some(uid) => crate::shell::providers_link::read_secret("ollama", &uid)
            .ok()
            .flatten(),
        None => None,
    };
    let mut req = client.get(&url);
    if let Some(h) = ollama_bearer(key) {
        req = req.header("Authorization", h);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => {
                serde_json::json!({ "ok": true, "running": true, "base_url": resolved, "models": ollama_ps_models(&body) })
            }
            Err(e) => {
                serde_json::json!({ "ok": false, "running": true, "code": "PARSE", "error": e.to_string(), "base_url": resolved })
            }
        },
        Ok(resp) => {
            let status = resp.status();
            // 401/403 (or 407 proxy auth) ⇒ the daemon answered but rejected
            // the request: a secured / reverse-proxied rig that needs an API
            // key, not a network fault. Surface it as AUTH (running: the server
            // IS reachable) so the card can prompt for a key ("Needs API key")
            // instead of a misleading "can't reach the daemon".
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
                || status == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED
            {
                serde_json::json!({ "ok": false, "running": true, "code": "AUTH", "error": format!("HTTP {status}"), "base_url": resolved })
            } else {
                serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": format!("HTTP {status}"), "base_url": resolved })
            }
        }
        Err(e) if e.is_timeout() => {
            serde_json::json!({ "ok": false, "running": false, "code": "TIMEOUT", "error": e.to_string(), "base_url": resolved })
        }
        Err(e) => {
            serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": e.to_string(), "base_url": resolved })
        }
    }
}

/// Drain complete `\n`-terminated JSON lines from `buf`, parsing each; leaves
/// any trailing partial line in `buf` for the next chunk. Ollama's `/api/pull`
/// stream is NDJSON and a single TCP chunk can split a line, so the loop must
/// buffer the remainder rather than drop it.
fn drain_ndjson(buf: &mut Vec<u8>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) {
            out.push(v);
        }
    }
    out
}

// Per-model cancel flags for in-flight `/api/pull` streams, keyed by model
// name. `providers_ollama_pull` registers a fresh flag on entry and removes it
// on exit; `providers_ollama_pull_cancel` flips it. Mirrors the `GH_AUTH_CHILD`
// OnceLock<Mutex<…>> global-state slot.
static OLLAMA_PULL_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
fn ollama_pull_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    OLLAMA_PULL_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pull a model from an Ollama server, streaming `/api/pull` NDJSON progress to
/// the renderer via `ollama-pull-progress` events. Base resolution + the
/// optional saved bearer mirror `providers_ollama_probe`. A pull runs for
/// minutes, so the client carries no overall timeout (only a connect cap);
/// `providers_ollama_pull_cancel` aborts it between chunks (Ollama resumes the
/// download on a later retry). Terminal state (`success` / `error`) is conveyed
/// via events — the return value only acknowledges the command landed.
#[tauri::command]
pub async fn providers_ollama_pull(
    app: tauri::AppHandle,
    model: String,
    base_url: Option<String>,
) -> serde_json::Value {
    let resolved = base_url
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|d| config::providers_from(&config::load_config_from(&d)))
                .and_then(|p| p.ollama_base_url)
        })
        .unwrap_or_else(|| "http://localhost:11434".into());

    // Register a fresh cancel flag so `providers_ollama_pull_cancel` can abort
    // this stream the instant the user clicks cancel.
    let cancel = Arc::new(AtomicBool::new(false));
    ollama_pull_cancels()
        .lock()
        .unwrap()
        .insert(model.clone(), cancel.clone());

    // Optional saved key — a secured/reverse-proxied daemon needs it; keyless
    // localhost works unchanged (no user or no saved key ⇒ no header).
    let key = match auth::get_user_id().await {
        Some(uid) => crate::shell::providers_link::read_secret("ollama", &uid)
            .ok()
            .flatten(),
        None => None,
    };

    // No overall timeout — pulls take minutes — but cap the initial connect.
    let built = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .build();
    let url = format!("{}/api/pull", resolved.trim_end_matches('/'));

    // A single labeled block so every terminal path lands on one cleanup.
    'pull: {
        let client = match built {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "ollama-pull-progress",
                    serde_json::json!({ "model": model, "status": "error", "error": e.to_string() }),
                );
                break 'pull;
            }
        };
        let mut req = client
            .post(&url)
            .json(&serde_json::json!({ "model": model, "stream": true }));
        if let Some(h) = ollama_bearer(key) {
            req = req.header("Authorization", h);
        }
        let mut resp = match req.send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let _ = app.emit(
                    "ollama-pull-progress",
                    serde_json::json!({ "model": model, "status": "error", "error": format!("HTTP {}", r.status()) }),
                );
                break 'pull;
            }
            Err(e) => {
                let _ = app.emit(
                    "ollama-pull-progress",
                    serde_json::json!({ "model": model, "status": "error", "error": e.to_string() }),
                );
                break 'pull;
            }
        };

        // Fold each decoded NDJSON line through the per-layer accumulator,
        // emitting a progress event per line and a terminal event on
        // success/error. `drain_ndjson` keeps any partial trailing line.
        let mut prog = OllamaPullProgress::default();
        let mut buf: Vec<u8> = Vec::new();
        loop {
            // Honor cancellation before blocking on the next chunk read.
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    for line in drain_ndjson(&mut buf) {
                        if let Some(msg) = OllamaPullProgress::is_error(&line) {
                            let _ = app.emit(
                                "ollama-pull-progress",
                                serde_json::json!({ "model": model, "status": "error", "error": msg }),
                            );
                            break 'pull;
                        }
                        // The final `{"status":"success"}` line is terminal:
                        // emit ONLY the dedicated 100% frame and break. Emitting
                        // the per-line event too would hand the renderer a second
                        // terminal event (with stale completed/total), so it
                        // re-probes twice and never paints the 100% frame.
                        if OllamaPullProgress::is_done(&line) {
                            let _ = app.emit(
                                "ollama-pull-progress",
                                serde_json::json!({ "model": model, "status": "success", "percent": 100 }),
                            );
                            break 'pull;
                        }
                        let (completed, total, percent) = prog.update(&line);
                        let _ = app.emit(
                            "ollama-pull-progress",
                            serde_json::json!({
                                "model": model,
                                "status": line["status"],
                                "completed": completed,
                                "total": total,
                                "percent": percent,
                            }),
                        );
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = app.emit(
                        "ollama-pull-progress",
                        serde_json::json!({ "model": model, "status": "error", "error": e.to_string() }),
                    );
                    break;
                }
            }
        }
    }

    // Single cleanup point for every exit (success, error, cancel, EOF).
    ollama_pull_cancels().lock().unwrap().remove(&model);
    serde_json::json!({ "ok": true })
}

/// Flip the cancel flag for an in-flight `providers_ollama_pull(model)` so its
/// streaming loop returns between chunks. No-op when no pull is in flight.
#[tauri::command]
pub async fn providers_ollama_pull_cancel(model: String) -> serde_json::Value {
    if let Some(flag) = ollama_pull_cancels().lock().unwrap().get(&model) {
        flag.store(true, Ordering::SeqCst);
    }
    serde_json::json!({ "ok": true })
}

/// Delete a model from an Ollama server via `DELETE /api/delete`. Base
/// resolution + the optional saved bearer mirror `providers_ollama_probe`.
/// Maps the daemon's status into the renderer's `{ ok, code }` taxonomy.
#[tauri::command]
pub async fn providers_ollama_delete(
    app: tauri::AppHandle,
    model: String,
    base_url: Option<String>,
) -> serde_json::Value {
    let resolved = base_url
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|d| config::providers_from(&config::load_config_from(&d)))
                .and_then(|p| p.ollama_base_url)
        })
        .unwrap_or_else(|| "http://localhost:11434".into());

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({ "ok": false, "code": "NETWORK", "error": e.to_string() })
        }
    };
    let url = format!("{}/api/delete", resolved.trim_end_matches('/'));
    let key = match auth::get_user_id().await {
        Some(uid) => crate::shell::providers_link::read_secret("ollama", &uid)
            .ok()
            .flatten(),
        None => None,
    };
    let mut req = client
        .delete(&url)
        .json(&serde_json::json!({ "model": model }));
    if let Some(h) = ollama_bearer(key) {
        req = req.header("Authorization", h);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => serde_json::json!({ "ok": true }),
        Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
            serde_json::json!({ "ok": false, "code": "NOT_FOUND" })
        }
        Ok(resp) => {
            serde_json::json!({ "ok": false, "code": "NETWORK", "error": format!("HTTP {}", resp.status()) })
        }
        Err(e) => serde_json::json!({ "ok": false, "code": "NETWORK", "error": e.to_string() }),
    }
}

#[tauri::command]
pub async fn providers_set_enabled_models(
    app: tauri::AppHandle,
    id: String,
    models: Vec<String>,
) -> serde_json::Value {
    if fleetify_backend::providers::find_provider(&id).is_none() {
        return serde_json::json!({ "ok": false, "code": "UNKNOWN_PROVIDER", "error": format!("unknown provider {id}") });
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    let saved = config::update_config(&dir, |cfg| {
        let mut providers = config::providers_from(cfg);
        providers.enabled_models.insert(id, models);
        config::providers_set(cfg, &providers);
    });
    if let Err(e) = saved {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    // Picker reads renderer-side state via the Zustand store, which the
    // setEnabledModels mutator updates locally — no backend reload needed.
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn providers_set_ollama_base_url(
    app: tauri::AppHandle,
    base_url: String,
) -> serde_json::Value {
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    let trimmed = base_url.trim().to_string();
    let base_url = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    let saved = config::update_config(&dir, |cfg| {
        let mut providers = config::providers_from(cfg);
        providers.ollama_base_url = base_url;
        config::providers_set(cfg, &providers);
    });
    if let Err(e) = saved {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn providers_set_ollama_cloud_base_url(
    app: tauri::AppHandle,
    base_url: String,
) -> serde_json::Value {
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    let trimmed = base_url.trim().to_string();
    let base_url = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    let saved = config::update_config(&dir, |cfg| {
        let mut providers = config::providers_from(cfg);
        providers.ollama_cloud_base_url = base_url;
        config::providers_set(cfg, &providers);
    });
    if let Err(e) = saved {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn providers_set_cloudflare_account_id(
    app: tauri::AppHandle,
    account_id: String,
) -> serde_json::Value {
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    let trimmed = account_id.trim().to_string();
    let account_id = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    let saved = config::update_config(&dir, |cfg| {
        let mut providers = config::providers_from(cfg);
        providers.cloudflare_account_id = account_id;
        config::providers_set(cfg, &providers);
    });
    if let Err(e) = saved {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_controls_look_the_main_window_up_as_a_window() {
        // Drag, minimize, maximize, close, resize and the taskbar icon go
        // through main_window(). get_webview_window would find no window
        // while the Browser panel's child webview is attached (see
        // focus_main_window in lib.rs). Whitespace removed, so line wrapping
        // doesn't matter; the needle is built at run time, so this test
        // never matches itself.
        let source: String = include_str!("mod.rs").split_whitespace().collect();
        let wanted = format!(
            "fn{}(app:&tauri::AppHandle)->Option<tauri::Window>{{app.{}(MAIN_WINDOW)}}",
            "main_window", "get_window"
        );
        assert!(
            source.contains(&wanted),
            "main_window must be app.get_window(MAIN_WINDOW), a tauri::Window"
        );
    }

    #[tokio::test]
    async fn a_path_that_isnt_a_folder_or_document_is_refused_with_a_message() {
        // Refused before anything is launched: nothing opens here.
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("setup.exe");
        std::fs::write(&exe, b"").unwrap();
        for path in [
            exe.to_string_lossy().into_owned(),
            dir.path().join("missing.md").to_string_lossy().into_owned(),
            "notes.md".to_string(),
            String::new(),
        ] {
            assert_eq!(
                shell_open_path(path.clone()).await,
                serde_json::json!({ "ok": false, "error": PATH_REFUSED }),
                "{path:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_item_that_cant_be_shown_is_refused_before_the_file_manager_starts() {
        // The path is checked and resolved first: nothing is revealed here.
        // (A relative path is refused even when it exists: it would be
        // resolved against the working directory.)
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.md").to_string_lossy().into_owned();
        assert_eq!(
            shell_show_item_in_folder(missing.clone()).await,
            serde_json::json!({ "ok": false, "error": format!("path does not exist: {missing}") })
        );
        for path in ["notes.md", ""] {
            assert_eq!(
                shell_show_item_in_folder(path.to_string()).await,
                serde_json::json!({ "ok": false, "error": PATH_REFUSED }),
                "{path:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_link_that_isnt_web_or_mail_is_refused_with_a_message() {
        // Refused before anything is launched: no browser starts here.
        for url in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "https://x%22&calc.exe&%22y.com/",
            "",
        ] {
            assert_eq!(
                shell_open_external(url.to_string()).await,
                serde_json::json!({ "ok": false, "error": LINK_REFUSED }),
                "{url:?}"
            );
        }
    }

    #[test]
    fn ollama_auth_header_only_when_key_present() {
        assert_eq!(
            ollama_bearer(Some("k".into())),
            Some("Bearer k".to_string())
        );
        assert_eq!(ollama_bearer(None), None);
    }

    #[test]
    fn extracts_ps_running_models() {
        let body = serde_json::json!({ "models": [
            { "name": "gemma:8b", "size": 100, "size_vram": 90, "expires_at": "2025-10-17T16:47:07Z", "context_length": 4096 }
        ]});
        let v = ollama_ps_models(&body);
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["name"], "gemma:8b");
        assert_eq!(v[0]["size_vram"], 90);
    }

    #[test]
    fn pull_percent_accumulates_per_digest() {
        let mut p = OllamaPullProgress::default();
        // layer A: 50% of 200
        let (_, _, pct) = p.update(&serde_json::json!({"status":"pulling sha-A","digest":"sha-A","total":200,"completed":100}));
        assert!((pct - 50.0).abs() < 0.01);
        // layer B appears: denominator grows to 300, completed 100/300
        let (c, t, pct2) = p.update(&serde_json::json!({"status":"pulling sha-B","digest":"sha-B","total":100,"completed":0}));
        assert_eq!((c, t), (100, 300));
        assert!((pct2 - 33.33).abs() < 0.1);
    }

    #[test]
    fn pull_handles_missing_completed_and_terminal_lines() {
        let mut p = OllamaPullProgress::default();
        p.update(&serde_json::json!({"status":"pulling sha-A","digest":"sha-A","total":200})); // completed absent ⇒ 0
        let (c, _, _) = p.update(&serde_json::json!({"status":"verifying sha256 digest"})); // no bytes ⇒ unchanged
        assert_eq!(c, 0);
        assert!(OllamaPullProgress::is_done(
            &serde_json::json!({"status":"success"})
        ));
        assert_eq!(
            OllamaPullProgress::is_error(&serde_json::json!({"error":"boom"})),
            Some("boom".into())
        );
    }

    #[test]
    fn drain_ndjson_buffers_partial_lines() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"{\"status\":\"a\"}\n{\"sta"); // 1 complete + 1 partial
        let first = drain_ndjson(&mut buf);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["status"], "a");
        buf.extend_from_slice(b"tus\":\"b\"}\n"); // completes the 2nd
        let second = drain_ndjson(&mut buf);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["status"], "b");
        assert!(buf.is_empty());
    }

    #[test]
    fn read_directory_lists_dirs_first_then_alpha() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("z.txt"), "").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "").unwrap();
        std::fs::create_dir(tmp.path().join("bdir")).unwrap();
        std::fs::create_dir(tmp.path().join("Adir")).unwrap();

        let v = read_directory_impl(tmp.path());
        let arr = v["dirs"].as_array().unwrap();
        let names: Vec<&str> = arr.iter().map(|x| x["name"].as_str().unwrap()).collect();
        // Dirs first, then files; case-insensitive alpha within each group.
        assert_eq!(names, vec!["Adir", "bdir", "a.txt", "z.txt"]);
        assert_eq!(arr[0]["isDir"], true);
        assert_eq!(arr[2]["isDir"], false);
    }

    #[test]
    fn read_directory_error_envelope_on_missing() {
        let v = read_directory_impl(std::path::Path::new("Z:/does/not/exist/anywhere"));
        assert!(v.get("error").is_some());
        assert!(v.get("dirs").is_none());
    }

    #[test]
    fn read_file_roundtrip_and_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.txt");
        std::fs::write(&p, "hello").unwrap();
        assert_eq!(read_file_impl(&p)["content"], "hello");
        let miss = read_file_impl(&tmp.path().join("nope.txt"));
        assert!(miss.get("error").is_some());
    }

    #[test]
    fn extension_no_dot_cases() {
        assert_eq!(extension_no_dot(std::path::Path::new("a.tsx")), "tsx");
        assert_eq!(extension_no_dot(std::path::Path::new("Cargo.toml")), "toml");
        assert_eq!(extension_no_dot(std::path::Path::new("noext")), "");
    }

    #[test]
    fn centered_top_left_uses_target_size_and_clamps() {
        // 1920×1080 monitor at origin, centering the 1500×960 main window.
        assert_eq!(
            centered_top_left(0.0, 0.0, 1920.0, 1080.0, 1500.0, 960.0),
            (210.0, 60.0)
        );
        // A second monitor offset (logical origin x=1920) is respected.
        let (x, _) = centered_top_left(1920.0, 0.0, 1920.0, 1080.0, 1500.0, 960.0);
        assert_eq!(x, 2130.0);
        // A window larger than the monitor clamps to the origin (never negative).
        assert_eq!(
            centered_top_left(0.0, 0.0, 1000.0, 800.0, 1500.0, 960.0),
            (0.0, 0.0)
        );
        // Regression for the Linux bottom-right bug: placement must use the
        // TARGET width (1500 → x=210), NOT the stale pre-resize width (760 →
        // x=580), which let the grown window spill off toward the right.
        let (stale_x, _) = centered_top_left(0.0, 0.0, 1920.0, 1080.0, 760.0, 740.0);
        let (correct_x, _) = centered_top_left(0.0, 0.0, 1920.0, 1080.0, 1500.0, 960.0);
        assert_eq!(stale_x, 580.0);
        assert!(
            correct_x < stale_x,
            "centering the target size must sit left of the stale-size placement"
        );
    }

    #[test]
    fn scaffold_plugin_writes_files_and_refuses_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().to_string_lossy().to_string();
        let mut files = HashMap::new();
        files.insert(
            ".fleetify-plugin/plugin.json".to_string(),
            "{\"name\":\"my-plugin\"}".to_string(),
        );
        files.insert("README.md".to_string(), "# my-plugin".to_string());

        let v = scaffold_plugin_impl(&parent, "my-plugin", &files);
        assert!(v.get("path").is_some(), "got {v}");
        let written: Vec<String> = v["written"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        assert_eq!(written.len(), 2);
        let plugin_dir = tmp.path().join("my-plugin");
        assert!(plugin_dir.join(".fleetify-plugin/plugin.json").is_file());
        assert!(plugin_dir.join("README.md").is_file());

        // Bad slug.
        let v2 = scaffold_plugin_impl(&parent, "Bad_Slug", &files);
        assert!(v2.get("error").is_some());

        // Already-exists.
        let v3 = scaffold_plugin_impl(&parent, "my-plugin", &files);
        assert!(v3["error"].as_str().unwrap().contains("already exists"));

        // Traversal refused.
        let mut bad = HashMap::new();
        bad.insert("../escape.txt".to_string(), "x".to_string());
        let v4 = scaffold_plugin_impl(&parent, "other-plugin", &bad);
        assert!(v4["error"].as_str().unwrap().contains("unsafe path"));
    }

    #[test]
    fn parse_device_code_reads_the_gh_prompt() {
        assert_eq!(
            parse_device_code("! First copy your one-time code: ABCD-1234"),
            Some("ABCD-1234".to_string())
        );
        assert_eq!(
            parse_device_code("code: abcd-1234"),
            Some("ABCD-1234".to_string())
        );
        assert_eq!(
            parse_device_code("Press Enter to open github.com in your browser..."),
            None
        );
        assert_eq!(parse_device_code("code: ABCD1234"), None);
    }

    /// Regression: the offset of `code:` came from a Unicode-lowercased copy
    /// of the line. `İ` lowercases from 2 bytes to 3, so the slice of the
    /// original line started 5 bytes too far and missed the code.
    #[test]
    fn parse_device_code_after_non_ascii_text() {
        assert_eq!(
            parse_device_code("İİİİİ code: ABCD-1234"),
            Some("ABCD-1234".to_string())
        );
    }

    /// The same stale offset could land inside a letter or past the end of
    /// the line, and the panic failed the whole sign-in.
    #[test]
    fn parse_device_code_does_not_panic_after_non_ascii_text() {
        assert_eq!(parse_device_code("İİ code: İİİİ"), None);
        assert_eq!(parse_device_code("İİİİİİİİİİ code:"), None);
    }

    /// The diagnostics bundle a user attaches to a bug report: system info
    /// first, then the rotated log files and nothing else from the log folder.
    /// Entry names come from `name_raw`, whose signature zip 2 and zip 9 share
    /// (`name` changed), so the same test checked the move between them.
    #[test]
    fn write_diagnostics_zip_keeps_system_info_first_and_only_log_files() {
        use std::io::Read;

        let logs = tempfile::tempdir().unwrap();
        let log_text = "first line\nsecond line\n";
        std::fs::write(logs.path().join("fleetify.log.2026-11-20"), log_text).unwrap();
        std::fs::write(logs.path().join("crash.flag"), "").unwrap();
        std::fs::write(logs.path().join("notes.txt"), "not a log").unwrap();
        let out_dir = tempfile::tempdir().unwrap();
        let out = out_dir.path().join("diagnostics.zip");

        let bytes =
            write_diagnostics_zip(logs.path(), &out, build_system_info("9.9.9-test")).unwrap();

        assert_eq!(bytes, std::fs::metadata(&out).unwrap().len());
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| String::from_utf8(archive.by_index(i).unwrap().name_raw().to_vec()).unwrap())
            .collect();
        assert_eq!(names, ["system-info.json", "logs/fleetify.log.2026-11-20"]);
        for i in 0..archive.len() {
            assert_eq!(
                archive.by_index(i).unwrap().compression(),
                zip::CompressionMethod::Deflated
            );
        }

        let mut info = String::new();
        archive
            .by_index(0)
            .unwrap()
            .read_to_string(&mut info)
            .unwrap();
        let info: serde_json::Value = serde_json::from_str(&info).unwrap();
        assert_eq!(info["app_version"], "9.9.9-test");

        let mut log = String::new();
        archive
            .by_index(1)
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert_eq!(log, log_text);
    }
}

#[cfg(test)]
mod editor_tests {
    use super::*;

    #[test]
    fn editor_bin_maps_known_ids_and_rejects_unknown() {
        assert_eq!(editor_bin("vscode"), Some("code"));
        assert_eq!(editor_bin("vscode-insiders"), Some("code-insiders"));
        assert_eq!(editor_bin("cursor"), Some("cursor"));
        assert_eq!(editor_bin("vs"), Some("devenv"));
        assert_eq!(editor_bin("sublime"), Some("subl"));
        assert_eq!(editor_bin("intellij"), Some("idea"));
        assert_eq!(editor_bin("bogus"), None);
    }

    #[test]
    fn open_in_editor_rejects_unknown_editor() {
        // Unknown id returns early — never reaches spawn.
        let r = tauri::async_runtime::block_on(open_in_editor("bogus".into(), ".".into()));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn open_in_editor_rejects_missing_path() {
        // Known id but nonexistent path returns early — never reaches spawn.
        let r = tauri::async_runtime::block_on(open_in_editor(
            "vscode".into(),
            "/no/such/path/zzz-fleet-test".into(),
        ));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn a_relative_or_missing_path_is_not_opened_in_an_editor() {
        // A relative path is refused even when it exists ("." does): it
        // would be resolved against the working directory.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        for path in ["relative/dir", "."] {
            assert_eq!(
                editor_target(path),
                Err(PATH_REFUSED.to_string()),
                "{path:?}"
            );
        }
        assert_eq!(
            editor_target(&missing),
            Err(format!("path does not exist: {missing}"))
        );
    }

    #[test]
    fn an_existing_folder_opens_in_an_editor_by_its_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("proj")).unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let canonical = fleetify_core::canonicalize_no_verbatim(&dir.path().join("proj")).unwrap();
        for path in [
            dir.path().join("proj"),
            dir.path().join("sub").join("..").join("proj"),
        ] {
            assert_eq!(
                editor_target(&path.to_string_lossy()),
                Ok(canonical.clone()),
                "{path:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_network_path_is_not_opened_in_an_editor() {
        assert_eq!(
            editor_target(r"\\server\share\x"),
            Err(PATH_REFUSED.to_string())
        );
    }

    #[test]
    fn open_in_editor_checks_the_path_before_looking_for_the_editor() {
        // Refused before the editor is looked up: nothing is launched here.
        let r =
            tauri::async_runtime::block_on(open_in_editor("vscode".into(), "relative/dir".into()));
        assert_eq!(r, serde_json::json!({ "ok": false, "error": PATH_REFUSED }));
    }
}

#[cfg(test)]
mod telemetry_config_tests {
    use super::*;
    use fleetify_backend::services::telemetry::{cloud_enabled, posthog, set_cloud_enabled};

    use tauri::async_runtime::block_on;

    /// The gates are process-wide, so the tests that flip them take turns.
    static GATES: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Puts both gates back as they were, also when the test fails.
    struct RestoreGates {
        posthog: bool,
        cloud: bool,
    }

    impl RestoreGates {
        fn now() -> Self {
            Self {
                posthog: posthog::is_enabled(),
                cloud: cloud_enabled(),
            }
        }
    }

    impl Drop for RestoreGates {
        fn drop(&mut self) {
            posthog::set_enabled(self.posthog);
            block_on(set_cloud_enabled(self.cloud));
        }
    }

    #[test]
    fn telemetry_config_reports_the_live_gates() {
        let _turn = GATES.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreGates::now();
        let dir = tempfile::tempdir().unwrap();

        // After a failed save the gates differ from the saved choices, and a
        // re-mounted Settings card has to show the gates.
        posthog::set_enabled(true);
        block_on(set_cloud_enabled(false));
        assert_eq!(
            telemetry_config_now("device-1".into(), Some(dir.path())),
            serde_json::json!({
                "distinct_id": "device-1",
                "posthog_enabled": true,
                "cloud_enabled": false,
                "cloud_choice": null,
            })
        );

        posthog::set_enabled(false);
        block_on(set_cloud_enabled(true));
        assert_eq!(
            telemetry_config_now("device-1".into(), Some(dir.path())),
            serde_json::json!({
                "distinct_id": "device-1",
                "posthog_enabled": false,
                "cloud_enabled": true,
                "cloud_choice": null,
            })
        );
    }

    #[test]
    fn telemetry_config_reports_the_saved_cloud_choice() {
        let dir = tempfile::tempdir().unwrap();
        let reported = |dir: Option<&std::path::Path>| {
            telemetry_config_now("device-1".into(), dir)["cloud_choice"].clone()
        };

        // Nothing saved yet, or an install that finished onboarding before
        // it asked: no choice, so the renderer asks.
        assert_eq!(reported(Some(dir.path())), serde_json::Value::Null);
        config::save_config_to(dir.path(), &serde_json::json!({"onboardingComplete": true}))
            .unwrap();
        assert_eq!(reported(Some(dir.path())), serde_json::Value::Null);

        config::persist_cloud_choice(dir.path(), true).unwrap();
        assert_eq!(reported(Some(dir.path())), serde_json::json!(true));
        config::persist_cloud_choice(dir.path(), false).unwrap();
        assert_eq!(reported(Some(dir.path())), serde_json::json!(false));

        // An opt-out from the old switch is a choice too.
        let legacy = tempfile::tempdir().unwrap();
        config::save_config_to(
            legacy.path(),
            &serde_json::json!({"telemetryEnabled": false}),
        )
        .unwrap();
        assert_eq!(reported(Some(legacy.path())), serde_json::json!(false));

        // A settings file that can't be read, or a settings folder that
        // can't be found, keeps sync off, as startup does.
        let unreadable = tempfile::tempdir().unwrap();
        std::fs::create_dir(unreadable.path().join("fleet.config.json")).unwrap();
        assert_eq!(reported(Some(unreadable.path())), serde_json::json!(false));
        assert_eq!(reported(None), serde_json::json!(false));
    }
    #[test]
    fn startup_restore_closes_sync_when_the_saved_choice_is_off() {
        let _turn = GATES.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreGates::now();
        let set_since_launch = tokio::sync::Mutex::new(false);
        block_on(set_cloud_enabled(true));
        block_on(finish_cloud_sync_restore_with(&set_since_launch, false));
        assert!(!cloud_enabled());
    }

    #[test]
    fn startup_restore_never_opens_sync() {
        // The early restore opens the gate when the saved choice is on; the
        // late one only ever closes it.
        let _turn = GATES.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreGates::now();
        let set_since_launch = tokio::sync::Mutex::new(false);
        block_on(set_cloud_enabled(false));
        block_on(finish_cloud_sync_restore_with(&set_since_launch, true));
        assert!(!cloud_enabled());
    }

    #[test]
    fn startup_restore_keeps_a_choice_made_in_settings_since_launch() {
        // The save failed, so the saved choice still says the opposite of
        // what the user picked this session. The restore must not undo it.
        let _turn = GATES.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreGates::now();
        let set_since_launch = tokio::sync::Mutex::new(false);
        block_on(set_cloud_sync(&set_since_launch, true));
        block_on(finish_cloud_sync_restore_with(&set_since_launch, false));
        assert!(cloud_enabled(), "a turned-on gate stays on");

        block_on(set_cloud_sync(&set_since_launch, false));
        block_on(finish_cloud_sync_restore_with(&set_since_launch, true));
        assert!(!cloud_enabled(), "a turned-off gate stays off");
    }
}
