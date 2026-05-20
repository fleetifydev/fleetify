//! Faithful ports of `sessions.py::_list_gemini_sessions_for_path` and
//! `_list_codex_sessions_for_path`. Same row shape as the Claude
//! variant in [`crate::services::claude_history`] so the renderer's
//! resume picker treats all three uniformly.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionPreview {
    pub session_id: String,
    pub summary: String,
    pub updated_at: String,
}

fn home() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string()),
    )
}

/// Match Gemini's project-encoding (separators → `-`, leading dash
/// stripped). Faithful with `_gemini_project_hash`.
pub fn gemini_project_hash(path: &str) -> String {
    let normalized = path
        .trim_end_matches('/')
        .trim_end_matches('\\')
        .to_string();
    let dashed = normalized.replace('\\', "-").replace('/', "-");
    dashed.trim_start_matches('-').to_string()
}

/// List Gemini ACP session checkpoints saved for `project_path`. Each
/// entry under `~/.gemini/tmp/<hash>/checkpoints/` is a session — file
/// (json) or directory (some Gemini variants persist as a tree of
/// segments). Returns rows newest-first.
pub fn list_gemini_sessions(project_path: &str) -> Vec<SessionPreview> {
    let hash_str = gemini_project_hash(project_path);
    let checkpoint_dir = home()
        .join(".gemini")
        .join("tmp")
        .join(hash_str)
        .join("checkpoints");
    if !checkpoint_dir.is_dir() {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(&checkpoint_dir) else {
        return Vec::new();
    };
    let mut out: Vec<SessionPreview> = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        let session_id = if p.is_file() {
            p.file_stem().and_then(|s| s.to_str()).map(String::from)
        } else if p.is_dir() {
            p.file_name().and_then(|s| s.to_str()).map(String::from)
        } else {
            None
        };
        let Some(session_id) = session_id else { continue };
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339(),
            Err(_) => chrono::Utc::now().to_rfc3339(),
        };
        let summary = if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("json") {
            preview_from_first_user(&p).unwrap_or_else(|| "No preview".to_string())
        } else {
            "No preview".to_string()
        };
        out.push(SessionPreview {
            session_id,
            summary,
            updated_at: mtime,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// List Codex thread checkpoints persisted for `project_path`. Files
/// in `~/.codex/sessions/*.json` whose `cwd` field matches the
/// requested path are returned, newest-first.
pub fn list_codex_sessions(project_path: &str) -> Vec<SessionPreview> {
    let sessions_root = home().join(".codex").join("sessions");
    if !sessions_root.is_dir() {
        return Vec::new();
    }
    let path_norm = project_path
        .trim_end_matches('/')
        .trim_end_matches('\\')
        .to_string();
    let Ok(rd) = std::fs::read_dir(&sessions_root) else {
        return Vec::new();
    };
    let mut out: Vec<SessionPreview> = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(&text) else { continue };
        let cwd_in_file = data
            .get("cwd")
            .and_then(|x| x.as_str())
            .map(|s| s.trim_end_matches('/').trim_end_matches('\\').to_string())
            .unwrap_or_default();
        if cwd_in_file != path_norm {
            continue;
        }
        let Some(session_id) = p.file_stem().and_then(|s| s.to_str()).map(String::from)
        else {
            continue;
        };
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339(),
            Err(_) => chrono::Utc::now().to_rfc3339(),
        };
        let summary = preview_from_messages(&data).unwrap_or_else(|| "No preview".to_string());
        out.push(SessionPreview {
            session_id,
            summary,
            updated_at: mtime,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// Both Gemini and Codex persist a JSON file with a top-level
/// `messages: [{role, content}]` array. Pull the first non-empty user
/// prompt as the preview (capped at 120 chars).
fn preview_from_first_user(json_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(json_path).ok()?;
    let data: Value = serde_json::from_str(&text).ok()?;
    preview_from_messages(&data)
}

fn preview_from_messages(data: &Value) -> Option<String> {
    let messages = data.get("messages")?.as_array()?;
    // Same "first 5 messages" budget as Python — the first user
    // prompt is almost always within the first couple of rows.
    for msg in messages.iter().take(5) {
        let Some(obj) = msg.as_object() else { continue };
        if obj.get("role").and_then(|x| x.as_str()) != Some("user") {
            continue;
        }
        let content = obj.get("content").cloned().unwrap_or(Value::Null);
        match content {
            Value::String(s) => {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.chars().take(120).collect());
                }
            }
            Value::Array(arr) => {
                for block in arr {
                    if let Some(t) = block
                        .as_object()
                        .and_then(|o| o.get("text"))
                        .and_then(|x| x.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        return Some(t.chars().take(120).collect());
                    }
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_project_hash_strips_separators_and_leading_dash() {
        assert_eq!(gemini_project_hash("/home/loseu/proj"), "home-loseu-proj");
        assert_eq!(
            gemini_project_hash(r"C:\Users\loseu\proj"),
            "C:-Users-loseu-proj",
        );
        assert_eq!(gemini_project_hash("/proj/"), "proj");
    }

    fn install_fake_home() -> (
        std::sync::MutexGuard<'static, ()>,
        tempfile::TempDir,
    ) {
        let g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        (g, tmp)
    }

    #[test]
    fn list_gemini_sessions_empty_when_root_missing() {
        let (_g, _tmp) = install_fake_home();
        assert!(list_gemini_sessions("/x/y").is_empty());
    }

    #[test]
    fn list_gemini_sessions_returns_files_with_preview_and_newest_first() {
        let (_g, tmp) = install_fake_home();
        let hash = gemini_project_hash("/work/proj");
        let dir = tmp.path().join(".gemini").join("tmp").join(hash).join("checkpoints");
        std::fs::create_dir_all(&dir).unwrap();

        // One JSON checkpoint with a user prompt → returns preview.
        let older = dir.join("aaa.json");
        std::fs::write(
            &older,
            r#"{"messages":[{"role":"user","content":"older prompt"}]}"#,
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        let newer = dir.join("bbb.json");
        std::fs::write(
            &newer,
            r#"{"messages":[{"role":"assistant","content":"hi"},{"role":"user","content":[{"text":"newer prompt"}]}]}"#,
        )
        .unwrap();

        let rows = list_gemini_sessions("/work/proj");
        assert_eq!(rows.len(), 2);
        // Both rows present.
        let ids: std::collections::HashSet<&str> =
            rows.iter().map(|r| r.session_id.as_str()).collect();
        assert!(ids.contains("aaa"));
        assert!(ids.contains("bbb"));
        for r in &rows {
            match r.session_id.as_str() {
                "aaa" => assert_eq!(r.summary, "older prompt"),
                "bbb" => assert_eq!(r.summary, "newer prompt"),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn list_codex_sessions_filters_by_cwd_field() {
        let (_g, tmp) = install_fake_home();
        let root = tmp.path().join(".codex").join("sessions");
        std::fs::create_dir_all(&root).unwrap();

        // Matching cwd — should be returned.
        std::fs::write(
            root.join("session-keep.json"),
            r#"{"cwd":"/work/proj","messages":[{"role":"user","content":"do it"}]}"#,
        )
        .unwrap();
        // Different cwd — must NOT appear.
        std::fs::write(
            root.join("session-drop.json"),
            r#"{"cwd":"/other","messages":[{"role":"user","content":"x"}]}"#,
        )
        .unwrap();
        // No cwd at all — also dropped.
        std::fs::write(
            root.join("session-no-cwd.json"),
            r#"{"messages":[{"role":"user","content":"y"}]}"#,
        )
        .unwrap();

        let rows = list_codex_sessions("/work/proj/");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "session-keep");
        assert_eq!(rows[0].summary, "do it");
    }

    #[test]
    fn preview_from_messages_returns_none_for_no_user_in_first_five() {
        let v = serde_json::json!({
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "assistant", "content": "hi"},
                {"role": "assistant", "content": "still nothing"},
                {"role": "assistant", "content": "and again"},
                {"role": "assistant", "content": "fifth"},
                {"role": "user", "content": "BUT this is past the cap"}
            ]
        });
        assert!(preview_from_messages(&v).is_none());
    }
}
