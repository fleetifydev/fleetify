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
    // Open the parent dir in the system file browser (Finder/Explorer).
    let p = std::path::Path::new(&path);
    let target = p
        .parent()
        .map(|x| x.to_path_buf())
        .unwrap_or_else(|| p.to_path_buf());
    match ::open::that(&target) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
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
pub async fn window_set_size(app: tauri::AppHandle, width: f64, height: f64) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
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
#[tauri::command]
pub async fn git_has_gh_cli() -> serde_json::Value {
    git::has_gh_cli().await
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
    github_link::begin_oauth(app).await
}

#[tauri::command]
pub async fn github_refresh_link(app: tauri::AppHandle) -> serde_json::Value {
    github_link::refresh_link(app).await
}

#[tauri::command]
pub async fn github_disconnect(app: tauri::AppHandle) -> serde_json::Value {
    github_link::disconnect(app).await;
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub async fn github_open_installation() -> serde_json::Value {
    github_link::open_installation().await
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
];

#[tauri::command]
pub async fn shell_install_provider(tool_key: String) -> serde_json::Value {
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

// ── PTY ──────────────────────────────────────────────────────────
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> serde_json::Value {
    match pty::spawn(app, shell, cwd, env) {
        Ok(id) => serde_json::json!({ "id": id }),
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
    let Some(log_dir) = logging::logs_dir() else {
        return serde_json::json!({
            "ok": false,
            "error": "logging not initialised"
        });
    };

    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let out_path = std::env::temp_dir().join(format!("fleetify-diagnostics-{stamp}.zip"));

    let log_dir_owned = log_dir.to_path_buf();
    let out_path_clone = out_path.clone();
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
            "path": out_path.to_string_lossy(),
            "bytes": bytes,
        }),
        Ok(Err(e)) => serde_json::json!({ "ok": false, "error": e }),
        Err(e) => serde_json::json!({ "ok": false, "error": format!("join: {e}") }),
    }
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
