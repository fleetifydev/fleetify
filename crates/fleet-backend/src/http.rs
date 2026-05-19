use std::path::PathBuf;

use axum::{routing::get, Json, Router};
use serde_json::json;
use tower_http::services::ServeDir;

/// Build the axum app. In later phases this gains `/api`, `/ws`, and
/// `/events`. When `static_dir` is `Some`, the built React assets are served
/// from `/` (single-origin: UI + API share 127.0.0.1:8765).
pub fn app(static_dir: Option<PathBuf>) -> Router {
    let router = Router::new().route("/healthz", get(healthz));
    match static_dir {
        Some(dir) => router.fallback_service(ServeDir::new(dir)),
        None => router,
    }
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}
