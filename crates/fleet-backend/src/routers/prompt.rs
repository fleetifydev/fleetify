//! `/api/prompt/*` — Haiku-driven prompt operations. Phase-3 lands
//! `enhance`; future helpers (auto_planner, etc.) can mount here too.

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;

use crate::routers::AppState;
use crate::services::prompt_enhancer;

pub fn router() -> Router<AppState> {
    Router::new().route("/prompt/enhance", post(enhance))
}

#[derive(Deserialize, Default)]
struct EnhanceBody {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    text: String,
}

async fn enhance(State(st): State<AppState>, Json(b): Json<EnhanceBody>) -> Json<Value> {
    match prompt_enhancer::enhance(&st.auth.pool, &b.session_id, &b.text).await {
        Ok(r) => Json(serde_json::to_value(r).unwrap_or(Value::Null)),
        Err(_) => Json(serde_json::json!({
            "enhanced": b.text,
            "no_op": true,
        })),
    }
}
