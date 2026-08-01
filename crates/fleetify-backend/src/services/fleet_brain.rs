//! Fleet brain — Haiku-driven continue/ask/done classification.
//! Faithful port of `services/fleet_brain.py`.
//!
//! Reads the latest agent reply (plus the user's prior prompt) and
//! classifies what should happen next:
//!   - `continue`: an obvious next step exists; emit `next_prompt`.
//!   - `ask`:      agent left a fork or claimed-but-unverified work;
//!     emit `question` to surface to the user.
//!   - `done`:     concrete evidence the task finished (tests pass /
//!     commit / definitive answer); emit `summary` + the
//!     optional structured `sections` block.
//!
//! Degraded path: on parse failure / Haiku breaker open / timeout the
//! caller gets `decision=ask, degraded=true` so the frontend filters
//! the card out instead of showing a fake "Fleet couldn't analyze".

use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

use super::haiku_client::{call_haiku_with_meta_cost, extract_json_object};

// Cold-start headroom. An isolated `claude --print` one-shot floors at
// ~6 s from a neutral cwd (CLI boot + auth + model handshake); analyze
// adds the 60-line classifier system prompt and generates a JSON object
// with reasoning, measuring ~10–12 s in practice (more under load). The
// old 8 s budget timed out every call and tripped the breaker. 25 s
// matches the proven meta-call budget (`DEFAULT_TIMEOUT`) and absorbs
// load variance — these run in the background after the agent's reply, so
// a higher ceiling only delays giving up on a genuine hang (which then
// fails soft to "degraded → no card").
const ANALYZE_TIMEOUT: Duration = Duration::from_secs(25);
const CHAT_TIMEOUT: Duration = Duration::from_secs(25);

const MAX_AGENT_TEXT: usize = 8000;
const MAX_PRIOR_PROMPT: usize = 600;

/// Optional structured report body. Populated on `done` when the
/// model returns it. Frontend renders these as compact bullet groups.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzeSections {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub what_done: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decisions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncertain: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeResult {
    pub decision: String, // "continue" | "ask" | "done"
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<AnalyzeSections>,
    #[serde(default)]
    pub degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResult {
    pub text: String,
    pub cost_estimate_usd: f64,
}

pub fn safe_default(reason: &str) -> AnalyzeResult {
    AnalyzeResult {
        decision: "ask".into(),
        reasoning: format!("Fleet brain unavailable ({reason}) — silent skip."),
        next_prompt: None,
        question: Some("Fleet couldn't analyze. Continue the conversation manually.".into()),
        summary: None,
        sections: None,
        degraded: true,
    }
}

const ANALYZE_SYSTEM: &str = r#"You are Fleet, an AI co-pilot watching a developer's coding agent.
You SYNTHESIZE the agent's reply for the user and classify what
should happen next. Be skeptical — agents routinely write "Task
completed successfully" when they have only OUTLINED a plan, and
your job is to catch that.

Three decisions, with HARD evidence requirements:

  continue  An obvious next concrete step exists and the agent
            already executed something. e.g. it edited a file —
            next is "run tests". It ran tests — next is "commit".
            Do NOT pick continue when the agent is still planning;
            that's "ask" so the user can confirm the plan first.

  ask       Use whenever the agent:
              • produced a PLAN, OUTLINE, or "I'll do X" intent
                without actually doing it
              • hit a fork (multiple ways forward, no clear winner)
              • made a non-obvious choice (deleted code, renamed
                API, added a dependency)
              • returned an analysis / audit / explanation without
                any code-changing action — the user has to say
                "yes, now go do it"
            The "question" field MUST be a SPECIFIC question
            grounded in the agent's reply, not generic boilerplate.

  done      ONLY when the agent's reply contains CONCRETE EVIDENCE
            the task is finished. At least one of:
              • test output showing passes (e.g. "23 passed, 0 failed")
              • a git commit, PR, or deploy mentioned by sha/url
              • concrete file edits + a verifier ran (lint/build/tests)
              • a definitive answer to a question the user asked
                ("the function lives in X.py at line Y") when the
                user's prompt was a question, not an action
            Words like "Task completed successfully" / "I've
            finished" / "All done" WITHOUT one of the bullets above
            do NOT count — that's "ask", because the user should
            verify or the agent is bullshitting.

Output rules:
- Reply with a single JSON object only. No prose, no fences.
- Required keys: decision (string), reasoning (string).
- decision is exactly one of: continue, ask, done.
- reasoning is one short sentence (< 100 chars) — your honest take.
- If decision == "continue": include next_prompt — the exact next
  message you would send to the agent. Keep it 1-2 short sentences.
- If decision == "ask": include question — the single question to
  ask the user, GROUNDED in the agent's reply.
- If decision == "done": include summary — one short sentence
  capturing what concretely got done. ALSO optionally include
  "sections", a structured report:
    sections.what_done   — bullet list of concrete changes/actions
    sections.decisions   — non-obvious calls Fleet/agent made
    sections.uncertain   — open items, warnings, things to verify
    sections.options     — short bullet list of what user could do next
  Each list MUST contain 1-4 short bullets (under 100 chars each).
  Omit any section that doesn't apply (don't pad with filler).
- Be CONSERVATIVE about "continue": only when the next step is
  genuinely obvious. When in doubt, "ask".
- Never invent details. Read the agent's text and the user's prior
  prompt and reason from those."#;

const CHAT_SYSTEM: &str = r#"You are Fleet, an AI co-pilot watching a developer's multi-session
agent workflow. The user is asking you a question about their fleet.
You have a snapshot of every session: title, status, last activity,
cost. Answer factually, concisely (2-3 short sentences max), and
honestly. If the fleet snapshot doesn't contain the answer, say so
directly — don't guess.

Rules:
- Plain prose. No JSON. No markdown headers or fences.
- Keep it scannable: short sentences, no padding.
- If the user asks for an action (start / stop / dispatch), reply
  with the natural-language outcome and a one-line "what I'd do
  next" — DON'T pretend to have executed it. Fleet executes via
  separate tools, not via this chat endpoint.
- Don't invent session names that aren't in the fleet snapshot."#;

fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn tail_chars(s: &str, max: usize) -> String {
    // Take the last `max` chars (used to keep the END of long agent
    // replies — the most recent context is usually the most useful).
    let count = s.chars().count();
    if count <= max {
        s.to_string()
    } else {
        s.chars().skip(count - max).collect()
    }
}

fn build_user_block(prior_prompt: &str, agent_text: &str, project_context: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = project_context.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("Project: {}", cap_chars(p.trim(), 200)));
    }
    parts.push(format!(
        "User asked:\n{}",
        cap_chars(prior_prompt.trim(), MAX_PRIOR_PROMPT)
    ));
    parts.push(format!(
        "Agent responded:\n{}",
        tail_chars(agent_text.trim(), MAX_AGENT_TEXT)
    ));
    parts.join("\n\n")
}

/// Parse the model's JSON reply into a typed AnalyzeResult. Returns
/// None on missing/invalid `decision` or non-JSON output.
pub fn parse_analyze(raw: &str) -> Option<AnalyzeResult> {
    let obj = extract_json_object(raw)?;
    let decision = obj
        .get("decision")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(decision.as_str(), "continue" | "ask" | "done") {
        return None;
    }
    let reasoning = obj
        .get("reasoning")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let reasoning = if reasoning.is_empty() {
        "—".to_string()
    } else {
        reasoning
    };

    let str_or_none = |k: &str| -> Option<String> {
        obj.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };

    let sections = if decision == "done" {
        obj.get("sections")
            .filter(|&v| v.is_object())
            .and_then(|raw_sections| {
                let bullets = |key: &str| -> Option<Vec<String>> {
                    let arr = raw_sections.get(key)?.as_array()?;
                    let cleaned: Vec<String> = arr
                        .iter()
                        .filter_map(|x| match x {
                            Value::String(s) => Some(s.clone()),
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        })
                        .map(|s| cap_chars(s.trim(), 200))
                        .filter(|s| !s.is_empty())
                        .take(4)
                        .collect();
                    if cleaned.is_empty() {
                        None
                    } else {
                        Some(cleaned)
                    }
                };
                let wd = bullets("what_done");
                let de = bullets("decisions");
                let un = bullets("uncertain");
                let op = bullets("options");
                if wd.is_some() || de.is_some() || un.is_some() || op.is_some() {
                    Some(AnalyzeSections {
                        what_done: wd,
                        decisions: de,
                        uncertain: un,
                        options: op,
                    })
                } else {
                    None
                }
            })
    } else {
        None
    };

    Some(AnalyzeResult {
        decision: decision.clone(),
        reasoning,
        next_prompt: if decision == "continue" {
            str_or_none("next_prompt")
        } else {
            None
        },
        question: if decision == "ask" {
            str_or_none("question")
        } else {
            None
        },
        summary: if decision == "done" {
            str_or_none("summary")
        } else {
            None
        },
        sections,
        degraded: false,
    })
}

/// Run an analyze pass. Returns a degraded `ask` result on any
/// failure (Haiku unavailable / timeout / JSON parse). Callers
/// surface `degraded=true` rows as a silent skip in the frontend.
pub async fn analyze(
    pool: &SqlitePool,
    session_id: &str,
    prior_prompt: &str,
    agent_text: &str,
    project_context: Option<&str>,
) -> Result<AnalyzeResult> {
    let user_block = build_user_block(prior_prompt, agent_text, project_context);
    let raw = match call_haiku_with_meta_cost(
        pool,
        "brain",
        session_id,
        &user_block,
        Some(ANALYZE_SYSTEM),
        Some(ANALYZE_TIMEOUT),
    )
    .await
    {
        Ok(s) => s,
        Err(e) => return Ok(safe_default(&e.to_string())),
    };
    Ok(parse_analyze(&raw).unwrap_or_else(|| safe_default("parse")))
}

/// Free-form fleet-status chat reply. Used by `/api/fleet/chat`.
pub async fn chat(
    pool: &SqlitePool,
    session_id: &str,
    user_prompt: &str,
    fleet_snapshot: &str,
) -> Result<ChatResult> {
    // Compose: snapshot + user prompt. Cap snapshot at 4 KB.
    let snapshot = cap_chars(fleet_snapshot.trim(), 4000);
    let prompt = cap_chars(user_prompt.trim(), MAX_PRIOR_PROMPT);
    let user_block = format!("Fleet snapshot:\n{snapshot}\n\nUser asks:\n{prompt}");
    let raw = call_haiku_with_meta_cost(
        pool,
        "brain-chat",
        session_id,
        &user_block,
        Some(CHAT_SYSTEM),
        Some(CHAT_TIMEOUT),
    )
    .await?;
    Ok(ChatResult {
        text: raw.trim().to_string(),
        cost_estimate_usd: 0.0008,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_continue_decision_with_next_prompt() {
        let raw = json!({
            "decision": "continue",
            "reasoning": "Agent edited auth.py, tests not run yet",
            "next_prompt": "Run the test suite and report the result."
        })
        .to_string();
        let r = parse_analyze(&raw).unwrap();
        assert_eq!(r.decision, "continue");
        assert_eq!(
            r.next_prompt.as_deref(),
            Some("Run the test suite and report the result.")
        );
        assert!(r.question.is_none());
        assert!(r.summary.is_none());
        assert!(!r.degraded);
    }

    #[test]
    fn parse_ask_decision_with_question() {
        let raw = json!({
            "decision": "ask",
            "reasoning": "Only an outline — no files edited",
            "question": "Run step 1 now?"
        })
        .to_string();
        let r = parse_analyze(&raw).unwrap();
        assert_eq!(r.decision, "ask");
        assert_eq!(r.question.as_deref(), Some("Run step 1 now?"));
        assert!(r.next_prompt.is_none());
    }

    #[test]
    fn parse_done_with_sections_caps_each_bullet_list_at_4() {
        let raw = json!({
            "decision": "done",
            "reasoning": "All tests pass",
            "summary": "Fixed null-pointer.",
            "sections": {
                "what_done": ["a", "b", "c", "d", "e", "f"],
                "decisions": [42, "decided-x"],
                "uncertain": [],
                "options": ["next"]
            }
        })
        .to_string();
        let r = parse_analyze(&raw).unwrap();
        assert_eq!(r.decision, "done");
        let s = r.sections.unwrap();
        assert_eq!(s.what_done.unwrap().len(), 4); // capped
        let de = s.decisions.unwrap();
        assert_eq!(de.len(), 2);
        // Numeric value coerced via to_string().
        assert!(de.iter().any(|x| x == "42"));
        // Empty list dropped → None.
        assert!(s.uncertain.is_none());
        assert_eq!(s.options.unwrap(), vec!["next".to_string()]);
    }

    #[test]
    fn parse_rejects_unknown_decision() {
        let raw = json!({ "decision": "wtf", "reasoning": "?" }).to_string();
        assert!(parse_analyze(&raw).is_none());
    }

    #[test]
    fn parse_handles_fenced_json() {
        let raw = "```json\n{\"decision\":\"continue\",\"reasoning\":\"ok\"}\n```";
        let r = parse_analyze(raw).unwrap();
        assert_eq!(r.decision, "continue");
    }

    #[test]
    fn build_user_block_caps_long_strings() {
        let long_prompt = "x".repeat(2000);
        let long_agent = "y".repeat(20_000);
        let block = build_user_block(&long_prompt, &long_agent, Some("/path"));
        // Prompt capped at front, agent text capped from the END.
        let lines: Vec<&str> = block.split("\n\n").collect();
        assert_eq!(lines[0], "Project: /path");
        let prompt_line = lines[1].split_once('\n').unwrap().1;
        assert_eq!(prompt_line.chars().count(), MAX_PRIOR_PROMPT);
        let agent_line = lines[2].split_once('\n').unwrap().1;
        assert_eq!(agent_line.chars().count(), MAX_AGENT_TEXT);
    }

    #[test]
    fn safe_default_marks_degraded_with_reason() {
        let r = safe_default("haiku_breaker_open");
        assert_eq!(r.decision, "ask");
        assert!(r.degraded);
        assert!(r.reasoning.contains("haiku_breaker_open"));
    }
}
