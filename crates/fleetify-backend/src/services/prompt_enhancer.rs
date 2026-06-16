//! Prompt enhancer — rewrites a user's draft prompt into a sharper
//! one. Faithful subset of `services/prompt_enhancer.py`.
//!
//! Phase-3 cut always routes through Haiku via haiku_client; the
//! Python's per-provider routing (OpenAI/Gemini for codex/openai
//! sessions) lands when a Rust OpenAI / Gemini one-shot client exists.
//! Cost target stays well under $0.001 per call regardless of
//! provider — Haiku one-shot is ~$0.0005.

use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::haiku_client::call_haiku_with_meta_cost;

// Cold-start headroom — an isolated `claude --print` one-shot floors at
// ~6 s from a neutral cwd (CLI boot + auth + model handshake), so the old
// 6 s budget timed out on the first refine of a session and tripped the
// breaker. 20 s clears a cold start with generous margin; refine still
// fails soft (sends the original draft) if it somehow runs slower, so the
// user is never blocked.
const ENHANCE_TIMEOUT: Duration = Duration::from_secs(20);
const NOOP_SENTINEL: &str = "__NOOP__";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhanceResult {
    pub enhanced: String,
    #[serde(default)]
    pub no_op: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

const SYSTEM: &str = r#"You rewrite developer prompts to be clearer and more actionable. The prompt will be fed to a coding agent (Claude / Codex / Gemini) that edits a real codebase, runs commands, and writes code.

Rules:
- Reply with the rewritten prompt ONLY. No prefatory text, no markdown fences, no quotes, no "Here is the rewritten prompt:".
- Preserve the user's intent exactly — do NOT add new requirements.
- Make verbs specific (e.g. "fix this" → "fix the null-pointer in authenticate()").
- Add missing context that's IMPLIED by the original (e.g. file paths, function names, error messages the user clearly meant).
- Keep it CONCISE. A 3-line prompt should stay 3-5 lines, not balloon into a 20-line spec. Coding agents follow short clear prompts better than long ones.
- DO NOT pad with filler ("please", "if possible", "I would like").
- If the prompt is already specific, actionable, and unambiguous, reply with the EXACT string `__NOOP__` (8 chars) and nothing else.
- Never invent details the user did not provide. If the prompt is vague, sharpen the LANGUAGE — do not fabricate technical specifics.

Examples:

USER: fix the bug
ASSISTANT: Fix the bug — please specify which file or function fails, and what the symptom is.

USER: add a button
ASSISTANT: Add a button — please specify where (which component / page) and what it should do.

USER: refactor the auth module to use bcrypt
ASSISTANT: __NOOP__

USER: rewrite this auth module its hard to read
ASSISTANT: Refactor the auth module for readability: extract helper functions, add type hints, and split files larger than 200 lines."#;

/// Enhance the user's draft prompt. Returns the rewritten text, or
/// `no_op = true` when the model decided the prompt was already
/// sharp enough. On any Haiku failure path returns the original text
/// and `no_op = true` so the renderer's wand button silently degrades
/// rather than showing an error.
pub async fn enhance(
    pool: &SqlitePool,
    session_id: &str,
    user_text: &str,
) -> Result<EnhanceResult> {
    let trimmed = user_text.trim();
    if trimmed.is_empty() {
        return Ok(EnhanceResult {
            enhanced: String::new(),
            no_op: true,
            rationale: None,
        });
    }
    let user_block = format!("USER: {trimmed}\nASSISTANT:");
    let raw = match call_haiku_with_meta_cost(
        pool,
        "enhancer",
        session_id,
        &user_block,
        Some(SYSTEM),
        Some(ENHANCE_TIMEOUT),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => {
            // Degraded — return the original verbatim with no_op so the
            // wand button silently no-ops rather than showing an error.
            return Ok(EnhanceResult {
                enhanced: trimmed.to_string(),
                no_op: true,
                rationale: None,
            });
        }
    };

    // Strip wrapping quotes / fences the model may still produce.
    let mut s = raw.trim().to_string();
    if let Some(stripped) = s.strip_prefix("```") {
        s = stripped.to_string();
        if let Some(line_end) = s.find('\n') {
            // First line might be `json` or empty — drop it.
            if s[..line_end].chars().all(|c| c.is_ascii_alphabetic()) {
                s = s[line_end + 1..].to_string();
            }
        }
        if let Some(stripped) = s.strip_suffix("```") {
            s = stripped.trim_end_matches('\n').to_string();
        }
    }
    while s.starts_with('"') || s.starts_with('\'') || s.starts_with('`') {
        s.remove(0);
    }
    while s.ends_with('"') || s.ends_with('\'') || s.ends_with('`') {
        s.pop();
    }

    if s.trim() == NOOP_SENTINEL {
        return Ok(EnhanceResult {
            enhanced: trimmed.to_string(),
            no_op: true,
            rationale: Some("Prompt was already specific enough.".into()),
        });
    }
    let enhanced = s.trim().to_string();
    let no_op = enhanced.is_empty() || enhanced == trimmed;
    Ok(EnhanceResult {
        enhanced: if no_op { trimmed.to_string() } else { enhanced },
        no_op,
        rationale: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enhance_result_serialises_default_no_op_false_field() {
        let r = EnhanceResult {
            enhanced: "x".into(),
            no_op: false,
            rationale: None,
        };
        let v = serde_json::to_value(r).unwrap();
        assert_eq!(v["enhanced"], "x");
        // no_op present even when false (default(false) → still serialised).
        assert_eq!(v["no_op"], false);
        // rationale skipped via skip_serializing_if.
        assert!(v.get("rationale").is_none());
    }

    #[test]
    fn enhance_round_trip_via_json() {
        // Confirm the wire shape matches the renderer's expectation:
        // { enhanced, no_op, rationale? }
        let r = EnhanceResult {
            enhanced: "rewritten".into(),
            no_op: false,
            rationale: Some("added context".into()),
        };
        let s = serde_json::to_string(&r).unwrap();
        let back: EnhanceResult = serde_json::from_str(&s).unwrap();
        assert_eq!(back.enhanced, "rewritten");
        assert!(!back.no_op);
        assert_eq!(back.rationale.as_deref(), Some("added context"));
    }
}
