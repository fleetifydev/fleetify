//! `/api/fleet/*` — Phase-3 Haiku-driven analyze + chat. Wired to the
//! fleet_brain service which shells to `claude --print` for the
//! classification + reply (haiku_breaker short-circuits when Haiku
//! is unavailable so the user never sees a fake "Fleet couldn't
//! analyze" card sitting on top of their chat).

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::{ApiError, AppState};
use crate::services::fleet_brain;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fleet/analyze", post(analyze))
        .route("/fleet/chat", post(chat))
        .route("/fleet/rules", get(get_rules).put(set_rules))
}

/// `GET /api/fleet/rules` — the current FLEET.md text (empty when absent).
async fn get_rules() -> Json<Value> {
    let content = crate::services::fleet_rules::read_raw(&fleetify_core::fleetify_home());
    Json(json!({ "content": content }))
}

#[derive(Deserialize, Default)]
struct RulesBody {
    #[serde(default)]
    content: String,
}

/// `PUT /api/fleet/rules` — persist FLEET.md (creating `~/.fleetify/` if
/// needed); empty/whitespace content deletes the file (delete-on-empty).
async fn set_rules(Json(b): Json<RulesBody>) -> Result<Json<Value>, ApiError> {
    crate::services::fleet_rules::save(&fleetify_core::fleetify_home(), &b.content)
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(json!({ "ok": true, "content": b.content })))
}

#[derive(Deserialize, Default)]
struct AnalyzeBody {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    prior_prompt: String,
    #[serde(default)]
    agent_text: String,
    #[serde(default)]
    project_context: Option<String>,
}

async fn analyze(State(st): State<AppState>, Json(b): Json<AnalyzeBody>) -> Json<Value> {
    let r = fleet_brain::analyze(
        &st.auth.pool,
        &b.session_id,
        &b.prior_prompt,
        &b.agent_text,
        b.project_context.as_deref(),
    )
    .await
    .unwrap_or_else(|e| fleet_brain::safe_default(&e.to_string()));
    Json(serde_json::to_value(r).unwrap_or(Value::Null))
}

#[derive(Deserialize, Default)]
struct ChatBody {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    fleet_snapshot: String,
}

async fn chat(State(st): State<AppState>, Json(b): Json<ChatBody>) -> Json<Value> {
    match fleet_brain::chat(&st.auth.pool, &b.session_id, &b.prompt, &b.fleet_snapshot).await {
        Ok(r) => Json(serde_json::to_value(r).unwrap_or(Value::Null)),
        Err(e) => Json(json!({
            "text": format!("Fleet couldn't reply ({e})."),
            "cost_estimate_usd": 0.0,
        })),
    }
}
