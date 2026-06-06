//! Tauri command layer = the Electron `ipcMain.handle` surface. Phase 1b
//! ships the 5 `window.fleetify` auth commands; the ~51 `window.electronAPI`
//! commands (fs/git/pty/github/window/dialog/…) land in Phase 1c+.

use std::path::PathBuf;

use tauri::{Emitter, Manager};

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::shell::{ai_git, auth, config, feedback, git, github_link, head_watcher, logging, pty};

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

#[tauri::command]
pub async fn config_set(app: tauri::AppHandle, config: serde_json::Value) -> serde_json::Value {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = config::save_config_to(&dir, &config);
    }
    serde_json::json!({ "ok": true })
}

// ── PostHog telemetry config ──────────────────────────────────────
// Renderer fetches `{ distinct_id, posthog_enabled }` at boot to
// initialise posthog-js with the same device_id the Rust backend uses,
// so frontend + backend events flow to one PostHog person. Setter both
// persists the flag AND flips the backend's runtime gate live so the
// worker stops / starts without a restart.

#[tauri::command]
pub async fn telemetry_get_config(app: tauri::AppHandle) -> serde_json::Value {
    let posthog_enabled = match app.path().app_data_dir() {
        Ok(dir) => config::telemetry_from(&config::load_config_from(&dir)).posthog_enabled,
        Err(_) => false,
    };
    let device = fleetify_backend::services::telemetry::device_id::get_or_create();
    serde_json::json!({
        "distinct_id": device.device_id,
        "posthog_enabled": posthog_enabled,
    })
}

#[tauri::command]
pub async fn telemetry_set_posthog_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> serde_json::Value {
    if let Ok(dir) = app.path().app_data_dir() {
        let mut cfg = config::load_config_from(&dir);
        let mut telem = config::telemetry_from(&cfg);
        let was_enabled = telem.posthog_enabled;
        telem.posthog_enabled = enabled;
        // Stamp the first opt-in time so funnels can split "fresh"
        // consenters from long-standing users. Clearing the flag does
        // NOT wipe the timestamp — useful for support if the user
        // toggles off then back on.
        if enabled && !was_enabled {
            telem.posthog_enabled_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            );
        }
        config::telemetry_set(&mut cfg, &telem);
        let _ = config::save_config_to(&dir, &cfg);
    }
    fleetify_backend::services::telemetry::posthog::set_enabled(enabled);
    serde_json::json!({ "ok": true })
}

// ── shell ─────────────────────────────────────────────────────────
#[tauri::command]
pub async fn shell_open_external(url: String) -> serde_json::Value {
    match ::open::that(&url) {
        Ok(_) => serde_json::json!({ "ok": true }),
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
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return serde_json::json!({
            "ok": false,
            "error": format!("path does not exist: {}", p.display())
        });
    }
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
        std::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer /select: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
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
        let dbus = std::process::Command::new("dbus-send")
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
                ::open::that(parent)
                    .map(|_| ())
                    .map_err(|e| format!("dbus-send unavailable and xdg-open fallback failed: {e}"))
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        ::open::that(path.parent().unwrap_or(path))
            .map(|_| ())
            .map_err(|e| e.to_string())
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

// ── window controls ──────────────────────────────────────────────
fn main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
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

#[tauri::command]
pub async fn window_set_size(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    center: Option<bool>,
) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
        // Each screen mode has its own size (760×740 onboarding vs
        // 1500×960 main). Without recentering, shrinking from main to
        // onboarding leaves the smaller window pinned to the previous
        // top-left, so onboarding appears anchored to the left edge
        // instead of centered like the cold-start window was.
        if center.unwrap_or(false) {
            let _ = w.center();
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
pub async fn git_open_pr(folder: String) -> serde_json::Value {
    git::open_pr(&PathBuf::from(folder)).await
}
/// IPC: create a pull request. `method` selects the auth path:
/// "gh" | "cli" → GitHub CLI only, "oauth" | "link" → Fleetify OAuth
/// link only, omitted → legacy gh-first / link-fallback. Renderer
/// pulls the value from `localStorage["fleet:github-auth-method"]`
/// so the onboarding choice is honoured exactly.
// 8 args is one over the default 7; refactor to a struct is out of scope for this cleanup.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_create_pr(
    folder: String,
    title: String,
    body: Option<String>,
    base: Option<String>,
    draft: Option<bool>,
    #[allow(non_snake_case)] featureBranch: Option<String>,
    tool: Option<String>,
    method: Option<String>,
) -> serde_json::Value {
    git::create_pr(
        &PathBuf::from(folder),
        &title,
        body.as_deref(),
        base.as_deref(),
        draft.unwrap_or(false),
        featureBranch.as_deref(),
        tool.as_deref(),
        method.as_deref(),
    )
    .await
}
#[tauri::command]
pub async fn git_get_pr_status(folder: String, pr_number: Option<u64>) -> serde_json::Value {
    git::get_pr_status(&PathBuf::from(folder), pr_number).await
}

#[tauri::command]
pub async fn git_list_prs(folder: String, limit: Option<u32>) -> serde_json::Value {
    git::list_prs(&PathBuf::from(folder), limit.unwrap_or(50)).await
}
#[tauri::command]
pub async fn git_merge_pr(
    folder: String,
    pr_number: u64,
    method: Option<String>,
) -> serde_json::Value {
    git::merge_pr(
        &PathBuf::from(folder),
        pr_number,
        method.as_deref().unwrap_or("merge"),
    )
    .await
}

#[tauri::command]
pub async fn git_pr_ready(folder: String, pr_number: u64) -> serde_json::Value {
    git::pr_ready(&PathBuf::from(folder), pr_number).await
}
#[tauri::command]
pub async fn git_sync_main(folder: String, base_branch: String) -> serde_json::Value {
    git::sync_main(&PathBuf::from(folder), &base_branch).await
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
pub async fn github_begin_oauth(app: tauri::AppHandle) -> serde_json::Value {
    let r = github_link::begin_oauth(app).await;
    // Refresh the backend clone token now that a link may exist.
    github_link::push_clone_token().await;
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
    r
}

#[tauri::command]
pub async fn github_disconnect(app: tauri::AppHandle) -> serde_json::Value {
    github_link::disconnect(app).await;
    // Clear the backend clone token — no link anymore.
    github_link::push_clone_token().await;
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
        tokio::process::Command::new("cmd")
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
        tokio::process::Command::new("osascript")
            .args([
                "-e",
                &format!("tell application \"Terminal\" to do script \"{cmdline}\""),
            ])
            .spawn()
    } else {
        // Best-effort Linux: try x-terminal-emulator, then xterm.
        tokio::process::Command::new("x-terminal-emulator")
            .args(["-e", "bash", "-c", &format!("{cmdline}; exec bash")])
            .spawn()
            .or_else(|_| {
                tokio::process::Command::new("xterm")
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
    // `git_has_gh_cli` re-probes and reflects the new authed/login pair.
    if ok {
        crate::shell::integrations_cache::invalidate_gh_cli();
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
    let lower = line.to_lowercase();
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
    ("claude", "@anthropic-ai/claude-code"),
    ("codex", "@openai/codex"),
    ("gemini", "@google/gemini-cli"),
    ("kimi", "@moonshot-ai/kimi-code"),
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
        let res = tokio::process::Command::new(&py)
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
    if tool_key == "agy" {
        let res = if cfg!(windows) {
            tokio::process::Command::new("powershell")
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
            tokio::process::Command::new("sh")
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
    if tool_key == "cursor" {
        let res = if cfg!(windows) {
            tokio::process::Command::new("powershell")
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
            tokio::process::Command::new("sh")
                .args(["-c", "curl https://cursor.com/install -fsS | bash"])
                .output()
                .await
        };
        return shell_installer_result(res, "cursor");
    }
    // Hermes Agent installs via the official scripts at
    // hermes-agent.nousresearch.com (irm|iex on Windows, curl|bash on
    // Unix). Mirrors the catalog's hermes `install_hints`.
    if tool_key == "hermes" {
        let res = if cfg!(windows) {
            tokio::process::Command::new("powershell")
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
            tokio::process::Command::new("sh")
                .args([
                    "-c",
                    "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
                ])
                .output()
                .await
        };
        return shell_installer_result(res, "hermes");
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
    let res = tokio::process::Command::new(bin)
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
        tokio::process::Command::new("powershell")
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
        tokio::process::Command::new("sh")
            .args(["-c", "curl -fsSL https://ollama.com/install.sh | sh"])
            .output()
            .await
    };
    match res {
        Ok(o) if o.status.success() => serde_json::json!({ "ok": true }),
        _ => {
            let _ = ::open::that(download_url);
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
        tokio::process::Command::new(&py).arg("--version").output(),
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
) -> serde_json::Value {
    match pty::spawn(app, shell, cwd, env) {
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

// ── dialog ───────────────────────────────────────────────────────
// `window.electronAPI.openFolderDialog()` → `Promise<string | null>`.
// Renderer (new-agent-dialog.tsx, session-toolbar.tsx) treats the
// awaited value as a single path string and gates on `if (p)`. An
// array would always be truthy and break the `if` check.
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
    if let Err(e) = open::that(&path_str) {
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
        let mut cfg = config::load_config_from(&dir);
        let mut routing = config::routing_from(&cfg);
        routing.connected_routers.insert(
            id.clone(),
            config::ConnectedRouter {
                connected: true,
                metadata,
            },
        );
        config::routing_set(&mut cfg, &routing);
        if let Err(e) = config::save_config_to(&dir, &cfg) {
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
        let mut cfg = config::load_config_from(&dir);
        let mut routing = config::routing_from(&cfg);
        routing.connected_routers.remove(&id);
        if routing.active_decision_router == id {
            routing.active_decision_router = "builtin".into();
        }
        if routing.active_proxy_gateway == id {
            routing.active_proxy_gateway = "none-proxy".into();
        }
        config::routing_set(&mut cfg, &routing);
        let _ = config::save_config_to(&dir, &cfg);
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
    let mut cfg = config::load_config_from(&dir);
    let mut routing = config::routing_from(&cfg);
    match category.as_str() {
        "decision" => routing.active_decision_router = id,
        "proxy" => routing.active_proxy_gateway = id,
        _ => return serde_json::json!({ "ok": false, "error": "invalid category" }),
    }
    config::routing_set(&mut cfg, &routing);
    let _ = config::save_config_to(&dir, &cfg);
    crate::shell::routing_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn routers_set_master_toggle(app: tauri::AppHandle, enabled: bool) -> serde_json::Value {
    let Ok(dir) = app.path().app_data_dir() else {
        return serde_json::json!({ "ok": false, "error": "no app data dir" });
    };
    let mut cfg = config::load_config_from(&dir);
    let mut routing = config::routing_from(&cfg);
    routing.enabled = enabled;
    config::routing_set(&mut cfg, &routing);
    let _ = config::save_config_to(&dir, &cfg);
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
        let mut cfg = config::load_config_from(&dir);
        let mut providers = config::providers_from(&cfg);
        providers.connected.insert(id.clone(), true);
        config::providers_set(&mut cfg, &providers);
        if let Err(e) = config::save_config_to(&dir, &cfg) {
            return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
        }
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    fleetify_backend::services::telemetry::emitters::emit_provider_connected(&id).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn providers_get_key_preview(id: String) -> serde_json::Value {
    // Local-only providers (ollama) never have a keychain entry.
    if let Some(spec) = fleetify_backend::providers::find_provider(&id) {
        if matches!(
            spec.kind,
            fleetify_backend::providers::ProviderKind::LocalHttp
        ) {
            return serde_json::json!({ "ok": true, "preview": null });
        }
    } else {
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
        let mut cfg = config::load_config_from(&dir);
        let mut providers = config::providers_from(&cfg);
        providers.connected.insert(id.clone(), false);
        config::providers_set(&mut cfg, &providers);
        let _ = config::save_config_to(&dir, &cfg);
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
        "cursor" => fleetify_backend::bridges::cursor::resolve_cursor_bin(),
        "hermes" => fleetify_backend::bridges::hermes::resolve_hermes_bin(),
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
    ) {
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
        let mut cfg = config::load_config_from(&dir);
        let mut providers = config::providers_from(&cfg);
        providers.connected.insert(id.clone(), enabled);
        config::providers_set(&mut cfg, &providers);
        if let Err(e) = config::save_config_to(&dir, &cfg) {
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
    let mut cfg = config::load_config_from(&dir);
    let mut providers = config::providers_from(&cfg);
    for (id, on) in &connected {
        providers.connected.insert(id.clone(), *on);
    }
    if let Some(agents) = enabled_agents {
        providers.enabled_agents = agents;
    }
    config::providers_set(&mut cfg, &providers);
    if let Err(e) = config::save_config_to(&dir, &cfg) {
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
/// classic mismatch (pick Gemini, composer still uses
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
    let mut cfg = config::load_config_from(&dir);
    match &mut cfg {
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
            cfg = serde_json::json!({
                "defaultProvider": id,
                "defaultModel": default_model,
            });
        }
    }
    if let Err(e) = config::save_config_to(&dir, &cfg) {
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
pub async fn providers_test_connection(id: String, key: String) -> serde_json::Value {
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

/// Probe an Ollama server for the model catalog. `base_url` defaults to
/// the user's configured value (or `http://localhost:11434`). Returns the
/// model list verbatim so the renderer can drive checkbox state.
#[tauri::command]
pub async fn providers_ollama_probe(
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
    let url = format!("{}/api/tags", resolved.trim_end_matches('/'));
    match client.get(&url).send().await {
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
            serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": format!("HTTP {}", resp.status()), "base_url": resolved })
        }
        Err(e) if e.is_timeout() => {
            serde_json::json!({ "ok": false, "running": false, "code": "TIMEOUT", "error": e.to_string(), "base_url": resolved })
        }
        Err(e) => {
            serde_json::json!({ "ok": false, "running": false, "code": "NETWORK", "error": e.to_string(), "base_url": resolved })
        }
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
    let mut cfg = config::load_config_from(&dir);
    let mut providers = config::providers_from(&cfg);
    providers.enabled_models.insert(id, models);
    config::providers_set(&mut cfg, &providers);
    if let Err(e) = config::save_config_to(&dir, &cfg) {
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
    let mut cfg = config::load_config_from(&dir);
    let mut providers = config::providers_from(&cfg);
    let trimmed = base_url.trim().to_string();
    providers.ollama_base_url = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    config::providers_set(&mut cfg, &providers);
    if let Err(e) = config::save_config_to(&dir, &cfg) {
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
    let mut cfg = config::load_config_from(&dir);
    let mut providers = config::providers_from(&cfg);
    let trimmed = account_id.trim().to_string();
    providers.cloudflare_account_id = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    config::providers_set(&mut cfg, &providers);
    if let Err(e) = config::save_config_to(&dir, &cfg) {
        return serde_json::json!({ "ok": false, "code": "CONFIG", "error": e.to_string() });
    }
    crate::shell::providers_setup::reload_backend(&app).await;
    serde_json::json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
