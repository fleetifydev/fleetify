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
                        .map(|s| {
                            s.trim_end_matches('/').trim_end_matches('\\').to_string()
                        })
                        .unwrap_or_default();
                    if original == normalized {
                        return Some(d);
                    }
                }
            }
        }
    }

    // ── Strategy 2: '/' and '_' → '-' ──
    let encoded_both = normalized.replace('/', "-").replace('_', "-");
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

/// Parse a `<sid>.jsonl` transcript and return the last 120 Fleet-
/// shaped messages. Best-effort: malformed lines / files are silently
/// skipped — empty result on any catastrophic failure matches the
/// Python behaviour. Heavy disk I/O — call from a blocking task or
/// via `tokio::task::spawn_blocking` to avoid stalling the runtime.
pub fn parse_jsonl(jsonl_file: &Path) -> Vec<HistoryMessage> {
    let Ok(text) = std::fs::read_to_string(jsonl_file) else {
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
                    let model = msg
                        .get("model")
                        .and_then(|x| x.as_str())
                        .map(String::from);
                    let usage = msg
                        .get("usage")
                        .filter(|v| v.is_object())
                        .map(|u| {
                            let g = |k: &str| {
                                u.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
                            };
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
                let Some(obj) = block.as_object() else { continue };
                let btype = obj
                    .get("type")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
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
        let Some(obj) = block.as_object() else { continue };
        let btype = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match btype {
            "text" => {
                if let Some(t) =
                    obj.get("text").and_then(|x| x.as_str()).filter(|s| !s.is_empty())
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
        assert_eq!(m[0].content, vec![json!({"type":"text","text":"hello fleet"})]);
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
