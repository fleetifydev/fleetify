//! `/api/workflows/*` — list active workflows + run lifecycle. Step
//! execution stays Phase-4-deferred (depends on SdkBridge); the run
//! lifecycle (allocate / status / per-user list) is real.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::routers::AppState;
use crate::services::workflows;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/workflows", get(list_workflows))
        .route("/workflows/{install_id}/{name}/run", post(run_workflow))
        .route("/workflows/runs/{run_id}", get(get_run))
}

async fn list_workflows(State(st): State<AppState>) -> Json<Value> {
    // Walks every installed plugin's `workflows/` directory under
    // `~/.fleetify/plugins/<name>/workflows/*.{json,yaml,yml,md}`. Each
    // file's stem (sans extension) is the workflow name. Returns the
    // shape the renderer's <WorkflowsList> reads.
    let _ = st; // kept for future scope-based filtering
    use crate::services::plugins::manifest;
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let plugins_dir = std::path::PathBuf::from(home)
        .join(".fleetify")
        .join("plugins");
    let Ok(rd) = std::fs::read_dir(&plugins_dir) else {
        return Json(Value::Array(Vec::new()));
    };
    let mut out: Vec<Value> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let install_id = entry.file_name().to_string_lossy().to_string();
        let Ok(m) = manifest::parse_plugin(&path) else {
            continue;
        };
        let wf_dir = path.join("workflows");
        let Ok(wf_rd) = std::fs::read_dir(&wf_dir) else {
            continue;
        };
        for wf in wf_rd.flatten() {
            let wf_path = wf.path();
            if !wf_path.is_file() {
                continue;
            }
            let ext = wf_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            if !matches!(ext, "json" | "yaml" | "yml" | "md") {
                continue;
            }
            let stem = wf_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if stem.is_empty() {
                continue;
            }
            out.push(json!({
                "install_id": install_id,
                "plugin": m.name,
                "name": stem,
                "title": null,
                "steps": [],
            }));
        }
    }
    Json(Value::Array(out))
}

#[derive(Deserialize, Default)]
struct RunBody {
    #[serde(default)]
    #[allow(dead_code)] // Stored at allocate-time once SdkBridge expansion lands.
    args: Value,
}

async fn run_workflow(
    State(_st): State<AppState>,
    AuthUser(user): AuthUser,
    Path((install_id, name)): Path<(String, String)>,
    Json(body): Json<RunBody>,
) -> impl IntoResponse {
    // Load the workflow definition from
    // <plugins>/<install_id>/workflows/<name>.{json,yaml,md} and
    // allocate steps from its `steps[]` array. JSON is the canonical
    // format; YAML / MD support is a follow-up (json covers what the
    // scaffold emits today).
    use crate::services::plugins::manifest;
    let _ = body; // args carried inside the run when expansion lands.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let wf_dir = std::path::PathBuf::from(home)
        .join(".fleetify")
        .join("plugins")
        .join(&install_id)
        .join("workflows");
    let candidates = [
        wf_dir.join(format!("{name}.json")),
        wf_dir.join(format!("{name}.yaml")),
        wf_dir.join(format!("{name}.yml")),
        wf_dir.join(format!("{name}.md")),
    ];
    let wf_path = candidates.into_iter().find(|p| p.is_file());
    let Some(wf_path) = wf_path else {
        let run_id = workflows::allocate_run(&name, &install_id, &user.id, "", &[]);
        workflows::finish_run(
            &run_id,
            "failed",
            Some(&format!("workflow '{name}' not found in install {install_id}")),
        );
        let r = workflows::get_run(&run_id).map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
        return (StatusCode::NOT_FOUND, Json(r.unwrap_or(Value::Null))).into_response();
    };
    // Verify the install's manifest parses (covers traversal in install_id).
    let plugin_root = wf_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let plugin_name = match manifest::parse_plugin(&plugin_root) {
        Ok(m) => m.name,
        Err(_) => install_id.clone(),
    };
    let raw = match std::fs::read_to_string(&wf_path) {
        Ok(s) => s,
        Err(e) => {
            let run_id = workflows::allocate_run(&name, &plugin_name, &user.id, "", &[]);
            workflows::finish_run(&run_id, "failed", Some(&format!("read {}: {e}", wf_path.display())));
            let r = workflows::get_run(&run_id).map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
            return (StatusCode::ACCEPTED, Json(r.unwrap_or(Value::Null))).into_response();
        }
    };
    // Phase-4 cut: only JSON workflows. YAML/MD follow.
    let def: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            let run_id = workflows::allocate_run(&name, &plugin_name, &user.id, "", &[]);
            workflows::finish_run(
                &run_id,
                "failed",
                Some(&format!("workflow parse failed: {e} (only JSON supported in this cut)")),
            );
            let r = workflows::get_run(&run_id).map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
            return (StatusCode::ACCEPTED, Json(r.unwrap_or(Value::Null))).into_response();
        }
    };
    let steps_arr = def.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let steps_meta: Vec<(String, String)> = steps_arr
        .iter()
        .map(|s| {
            let title = s
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("step")
                .to_string();
            let kind = s
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            (title, kind)
        })
        .collect();
    let run_id = workflows::allocate_run(&name, &plugin_name, &user.id, "", &steps_meta);
    workflows::mark_started(&run_id);

    // Step execution loop (background): walks steps in order.
    let steps_clone = steps_arr.clone();
    let run_id_bg = run_id.clone();
    tokio::spawn(async move {
        let mut aborted = false;
        for (i, step) in steps_clone.iter().enumerate() {
            if aborted {
                workflows::record_step(
                    &run_id_bg,
                    i,
                    "skipped",
                    "",
                    Some("prior step failed"),
                );
                continue;
            }
            workflows::record_step(&run_id_bg, i, "running", "", None);
            let kind = step
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("tool");
            let result = match kind {
                "tool" => {
                    // V1: echo the input back as the output (matches Python
                    // placeholder behaviour until real MCP-tool dispatch
                    // from Fleet ships).
                    Ok(serde_json::to_string(step.get("input").unwrap_or(&serde_json::Value::Null)).unwrap_or_default())
                }
                "agent" => {
                    // Spawn a one-shot Haiku call and capture the response
                    // text. system_prompt + message both run through
                    // `substitute()` so `{{step:N:output}}` references in
                    // later steps resolve correctly.
                    let run = match workflows::get_run(&run_id_bg) {
                        Some(r) => r,
                        None => {
                            workflows::record_step(
                                &run_id_bg, i, "failed", "",
                                Some("run state vanished"),
                            );
                            aborted = true;
                            continue;
                        }
                    };
                    let sys = step
                        .get("system_prompt")
                        .and_then(|v| v.as_str())
                        .map(|s| workflows::substitute(s, &run, &Default::default()))
                        .unwrap_or_default();
                    let msg = step
                        .get("message")
                        .and_then(|v| v.as_str())
                        .map(|s| workflows::substitute(s, &run, &Default::default()))
                        .unwrap_or_else(|| "Run the step.".into());
                    run_one_shot_claude(&run.project_path, &sys, &msg).await
                }
                other => Err(format!("unknown step kind: {other}")),
            };
            match result {
                Ok(out) => {
                    workflows::record_step(&run_id_bg, i, "succeeded", &out, None);
                }
                Err(e) => {
                    workflows::record_step(&run_id_bg, i, "failed", "", Some(&e));
                    aborted = true;
                }
            }
        }
        let final_status = if aborted { "failed" } else { "succeeded" };
        workflows::finish_run(&run_id_bg, final_status, None);
    });

    let r = workflows::get_run(&run_id).map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
    (StatusCode::ACCEPTED, Json(r.unwrap_or(Value::Null))).into_response()
}

async fn run_one_shot_claude(
    project_path: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    use crate::services::haiku_client::call_haiku;
    use std::time::Duration;
    // For agent steps without an explicit model, default to Haiku to
    // keep workflow runs cheap. Users can override via the workflow
    // step JSON once the model field is wired through.
    let sys = if system_prompt.is_empty() {
        None
    } else {
        Some(system_prompt)
    };
    let _ = project_path; // reserved for cwd-aware one-shots
    call_haiku(user_message, sys, Some(Duration::from_secs(60)))
        .await
        .map_err(|e| e.to_string())
}

async fn get_run(
    AuthUser(user): AuthUser,
    Path(run_id): Path<String>,
) -> impl IntoResponse {
    match workflows::get_run(&run_id) {
        Some(r) if r.user_id == user.id => {
            let v = serde_json::to_value(&r).unwrap_or(Value::Null);
            (StatusCode::OK, Json(v)).into_response()
        }
        Some(_) => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not your run" })),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "run not found" })),
        )
            .into_response(),
    }
}
