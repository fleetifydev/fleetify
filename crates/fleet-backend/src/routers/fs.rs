//! Faithful port of `app/routers/fs.py` — path validation + default home.
//! `/fs/pick` is intentionally a no-op here (`{path:""}`): the original
//! opens a tkinter dialog from the backend process, but in the Tauri
//! rebuild the renderer uses `window.electronAPI.openFolderDialog` (the
//! `dialog_open_folder` Tauri command), which is the same window-owning
//! process and the correct place to surface the native picker.

use std::path::PathBuf;

use axum::extract::Query;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fs/validate", get(validate_path))
        .route("/fs/default", get(default_path))
        .route("/fs/pick", get(pick_folder))
}

#[derive(Deserialize)]
struct ValidateQ {
    #[serde(default)]
    path: String,
}

async fn validate_path(Query(q): Query<ValidateQ>) -> Json<Value> {
    let raw = q.path.trim();
    if raw.is_empty() {
        return Json(json!({ "exists": false, "is_dir": false, "absolute": "" }));
    }
    let p = PathBuf::from(raw);
    let resolved = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
    let exists = resolved.exists();
    let is_dir = if exists { resolved.is_dir() } else { false };
    Json(json!({
        "exists": exists,
        "is_dir": is_dir,
        "absolute": resolved.to_string_lossy(),
    }))
}

async fn default_path() -> Json<Value> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    Json(json!({ "path": home }))
}

#[derive(Deserialize)]
struct PickQ {
    #[serde(default)]
    #[allow(dead_code)]
    initial: Option<String>,
}

async fn pick_folder(Query(_q): Query<PickQ>) -> Json<Value> {
    // Renderer uses electronAPI.openFolderDialog (Tauri dialog plugin) —
    // that's the window-owning process and the correct UX. Backend /fs/pick
    // stays as an empty-path no-op for parity with callers hitting REST.
    Json(json!({ "path": "" }))
}
