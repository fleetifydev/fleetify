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
        .route("/fs/git", get(git_status))
        .route("/fs/git/diff", get(git_diff))
        .route("/fs/search", get(search_files))
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
    let resolved = fleet_core::canonicalize_or_keep(&p);
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

// ── /api/fs/git — branch + porcelain status + recent commits ─────
// Faithful with workspace.py git_status: fan out 4 probes in parallel.
async fn run_git(args: &[&str], cwd: &str) -> (String, i32) {
    let cmd = tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output();
    let out = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd).await {
        Ok(Ok(o)) => o,
        _ => {
            return (
                String::new(),
                -1, // timeout/spawn-error sentinel
            )
        }
    };
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let rc = out.status.code().unwrap_or(-1);
    (s, rc)
}

async fn git_status(Query(q): Query<PathQ>) -> Json<Value> {
    let path = q.path.clone();
    let (branch_r, status_r, log_r, diff_r) = tokio::join!(
        run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &path),
        run_git(&["status", "--porcelain"], &path),
        run_git(&["log", "--oneline", "-8"], &path),
        run_git(&["diff", "--stat"], &path),
    );
    let branch = branch_r.0;
    if branch.is_empty() {
        return Json(json!({ "error": "Not a git repository" }));
    }
    let mut staged: Vec<String> = vec![];
    let mut modified: Vec<String> = vec![];
    let mut untracked: Vec<String> = vec![];
    for line in status_r.0.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let name = &line[3..];
        let x = xy.as_bytes()[0] as char;
        let y = xy.as_bytes()[1] as char;
        if matches!(x, 'M' | 'A' | 'D' | 'R' | 'C') {
            staged.push(name.to_string());
        } else if matches!(y, 'M' | 'D') {
            modified.push(name.to_string());
        } else if xy == "??" {
            untracked.push(name.to_string());
        }
    }
    let commits: Vec<Value> = log_r
        .0
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (hash, msg) = if l.len() >= 8 {
                (&l[..7], &l[8..])
            } else {
                (l, "")
            };
            json!({ "hash": hash, "msg": msg })
        })
        .collect();
    Json(json!({
        "branch": branch,
        "staged": staged,
        "modified": modified,
        "untracked": untracked,
        "commits": commits,
        "diff_stat": diff_r.0,
    }))
}

// ── /api/fs/git/diff — working|branch|auto unified diff ──────────
#[derive(Deserialize)]
struct DiffQ {
    path: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

async fn run_git_keep_out(args: Vec<String>, cwd: String) -> (String, i32) {
    let cmd = tokio::process::Command::new("git")
        .args(&args)
        .current_dir(&cwd)
        .output();
    let out = match tokio::time::timeout(std::time::Duration::from_secs(8), cmd).await {
        Ok(Ok(o)) => o,
        _ => return (String::new(), -1),
    };
    (
        String::from_utf8_lossy(&out.stdout).to_string(),
        out.status.code().unwrap_or(-1),
    )
}

fn sv(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

async fn git_diff(Query(q): Query<DiffQ>) -> Json<Value> {
    let path = q.path.clone();
    let file = q.file.clone();
    let scope = q
        .scope
        .as_deref()
        .map(|s| match s {
            "working" | "branch" | "auto" => s.to_string(),
            _ => "auto".to_string(),
        })
        .unwrap_or_else(|| "auto".to_string());

    // Repo check.
    let (_, rc) = run_git(&["rev-parse", "--is-inside-work-tree"], &path).await;
    if rc != 0 {
        return Json(json!({ "error": "Not a git repository" }));
    }

    // Untracked-single-file: synthesise an "all added" diff.
    if let Some(f) = file.as_deref() {
        let (so, _) =
            run_git_keep_out(sv(&["status", "--porcelain", "--", f]), path.clone()).await;
        if so.trim_start().starts_with("??") {
            let abs = std::path::Path::new(&path).join(f);
            let body = std::fs::read_to_string(&abs).unwrap_or_default();
            let mut lines: Vec<&str> = body.split('\n').collect();
            if lines.last() == Some(&"") {
                lines.pop();
            }
            let added = lines
                .iter()
                .map(|l| format!("+{l}"))
                .collect::<Vec<_>>()
                .join("\n");
            let header = format!(
                "diff --git a/{f} b/{f}\nnew file mode 100644\n--- /dev/null\n+++ b/{f}\n@@ -0,0 +1,{} @@\n",
                lines.len()
            );
            let tail = if added.is_empty() { "" } else { "\n" };
            return Json(json!({
                "diff": format!("{header}{added}{tail}"),
                "untracked": true,
            }));
        }
    }

    let working_diff = |path: String, file: Option<String>| async move {
        let mut args = sv(&["diff", "HEAD", "--no-color"]);
        if let Some(f) = file.clone() {
            args.push("--".into());
            args.push(f);
        }
        let (out, rc) = run_git_keep_out(args, path.clone()).await;
        if rc != 0 && out.is_empty() {
            let mut args2 = sv(&["diff", "--no-color"]);
            if let Some(f) = file.clone() {
                args2.push("--".into());
                args2.push(f);
            }
            let (out2, _) = run_git_keep_out(args2, path).await;
            return out2;
        }
        out
    };

    let resolve_base = |path: String| async move {
        let (head_out, head_rc) = run_git_keep_out(
            sv(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
            path.clone(),
        )
        .await;
        if head_rc == 0 && !head_out.trim().is_empty() {
            let r = head_out.trim().to_string();
            return Some(match r.split_once('/') {
                Some((_, tail)) => tail.to_string(),
                None => r,
            });
        }
        let candidates = ["main", "master", "develop"];
        let mut futs = Vec::with_capacity(candidates.len() * 2);
        for c in &candidates {
            futs.push(run_git_keep_out(
                sv(&["rev-parse", "--verify"])
                    .into_iter()
                    .chain(std::iter::once(format!("refs/heads/{c}")))
                    .collect(),
                path.clone(),
            ));
        }
        for c in &candidates {
            futs.push(run_git_keep_out(
                sv(&["rev-parse", "--verify"])
                    .into_iter()
                    .chain(std::iter::once(format!("refs/remotes/origin/{c}")))
                    .collect(),
                path.clone(),
            ));
        }
        let results = futures_util::future::join_all(futs).await;
        for (i, c) in candidates.iter().enumerate() {
            let local_ok = results[i].1 == 0;
            let remote_ok = results[candidates.len() + i].1 == 0;
            if local_ok || remote_ok {
                return Some(c.to_string());
            }
        }
        None
    };

    let branch_diff = |path: String, file: Option<String>, base: String| async move {
        let spec = format!("{base}...HEAD");
        let mut args = sv(&["diff"]);
        args.push(spec);
        args.push("--no-color".into());
        if let Some(f) = file {
            args.push("--".into());
            args.push(f);
        }
        let (out, _) = run_git_keep_out(args, path).await;
        out
    };

    match scope.as_str() {
        "working" => {
            let out = working_diff(path.clone(), file.clone()).await;
            let scope_label = if out.is_empty() { "empty" } else { "working" };
            Json(json!({ "diff": out, "scope": scope_label, "baseBranch": Value::Null, "untracked": false }))
        }
        "branch" => {
            let base = resolve_base(path.clone()).await;
            let Some(base) = base else {
                return Json(json!({
                    "diff": "",
                    "scope": "empty",
                    "baseBranch": Value::Null,
                    "untracked": false,
                    "note": "no base branch"
                }));
            };
            let out = branch_diff(path.clone(), file.clone(), base.clone()).await;
            let scope_label = if out.is_empty() { "empty" } else { "branch" };
            Json(json!({ "diff": out, "scope": scope_label, "baseBranch": base, "untracked": false }))
        }
        _ => {
            // "auto"
            let working = working_diff(path.clone(), file.clone()).await;
            if !working.is_empty() {
                return Json(json!({ "diff": working, "scope": "working", "baseBranch": Value::Null, "untracked": false }));
            }
            let base = resolve_base(path.clone()).await;
            let Some(base) = base else {
                return Json(json!({ "diff": "", "scope": "empty", "baseBranch": Value::Null, "untracked": false }));
            };
            let spec = format!("{base}..HEAD");
            let (ahead_out, _) =
                run_git_keep_out(sv(&["rev-list", "--count"]).into_iter().chain(std::iter::once(spec)).collect(), path.clone()).await;
            let ahead: i64 = ahead_out.trim().parse().unwrap_or(0);
            if ahead == 0 {
                return Json(
                    json!({ "diff": "", "scope": "empty", "baseBranch": base, "untracked": false }),
                );
            }
            let out = branch_diff(path.clone(), file.clone(), base.clone()).await;
            Json(json!({ "diff": out, "scope": "branch", "baseBranch": base, "untracked": false }))
        }
    }
}

// ── /api/fs/search — `@` mention picker file/folder search ───────
// Faithful with workspace.py:_search_project: empty q = first-level
// entries (folders first), non-empty q = case-insensitive substring
// match on path with rank-then-position scoring.
#[derive(Deserialize)]
struct SearchQ {
    root: String,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

const SEARCH_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".vscode",
];

fn search_should_skip_top_level(name: &str) -> bool {
    should_skip(name) || SEARCH_SKIP_DIRS.contains(&name)
}

async fn search_files(Query(q): Query<SearchQ>) -> Json<Value> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let root = std::path::PathBuf::from(&q.root);
    if !root.is_dir() {
        return Json(json!([]));
    }
    let query = q.q.as_deref().unwrap_or("").trim().to_lowercase();
    // Off-thread walk (tokio doesn't have a real fs walker; the Python
    // version used `asyncio.to_thread` for the same reason).
    let result = tokio::task::spawn_blocking(move || search_project(&root, &query, limit))
        .await
        .unwrap_or_default();
    Json(Value::Array(result))
}

fn search_project(root: &std::path::Path, q: &str, limit: usize) -> Vec<Value> {
    // Empty query → first-level entries, folders first.
    if q.is_empty() {
        let mut entries: Vec<(bool, String, Value)> = Vec::new();
        let rd = match std::fs::read_dir(root) {
            Ok(rd) => rd,
            Err(_) => return Vec::new(),
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if search_should_skip_top_level(&name) {
                continue;
            }
            let is_file = ent.file_type().map(|t| t.is_file()).unwrap_or(false);
            entries.push((
                is_file,
                name.to_lowercase(),
                json!({
                    "name": name,
                    "path": ent.path().to_string_lossy(),
                    "relative": name,
                    "type": if is_file { "file" } else { "folder" },
                }),
            ));
            if entries.len() >= limit {
                break;
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        return entries.into_iter().map(|(_, _, v)| v).collect();
    }

    // Non-empty query: bounded BFS with skip rules + substring matching.
    const WALK_BUDGET: usize = 20_000;
    let result_cap = std::cmp::max(limit * 4, 200);
    let mut stack: std::collections::VecDeque<std::path::PathBuf> =
        std::collections::VecDeque::new();
    stack.push_back(root.to_path_buf());

    struct Scored {
        rank: u8,
        pos: usize,
        len: usize,
        rel_lower: String,
        value: Value,
    }
    let mut hits: Vec<Scored> = Vec::new();
    let mut seen = 0usize;

    while let Some(current) = stack.pop_front() {
        if seen >= WALK_BUDGET {
            break;
        }
        let rd = match std::fs::read_dir(&current) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        let mut children: Vec<std::fs::DirEntry> = rd.flatten().collect();
        children.sort_by_key(|e| {
            let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
            (is_file, e.file_name().to_string_lossy().to_lowercase())
        });
        for ent in children {
            seen += 1;
            let name = ent.file_name().to_string_lossy().to_string();
            if SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name.starts_with('.') && name != ".env" && name != ".env.local" {
                continue;
            }
            let rel_path = ent
                .path()
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            let rel_lower = rel_path.to_lowercase();
            let name_lower = name.to_lowercase();
            let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);

            if let Some(pos) = name_lower.find(q) {
                let rank: u8 = if is_dir { 0 } else { 1 };
                hits.push(Scored {
                    rank,
                    pos,
                    len: name_lower.len(),
                    rel_lower: rel_lower.clone(),
                    value: json!({
                        "name": name,
                        "path": ent.path().to_string_lossy(),
                        "relative": rel_path,
                        "type": if is_dir { "folder" } else { "file" },
                    }),
                });
            } else if let Some(pos) = rel_lower.find(q) {
                let rank: u8 = if is_dir { 2 } else { 3 };
                hits.push(Scored {
                    rank,
                    pos,
                    len: rel_lower.len(),
                    rel_lower: rel_lower.clone(),
                    value: json!({
                        "name": name,
                        "path": ent.path().to_string_lossy(),
                        "relative": rel_path,
                        "type": if is_dir { "folder" } else { "file" },
                    }),
                });
            }

            if is_dir {
                stack.push_back(ent.path());
            }
            if hits.len() >= result_cap {
                break;
            }
        }
        if hits.len() >= result_cap {
            break;
        }
    }

    hits.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.pos.cmp(&b.pos))
            .then_with(|| a.len.cmp(&b.len))
            .then_with(|| a.rel_lower.cmp(&b.rel_lower))
    });
    hits.into_iter().take(limit).map(|s| s.value).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_empty_query_lists_first_level_folders_first() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        std::fs::create_dir(tmp.path().join("docs")).unwrap();
        std::fs::create_dir(tmp.path().join("node_modules")).unwrap(); // must be skipped
        std::fs::write(tmp.path().join("README.md"), b"").unwrap();
        std::fs::write(tmp.path().join("Cargo.toml"), b"").unwrap();

        let v = search_project(tmp.path(), "", 50);
        let names: Vec<&str> = v.iter().map(|e| e["name"].as_str().unwrap()).collect();
        // node_modules excluded; folders before files; alpha-insensitive
        // within each group.
        assert_eq!(names, vec!["docs", "src", "Cargo.toml", "README.md"]);
    }

    #[test]
    fn search_matches_name_then_path_with_skip_rules() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        std::fs::write(tmp.path().join("src/foo.rs"), b"").unwrap();
        std::fs::write(tmp.path().join("src/bar.rs"), b"").unwrap();
        std::fs::write(tmp.path().join(".git/foo.txt"), b"").unwrap();

        // .git is in SEARCH_SKIP_DIRS so its foo.txt is invisible.
        let v = search_project(tmp.path(), "foo", 50);
        let names: Vec<&str> = v.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["foo.rs"]);
    }
}
