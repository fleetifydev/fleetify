//! Workflow engine — sequential runner for plugin-contributed workflows.
//! Faithful subset of `services/workflows/engine.py` — Phase-4 cut.
//!
//! Two step kinds (matching the Python):
//!   * `agent` — spawns a one-shot Claude (SdkBridge) staff-style agent
//!     with `system_prompt` (after `{{var}}` substitution). Skeleton
//!     here records the intended invocation; full SdkBridge-driven
//!     execution lands with the SdkBridge port.
//!   * `tool` — invokes an MCP tool directly. V1 placeholder echoes
//!     the input back as the output.
//!
//! Steps run in order; output of step N is available as `{{step:N:output}}`
//! in later steps. Failures abort the run; remaining steps marked
//! `skipped`. State is in-memory; no persistence across restarts.

use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepResult {
    pub index: usize,
    pub title: String,
    pub kind: String,
    #[serde(default = "default_pending")]
    pub status: String, // pending | running | succeeded | failed | skipped
    #[serde(default)]
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<f64>,
}
fn default_pending() -> String {
    "pending".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub run_id: String,
    pub workflow_name: String,
    pub plugin_name: String,
    pub user_id: String,
    pub project_path: String,
    pub status: String, // pending | running | succeeded | failed | aborted
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<f64>,
    #[serde(default)]
    pub steps: Vec<StepResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn runs() -> &'static Mutex<std::collections::HashMap<String, WorkflowRun>> {
    static R: OnceLock<Mutex<std::collections::HashMap<String, WorkflowRun>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub fn get_run(run_id: &str) -> Option<WorkflowRun> {
    runs().lock().ok()?.get(run_id).cloned()
}

pub fn list_runs() -> Vec<WorkflowRun> {
    runs()
        .lock()
        .map(|g| g.values().cloned().collect())
        .unwrap_or_default()
}

pub fn list_runs_for_user(user_id: &str) -> Vec<WorkflowRun> {
    list_runs()
        .into_iter()
        .filter(|r| r.user_id == user_id)
        .collect()
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// `{{step:N:output}}` and `{{argname}}` substitution. Matches the
/// Python `_substitute` byte-for-byte.
pub fn substitute(
    template: &str,
    run: &WorkflowRun,
    args: &serde_json::Map<String, Value>,
) -> String {
    if template.is_empty() {
        return String::new();
    }
    // First pass: `{{step:N:output}}`. We walk the string once and
    // replace inline so a single-pass scan handles both patterns.
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            // Find the matching `}}`.
            if let Some(close_rel) = template[i + 2..].find("}}") {
                let inner = &template[i + 2..i + 2 + close_rel];
                let replaced = if let Some(rest) = inner.strip_prefix("step:") {
                    if let Some((idx_str, tail)) = rest.split_once(':') {
                        if tail == "output" {
                            if let Ok(idx) = idx_str.parse::<usize>() {
                                if idx < run.steps.len() && run.steps[idx].status == "succeeded" {
                                    Some(run.steps[idx].output.clone())
                                } else {
                                    Some(String::new())
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else if !inner.is_empty()
                    && inner.chars().all(|c| c.is_alphanumeric() || c == '_')
                {
                    // `{{argname}}` → args[name] (or "").
                    Some(
                        args.get(inner)
                            .and_then(|v| {
                                v.as_str().map(String::from).or_else(|| Some(v.to_string()))
                            })
                            .unwrap_or_default(),
                    )
                } else {
                    None
                };
                match replaced {
                    Some(s) => {
                        out.push_str(&s);
                        i += 2 + close_rel + 2;
                        continue;
                    }
                    None => {
                        // Not a recognised placeholder — keep verbatim.
                        out.push_str(&template[i..i + 2 + close_rel + 2]);
                        i += 2 + close_rel + 2;
                        continue;
                    }
                }
            }
        }
        out.push(template[i..].chars().next().unwrap());
        // Advance by char-byte length so multi-byte UTF-8 doesn't desync.
        i += template[i..]
            .chars()
            .next()
            .map(|c| c.len_utf8())
            .unwrap_or(1);
    }
    out
}

/// Allocate a new run row in the registry and return its id. The
/// caller drives step execution via `mark_started`, `record_step`,
/// `finish_run` — the engine's run_workflow loop wraps these. For
/// now (until SdkBridge lands) external callers can poll
/// `get_run(run_id)` and see steps as they advance.
pub fn allocate_run(
    workflow_name: &str,
    plugin_name: &str,
    user_id: &str,
    project_path: &str,
    steps_meta: &[(String, String)], // (title, kind) per step
) -> String {
    let run_id = uuid::Uuid::new_v4().to_string();
    let steps: Vec<StepResult> = steps_meta
        .iter()
        .enumerate()
        .map(|(i, (title, kind))| StepResult {
            index: i,
            title: title.clone(),
            kind: kind.clone(),
            status: "pending".into(),
            output: String::new(),
            error: None,
            started_at: None,
            ended_at: None,
        })
        .collect();
    let run = WorkflowRun {
        run_id: run_id.clone(),
        workflow_name: workflow_name.to_string(),
        plugin_name: plugin_name.to_string(),
        user_id: user_id.to_string(),
        project_path: project_path.to_string(),
        status: "pending".into(),
        started_at: now_secs(),
        ended_at: None,
        steps,
        error: None,
    };
    runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), run);
    run_id
}

pub fn mark_started(run_id: &str) {
    if let Ok(mut g) = runs().lock() {
        if let Some(r) = g.get_mut(run_id) {
            r.status = "running".into();
        }
    }
}

pub fn record_step(run_id: &str, index: usize, status: &str, output: &str, error: Option<&str>) {
    if let Ok(mut g) = runs().lock() {
        if let Some(r) = g.get_mut(run_id) {
            if let Some(s) = r.steps.get_mut(index) {
                s.status = status.into();
                if !output.is_empty() {
                    s.output = output.into();
                }
                s.error = error.map(String::from);
                let now = now_secs();
                if s.started_at.is_none() {
                    s.started_at = Some(now);
                }
                if matches!(status, "succeeded" | "failed" | "skipped") {
                    s.ended_at = Some(now);
                }
            }
        }
    }
}

pub fn finish_run(run_id: &str, status: &str, error: Option<&str>) {
    if let Ok(mut g) = runs().lock() {
        if let Some(r) = g.get_mut(run_id) {
            r.status = status.into();
            r.error = error.map(String::from);
            r.ended_at = Some(now_secs());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allocate_run_creates_steps_in_pending() {
        let id = allocate_run(
            "wf",
            "plugin-a",
            "user-1",
            "/proj",
            &[
                ("Step A".into(), "agent".into()),
                ("Step B".into(), "tool".into()),
            ],
        );
        let r = get_run(&id).unwrap();
        assert_eq!(r.status, "pending");
        assert_eq!(r.steps.len(), 2);
        assert_eq!(r.steps[0].title, "Step A");
        assert_eq!(r.steps[0].kind, "agent");
        assert_eq!(r.steps[0].status, "pending");
    }

    #[test]
    fn record_step_transitions_status_and_timestamps() {
        let id = allocate_run("wf", "p", "u", "/p", &[("S".into(), "agent".into())]);
        mark_started(&id);
        record_step(&id, 0, "running", "", None);
        let r = get_run(&id).unwrap();
        assert_eq!(r.status, "running");
        assert_eq!(r.steps[0].status, "running");
        assert!(r.steps[0].started_at.is_some());
        assert!(r.steps[0].ended_at.is_none());

        record_step(&id, 0, "succeeded", "OK", None);
        let r = get_run(&id).unwrap();
        assert_eq!(r.steps[0].status, "succeeded");
        assert_eq!(r.steps[0].output, "OK");
        assert!(r.steps[0].ended_at.is_some());

        finish_run(&id, "succeeded", None);
        let r = get_run(&id).unwrap();
        assert_eq!(r.status, "succeeded");
        assert!(r.ended_at.is_some());
    }

    #[test]
    fn substitute_handles_arg_and_step_placeholders() {
        let id = allocate_run(
            "wf",
            "p",
            "u",
            "/p",
            &[("S0".into(), "agent".into()), ("S1".into(), "agent".into())],
        );
        record_step(&id, 0, "succeeded", "hello", None);
        let run = get_run(&id).unwrap();
        let args: serde_json::Map<String, Value> =
            json!({ "name": "Doruk" }).as_object().unwrap().clone();
        let out = substitute("Hi {{name}}, prior: {{step:0:output}}", &run, &args);
        assert_eq!(out, "Hi Doruk, prior: hello");

        // Unsucceeded step → empty.
        let out2 = substitute("[{{step:1:output}}]", &run, &args);
        assert_eq!(out2, "[]");

        // Unknown arg → empty (matches Python `args.get(k, "")`).
        let out3 = substitute("{{nope}}", &run, &args);
        assert_eq!(out3, "");

        // Literal `{{ }}` without recognised inner → preserved.
        let out4 = substitute("{{ this is not }}", &run, &args);
        assert_eq!(out4, "{{ this is not }}");
    }

    #[test]
    fn list_runs_for_user_scopes_to_user() {
        // Allocate two distinct runs for different users so we can
        // verify the filter is exact.
        let r1 = allocate_run("a", "p", "user-x", "/p", &[]);
        let r2 = allocate_run("b", "p", "user-y", "/p", &[]);
        let xs = list_runs_for_user("user-x");
        assert!(xs.iter().any(|r| r.run_id == r1));
        assert!(xs.iter().all(|r| r.user_id == "user-x"));
        // user-y's run isn't in user-x's list.
        assert!(!xs.iter().any(|r| r.run_id == r2));
    }
}
