//! Automatic personal-fact extraction from the Fleet (staff) conversation.
//! After a staff turn goes idle, a cheap Haiku pass reads the recent
//! transcript and saves 0-5 durable facts ABOUT THE USER to `user_memory`
//! (source = "auto"). Mirrors `session_summarizer` but user-scoped and gated
//! to the staff session — so Fleet keeps learning who you are as you talk.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;
use sqlx::SqlitePool;

use super::haiku_client::{call_haiku_with_meta_cost, extract_json_object};

const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);
const COOLDOWN: Duration = Duration::from_secs(300);
const MIN_MESSAGES: i64 = 4;
const TURN_CAP: usize = 800;
const TOTAL_CAP: usize = 14_000;

const EXTRACT_SYSTEM: &str = r#"You extract durable facts ABOUT THE USER from their conversation with Fleet
(their personal assistant). These persist so Fleet knows the user next time.

Output STRICT JSON, no prose, no markdown fences:
{"items": [{"kind": "...", "title": "...", "content": "...", "importance": 1-5}, ...]}

Rules:
- Save ONLY durable, personal facts: preferences, tech stack, goals, working
  style, interests, life context, ongoing threads. NOT ephemeral task chatter,
  not one-off questions, not project code details.
- Be ruthless. Most turns deserve 0-2 items, often 0. Empty array is fine.
- kind ∈ preference, stack, goal, working_style, interest, life_context,
  thread, fact.
- title: one short phrase (<= 10 words). content: one sentence with the detail.
- importance: 1-5 (5 = core identity/strong preference, 3 = typical, 1 = minor).
- Write from Fleet's perspective about the user (e.g. "Prefers Rust over Go").
- Use the language of the conversation."#;

/// Per-user extraction timestamps (process-wide).
fn last_extract() -> &'static Mutex<HashMap<String, Instant>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read the staff transcript + extract durable personal facts. Best-effort:
/// returns the number of memories saved (0 when it doesn't qualify / Haiku
/// unavailable / parse fails). Cooldown + qualification + dedupe all happen
/// inside this one call.
pub async fn maybe_extract_user_facts(
    pool: &SqlitePool,
    user_id: &str,
    session_id: &str,
) -> Result<u32> {
    let now = Instant::now();
    {
        let g = last_extract().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = g.get(user_id) {
            if now.duration_since(*prev) < COOLDOWN {
                return Ok(0);
            }
        }
    }

    let (msg_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE session_id = ?")
        .bind(session_id)
        .fetch_one(pool)
        .await?;
    if msg_count < MIN_MESSAGES {
        return Ok(0);
    }

    // Compact transcript: role + concatenated text blocks, oldest first.
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
        let capped: String = text_parts.join(" ").chars().take(TURN_CAP).collect();
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

    // Mark cooldown BEFORE the LLM call so a concurrent trigger doesn't double-fire.
    last_extract()
        .lock()
        .unwrap()
        .insert(user_id.to_string(), now);

    let user_prompt = format!(
        "Extract durable personal facts about the user from this conversation. Return the JSON object:\n\n{}",
        parts.join("\n---\n")
    );

    let raw = match call_haiku_with_meta_cost(
        pool,
        "user-extract",
        session_id,
        &user_prompt,
        Some(EXTRACT_SYSTEM),
        Some(EXTRACT_TIMEOUT),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => return Ok(0),
    };

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
            .trim();
        let content = obj
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("fact");
        let importance = obj.get("importance").and_then(|v| v.as_i64()).unwrap_or(3);
        if title.is_empty() || content.is_empty() {
            continue;
        }
        // Dedupe against an existing memory with the same title.
        if let Ok(dupes) = super::user_memory::find_similar(pool, user_id, title).await {
            if !dupes.is_empty() {
                continue;
            }
        }
        if super::user_memory::create(pool, user_id, kind, title, content, importance, "auto")
            .await
            .is_ok()
        {
            saved += 1;
        }
    }

    tracing::info!(target: "user_extractor", user_id=%user_id, saved=%saved, "user_extractor.done");
    Ok(saved)
}

/// Fire-and-forget background trigger for the staff session. Safe to call after
/// every staff turn — the cooldown + qualification gate keep it bounded.
pub fn schedule_user_extract(pool: SqlitePool, user_id: String, session_id: String) {
    tokio::spawn(async move {
        let _ = maybe_extract_user_facts(&pool, &user_id, &session_id).await;
    });
}
