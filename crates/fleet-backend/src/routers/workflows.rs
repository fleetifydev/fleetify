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
    // V1 cut: allocate a run row with no steps (until the SdkBridge
    // execution path lands) and return the id so the renderer can
    // poll status. Args are stored at allocate time; once execution
    // ships they're consumed by `substitute()` during step expansion.
    let _ = body; // accepted but no step expansion yet.
    let run_id = workflows::allocate_run(&name, &install_id, &user.id, "", &[]);
    workflows::mark_started(&run_id);
    workflows::finish_run(
        &run_id,
        "failed",
        Some("workflow step execution not implemented yet (Phase 4 SdkBridge follow-up)"),
    );
    let r = workflows::get_run(&run_id).map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
    (StatusCode::ACCEPTED, Json(r.unwrap_or(Value::Null))).into_response()
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
