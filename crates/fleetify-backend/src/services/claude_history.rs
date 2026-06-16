//! Faithful port of `app/routers/sessions.py::_parse_claude_history_jsonl`
//! and `_find_claude_project_dir`. Reads Claude Code's native JSONL
//! transcripts at `~/.claude/projects/<encoded-path>/<session_id>.jsonl`
//! and reconstructs Fleet-shaped message rows the renderer's resume
//! picker can hydrate without a backend bridge spin-up.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

const MAX_RETURNED: usize = 120;
const SKIP_PREFIXES: &[&str] = &[
    "<local-command-caveat>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    // Slash-command stdout/stderr Claude records when the user runs `/bg`,
    // `/compact`, etc. These are CLI plumbing, not conversation — surfacing
    // them in the resumed chat shows the raw `<local-command-stdout>…` markers.
    "<local-command-stdout>",
    "<local-command-stderr>",
    // Placeholder assistant turn Claude emits for a slash command that doesn't
    // request a model response (e.g. `/bg`). Plain text, no marker tags.
    "No response requested.",
];

/// Fleet chat-format message — matches the JSON shape the renderer
/// already consumes from `/api/sessions/{id}/messages`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HistoryMessage {
    pub id: String,
    pub role: String,
    pub content: Vec<Value>,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

fn home() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string()),
    )
}

/// Resolve a filesystem path to its `~/.claude/projects/<encoded>` dir.
/// Three-strategy fallback matching the Python original:
///   1. sessions-index.json originalPath exact match (most reliable;
///      Claude writes this for every project).
///   2. `/` → `-` AND `_` → `-` encoding (Claude's current encoding).
///   3. `/` → `-` only (older Claude versions kept underscores).
///
/// Returns None when the projects root doesn't exist or no candidate
/// matches — caller treats that as "no resumable sessions".
pub fn find_claude_project_dir(path: &str) -> Option<PathBuf> {
    let projects_root = home().join(".claude").join("projects");
    if !projects_root.is_dir() {
        return None;
    }
    let normalized = path
        .trim_end_matches('/')
        .trim_end_matches('\\')
        .to_string();

    // ── Strategy 1: sessions-index.json originalPath ──
    if let Ok(rd) = std::fs::read_dir(&projects_root) {
        for entry in rd.flatten() {
            let d = entry.path();
            if !d.is_dir() {
                continue;
            }
            let index = d.join("sessions-index.json");
            if let Ok(text) = std::fs::read_to_string(&index) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    let original = v
                        .get("originalPath")
                        .and_then(|x| x.as_str())
                        .map(|s| s.trim_end_matches('/').trim_end_matches('\\').to_string())
                        .unwrap_or_default();
                    if original == normalized {
                        return Some(d);
                    }
                }
            }
        }
    }

    // ── Strategy 2: '/' and '_' → '-' ──
    let encoded_both = normalized.replace(['/', '_'], "-");
    let cand = projects_root.join(&encoded_both);
    if cand.is_dir() {
        return Some(cand);
    }

    // ── Strategy 3: only '/' → '-' ──
    let encoded_slash = normalized.replace('/', "-");
    let cand2 = projects_root.join(&encoded_slash);
    if cand2.is_dir() {
        return Some(cand2);
    }
    None
}

/// True when `claude --resume <claude_session_id>` has a real transcript to
/// resume for `cwd`. Claude stores transcripts at
/// `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, encoding the cwd by
/// replacing every non-alphanumeric character with `-` (e.g. `C:\Users\loseu`
/// → `C--Users-loseu`).
///
/// We check that modern encoding first, then fall back to
/// [`find_claude_project_dir`] (which additionally honours
/// `sessions-index.json` and the legacy `/`/`_` encodings) so a scheme
/// difference never produces a false "missing". The bias is deliberate: a
/// false "missing" would needlessly downgrade a healthy `--resume` to
/// `--continue`, whereas a false "present" merely lets the original
/// `--resume` fail exactly as it does today. So we report "missing" only when
/// no candidate directory holds the transcript at all — the orphaned-id case
/// (cwd changed, `~/.claude` cleared, or the id was persisted before its
/// transcript was durably written).
/// Like [`resume_conversation_exists`] but checks under an explicit Claude
/// config dir (`CLAUDE_CONFIG_DIR`) rather than the default `~/.claude`. Used by
/// the multi-account path: a session pinned to / following the `~/.claude-2`
/// account stores its transcripts under `~/.claude-2/projects/…`, so the resume
/// check must look there — otherwise a conversation that exists under System
/// looks "present" and `claude --resume` hard-fails in the other account with
/// "No conversation found".
pub fn resume_conversation_exists_in(
    config_dir: &std::path::Path,
    cwd: &str,
    claude_session_id: &str,
) -> bool {
    if claude_session_id.is_empty() {
        return false;
    }
    let projects_root = config_dir.join("projects");
    let file = format!("{claude_session_id}.jsonl");
    // Modern encoding (every non-alphanumeric → '-') and the slash-only
    // encoding both seen in the wild.
    let encoded_dash: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if projects_root.join(&encoded_dash).join(&file).is_file() {
        return true;
    }
    let encoded_slash: String = cwd.replace(['/', '\\'], "-");
    projects_root.join(&encoded_slash).join(&file).is_file()
}

pub fn resume_conversation_exists(cwd: &str, claude_session_id: &str) -> bool {
    if claude_session_id.is_empty() {
        return false;
    }
    let projects_root = home().join(".claude").join("projects");
    let file = format!("{claude_session_id}.jsonl");

    // Modern Claude encoding: every non-alphanumeric char → '-'.
    let encoded: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if projects_root.join(&encoded).join(&file).is_file() {
        return true;
    }

    // Fallback: Fleet's existing resolver (index + legacy encodings).
    if let Some(dir) = find_claude_project_dir(cwd) {
        if dir.join(&file).is_file() {
            return true;
        }
    }
    false
}

/// One row in the resume-picker list — a Claude Code session's id,
/// modification timestamp, and a short user-prompt preview.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClaudeSessionPreview {
    pub session_id: String,
    pub summary: String,
    pub updated_at: String,
    /// Friendly label of the Claude account this transcript belongs to —
    /// `"System"` for the primary `~/.claude` config dir, or the discovered
    /// dir name (e.g. `".claude-2"`, `".claude-work"`) for sibling dirs.
    /// Populated by `scan_sessions_all_accounts`; the legacy `scan_sessions`
    /// (System-only) leaves it empty for back-compat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    /// Original project path (Claude's encoded dir → human path) so the
    /// resume picker can show which folder the conversation belongs to.
    /// Recovered from `sessions-index.json::originalPath` when available,
    /// otherwise decoded from the dir name (`-Users-…` → `/Users/…`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

/// Walk `~/.claude/projects/<encoded>/*.jsonl` and return one row per
/// transcript file (newest first). Faithful with
/// `sessions.py::_scan_claude_sessions_sync`. Heavy I/O — call from
/// a blocking task.
pub fn scan_sessions(project_path: &str) -> Vec<ClaudeSessionPreview> {
    let Some(project_dir) = find_claude_project_dir(project_path) else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(&project_dir) else {
        return Vec::new();
    };
    let mut out: Vec<ClaudeSessionPreview> = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339(),
            Err(_) => chrono::Utc::now().to_rfc3339(),
        };
        let summary = first_user_text(&p).unwrap_or_else(|| "No preview".to_string());
        out.push(ClaudeSessionPreview {
            session_id: session_id.to_string(),
            summary,
            updated_at: mtime,
            account_label: None,
            project_path: project_path_for_dir(&project_dir),
        });
    }
    // Sort newest first.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// Walks EVERY Claude config dir on disk — the primary `~/.claude/projects/`
/// (label `"System"`) and every discovered sibling `~/.claude-*/projects/`
/// (label = the dir name, e.g. `".claude-2"`). When `project_path` is `Some`,
/// only that project's transcripts are returned (back-compat); when `None`,
/// EVERY project across EVERY account is returned — the "general history" the
/// resume picker uses so the user sees their full Claude conversation history.
/// Capped to `MAX_RETURNED` entries (newest first) so the picker stays snappy.
pub fn scan_sessions_all_accounts(project_path: Option<&str>) -> Vec<ClaudeSessionPreview> {
    let mut out: Vec<ClaudeSessionPreview> = Vec::new();
    let home = home();

    // Build the list of (label, config_dir) pairs we'll walk.
    let mut accounts: Vec<(String, std::path::PathBuf)> =
        vec![("System".into(), home.join(".claude"))];
    if let Ok(rd) = std::fs::read_dir(&home) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(".claude-") && e.path().is_dir() {
                accounts.push((name, e.path()));
            }
        }
    }
    accounts.sort_by(|a, b| a.0.cmp(&b.0));

    for (label, config_dir) in accounts {
        // Project dirs to scan inside this account.
        let project_dirs: Vec<PathBuf> = match project_path {
            // Path-filtered: the exact project dir AND any sub-project dirs
            // Claude carved off for worktrees / nested checkouts (Claude
            // encodes each unique path as its own `projects/<dir>` —
            // `canadiantire`, `canadiantire--fleetify-worktrees-XXX`, etc.).
            // Without the prefix match the worktree transcripts were
            // invisible in the resume picker even though they belong to the
            // same logical project.
            Some(p) => find_claude_project_dirs_prefix(&config_dir, p),
            // Global history: every project under this account.
            None => {
                let root = config_dir.join("projects");
                std::fs::read_dir(&root)
                    .map(|rd| {
                        rd.flatten()
                            .map(|e| e.path())
                            .filter(|p| p.is_dir())
                            .collect()
                    })
                    .unwrap_or_default()
            }
        };
        for project_dir in project_dirs {
            let Ok(rd) = std::fs::read_dir(&project_dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let p = entry.path();
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(session_id) = p.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let mtime = match entry.metadata().and_then(|m| m.modified()) {
                    Ok(t) => chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339(),
                    Err(_) => chrono::Utc::now().to_rfc3339(),
                };
                let summary = first_user_text(&p).unwrap_or_else(|| "No preview".to_string());
                out.push(ClaudeSessionPreview {
                    session_id: session_id.to_string(),
                    summary,
                    updated_at: mtime,
                    account_label: Some(label.clone()),
                    project_path: project_path_for_dir(&project_dir),
                });
            }
        }
    }
    // Newest first across all accounts + cap so a user with hundreds of
    // transcripts (we've seen 100+ per account) doesn't ship a megabyte of
    // history through the resume picker's tiny menu.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out.truncate(MAX_RETURNED);
    out
}

/// Resolve a Claude project dir (`~/.claude*/projects/<encoded>/`) back to
/// the original filesystem path. Prefers `sessions-index.json::originalPath`
/// when present (authoritative); otherwise reconstructs from the dir name by
/// stripping the leading `-` (which Claude uses for the path's leading `/`)
/// and replacing the remaining `-` separators with `/`. Reconstruction is
/// best-effort — a path with intentional dashes (e.g. `~/my-folder`) can't
/// be perfectly recovered, but the resulting string is still enough for the
/// resume picker to display "which folder?". Returns `None` only when neither
/// signal is available.
fn project_path_for_dir(project_dir: &Path) -> Option<String> {
    // 1) Authoritative: Claude writes `originalPath` into sessions-index.json.
    if let Ok(text) = std::fs::read_to_string(project_dir.join("sessions-index.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(p) = v.get("originalPath").and_then(|x| x.as_str()) {
                if !p.is_empty() {
                    return Some(p.to_string());
                }
            }
        }
    }
    // 2) Best-effort: decode the dir name. `-Users-cryonicx-Desktop-foo`
    //    → `/Users/cryonicx/Desktop/foo`.
    let name = project_dir.file_name()?.to_string_lossy().into_owned();
    if let Some(body) = name.strip_prefix('-') {
        return Some(format!("/{}", body.replace('-', "/")));
    }
    None
}

/// Walk EVERY `~/.claude*/projects/*/` and return the absolute jsonl path of
/// the transcript whose stem matches `claude_session_id`. The id is a v4 UUID
/// so collisions across accounts are vanishingly unlikely — first match wins.
/// Used by the resume-history fetcher so picking a row from another account
/// loads its transcript instead of silently falling back to an empty body.
pub fn find_jsonl_anywhere(claude_session_id: &str) -> Option<PathBuf> {
    if claude_session_id.is_empty() {
        return None;
    }
    let home = home();
    let mut candidates: Vec<PathBuf> = vec![home.join(".claude")];
    if let Ok(rd) = std::fs::read_dir(&home) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with(".claude-") && e.path().is_dir() {
                candidates.push(e.path());
            }
        }
    }
    let target = format!("{claude_session_id}.jsonl");
    for c in candidates {
        let root = c.join("projects");
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in rd.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let cand = dir.join(&target);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// Strip a `<...>/.fleetify-worktrees/<UUID>/...` / `.claude-worktrees/<...>` /
/// `.maestro-worktrees/<...>` suffix so a session opened from a worktree path
/// still resolves to its parent project root. Worktree session lookups would
/// otherwise be siloed: a user editing inside `<project>/.fleetify-worktrees/
/// UUID/` would only see THAT worktree's transcripts, not the project's main
/// history or sibling worktrees. Leaves paths without a worktree segment
/// unchanged.
fn project_root_path(path: &str) -> &str {
    for marker in [
        "/.fleetify-worktrees/",
        "/.claude-worktrees/",
        "/.maestro-worktrees/",
    ] {
        if let Some(idx) = path.find(marker) {
            return &path[..idx];
        }
    }
    path
}

/// Every `~/.claude*/projects/<encoded>/` whose encoded name matches the
/// project root OR starts with `<root>-` — i.e. the project itself AND every
/// sub-project Claude carved off for worktrees / nested checkouts.
/// Worktree directories (`<project>--fleetify-worktrees-<UUID>/`) hold
/// genuine conversations that BELONG to the same logical project; the old
/// single-dir lookup left them invisible in the resume picker. Both modern
/// (every non-alnum → `-`) and legacy (`/` → `-` only) encodings are tried,
/// and any sessions-index.json match wins outright. Empty / non-existent
/// projects root → empty vec.
fn find_claude_project_dirs_prefix(config_dir: &Path, path: &str) -> Vec<PathBuf> {
    let projects_root = config_dir.join("projects");
    if !projects_root.is_dir() {
        return Vec::new();
    }
    // Hop up out of any worktree subdir so the prefix scan covers the whole
    // project (main + every sibling worktree), not just the active worktree.
    let normalized = project_root_path(path)
        .trim_end_matches('/')
        .trim_end_matches('\\');
    let modern: String = normalized
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let legacy = normalized.replace(['/', '\\'], "-");
    let modern_pfx = format!("{modern}-");
    let legacy_pfx = format!("{legacy}-");

    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&projects_root) else {
        return out;
    };
    for entry in rd.flatten() {
        let d = entry.path();
        if !d.is_dir() {
            continue;
        }
        // sessions-index.json originalPath — definitive same-project signal.
        let index_match = std::fs::read_to_string(d.join("sessions-index.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| {
                v.get("originalPath").and_then(|x| x.as_str()).map(|s| {
                    s.trim_end_matches('/').trim_end_matches('\\') == normalized
                        || s.trim_end_matches('/')
                            .trim_end_matches('\\')
                            .starts_with(&format!("{normalized}/"))
                })
            })
            .unwrap_or(false);
        if index_match {
            out.push(d);
            continue;
        }
        // Encoded-name match: exact OR project-prefix.
        let Some(name) = d.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name == modern
            || name == legacy
            || name.starts_with(&modern_pfx)
            || name.starts_with(&legacy_pfx)
        {
            out.push(d);
        }
    }
    out
}

/// First meaningful user-prompt preview from a JSONL transcript,
/// capped at 120 chars. Skip-prefixes match Python `_SKIP_PREFIXES`.
pub fn first_user_text(jsonl_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(jsonl_path).ok()?;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(d) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if d.get("type").and_then(|x| x.as_str()) != Some("user") {
            continue;
        }
        let content = d
            .get("message")
            .and_then(|m| m.get("content"))
            .cloned()
            .unwrap_or(Value::Null);
        let texts: Vec<String> = match &content {
            Value::String(s) => vec![s.clone()],
            Value::Array(arr) => arr
                .iter()
                .filter_map(|b| {
                    let o = b.as_object()?;
                    if o.get("type").and_then(|x| x.as_str()) == Some("text") {
                        o.get("text").and_then(|x| x.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
                .collect(),
            _ => Vec::new(),
        };
        for raw in texts {
            let t = raw.trim();
            if t.is_empty() {
                continue;
            }
            if looks_like_skip_prefix(t) {
                continue;
            }
            return Some(t.chars().take(120).collect());
        }
    }
    None
}

/// Tail size read when hydrating a transcript. Comfortably holds the last
/// `MAX_RETURNED` (120) messages for any normal conversation while keeping the
/// parse bounded — a 36 MB history would otherwise take seconds to decode.
const PARSE_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// Read at most the last `max_bytes` of a file as text. For files <= `max_bytes`
/// the whole file is returned; for larger files we seek to the tail and drop the
/// first (almost certainly partial) line so parsing starts on a clean boundary.
/// UTF-8 is decoded lossily since the seek may split a multibyte char.
fn read_tail(path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len <= max_bytes {
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        return Some(s);
    }
    f.seek(SeekFrom::Start(len - max_bytes)).ok()?;
    let mut buf = Vec::with_capacity(max_bytes as usize);
    f.take(max_bytes).read_to_end(&mut buf).ok()?;
    // Drop everything up to and including the first newline (the partial line).
    let start = buf
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    Some(String::from_utf8_lossy(&buf[start..]).into_owned())
}

/// Parse a `<sid>.jsonl` transcript and return the last 120 Fleet-
/// shaped messages. Best-effort: malformed lines / files are silently
/// skipped — empty result on any catastrophic failure matches the
/// Python behaviour. Heavy disk I/O — call from a blocking task or
/// via `tokio::task::spawn_blocking` to avoid stalling the runtime.
pub fn parse_jsonl(jsonl_file: &Path) -> Vec<HistoryMessage> {
    // Only the LAST MAX_RETURNED messages are kept, so reading + JSON-parsing a
    // multi-MB transcript end-to-end is pure waste — the 36 MB canadiantire
    // history took several seconds and stalled the chat on open. Read just the
    // tail (enough to comfortably hold 120 messages) and parse that.
    let Some(text) = read_tail(jsonl_file, PARSE_TAIL_BYTES) else {
        return Vec::new();
    };
    let mut messages: Vec<HistoryMessage> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(d) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let msg_type = d.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if msg_type != "user" && msg_type != "assistant" {
            continue;
        }
        let msg = d.get("message").cloned().unwrap_or(Value::Null);
        let content_raw = msg.get("content").cloned().unwrap_or(Value::Null);
        let timestamp = d
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let id = d
            .get("uuid")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        match msg_type {
            "user" => {
                let blocks = user_blocks(&content_raw);
                if !blocks.is_empty() {
                    messages.push(HistoryMessage {
                        id,
                        role: "user".into(),
                        content: blocks,
                        timestamp,
                        model: None,
                        usage: None,
                    });
                }
            }
            "assistant" => {
                let blocks = assistant_blocks(&content_raw);
                if !blocks.is_empty() {
                    let model = msg.get("model").and_then(|x| x.as_str()).map(String::from);
                    let usage = msg.get("usage").filter(|v| v.is_object()).map(|u| {
                        let g = |k: &str| u.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                        json!({
                            "input_tokens": g("input_tokens"),
                            "output_tokens": g("output_tokens"),
                            "cache_read_tokens": g("cache_read_input_tokens"),
                            "cache_write_tokens": g("cache_creation_input_tokens"),
                        })
                    });
                    messages.push(HistoryMessage {
                        id,
                        role: "assistant".into(),
                        content: blocks,
                        timestamp,
                        model,
                        usage,
                    });
                }
            }
            _ => {}
        }
    }
    if messages.len() > MAX_RETURNED {
        let cut = messages.len() - MAX_RETURNED;
        messages.drain(..cut);
    }
    messages
}

fn looks_like_skip_prefix(text: &str) -> bool {
    SKIP_PREFIXES.iter().any(|p| text.starts_with(p))
}

fn user_blocks(content_raw: &Value) -> Vec<Value> {
    let mut blocks: Vec<Value> = Vec::new();
    match content_raw {
        Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() && !looks_like_skip_prefix(t) {
                blocks.push(json!({"type": "text", "text": t}));
            }
        }
        Value::Array(arr) => {
            for block in arr {
                let Some(obj) = block.as_object() else {
                    continue;
                };
                let btype = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match btype {
                    "text" => {
                        let t = obj
                            .get("text")
                            .and_then(|x| x.as_str())
                            .map(str::trim)
                            .unwrap_or("");
                        if !t.is_empty() && !looks_like_skip_prefix(t) {
                            blocks.push(json!({"type": "text", "text": t}));
                        }
                    }
                    "tool_result" => {
                        let inner = obj.get("content").cloned().unwrap_or(Value::Null);
                        let output = if let Some(arr) = inner.as_array() {
                            arr.iter()
                                .map(|b| {
                                    b.as_object()
                                        .and_then(|o| o.get("text"))
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string()
                                })
                                .collect::<Vec<_>>()
                                .join(" ")
                        } else if let Some(s) = inner.as_str() {
                            s.to_string()
                        } else {
                            inner.to_string()
                        };
                        blocks.push(json!({
                            "type": "tool_result",
                            "tool_id": obj
                                .get("tool_use_id")
                                .and_then(|x| x.as_str())
                                .unwrap_or(""),
                            "output": output,
                            "is_error": obj
                                .get("is_error")
                                .and_then(|x| x.as_bool())
                                .unwrap_or(false),
                        }));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    blocks
}

fn assistant_blocks(content_raw: &Value) -> Vec<Value> {
    let mut blocks: Vec<Value> = Vec::new();
    let Some(arr) = content_raw.as_array() else {
        return blocks;
    };
    for block in arr {
        let Some(obj) = block.as_object() else {
            continue;
        };
        let btype = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match btype {
            "text" => {
                // Trim + drop CLI-plumbing placeholders (e.g. the slash-command
                // "No response requested." turn) so they don't render as empty
                // assistant bubbles. An assistant message left with no blocks is
                // skipped entirely by the caller.
                if let Some(t) = obj
                    .get("text")
                    .and_then(|x| x.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && !looks_like_skip_prefix(s))
                {
                    blocks.push(json!({"type": "text", "text": t}));
                }
            }
            "thinking" => {
                if let Some(t) = obj
                    .get("thinking")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                {
                    blocks.push(json!({"type": "thinking", "text": t}));
                }
            }
            "tool_use" => {
                blocks.push(json!({
                    "type": "tool_use",
                    "tool_id": obj.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                    "tool_name": obj.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                    "input": obj.get("input").cloned().unwrap_or(Value::Null),
                }));
            }
            _ => {}
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_jsonl(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut f = tempfile::Builder::new()
            .suffix(".jsonl")
            .tempfile()
            .unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        f
    }

    #[test]
    fn user_string_content_becomes_one_text_block() {
        let f = tmp_jsonl(&[
            r#"{"type":"user","timestamp":"2026-05-20T10:00:00Z","uuid":"u1","message":{"content":"hello fleet"}}"#,
        ]);
        let m = parse_jsonl(f.path());
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].role, "user");
        assert_eq!(
            m[0].content,
            vec![json!({"type":"text","text":"hello fleet"})]
        );
    }

    #[test]
    fn user_text_with_skip_prefix_is_dropped_entirely() {
        let f = tmp_jsonl(&[
            r#"{"type":"user","timestamp":"t","uuid":"u","message":{"content":"<local-command-caveat>internal"}}"#,
        ]);
        assert!(parse_jsonl(f.path()).is_empty());
    }

    #[test]
    fn assistant_block_array_emits_text_thinking_and_tool_use() {
        // One physical line per JSONL row — the parser splits on
        // `lines()` so embedded newlines would split a single
        // logical record across many invalid lines.
        let f = tmp_jsonl(&[
            r#"{"type":"assistant","timestamp":"t","uuid":"a1","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"reply"},{"type":"thinking","thinking":"hmm"},{"type":"tool_use","id":"t1","name":"Bash","input":{"cmd":"ls"}}],"usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":1,"cache_creation_input_tokens":2}}}"#,
        ]);
        let m = parse_jsonl(f.path());
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].role, "assistant");
        assert_eq!(m[0].model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(m[0].content.len(), 3);
        assert_eq!(m[0].content[0]["type"], "text");
        assert_eq!(m[0].content[1]["type"], "thinking");
        assert_eq!(m[0].content[2]["type"], "tool_use");
        assert_eq!(m[0].content[2]["tool_id"], "t1");
        assert_eq!(m[0].content[2]["tool_name"], "Bash");
        let usage = m[0].usage.as_ref().unwrap();
        assert_eq!(usage["input_tokens"], 12);
        assert_eq!(usage["output_tokens"], 34);
        assert_eq!(usage["cache_read_tokens"], 1);
        assert_eq!(usage["cache_write_tokens"], 2);
    }

    #[test]
    fn malformed_lines_are_skipped_individually() {
        let f = tmp_jsonl(&[
            "not json at all",
            r#"{"type":"user","timestamp":"t","uuid":"u","message":{"content":"ok"}}"#,
            "{another garbage line",
        ]);
        let m = parse_jsonl(f.path());
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].content[0]["text"], "ok");
    }

    #[test]
    fn output_capped_at_120_messages() {
        let mut lines: Vec<String> = Vec::with_capacity(150);
        for i in 0..150 {
            lines.push(format!(
                r#"{{"type":"user","timestamp":"t{i}","uuid":"u{i}","message":{{"content":"msg-{i}"}}}}"#
            ));
        }
        let borrowed: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let f = tmp_jsonl(&borrowed);
        let m = parse_jsonl(f.path());
        assert_eq!(m.len(), 120);
        // The LAST 120 are kept — first kept message should be msg-30.
        assert_eq!(m[0].content[0]["text"], "msg-30");
        assert_eq!(m[119].content[0]["text"], "msg-149");
    }

    #[test]
    fn nonexistent_file_returns_empty() {
        let m = parse_jsonl(Path::new("__does_not_exist_5be2__"));
        assert!(m.is_empty());
    }

    #[test]
    fn first_user_text_returns_the_first_non_skipped_prompt_capped_at_120() {
        let prompt = "this is a normal user prompt that should be returned as the preview";
        let f = tmp_jsonl(&[
            // First user message uses a skip prefix → must be ignored.
            r#"{"type":"user","timestamp":"t1","message":{"content":"<command-name>git"}}"#,
            // Assistant in between — must be skipped (we only want user).
            r#"{"type":"assistant","timestamp":"t2","message":{"content":[{"type":"text","text":"hi"}]}}"#,
            // First real user prompt → returned.
            &format!(r#"{{"type":"user","timestamp":"t3","message":{{"content":"{prompt}"}}}}"#),
            // Should never be reached.
            r#"{"type":"user","timestamp":"t4","message":{"content":"later"}}"#,
        ]);
        let s = first_user_text(f.path()).unwrap();
        assert_eq!(s, prompt);

        // Long-prompt cap.
        let long: String = "abcde".repeat(40); // 200 chars
        let f2 = tmp_jsonl(&[&format!(
            r#"{{"type":"user","timestamp":"t","message":{{"content":"{long}"}}}}"#
        )]);
        let s2 = first_user_text(f2.path()).unwrap();
        assert_eq!(s2.chars().count(), 120);
        assert!(long.starts_with(&s2));
    }

    #[test]
    fn first_user_text_handles_array_content_blocks() {
        let f = tmp_jsonl(&[
            r#"{"type":"user","timestamp":"t","message":{"content":[{"type":"tool_result","tool_use_id":"x"},{"type":"text","text":"actual prompt"}]}}"#,
        ]);
        let s = first_user_text(f.path()).unwrap();
        assert_eq!(s, "actual prompt");
    }

    #[test]
    fn scan_sessions_returns_empty_when_projects_root_missing() {
        // Point HOME at a tempdir with no .claude/projects subtree
        // so the function takes the "no projects root" exit.
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        let rows = scan_sessions("/some/project");
        assert!(rows.is_empty());
    }

    #[test]
    fn resume_conversation_exists_detects_present_and_orphaned() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());

        // Windows-style cwd encoded via the modern non-alphanumeric→'-'
        // rule: C:\Users\me → C--Users-me.
        let cwd = "C:\\Users\\me";
        let dir = tmp
            .path()
            .join(".claude")
            .join("projects")
            .join("C--Users-me");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good-sid.jsonl"), "{}").unwrap();

        // Present transcript → resumable (healthy --resume preserved).
        assert!(resume_conversation_exists(cwd, "good-sid"));
        // Orphaned id (file absent) → not resumable → caller self-heals.
        assert!(!resume_conversation_exists(cwd, "ghost-sid"));
        // Empty id → not resumable.
        assert!(!resume_conversation_exists(cwd, ""));
    }

    #[test]
    fn scan_sessions_lists_jsonl_files_newest_first_with_preview() {
        let _g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());

        // Lay out ~/.claude/projects/<encoded>/<sid>.jsonl. Use the
        // simple "/" → "-" encoding strategy that the resolver tries.
        let projects = tmp.path().join(".claude").join("projects");
        let project_path = "/work/myproj";
        let encoded = project_path.trim_start_matches('/').replace('/', "-");
        // strategy 3: only `/` → `-`. But original begins with `/`, so leading dash.
        let project_dir = projects.join(project_path.replace('/', "-"));
        std::fs::create_dir_all(&project_dir).unwrap();
        let older = project_dir.join("aaa.jsonl");
        let newer = project_dir.join("bbb.jsonl");
        std::fs::write(
            &older,
            r#"{"type":"user","timestamp":"t","message":{"content":"older prompt"}}"#,
        )
        .unwrap();
        // Tiny sleep so the newer file's mtime is strictly greater
        // (filesystem timestamp granularity is OS-dependent; 25ms is
        // comfortably above the worst case we care about in CI).
        std::thread::sleep(std::time::Duration::from_millis(25));
        std::fs::write(
            &newer,
            r#"{"type":"user","timestamp":"t","message":{"content":"newer prompt"}}"#,
        )
        .unwrap();
        let _ = encoded;

        let rows = scan_sessions(project_path);
        assert_eq!(rows.len(), 2);
        let ids: std::collections::HashSet<&str> =
            rows.iter().map(|r| r.session_id.as_str()).collect();
        assert!(ids.contains("aaa"));
        assert!(ids.contains("bbb"));
        // Preview text round-trips for both.
        for r in &rows {
            match r.session_id.as_str() {
                "aaa" => assert_eq!(r.summary, "older prompt"),
                "bbb" => assert_eq!(r.summary, "newer prompt"),
                _ => panic!("unexpected sid {}", r.session_id),
            }
        }
    }

    #[test]
    fn user_tool_result_block_carries_output_and_error_flag() {
        let f = tmp_jsonl(&[
            r#"{"type":"user","timestamp":"t","uuid":"u","message":{"content":[{"type":"tool_result","tool_use_id":"t-42","content":"all good","is_error":false}]}}"#,
        ]);
        let m = parse_jsonl(f.path());
        assert_eq!(m.len(), 1);
        let b = &m[0].content[0];
        assert_eq!(b["type"], "tool_result");
        assert_eq!(b["tool_id"], "t-42");
        assert_eq!(b["output"], "all good");
        assert_eq!(b["is_error"], false);
    }
}
