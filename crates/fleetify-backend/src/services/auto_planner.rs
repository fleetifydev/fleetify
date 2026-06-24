//! Auto-mode planner — routes a user prompt to specific fleet agents
//! via a single Haiku call. Faithful port of services/auto_planner.py.
//!
//! Returns a structured `AutoPlanResult` { dispatches[], summary }.
//! Frontend turns the JSON into `[[DIRECT_DISPATCH:]]` tokens that
//! flow through the deterministic dispatch path the rest of the
//! system already uses.

use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;

use super::haiku_client::{call_haiku_with_meta_cost, extract_json_object};

// The planner shells to `claude --print` (Haiku). A cold one-shot call on
// Windows with the planner system prompt + fleet context measured ~9.3s — over
// the original 8s budget, so every plan timed out and degraded to an empty
// routing. 30s gives comfortable headroom for cold-start + larger fleets while
// still bounding a genuinely hung call. (The renderer shows a "planning…"
// state, so a few seconds of latency reads as work, not a hang.)
const PLANNER_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_DISPATCHES: usize = 6;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FleetAgent {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanDispatch {
    pub target_id: String,
    pub task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoPlanResult {
    pub dispatches: Vec<PlanDispatch>,
    pub summary: String,
}

#[derive(Debug, Clone, Default)]
pub struct RoutedTask {
    pub target_id: String,
    pub task: String,
}

fn build_planner_prompt(
    user_prompt: &str,
    fleet: &[FleetAgent],
    already_routed: &[RoutedTask],
) -> String {
    let agent_block = if fleet.is_empty() {
        "(no agents available)".to_string()
    } else {
        let mut lines: Vec<String> = Vec::new();
        for a in fleet {
            let mut row = format!("- {} | {}", a.id, a.name);
            let mut extras: Vec<String> = Vec::new();
            if let Some(p) = &a.project {
                extras.push(format!("project: {p}"));
            }
            if let Some(s) = &a.status {
                extras.push(format!("status: {s}"));
            }
            if let Some(d) = &a.description {
                let trimmed: String = d.chars().take(80).collect();
                extras.push(format!("about: {trimmed}"));
            }
            if !extras.is_empty() {
                row.push_str(" (");
                row.push_str(&extras.join(" · "));
                row.push(')');
            }
            lines.push(row);
        }
        lines.join("\n")
    };

    let mut routed_block = String::new();
    if !already_routed.is_empty() {
        let mut rlines: Vec<String> = Vec::new();
        for r in already_routed {
            let tid: String = r.target_id.chars().take(200).collect();
            let tsk: String = r.task.chars().take(240).collect();
            if !tid.is_empty() && !tsk.is_empty() {
                rlines.push(format!("- {tid}: {tsk}"));
            }
        }
        if !rlines.is_empty() {
            routed_block = format!(
                "\n\nAlready routed (do not re-dispatch these):\n{}",
                rlines.join("\n")
            );
        }
    }

    format!(
        "User request:\n{}\n\nFleet:\n{agent_block}{routed_block}\n\nRespond with the JSON plan only.",
        user_prompt.trim()
    )
}

pub fn parse_plan(raw: &str) -> Option<AutoPlanResult> {
    let obj = extract_json_object(raw)?;
    let summary = obj
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let arr = obj.get("dispatches").and_then(|v| v.as_array());
    let mut dispatches: Vec<PlanDispatch> = Vec::new();
    if let Some(arr) = arr {
        for d in arr {
            let target_id = d.get("target_id").and_then(|v| v.as_str()).unwrap_or("");
            let task = d.get("task").and_then(|v| v.as_str()).unwrap_or("");
            if target_id.is_empty() || task.is_empty() {
                continue;
            }
            // Cap each field defensively.
            let target_id: String = target_id.chars().take(200).collect();
            let task: String = task.chars().take(800).collect();
            dispatches.push(PlanDispatch { target_id, task });
            if dispatches.len() >= MAX_DISPATCHES {
                break;
            }
        }
    }
    Some(AutoPlanResult {
        dispatches,
        summary,
    })
}

const PLANNER_SYSTEM_TEMPLATE: &str = r#"You are an agent task router. The user describes a goal; you decide which fleet agents (if any) should handle which sub-tasks. You DO NOT execute anything yourself — you only emit a routing plan as JSON.

Output rules:
- Reply with a SINGLE JSON object, nothing else. No prose, no markdown fences.
- Schema:
    {"dispatches": [{"target_id": "<exact uuid from fleet list>", "task": "<specific actionable task>"}, ...],
     "summary": "<one short sentence summarising the plan>"}
- target_id MUST be the UUID from the fleet list — never the agent name, never a partial id.
- Each task must be specific and project-aware. Reuse the user's intent verbatim where possible; expand only when an agent needs context the raw user text omits (e.g. "the X file" → name the project explicitly).
- Maximum {max_dispatches} dispatches per plan. Pick fewer if fewer agents fit. If NO agent fits the request, return {"dispatches": [], "summary": "<reason>"}.
- Do NOT dispatch to error/stopped agents unless the user is explicitly asking for restart/recovery work.
- If the request is conversational ("how's it going", "thanks"), return empty dispatches with a short summary acknowledging it.
- If "Already routed" lines are present below, the user's @mention has already been handled — do NOT re-dispatch the same task to the same agent. Only emit ADDITIONAL dispatches that cover OTHER intents in the user message that the @mention did not address. If everything is already routed, return empty dispatches.
"#;

/// Plan dispatches for `user_prompt` against `fleet`. Returns an
/// empty plan on any failure (haiku breaker open, timeout, parse
/// failure) rather than raising — auto mode is non-critical.
pub async fn plan_dispatches(
    pool: &SqlitePool,
    user_prompt: &str,
    fleet: &[FleetAgent],
    already_routed: &[RoutedTask],
    parent_session_id: Option<&str>,
) -> Result<AutoPlanResult> {
    if user_prompt.trim().is_empty() {
        return Ok(AutoPlanResult {
            dispatches: Vec::new(),
            summary: "(empty prompt)".into(),
        });
    }
    let system = PLANNER_SYSTEM_TEMPLATE.replace("{max_dispatches}", &MAX_DISPATCHES.to_string());
    let user_block = build_planner_prompt(user_prompt, fleet, already_routed);
    let raw = match call_haiku_with_meta_cost(
        pool,
        "planner",
        parent_session_id.unwrap_or(""),
        &user_block,
        Some(&system),
        Some(PLANNER_TIMEOUT),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => {
            return Ok(AutoPlanResult {
                dispatches: Vec::new(),
                summary: "Planner temporarily unavailable. Routed to staff agent.".into(),
            })
        }
    };
    Ok(parse_plan(&raw).unwrap_or(AutoPlanResult {
        dispatches: Vec::new(),
        summary: "Could not parse plan; defaulted to no dispatches.".into(),
    }))
}

// ── Helper: keep Value imports useful so it doesn't show unused.
fn _value_marker(_: &Value) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_plan_extracts_dispatches_with_caps() {
        let raw = json!({
            "summary": "Two dispatches.",
            "dispatches": [
                { "target_id": "id-1", "task": "do the thing" },
                { "target_id": "id-2", "task": "do the other thing" },
                { "target_id": "id-3", "task": "extra" },
                { "target_id": "id-4", "task": "extra 2" },
                { "target_id": "id-5", "task": "extra 3" },
                { "target_id": "id-6", "task": "extra 4" },
                { "target_id": "id-7", "task": "this exceeds MAX_DISPATCHES" }
            ]
        })
        .to_string();
        let r = parse_plan(&raw).unwrap();
        assert_eq!(r.summary, "Two dispatches.");
        assert_eq!(r.dispatches.len(), MAX_DISPATCHES);
        assert_eq!(r.dispatches[0].target_id, "id-1");
    }

    #[test]
    fn parse_plan_drops_empty_target_or_task_entries() {
        let raw = json!({
            "summary": "Mixed.",
            "dispatches": [
                { "target_id": "x", "task": "good" },
                { "target_id": "", "task": "no target" },
                { "target_id": "y", "task": "" }
            ]
        })
        .to_string();
        let r = parse_plan(&raw).unwrap();
        assert_eq!(r.dispatches.len(), 1);
        assert_eq!(r.dispatches[0].target_id, "x");
    }

    #[test]
    fn build_planner_prompt_renders_agents_and_routed_block() {
        let fleet = vec![FleetAgent {
            id: "agent-1".into(),
            name: "alpha".into(),
            project: Some("/proj".into()),
            status: Some("idle".into()),
            description: Some("does things".into()),
        }];
        let routed = vec![RoutedTask {
            target_id: "agent-1".into(),
            task: "already done".into(),
        }];
        let p = build_planner_prompt("fix it", &fleet, &routed);
        assert!(p.contains("User request:\nfix it"));
        assert!(
            p.contains("- agent-1 | alpha (project: /proj · status: idle · about: does things)")
        );
        assert!(p.contains("Already routed"));
        assert!(p.contains("- agent-1: already done"));
    }

    #[test]
    fn build_planner_prompt_empty_fleet_uses_placeholder() {
        let p = build_planner_prompt("hello", &[], &[]);
        assert!(p.contains("Fleet:\n(no agents available)"));
        // No routed block when empty.
        assert!(!p.contains("Already routed"));
    }
}
