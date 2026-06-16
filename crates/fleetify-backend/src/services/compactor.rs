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

use super::haiku_client::call_model_streaming_with_meta_cost;

/// Marker the persisted compact-summary message starts with so the
/// next /compact run skips it and the renderer can render it with a
/// distinct card. Mirrors `COMPACT_SUMMARY_MARKER` in Python.
pub const COMPACT_SUMMARY_MARKER: &str = "[fleet:compact-summary]";

pub const MIN_MESSAGE_COUNT: i64 = 6;
pub const MIN_CHAR_COUNT: i64 = 4000;
const MAX_HISTORY_CHARS: usize = 120_000;
const COMPACT_TIMEOUT: Duration = Duration::from_secs(120);

/// Model used to summarise — Opus 4.8 per the product decision (higher-
/// quality summaries; the live progress bar covers the extra latency).
const SUMMARIZER_MODEL: &str = "claude-opus-4-8";
/// Curve constant for the summarise-phase progress bar (see `summarize_pct`).
/// Smaller = the bar rises faster early. Tuned so a typical summary's streamed
/// activity (thinking + text) approaches ~90 % by the time the model finishes.
const SUMMARIZE_CURVE_K: usize = 2500;

/// Auto-compaction fires when a session's context fill reaches this fraction
/// of the model's window. 0.90 leaves headroom so the triggering turn does not
/// overflow (waiting for a literal 1.0 would already be too late).
pub const AUTO_COMPACT_THRESHOLD: f32 = 0.90;

// Modeled faithfully on Claude Code's conversation-summarization structure
// (Primary request & intent / Key technical concepts / Files & code / Errors &
// fixes / Problem solving / Pending tasks & next steps / Open questions; be
// chronological + thorough; preserve security constraints verbatim; the next
// step must be DIRECTLY in line with the user's most recent request).
const SYSTEM_PROMPT: &str = "You are summarizing a coding-agent conversation so the NEXT turn can continue seamlessly after the raw history is replaced by this summary. Analyze the transcript chronologically and be THOROUGH: capture every technical detail, decision, and piece of state needed to keep working without the original messages. Losing a relevant detail is worse than being long; there is no word limit, but cut redundancy, pleasantries, and resolved dead ends.\n\nALWAYS respond with the summary as plain text only. Never refuse, never reply empty, never ask questions, never call a tool or skill.\n\nWrite these sections (omit one only if it is genuinely empty):\n## Primary request and intent\nAll of the user's explicit requests and goals, in their own words where wording matters. Do not drift from what they actually asked for.\n## Key technical concepts\nTechnologies, frameworks, patterns, and conventions in play.\n## Files and code\nEvery file created or edited (exact paths) and the specific code under active work — include short snippets or diffs where they preserve in-flight work.\n## Errors and fixes\nProblems encountered and how each was resolved, or that it is still open. Note any user feedback and how you adjusted.\n## Problem solving\nProblems solved and any ongoing troubleshooting.\n## Pending tasks and next steps\nWhat remains, plus EXACTLY what was being worked on immediately before this summary and the immediate next action — the next step must be DIRECTLY in line with the user's most recent explicit request, introducing no new scope.\n## Open questions\nUnresolved questions or decisions still pending.\n\nRules:\n- Cite file paths, symbols, and commands verbatim.\n- Preserve any security-relevant instruction or constraint VERBATIM so it stays in effect after compaction.\n- Do not invent anything the transcript did not contain.";

#[derive(Debug, Clone)]
pub struct CompactionResult {
    pub summary: String,
    /// New (non-summary) messages folded in — added to sessions.compacted_message_count.
    pub compacted_message_count: i64,
    /// Total chars of the snapshotted (pre-compaction) transcript.
    pub pre_chars: i64,
    /// Chars of the generated summary (post-compaction transcript size).
    pub post_chars: i64,
    /// Number of message rows hard-deleted by this run (all snapshot rows).
    pub pre_message_count: i64,
    /// RFC3339 timestamp stamped on sessions.compact_at.
    pub compact_at: String,
    /// Row id of the persisted summary message.
    pub summary_message_id: String,
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

/// Total content chars + row count over a message snapshot. Pure so the
/// pre/post size numbers the UI shows are unit-testable without a DB.
fn transcript_metrics(rows: &[(String, String, String)]) -> (i64, i64) {
    let chars: i64 = rows.iter().map(|(_, _, c)| c.chars().count() as i64).sum();
    (chars, rows.len() as i64)
}

/// Map streamed activity bytes (thinking + text) onto the summarise-phase band
/// (8→92) with an asymptotic curve, so the bar advances smoothly and approaches
/// — but never reaches — 92 regardless of summary length (persist owns the
/// tail). Monotonic. Pure for unit testing.
fn summarize_pct(bytes: usize, k: usize) -> u32 {
    let k = if k == 0 { 1 } else { k };
    let frac = 1.0 - (-(bytes as f64) / k as f64).exp();
    8 + (84.0 * frac) as u32
}

/// `compaction_progress` envelope — interim % while the summariser runs.
/// Field names MUST match `WSCompactionProgress` in `src/types/chat.ts`.
pub fn compaction_progress_event(session_id: &str, pct: u32, phase: &str) -> Value {
    serde_json::json!({
        "type": "compaction_progress",
        "session_id": session_id,
        "pct": pct,
        "phase": phase,
    })
}

/// `compaction_status` envelope — emitted the instant the marker is seen,
/// BEFORE the (potentially slow) summariser runs, so the pill spins up
/// immediately. Field names MUST match `WSCompactionStatus` in
/// `src/types/chat.ts`.
pub fn compaction_status_event(session_id: &str, provider: &str, command: &str) -> Value {
    serde_json::json!({
        "type": "compaction_status",
        "state": "starting",
        "session_id": session_id,
        "provider": provider,
        "command": command,
    })
}

/// `compaction_done` success envelope. Field names MUST match
/// `WSCompactionDone` in `src/types/chat.ts`.
pub fn compaction_done_event(
    session_id: &str,
    provider: &str,
    model: Option<&str>,
    trigger: &str,
    r: &CompactionResult,
) -> Value {
    serde_json::json!({
        "type": "compaction_done",
        "session_id": session_id,
        "provider": provider,
        "pre_chars": r.pre_chars,
        "post_chars": r.post_chars,
        "pre_message_count": r.pre_message_count,
        "compact_at": r.compact_at.as_str(),
        "model": model,
        "trigger": trigger,
        "summary": r.summary.as_str(),
        "summary_message_id": r.summary_message_id.as_str(),
        "error": Value::Null,
    })
}

/// `compaction_done` failure envelope — same type, non-null `error`, all
/// size fields null. No message deletion happened; the pill flips to
/// "Compact failed" and the local hard-delete is skipped.
pub fn compaction_failed_event(session_id: &str, provider: &str, error: &str) -> Value {
    serde_json::json!({
        "type": "compaction_done",
        "session_id": session_id,
        "provider": provider,
        "pre_chars": Value::Null,
        "post_chars": Value::Null,
        "pre_message_count": Value::Null,
        "compact_at": Value::Null,
        "model": Value::Null,
        "trigger": "manual",
        "summary": Value::Null,
        "summary_message_id": Value::Null,
        "error": error,
    })
}

/// Extract the visible command ("/compact" or "/compress") from a
/// "[fleet:compaction]…" submit. Defaults to "/compact".
pub fn parse_compaction_command(text: &str) -> String {
    let rest = text.trim_start_matches("[fleet:compaction]").trim();
    if rest.is_empty() {
        "/compact".to_string()
    } else {
        rest.to_string()
    }
}

/// Run compaction on `session_id`. Returns the new summary + the
/// number of messages that were folded in. Errors with a typed
/// `CompactionError` so the chat handler can render a clean message.
pub async fn compact_session_streaming<F>(
    pool: &SqlitePool,
    session_id: &str,
    mut on_progress: F,
) -> Result<CompactionResult, CompactionError>
where
    F: FnMut(u32, &str),
{
    on_progress(0, "prepare");
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
    let (pre_chars, pre_message_count) = transcript_metrics(&messages);

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

    on_progress(8, "summarize");
    let mut last_pct = 8u32;
    let summary = match call_model_streaming_with_meta_cost(
        pool,
        "compactor",
        session_id,
        SUMMARIZER_MODEL,
        &transcript,
        Some(SYSTEM_PROMPT),
        Some(COMPACT_TIMEOUT),
        // Throttle to monotonic %: stream-json fires a delta per token, so only
        // forward when the integer % actually advances (≤ ~84 events/run).
        |bytes| {
            let p = summarize_pct(bytes, SUMMARIZE_CURVE_K);
            if p > last_pct {
                last_pct = p;
                on_progress(p, "summarize");
            }
        },
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
    on_progress(92, "persist");
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE sessions SET compact_summary = ?, compact_at = ?, compacted_message_count = COALESCE(compacted_message_count, 0) + ?, claude_session_id = NULL, compact_reseed_pending = 1 WHERE id = ?",
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
    on_progress(100, "persist");

    Ok(CompactionResult {
        post_chars: summary.chars().count() as i64,
        summary,
        compacted_message_count: msg_count,
        pre_chars,
        pre_message_count,
        compact_at: now,
        summary_message_id: row_id,
    })
}

/// Back-compat one-shot wrapper: run compaction discarding progress.
pub async fn compact_session(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<CompactionResult, CompactionError> {
    compact_session_streaming(pool, session_id, |_, _| {}).await
}

/// Current context-window fill for a session as a 0.0-1.0 fraction: the latest
/// real (non-meta) turn's prompt size (input + cache-read tokens) over the
/// model's catalog context window. None when the window is unknown or the
/// session has no usage yet. Drives the auto-compaction gate.
/// Cheap pre-flight: would compaction pass its size guards? Mirrors the
/// `MIN_MESSAGE_COUNT` / `MIN_CHAR_COUNT` gate inside
/// `compact_session_streaming` without doing the expensive summarisation.
///
/// Used to skip an AUTO-triggered compaction on a too-short conversation so the
/// user never sees a "too short to compact" error they didn't ask for (an
/// explicit `/compact` still surfaces it — they requested it). Any DB error is
/// treated as "not compactable" (fail safe: don't auto-fire).
pub async fn is_compactable(pool: &SqlitePool, session_id: &str) -> bool {
    let Ok(messages) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    else {
        return false;
    };
    let new_messages: Vec<&(String, String, String)> = messages
        .iter()
        .filter(|(_, role, content)| !is_compact_summary_message(role, content))
        .collect();
    let msg_count = new_messages.len() as i64;
    let char_count: i64 = new_messages.iter().map(|(_, _, c)| c.len() as i64).sum();
    msg_count >= MIN_MESSAGE_COUNT && char_count >= MIN_CHAR_COUNT
}

pub async fn context_fill(
    pool: &SqlitePool,
    session_id: &str,
    model_id: Option<&str>,
) -> Option<f32> {
    let window = model_id.and_then(crate::providers::catalog::context_window_tokens)? as f32;
    if window <= 0.0 {
        return None;
    }
    // Exclude meta-LLM rows (e.g. the compactor's own Opus call, keyed
    // `<model>/meta-<kind>`) so the fill reflects the real conversation turn.
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT input_tokens, cache_read FROM cost_events \
         WHERE session_id = ? AND model NOT LIKE '%meta-%' \
         ORDER BY timestamp DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .ok()?;
    let (input, cache_read) = row?;
    let used = (input.max(0) + cache_read.max(0)) as f32;
    Some((used / window).clamp(0.0, 1.0))
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

    #[test]
    fn transcript_metrics_sums_chars_and_counts_rows() {
        let rows = vec![
            ("m1".to_string(), "user".to_string(), "hello".to_string()), // 5 chars
            (
                "m2".to_string(),
                "assistant".to_string(),
                "worldd".to_string(),
            ), // 6 chars
        ];
        let (chars, count) = transcript_metrics(&rows);
        assert_eq!(chars, 11);
        assert_eq!(count, 2);
    }

    #[test]
    fn compaction_status_event_matches_frontend_contract() {
        let v = compaction_status_event("s1", "claude-code", "/compact");
        assert_eq!(v["type"], "compaction_status");
        assert_eq!(v["state"], "starting");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["provider"], "claude-code");
        assert_eq!(v["command"], "/compact");
    }

    #[test]
    fn compaction_done_event_has_all_frontend_fields() {
        let r = CompactionResult {
            summary: "S".to_string(),
            compacted_message_count: 7,
            pre_chars: 4200,
            post_chars: 1,
            pre_message_count: 8,
            compact_at: "2026-06-14T00:00:00Z".to_string(),
            summary_message_id: "row-1".to_string(),
        };
        let v = compaction_done_event("s1", "gemini-cli", Some("gemini-2.5-pro"), "manual", &r);
        assert_eq!(v["type"], "compaction_done");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["provider"], "gemini-cli");
        assert_eq!(v["pre_chars"], 4200);
        assert_eq!(v["post_chars"], 1);
        assert_eq!(v["pre_message_count"], 8);
        assert_eq!(v["compact_at"], "2026-06-14T00:00:00Z");
        assert_eq!(v["model"], "gemini-2.5-pro");
        assert_eq!(v["trigger"], "manual");
        assert_eq!(v["summary"], "S");
        assert_eq!(v["summary_message_id"], "row-1");
        assert_eq!(v["error"], Value::Null);
    }

    #[test]
    fn compaction_failed_event_carries_error_and_nulls() {
        let v = compaction_failed_event("s1", "claude-code", "boom");
        assert_eq!(v["type"], "compaction_done");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["error"], "boom");
        assert_eq!(v["summary"], Value::Null);
        assert_eq!(v["compact_at"], Value::Null);
        assert_eq!(v["pre_chars"], Value::Null);
    }

    #[test]
    fn parse_compaction_command_extracts_provider_command() {
        assert_eq!(
            parse_compaction_command("[fleet:compaction]/compact"),
            "/compact"
        );
        assert_eq!(
            parse_compaction_command("[fleet:compaction]/compress"),
            "/compress"
        );
        assert_eq!(parse_compaction_command("[fleet:compaction]"), "/compact");
    }

    #[test]
    fn summarize_pct_is_monotonic_and_clamped() {
        // Starts at 8, climbs, asymptotically approaches but never exceeds 92.
        assert_eq!(summarize_pct(0, 2500), 8);
        assert!(summarize_pct(2500, 2500) > 40 && summarize_pct(2500, 2500) < 92);
        assert!(summarize_pct(50_000, 2500) >= 90 && summarize_pct(50_000, 2500) <= 92);
        // Monotonic: more activity -> higher (until it saturates near 92).
        assert!(summarize_pct(5000, 2500) > summarize_pct(2500, 2500));
        // k = 0 is guarded (no divide-by-zero / NaN).
        assert_eq!(summarize_pct(100, 0), summarize_pct(100, 1));
    }

    #[test]
    fn compaction_progress_event_matches_frontend_contract() {
        let v = compaction_progress_event("s1", 42, "summarize");
        assert_eq!(v["type"], "compaction_progress");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["pct"], 42);
        assert_eq!(v["phase"], "summarize");
    }
}
