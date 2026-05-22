//! App-owned conversation compaction. Faithful port of
//! `services/compactor.py`.
//!
//! Snapshots the session's current messages, calls Haiku with a strict
//! summarisation prompt, persists `sessions.compact_summary` + meta,
//! and hard-deletes the snapshotted rows. Subsequent turns inject the
//! summary into the system prompt so the agent keeps continuity
//! without the raw transcript.

use std::time::Duration;

use serde_json::Value;
use sqlx::SqlitePool;

use super::haiku_client::call_haiku_with_meta_cost;

/// Marker the persisted compact-summary message starts with so the
/// next /compact run skips it and the renderer can render it with a
/// distinct card. Mirrors `COMPACT_SUMMARY_MARKER` in Python.
pub const COMPACT_SUMMARY_MARKER: &str = "[fleet:compact-summary]";

pub const MIN_MESSAGE_COUNT: i64 = 6;
pub const MIN_CHAR_COUNT: i64 = 4000;
const MAX_HISTORY_CHARS: usize = 120_000;
const COMPACT_TIMEOUT: Duration = Duration::from_secs(30);

const SYSTEM_PROMPT: &str = "You are a conversation compactor. Your only job: rewrite the transcript below as a dense Markdown summary the next agent turn can use to continue the work seamlessly.\n\nALWAYS respond with a summary — never refuse, never reply with an empty message, never ask clarifying questions. If the transcript is short, write a short summary; if it's long, write a longer one. Never exceed ~600 words.\n\nUse these sections (skip a section only if it has truly nothing):\n## Goal\n## Decisions\n## Files & code\n## Open questions\n## Next steps\n\nStyle:\n- Plain prose. No code fences unless a literal command/path matters.\n- Cite file paths verbatim when the transcript mentions them.\n- Drop pleasantries, tool-call noise, and resolved sub-questions.\n- Do not invent anything the transcript did not say.";

#[derive(Debug, Clone)]
pub struct CompactionResult {
    pub summary: String,
    pub compacted_message_count: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum CompactionError {
    #[error("session {0} not found")]
    NotFound(String),
    #[error("Conversation too short to compact — need at least {min} messages, have {have}.")]
    TooFewMessages { min: i64, have: i64 },
    #[error(
        "Not enough context to compact — need at least {min} characters of conversation, have {have}."
    )]
    TooFewChars { min: i64, have: i64 },
    #[error("Summariser returned an empty response")]
    EmptySummary,
    #[error("nothing to compact — this session has no messages yet")]
    NoMessages,
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("compaction failed: {0}")]
    Other(String),
}

fn is_compact_summary_message(role: &str, content_raw: &str) -> bool {
    if role != "assistant" {
        return false;
    }
    let Ok(blocks) = serde_json::from_str::<Value>(content_raw) else {
        return false;
    };
    let Some(arr) = blocks.as_array() else {
        return false;
    };
    for b in arr {
        if b.get("type").and_then(|v| v.as_str()) == Some("text") {
            let txt = b
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim_start();
            if txt.starts_with(COMPACT_SUMMARY_MARKER) {
                return true;
            }
        }
    }
    false
}

fn render_history(rows: &[(String, String, String)]) -> String {
    // rows = (id, role, content). Renders the transcript as `### ROLE\n
    // <text>` blocks; tool calls / results collapsed into single-line
    // surrogates so the summariser doesn't drown in raw JSON.
    let mut parts: Vec<String> = Vec::new();
    for (_id, role, content_raw) in rows {
        let blocks: Value = serde_json::from_str(content_raw).unwrap_or_else(|_| {
            // Fall back to one-text-block rendering of the raw string.
            Value::Array(vec![
                serde_json::json!({ "type": "text", "text": content_raw }),
            ])
        });
        let Some(arr) = blocks.as_array() else {
            continue;
        };
        let mut rendered: Vec<String> = Vec::new();
        for b in arr {
            let bt = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match bt {
                "text" => {
                    let txt = b.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if !txt.is_empty() {
                        rendered.push(txt.to_string());
                    }
                }
                "thinking" => {
                    let txt = b.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if !txt.is_empty() {
                        let trimmed: String = txt.chars().take(400).collect();
                        rendered.push(format!("[Thinking] {trimmed}"));
                    }
                }
                "tool_use" => {
                    let name = b
                        .get("tool_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                        .to_string();
                    rendered.push(format!("[Tool: {name}]"));
                }
                "tool_result" => {
                    let out = b.get("output").and_then(|v| v.as_str()).unwrap_or("");
                    let trimmed: String = out.chars().take(300).collect();
                    rendered.push(format!("[Result] {trimmed}"));
                }
                "image" => {
                    rendered.push("[Image attached]".to_string());
                }
                _ => {}
            }
        }
        if !rendered.is_empty() {
            let role_up = role.to_uppercase();
            parts.push(format!("### {role_up}\n{}", rendered.join("\n")));
        }
    }
    let mut text = parts.join("\n\n");
    if text.chars().count() > MAX_HISTORY_CHARS {
        // Keep head + tail — middle of long sessions is the most
        // compressible (tool churn).
        let half = MAX_HISTORY_CHARS / 2;
        let head: String = text.chars().take(half).collect();
        let total = text.chars().count();
        let tail: String = text.chars().skip(total - half).collect();
        text = format!("{head}\n\n…[transcript truncated for compaction]…\n\n{tail}");
    }
    text
}

/// Run compaction on `session_id`. Returns the new summary + the
/// number of messages that were folded in. Errors with a typed
/// `CompactionError` so the chat handler can render a clean message.
pub async fn compact_session(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<CompactionResult, CompactionError> {
    // Load the session row's prior_summary first.
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT compact_summary FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;
    let prior_summary = match row {
        Some((s,)) => s,
        None => return Err(CompactionError::NotFound(session_id.into())),
    };

    // Snapshot every message.
    let messages: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    if messages.is_empty() {
        return Err(CompactionError::NoMessages);
    }

    // Filter out previous compact-summary rows for the threshold gate;
    // they still get deleted (the new summary supersedes them).
    let new_messages: Vec<&(String, String, String)> = messages
        .iter()
        .filter(|(_, role, content)| !is_compact_summary_message(role, content))
        .collect();
    let msg_count = new_messages.len() as i64;
    let char_count: i64 = new_messages.iter().map(|(_, _, c)| c.len() as i64).sum();
    if msg_count < MIN_MESSAGE_COUNT {
        return Err(CompactionError::TooFewMessages {
            min: MIN_MESSAGE_COUNT,
            have: msg_count,
        });
    }
    if char_count < MIN_CHAR_COUNT {
        return Err(CompactionError::TooFewChars {
            min: MIN_CHAR_COUNT,
            have: char_count,
        });
    }

    // Render the new-messages transcript.
    let new_only_rows: Vec<(String, String, String)> = new_messages
        .iter()
        .map(|(a, b, c)| (a.clone(), b.clone(), c.clone()))
        .collect();
    let rendered = render_history(&new_only_rows);

    // Fold the prior summary so the new summary is cumulative.
    let transcript = match prior_summary.as_deref() {
        Some(p) if !p.trim().is_empty() => format!(
            "### PRIOR SUMMARY (preserved from an earlier /compact run — fold its facts into the new summary)\n{}\n\n### NEW CONVERSATION (since the prior summary)\n{rendered}",
            p.trim()
        ),
        _ => rendered,
    };

    let summary = match call_haiku_with_meta_cost(
        pool,
        "compactor",
        session_id,
        &transcript,
        Some(SYSTEM_PROMPT),
        Some(COMPACT_TIMEOUT),
    )
    .await
    {
        Ok(s) => s.trim().to_string(),
        Err(e) => return Err(CompactionError::Other(e.to_string())),
    };
    if summary.is_empty() {
        return Err(CompactionError::EmptySummary);
    }

    // Persist + delete in a single transaction.
    let snapshot_ids: Vec<String> = messages.iter().map(|(id, _, _)| id.clone()).collect();
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE sessions SET compact_summary = ?, compact_at = ?, compacted_message_count = COALESCE(compacted_message_count, 0) + ? WHERE id = ?",
    )
    .bind(&summary)
    .bind(&now)
    .bind(msg_count)
    .bind(session_id)
    .execute(&mut *tx)
    .await?;
    for id in &snapshot_ids {
        sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    // Insert a single new assistant message that holds the summary so
    // the renderer's chat scroll has a "Conversation summary" card.
    let row_id = uuid::Uuid::new_v4().to_string();
    let summary_block = serde_json::json!([
        {
            "type": "text",
            "text": format!("{COMPACT_SUMMARY_MARKER}\n\n{summary}"),
        }
    ]);
    sqlx::query(
        "INSERT INTO messages (id, session_id, role, content, model, usage_json, cost_usd, timestamp) \
         VALUES (?, ?, 'assistant', ?, NULL, NULL, 0.0, ?)",
    )
    .bind(&row_id)
    .bind(session_id)
    .bind(summary_block.to_string())
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CompactionResult {
        summary,
        compacted_message_count: msg_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_compact_summary_message_detects_marker_in_text_block() {
        let yes = serde_json::json!([
            { "type": "text", "text": format!("{COMPACT_SUMMARY_MARKER}\n\n## Goal\n...") }
        ])
        .to_string();
        assert!(is_compact_summary_message("assistant", &yes));

        // User-role rows are never compact summaries.
        assert!(!is_compact_summary_message("user", &yes));

        // Marker buried in the middle of text doesn't count — it must
        // be at the leading edge (matching Python's lstrip + startswith).
        let no = serde_json::json!([
            { "type": "text", "text": format!("hello {COMPACT_SUMMARY_MARKER} world") }
        ])
        .to_string();
        assert!(!is_compact_summary_message("assistant", &no));
    }

    #[test]
    fn render_history_collapses_tools_and_keeps_text() {
        let rows = vec![
            (
                "m1".into(),
                "user".into(),
                serde_json::json!([{ "type": "text", "text": "Please fix bug." }]).to_string(),
            ),
            (
                "m2".into(),
                "assistant".into(),
                serde_json::json!([
                    { "type": "thinking", "text": "let me think" },
                    { "type": "tool_use", "tool_name": "Edit" },
                    { "type": "tool_result", "output": "OK" },
                    { "type": "text", "text": "Done." }
                ])
                .to_string(),
            ),
        ];
        let h = render_history(&rows);
        assert!(h.contains("### USER\nPlease fix bug."));
        assert!(h.contains("### ASSISTANT"));
        assert!(h.contains("[Thinking] let me think"));
        assert!(h.contains("[Tool: Edit]"));
        assert!(h.contains("[Result] OK"));
        assert!(h.contains("Done."));
    }

    #[test]
    fn render_history_truncates_when_over_max() {
        // Build a synthetic row whose rendered text > MAX_HISTORY_CHARS.
        let big = "x".repeat(MAX_HISTORY_CHARS + 1000);
        let rows = vec![(
            "m".into(),
            "user".into(),
            serde_json::json!([{ "type": "text", "text": big }]).to_string(),
        )];
        let h = render_history(&rows);
        assert!(h.contains("transcript truncated for compaction"));
    }
}
