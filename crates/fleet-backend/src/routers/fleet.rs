//! `/api/fleet/*` — Phase-3 stubs. The full fleet_brain (Haiku-driven
//! continue/ask/done classification + fleet chat Q&A) lands with the
//! orchestration phase. For now, faithful endpoint surface returning
//! the degraded-default shape so the FleetCopilot UI in the renderer
//! renders gracefully instead of 404'ing.

use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fleet/analyze", post(analyze))
        .route("/fleet/chat", post(chat))
}

async fn analyze() -> Json<Value> {
    // Same shape as AnalyzeResult with degraded=true so the renderer
    // suppresses the Fleet decision card (parity with the Python
    // _safe_default() path).
    Json(json!({
        "decision": "ask",
        "reasoning": "fleet_brain not implemented yet (Phase 3)",
        "question": null,
        "next_prompt": null,
        "summary": null,
        "sections": null,
        "degraded": true
    }))
}

async fn chat() -> Json<Value> {
    Json(json!({
        "text": "fleet chat is not implemented yet (Phase 3 follow-up).",
        "cost_estimate_usd": 0.0
    }))
}
