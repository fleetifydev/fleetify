//! `/api/fs/*` workspace endpoints — faithful subset of
//! routers/workspace.py for the renderer's Files / Workspace panel:
//! directory listing + file read/write + create/delete/rename. The git
//! status/diff endpoints and the /ws/terminal WebSocket are Phase-3
//! follow-ups (those use the backend's own PTY subsystem; the Tauri
//! shell exposes its own native PTY via portable-pty in shell::pty,
//! used by the renderer's xterm-shell directly).

use std::path::PathBuf;

use axum::extract::Query;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fs/dir", get(list_directory))
        .route("/fs/file", get(read_file).put(write_file))
        .route("/fs/create", post(create_entry))
        .route("/fs/delete", axum::routing::delete(delete_entry))
        .route("/fs/rename", post(rename_entry))
        .route("/fs/git", get(git_status_stub))
        .route("/fs/git/diff", get(git_diff_stub))
        .route("/fs/search", get(search_stub))
}

fn should_skip(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "__pycache__"
            | "node_modules"
            | ".DS_Store"
            | ".Spotlight-V100"
            | ".Trashes"
            | ".fseventsd"
            | ".Thumbs.db"
            | ".idea"
            | ".vscode"
            | ".cache"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".turbo"
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | ".parcel-cache"
    )
}

#[derive(Deserialize)]
struct PathQ {
    path: String,
}

async fn list_directory(Query(q): Query<PathQ>) -> Json<Value> {
    let raw = q.path.trim();
    if raw.is_empty() {
        return Json(json!([]));
    }
    let p = PathBuf::from(raw);
    let resolved = std::fs::canonicalize(&p).unwrap_or(p);
    if !resolved.is_dir() {
        return Json(json!([]));
    }
    let Ok(rd) = std::fs::read_dir(&resolved) else {
        return Json(json!([]));
    };
    let mut entries: Vec<Value> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if should_skip(&name) {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(json!({
                "name": name,
                "path": e.path().to_string_lossy(),
                "type": if is_dir { "folder" } else { "file" }
            }))
        })
        .collect();
    // Folders first, then files, alpha-insensitive within each (parity).
    entries.sort_by(|a, b| {
        let af = a["type"].as_str() == Some("folder");
        let bf = b["type"].as_str() == Some("folder");
        bf.cmp(&af).then_with(|| {
            let an = a["name"].as_str().unwrap_or("");
            let bn = b["name"].as_str().unwrap_or("");
            an.to_lowercase().cmp(&bn.to_lowercase())
        })
    });
    Json(Value::Array(entries))
}

async fn read_file(Query(q): Query<PathQ>) -> Json<Value> {
    match std::fs::read_to_string(&q.path) {
        Ok(s) => Json(json!({ "content": s })),
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct WriteBody {
    path: String,
    content: String,
}

async fn write_file(Json(b): Json<WriteBody>) -> Json<Value> {
    if let Some(parent) = std::path::Path::new(&b.path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&b.path, b.content) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct CreateBody {
    path: String,
    #[serde(default)]
    is_dir: bool,
}

async fn create_entry(Json(b): Json<CreateBody>) -> Json<Value> {
    let res = if b.is_dir {
        std::fs::create_dir_all(&b.path).map(|_| ())
    } else {
        if let Some(p) = std::path::Path::new(&b.path).parent() {
            let _ = std::fs::create_dir_all(p);
        }
        std::fs::write(&b.path, "").map(|_| ())
    };
    match res {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct DeleteBody {
    path: String,
}

async fn delete_entry(Json(b): Json<DeleteBody>) -> Json<Value> {
    let p = std::path::Path::new(&b.path);
    let res = if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    match res {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

async fn rename_entry(Json(b): Json<RenameBody>) -> Json<Value> {
    if let Some(p) = std::path::Path::new(&b.to).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    match std::fs::rename(&b.from, &b.to) {
        Ok(_) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

// Phase 3: replace with real git/log integration; for now empty so the
// renderer's Git tab renders cleanly.
async fn git_status_stub(Query(_q): Query<PathQ>) -> Json<Value> {
    Json(json!({ "branch": null, "files": [], "ahead": 0, "behind": 0 }))
}
async fn git_diff_stub(Query(_q): Query<PathQ>) -> Json<Value> {
    Json(json!({ "files": [] }))
}
async fn search_stub(Query(_q): Query<PathQ>) -> Json<Value> {
    Json(json!([]))
}
