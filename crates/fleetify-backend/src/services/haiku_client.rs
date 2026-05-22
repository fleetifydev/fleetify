//! Haiku one-shot caller. Wraps `claude --print --model
//! claude-haiku-4-5 …` for the meta-LLM orchestration helpers
//! (task_enricher, auto_planner, query_expander, session_summarizer,
//! dump_session_memory, fleet_brain).
//!
//! Uses the Claude CLI's built-in auth (OAuth `~/.claude/credentials.json`
//! or `ANTHROPIC_API_KEY` env) so no additional API-key plumbing lives
//! in the backend. The CLI must be installed (`npm install -g
//! @anthropic-ai/claude-code`); when it isn't, callers see a "claude
//! CLI not found" error and the haiku_breaker trips after a few
//! attempts (any orchestration falls back to its non-LLM path).

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;

use super::{haiku_breaker, meta_cost};

/// Default Haiku model id. Mirrors `meta_cost::HAIKU_MODEL`.
pub const DEFAULT_MODEL: &str = "claude-haiku-4-5";

/// Per-call timeout — keep agent's wallclock budget bounded; the
/// breaker handles cumulative slowness.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(25);

/// `(text, error?)`. On success returns the trimmed stdout text.
/// On failure logs + bumps the breaker + returns Err.
pub async fn call_haiku(
    prompt: &str,
    system: Option<&str>,
    timeout: Option<Duration>,
) -> Result<String> {
    if !haiku_breaker::is_haiku_available() {
        return Err(anyhow!("haiku_breaker: open (skipping meta call)"));
    }
    let bin = which::which("claude")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "claude".to_string());

    // Build the CLI args. `--print` runs one-shot, `--model` pins the
    // model id, `--system-prompt` (if provided) is sent as the system
    // message. The prompt itself is piped on stdin to avoid the 32 KB
    // ARG_MAX cliff on Windows.
    let mut args: Vec<String> = vec!["--print".into(), "--model".into(), DEFAULT_MODEL.into()];
    if let Some(s) = system {
        args.push("--system-prompt".into());
        args.push(s.to_string());
    }

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            haiku_breaker::record_haiku_failure();
            return Err(anyhow!("claude CLI spawn failed: {e}"));
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);
    }

    let wait = tokio::time::timeout(timeout.unwrap_or(DEFAULT_TIMEOUT), child.wait_with_output());
    let out = match wait.await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            haiku_breaker::record_haiku_failure();
            return Err(anyhow!("claude CLI wait failed: {e}"));
        }
        Err(_) => {
            haiku_breaker::record_haiku_failure();
            return Err(anyhow!("claude CLI timed out"));
        }
    };
    if !out.status.success() {
        haiku_breaker::record_haiku_failure();
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!(
            "claude CLI exited {} ({err})",
            out.status.code().unwrap_or(-1)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    haiku_breaker::record_haiku_success();
    Ok(text)
}

/// One-shot Haiku call + automatic meta-cost tracking. Same return
/// shape as `call_haiku`; on success also writes a `cost_events` row
/// keyed by `<HAIKU_MODEL>/meta-<kind>` so the dashboard's rollups
/// pick the spend up automatically.
pub async fn call_haiku_with_meta_cost(
    pool: &sqlx::SqlitePool,
    kind: &str,
    parent_session_id: &str,
    prompt: &str,
    system: Option<&str>,
    timeout: Option<Duration>,
) -> Result<String> {
    let text = call_haiku(prompt, system, timeout).await?;
    // Best-effort meta-cost accounting — failures inside this don't
    // propagate (caller already has the text it wanted).
    let _ = meta_cost::track_meta_call(pool, kind, parent_session_id, prompt, &text).await;
    Ok(text)
}

/// Extract a `{...}` JSON object from a CLI response that may be
/// wrapped in ```json … ``` fences or have leading/trailing chatter.
/// Returns None when no balanced object can be located. Faithful with
/// the per-call extractor block used in fleet_brain / prompt_enhancer.
pub fn extract_json_object(text: &str) -> Option<Value> {
    let mut s = text.to_string();
    if let Some(start) = s.find("```") {
        if let Some(rel_end) = s[start + 3..].find("```") {
            let mut inner = &s[start + 3..start + 3 + rel_end];
            for tag in ["json", "JSON"] {
                if let Some(stripped) = inner.strip_prefix(tag) {
                    inner = stripped.trim_start_matches(['\n', '\r', ' ']);
                    break;
                }
            }
            s = inner.trim().to_string();
        }
    }
    if let (Some(o), Some(c)) = (s.find('{'), s.rfind('}')) {
        if c > o {
            return serde_json::from_str::<Value>(&s[o..=c]).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_json_handles_fenced_object() {
        let raw = "Here you go:\n```json\n{\"x\": 1, \"y\": \"hello\"}\n```\nThanks!";
        let v = extract_json_object(raw).unwrap();
        assert_eq!(v["x"], 1);
        assert_eq!(v["y"], "hello");
    }

    #[test]
    fn extract_json_handles_bare_object_with_chatter() {
        let raw = "Sure! {\"decision\":\"continue\",\"reasoning\":\"ok\"} Done.";
        let v = extract_json_object(raw).unwrap();
        assert_eq!(v["decision"], "continue");
    }

    #[test]
    fn extract_json_returns_none_on_no_braces() {
        assert!(extract_json_object("just text").is_none());
    }

    #[test]
    fn extract_json_handles_uppercase_json_tag() {
        let raw = "```JSON\n{\"a\":1}\n```";
        let v = extract_json_object(raw).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn extract_json_value_matches_json_macro_shape() {
        let raw = r#"{"foo": [1,2,3], "bar": {"baz": true}}"#;
        let v = extract_json_object(raw).unwrap();
        assert_eq!(v, json!({ "foo": [1, 2, 3], "bar": { "baz": true } }));
    }
}
