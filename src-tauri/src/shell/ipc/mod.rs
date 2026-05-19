//! Tauri command layer = the Electron `ipcMain.handle` surface. Phase 1b
//! ships the 5 `window.fleetify` auth commands; the ~51 `window.electronAPI`
//! commands (fs/git/pty/github/window/dialog/…) land in Phase 1c+.

use std::path::PathBuf;

use tauri::Manager;

use std::collections::HashMap;

use crate::shell::{auth, config, git, head_watcher, pty};

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
pub async fn config_set(
    app: tauri::AppHandle,
    config: serde_json::Value,
) -> serde_json::Value {
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
    let target = p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| p.to_path_buf());
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
pub async fn window_set_size(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
) -> serde_json::Value {
    if let Some(w) = main_window(&app) {
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
    }
    serde_json::json!({ "ok": true })
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
        let normalized = target.components().fold(
            std::path::PathBuf::new(),
            |mut acc, c| {
                acc.push(c);
                acc
            },
        );
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
pub async fn git_list_branches(folder: String) -> serde_json::Value {
    git::list_branches(&PathBuf::from(folder)).await
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
#[tauri::command]
pub async fn git_create_pr(
    folder: String,
    title: String,
    body: Option<String>,
    base: Option<String>,
    draft: Option<bool>,
) -> serde_json::Value {
    git::create_pr(
        &PathBuf::from(folder),
        &title,
        body.as_deref(),
        base.as_deref(),
        draft.unwrap_or(false),
    )
    .await
}
#[tauri::command]
pub async fn git_get_pr_status(
    folder: String,
    pr_number: Option<u64>,
) -> serde_json::Value {
    git::get_pr_status(&PathBuf::from(folder), pr_number).await
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
// window.electronAPI.openFolderDialog → Promise<string[]> (paths).
// Faithful with the Electron-original: empty array on cancel/error;
// single-entry array on selection (we don't multi-select for folders).
#[tauri::command]
pub async fn dialog_open_folder(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog().file().pick_folder(move |fp| {
        let _ = tx.send(fp);
    });
    match rx.await {
        Ok(Some(fp)) => match fp.into_path() {
            Ok(p) => vec![p.to_string_lossy().to_string()],
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
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
