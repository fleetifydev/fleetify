//! End-of-session auto-summariser. Faithful port of
//! `services/session_summarizer.py`.
//!
//! When a session goes idle after producing meaningful work, schedule
//! a background distillation pass: Haiku reads the transcript and
//! extracts key decisions / learnings / gotchas as memory items the
//! next agent on this project will inherit.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;
use sqlx::SqlitePool;

use super::haiku_client::{call_haiku_with_meta_cost, extract_json_object};

const DISTILL_TIMEOUT: Duration = Duration::from_secs(30);
const COOLDOWN: Duration = Duration::from_secs(600);
const MIN_TURNS_TO_DISTILL: i64 = 6;
const MIN_TOOL_EVENTS: i64 = 4;
const TURN_CAP: usize = 800;
const TOTAL_CAP: usize = 14_000;

/// Memory kinds — must match the renderer's filter chips.
const MEMORY_KINDS: &[&str] = &["decision", "learning", "gotcha", "plan", "note"];

const DISTILL_SYSTEM: &str = r#"You distill an AI agent's working session into 0-5 long-term memory items.
Future agents on the same project will inherit these — only save items
they would actually benefit from.

Output STRICT JSON, no prose, no markdown fences:
{"items": [{"title": "...", "content": "...", "kind": "decision|learning|gotcha|plan|note"}, ...]}

Rules:
- Be ruthless. Most sessions deserve 0-3 items, not 5. Empty array is
  fine if the session had no notable findings.
- Skip restatements of the user's prompt or obvious project facts.
- Each title is one short sentence (<= 12 words). Each content is 1-3
  sentences with the actionable detail.
- Prefer kind="decision" for architectural choices, "gotcha" for
  non-obvious bugs/blockers, "learning" for discovered facts, "plan"
  for strategic plans (rare), "note" only as last resort.
- Use the language of the session."#;

/// Per-session distillation timestamps (process-wide).
fn last_distill() -> &'static Mutex<HashMap<String, Instant>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Schedule a distillation. Best-effort: returns the number of memory
/// items saved (0 when the session doesn't qualify / Haiku unavailable
/// / parse fails). Cooldown + qualification + cost attribution all
/// fire inside this single call so the caller just passes session_id
/// + project_path and forgets.
pub async fn maybe_distill_session(
    pool: &SqlitePool,
    session_id: &str,
    project_path: Option<&str>,
) -> Result<u32> {
    let now = Instant::now();
    {
        let g = last_distill().lock().unwrap();
        if let Some(prev) = g.get(session_id) {
            if now.duration_since(*prev) < COOLDOWN {
                return Ok(0);
            }
        }
    }

    // Qualification: enough turns + enough tool events + not already
    // distilled (≥5 agent-created memory items).
    let (msg_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;
    if msg_count < MIN_TURNS_TO_DISTILL {
        return Ok(0);
    }
    let (act_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM session_activity WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;
    if act_count < MIN_TOOL_EVENTS {
        return Ok(0);
    }
    let (existing,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM session_memory WHERE session_id = ? AND created_by = 'agent'",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;
    if existing >= 5 {
        return Ok(0);
    }

    // Build a compact transcript: role + concatenated text blocks per
    // message, ordered by timestamp.
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let mut parts: Vec<String> = Vec::new();
    let mut running: usize = 0;
    for (role, content_raw) in rows {
        let Ok(blocks) = serde_json::from_str::<Value>(&content_raw) else {
            continue;
        };
        let Some(arr) = blocks.as_array() else {
            continue;
        };
        let mut text_parts: Vec<String> = Vec::new();
        for blk in arr {
            if blk.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = blk.get("text").and_then(|v| v.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        text_parts.push(t.to_string());
                    }
                }
            }
        }
        if text_parts.is_empty() {
            continue;
        }
        let joined: String = text_parts.join(" ");
        let capped: String = joined.chars().take(TURN_CAP).collect();
        let part = format!("{role}: {capped}");
        running += part.len();
        parts.push(part);
        if running > TOTAL_CAP {
            while running > TOTAL_CAP && parts.len() > 1 {
                let removed = parts.remove(0);
                running = running.saturating_sub(removed.len());
            }
            break;
        }
    }
    if parts.is_empty() {
        return Ok(0);
    }

    // Mark cooldown BEFORE the LLM call so a slow concurrent trigger
    // doesn't double-fire on the same content.
    last_distill().lock().unwrap().insert(session_id.to_string(), now);

    let user_prompt = format!(
        "Distill the following session transcript into long-term memory items. Return the JSON object:\n\n{}",
        parts.join("\n---\n")
    );

    let raw = match call_haiku_with_meta_cost(
        pool,
        "summarizer",
        session_id,
        &user_prompt,
        Some(DISTILL_SYSTEM),
        Some(DISTILL_TIMEOUT),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => return Ok(0),
    };

    // Tolerant JSON parse via the shared extractor.
    let Some(parsed) = extract_json_object(&raw) else {
        return Ok(0);
    };
    let Some(items_raw) = parsed.get("items").and_then(|v| v.as_array()) else {
        return Ok(0);
    };

    let mut saved: u32 = 0;
    for it in items_raw.iter().take(5) {
        let Some(obj) = it.as_object() else { continue };
        let title = obj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let content = obj
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let mut kind = obj
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("note")
            .trim()
            .to_ascii_lowercase();
        if title.is_empty() || content.is_empty() {
            continue;
        }
        if !MEMORY_KINDS.iter().any(|k| *k == kind.as_str()) {
            kind = "note".into();
        }
        let title_cap: String = title.chars().take(300).collect();
        let content_cap: String = content.chars().take(4000).collect();
        let row_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        let res = sqlx::query(
            "INSERT INTO session_memory \
             (id, session_id, project_path, title, content, kind, created_at, created_by) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 'agent')",
        )
        .bind(row_id)
        .bind(session_id)
        .bind(project_path)
        .bind(&title_cap)
        .bind(&content_cap)
        .bind(&kind)
        .bind(&created_at)
        .execute(pool)
        .await;
        if res.is_ok() {
            saved += 1;
        }
    }

    tracing::info!(target: "session_summarizer",
        session_id=%session_id, saved=%saved, "session_summarizer.done");
    Ok(saved)
}

/// Fire-and-forget background trigger. Safe to call frequently — the
/// cooldown + qualification gate inside `maybe_distill_session` keeps
/// it from running too often.
pub fn schedule_distill(pool: SqlitePool, session_id: String, project_path: Option<String>) {
    tokio::spawn(async move {
        let _ = maybe_distill_session(&pool, &session_id, project_path.as_deref()).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cooldown + qualification gates are pure logic and the
    // Haiku-driven path needs a live CLI; tests cover the cooldown
    // gate via process-local state only.

    #[tokio::test]
    async fn cooldown_blocks_immediate_redistill() {
        // Build a real in-memory DB so the qualification queries are
        // legal SQL. Schema is intentionally minimal — we only need
        // the three tables the qualification step reads.
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .in_memory(true)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT, timestamp TEXT);
             CREATE TABLE session_activity (id TEXT, session_id TEXT, kind TEXT, ts TEXT);
             CREATE TABLE session_memory (id TEXT, session_id TEXT, project_path TEXT, title TEXT, content TEXT, kind TEXT, created_at TEXT, created_by TEXT);",
        )
        .execute(&pool)
        .await
        .unwrap();

        let sid = "test-session-cooldown";
        // Prime the cooldown timestamp directly so the gate fires.
        last_distill().lock().unwrap().insert(sid.into(), Instant::now());
        let saved = maybe_distill_session(&pool, sid, None).await.unwrap();
        assert_eq!(saved, 0);
    }

    #[test]
    fn memory_kinds_constant_matches_python() {
        let expected = ["decision", "learning", "gotcha", "plan", "note"];
        assert_eq!(MEMORY_KINDS, &expected);
    }
}
