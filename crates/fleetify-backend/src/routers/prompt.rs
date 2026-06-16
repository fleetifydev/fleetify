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
    // The renderer sends the draft under `prompt`; accept `text` too for
    // back-compat. Without the alias `text` defaulted to "" on every
    // request → the enhancer got an empty draft → every refine silently
    // no-op'd and the refine card never appeared.
    #[serde(default, alias = "prompt")]
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

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: the renderer posts the draft under `prompt` (+ extra
    // project_path/tool/model fields the backend ignores). Before the
    // `alias`, `text` defaulted to "" and every refine silently no-op'd.
    #[test]
    fn enhance_body_accepts_renderer_prompt_field() {
        let b: EnhanceBody = serde_json::from_str(
            r#"{"session_id":"s1","prompt":"add a dark mode toggle","project_path":null,"tool":"claude","model":null}"#,
        )
        .expect("renderer payload should deserialize");
        assert_eq!(b.text, "add a dark mode toggle");
        assert_eq!(b.session_id, "s1");
    }

    #[test]
    fn enhance_body_still_accepts_legacy_text_field() {
        let b: EnhanceBody =
            serde_json::from_str(r#"{"session_id":"s1","text":"hi"}"#).expect("legacy payload");
        assert_eq!(b.text, "hi");
    }
}
