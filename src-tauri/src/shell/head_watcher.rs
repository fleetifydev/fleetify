//! Real-time `.git/HEAD` watcher = the Electron `git:watchHead` IPC.
//!
//! Each subscriber picks a unique `key` (typically
//! `"branchstrip:<folder>"`); `watch(folder, key)` is idempotent for the
//! same key and emits `git:head-changed` (`{ folder, key }`) to the main
//! window whenever HEAD changes. `unwatch(key)` tears down. Works for
//! both source repos and worktrees because we resolve the absolute git
//! dir with `git rev-parse --absolute-git-dir` (worktree HEAD lives at
//! `<repo>/.git/worktrees/<name>/HEAD`).
//!
//! `notify-debouncer-mini` collapses the double-write `git checkout`
//! produces into a single UI event (200 ms window is faithful with the
//! Electron version's `fs.watch` semantics, which already coalesces).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, Debouncer};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::shell::git;

struct Entry {
    _debouncer: Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>,
}

static WATCHERS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
fn watchers() -> &'static Mutex<HashMap<String, Entry>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start watching `<gitdir>/HEAD` and emit `git:head-changed` to the
/// main window on each change. No-op (returns `watching: true`) if the
/// same `key` is already subscribed.
pub async fn watch(app: AppHandle, folder: &str, key: &str) -> serde_json::Value {
    if folder.is_empty() || key.is_empty() {
        return json!({ "ok": false, "error": "folder + key required" });
    }
    {
        let map = watchers().lock().unwrap();
        if map.contains_key(key) {
            return json!({ "ok": true, "watching": true });
        }
    }

    // Resolve the real git dir — worktrees have their own HEAD inside
    // the parent repo's `.git/worktrees/<name>/`.
    let (rc, out, err) = git::run(
        "git",
        &["rev-parse", "--absolute-git-dir"],
        &PathBuf::from(folder),
        Duration::from_secs(5),
    )
    .await;
    if rc != 0 {
        return json!({
            "ok": false,
            "error": if err.is_empty() { "couldn't resolve git dir".to_string() } else { err.trim().to_string() }
        });
    }
    let head_path = PathBuf::from(out.trim()).join("HEAD");
    if !head_path.exists() {
        return json!({
            "ok": false,
            "error": format!("HEAD not found at {}", head_path.display())
        });
    }

    // notify-debouncer-mini calls its handler from a background thread.
    // We capture the app handle + key + folder to emit on each batch.
    let key_owned = key.to_string();
    let folder_owned = folder.to_string();
    let app_clone = app.clone();
    let debouncer_res = new_debouncer(
        Duration::from_millis(200),
        move |res: notify_debouncer_mini::DebounceEventResult| {
            if res.is_err() {
                return;
            }
            let _ = app_clone.emit(
                "git:head-changed",
                json!({ "folder": folder_owned, "key": key_owned }),
            );
        },
    );
    let mut debouncer = match debouncer_res {
        Ok(d) => d,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    if let Err(e) = debouncer
        .watcher()
        .watch(&head_path, RecursiveMode::NonRecursive)
    {
        return json!({ "ok": false, "error": e.to_string() });
    }

    watchers()
        .lock()
        .unwrap()
        .insert(key.to_string(), Entry { _debouncer: debouncer });
    json!({ "ok": true, "watching": true })
}

/// Stop watching the subscriber identified by `key`. Always returns
/// `{ ok: true }` (matching the Electron contract — quiet by design).
pub fn unwatch(key: &str) -> serde_json::Value {
    if !key.is_empty() {
        let _ = watchers().lock().unwrap().remove(key);
    }
    json!({ "ok": true })
}

/// Drop every watcher. Called from the Tauri `WindowEvent::Destroyed`
/// path so app shutdown doesn't leak file handles.
pub fn shutdown() {
    if let Some(m) = WATCHERS.get() {
        m.lock().unwrap().clear();
    }
}

// Quiet `Manager` warning if no caller imports it here — `app.emit` is
// part of the `Emitter` trait, which transitively uses Manager state.
#[allow(dead_code)]
fn _ensure_manager_in_scope(app: &AppHandle) {
    let _ = app.get_webview_window("main");
}
