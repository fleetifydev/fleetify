//! Meta-LLM cost tracker. Faithful port of `services/meta_cost.py`.
//!
//! Every "system" Haiku call we make on the user's behalf — task
//! enrichment, auto-planning, query expansion, session summarization,
//! dump_session_memory — costs real money. Without tracking, those
//! costs hide behind the foreground agent turns. This helper logs each
//! meta call into the same `cost_events` table the agent turns use,
//! with a `model` string like `"claude-haiku-4-5/meta-enricher"`. The
//! existing per-session cost rollup queries pick those up
//! automatically, so the dashboard's cost displays include meta cost
//! honestly.
//!
//! Token counts are estimated (~4 chars/token) because most meta calls
//! don't expose usage in their stream. Estimation is conservative —
//! err on the high side so the user isn't surprised by a higher bill.

use anyhow::Result;
use sqlx::SqlitePool;

use super::pricing::calculate_cost;

pub const HAIKU_MODEL: &str = "claude-haiku-4-5";
const CHARS_PER_TOKEN: usize = 4;

fn estimate_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    (text.len() / CHARS_PER_TOKEN).max(1) as i64
}

/// Persist a meta-LLM cost event under the parent session. Best
/// effort: failures log + return Ok so a flaky cost write never breaks
/// the user-facing flow.
pub async fn track_meta_call(
    pool: &SqlitePool,
    kind: &str, // 'enricher' | 'planner' | 'expander' | 'summarizer' | 'dump'
    parent_session_id: &str,
    prompt_text: &str,
    output_text: &str,
) -> Result<()> {
    if parent_session_id.is_empty() {
        return Ok(());
    }
    let in_tokens = estimate_tokens(prompt_text);
    let out_tokens = estimate_tokens(output_text);
    let cost_usd = calculate_cost(HAIKU_MODEL, in_tokens, out_tokens, 0, 0);

    let model_label = format!("{HAIKU_MODEL}/meta-{kind}");
    let event_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let write_res = sqlx::query(
        "INSERT INTO cost_events \
         (id,session_id,model,input_tokens,output_tokens,cache_read,cache_write,cost_usd,timestamp) \
         VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(&event_id)
    .bind(parent_session_id)
    .bind(&model_label)
    .bind(in_tokens)
    .bind(out_tokens)
    .bind(0i64)
    .bind(0i64)
    .bind(cost_usd)
    .bind(&now)
    .execute(pool)
    .await;
    if let Err(e) = write_res {
        tracing::warn!(
            target: "meta_cost",
            "meta_cost.write_failed kind={kind} err={e}"
        );
    } else {
        let _ = sqlx::query(
            "UPDATE sessions SET budget_used = COALESCE(budget_used,0.0) + ? WHERE id = ?",
        )
        .bind(cost_usd)
        .bind(parent_session_id)
        .execute(pool)
        .await;
    }

    tracing::info!(
        target: "meta_llm",
        "meta_llm.call kind={kind} session={parent_session_id} in_tokens={in_tokens} out_tokens={out_tokens} est_cost_usd={cost_usd:.6}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_rounds_down_and_clamps_to_1_minimum() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1); // 1/4 = 0 → clamped to 1
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        // Long string scales linearly.
        let long = "x".repeat(400);
        assert_eq!(estimate_tokens(&long), 100);
    }
}
