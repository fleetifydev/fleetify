use std::path::PathBuf;

use axum::http::{HeaderValue, Method};
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use crate::routers::{chat, docker, events, fs, groups, messages, sessions, ssh, AppState};

/// Build the axum app. Single origin: `/healthz`, `/api/*` (auth'd),
/// `/events/status` SSE, and the built React assets (when `static_dir`).
/// CORS mirrors the Python: localhost:3000 / 127.0.0.1:3000, creds, *.
pub fn app(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:3000".parse::<HeaderValue>().unwrap(),
            "http://127.0.0.1:3000".parse::<HeaderValue>().unwrap(),
        ])
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
            Method::PUT,
        ])
        // Starlette's `allow_headers=["*"]` + credentials maps to
        // mirroring the requested headers in tower-http (Any + credentials
        // is rejected at construction).
        .allow_headers(tower_http::cors::AllowHeaders::mirror_request());

    let api = sessions::router()
        .merge(messages::router())
        .merge(groups::router())
        .merge(fs::router())
        .merge(ssh::router())
        .merge(docker::router());

    let routed = Router::new()
        .route("/healthz", get(healthz))
        .nest("/api", api)
        .merge(events::router())
        .merge(chat::router())
        .with_state(state)
        .layer(cors);

    match static_dir {
        Some(dir) => routed.fallback_service(ServeDir::new(dir)),
        None => routed,
    }
}

async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "version": "0.1.0" }))
}
