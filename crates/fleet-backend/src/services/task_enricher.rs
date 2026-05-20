//! Dispatch-task enrichment. Faithful port of `services/task_enricher.py`.
//!
//! Rewrites raw @mention dispatch tasks into context-aware briefings
//! via Haiku so the receiving agent gets a clear actionable task
//! instead of a fragment.
//!
//! Best-effort: any failure path (breaker open, timeout, empty output,
//! absurd 6x-blowup) falls back to the original `raw_task` — never
//! blocks dispatch on enrichment.

use std::time::Duration;

use sqlx::SqlitePool;

use super::haiku_client::call_haiku_with_meta_cost;

const ENRICHER_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_INPUT_CHARS: usize = 200;

const SYSTEM: &str = r#"You rewrite dispatch tasks for AI coding agents.

Input: a raw task string the user wrote in a multi-agent chat, often as
a fragment after "@AgentName" (e.g. "save your memory", "fix the bug",
"araştır bunu"). The receiving agent will see ONLY your rewrite — not
the surrounding conversation.

Your job: turn the fragment into a self-contained, actionable task
that the receiving agent can execute without needing the broader
context. Add inferred specificity where the fragment is vague, but do
NOT invent facts. Preserve the user's intent and language.

Rules:
- Keep it short. 1-3 sentences max.
- Use the user's language (Turkish, English, etc.) — don't translate.
- If the fragment is already clear and self-contained, return it
  verbatim. Don't add fluff.
- If the user asked the agent to "save memory" / "remember things" /
  "hatırla" / "kayıt et", expand it to:
    "Reflect on what you've learned in this session and save the key
     decisions, learnings, and gotchas to long-term memory using the
     mcp__fleet_memory__remember tool (or dump_session_memory if available).
     Aim for 3-7 high-quality items, not bullet-point spam."
- If the fragment is a question ("what about X?"), keep it as a
  question — the agent will answer.
- Output ONLY the rewritten task. No prose preamble. No quotes around it."#;

/// Rewrite a raw dispatch task into a context-aware version. Returns
/// the original `raw_task` unchanged on any failure or when the task
/// is already long enough (>200 chars) that enrichment is unlikely
/// to add value.
pub async fn enrich_task(
    pool: &SqlitePool,
    raw_task: &str,
    agent_name: Option<&str>,
    project_path: Option<&str>,
    parent_session_id: Option<&str>,
) -> String {
    let task = raw_task.trim();
    if task.is_empty() {
        return String::new();
    }
    if task.chars().count() > MAX_INPUT_CHARS {
        return task.to_string();
    }

    let mut prompt_lines: Vec<String> = vec![format!("Raw task: {task}")];
    if let Some(name) = agent_name.filter(|s| !s.is_empty()) {
        prompt_lines.push(format!("Receiving agent name: {name}"));
    }
    if let Some(p) = project_path.filter(|s| !s.is_empty()) {
        prompt_lines.push(format!("Project: {p}"));
    }
    prompt_lines.push("Rewrite the task per the rules.".into());
    let prompt = prompt_lines.join("\n");

    let parent = parent_session_id.unwrap_or("");
    let out = match call_haiku_with_meta_cost(
        pool,
        "enricher",
        parent,
        &prompt,
        Some(SYSTEM),
        Some(ENRICHER_TIMEOUT),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => return task.to_string(),
    };

    let mut cleaned = out.trim().to_string();
    while cleaned.starts_with('"') || cleaned.starts_with('\'') {
        cleaned.remove(0);
    }
    while cleaned.ends_with('"') || cleaned.ends_with('\'') {
        cleaned.pop();
    }
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return task.to_string();
    }
    // Sanity: rewrite shouldn't balloon more than 6x — Haiku
    // occasionally echoes the prompt or hallucinates a manual.
    let task_chars = task.chars().count();
    let cleaned_chars = cleaned.chars().count();
    let cap = std::cmp::max(600, task_chars * 6);
    if cleaned_chars > cap {
        return task.to_string();
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    // Most of enrich_task's logic is the input gate + output sanitiser.
    // Live Haiku calls require the claude CLI installed + authenticated
    // — out of scope for unit tests. These cover the no-network paths.

    #[tokio::test]
    async fn empty_input_short_circuits() {
        // Pool unused on the empty branch but the signature still takes
        // one — open an in-memory connection so the type checks.
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .in_memory(true)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        let out = enrich_task(&pool, "", None, None, None).await;
        assert_eq!(out, "");
        let out = enrich_task(&pool, "   ", None, None, None).await;
        assert_eq!(out, "");
    }

    #[tokio::test]
    async fn long_input_returns_verbatim_without_haiku_call() {
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .in_memory(true)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        // A 250-char task is over MAX_INPUT_CHARS so we skip Haiku.
        let long = "x".repeat(250);
        let out = enrich_task(&pool, &long, None, None, None).await;
        assert_eq!(out, long);
    }
}
