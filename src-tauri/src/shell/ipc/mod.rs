//! Tauri command layer = the Electron `ipcMain.handle` surface. Phase 1b
//! ships the 5 `window.fleetify` auth commands; the ~51 `window.electronAPI`
//! commands (fs/git/pty/github/window/dialog/…) land in Phase 1c+.

use tauri::Manager;

use crate::shell::{auth, config};

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
