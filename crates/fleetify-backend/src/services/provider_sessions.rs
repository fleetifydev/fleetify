//! Faithful port of `sessions.py::_list_codex_sessions_for_path`. Same
//! row shape as the Claude variant in [`crate::services::claude_history`]
//! so the renderer's resume picker treats both uniformly.

use std::path::PathBuf;

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
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let cwd_in_file = data
            .get("cwd")
            .and_then(|x| x.as_str())
            .map(|s| s.trim_end_matches('/').trim_end_matches('\\').to_string())
            .unwrap_or_default();
        if cwd_in_file != path_norm {
            continue;
        }
        let Some(session_id) = p.file_stem().and_then(|s| s.to_str()).map(String::from) else {
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

/// Codex persists a JSON file with a top-level
/// `messages: [{role, content}]` array. Pull the first non-empty user
/// prompt as the preview (capped at 120 chars).
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

    fn install_fake_home() -> (std::sync::MutexGuard<'static, ()>, tempfile::TempDir) {
        let g = crate::test_support::home_lock()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());
        (g, tmp)
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
