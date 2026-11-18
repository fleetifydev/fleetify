use std::path::PathBuf;

use axum::middleware::from_fn_with_state;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use tower_http::services::ServeDir;

use crate::access::{self, AccessPolicy};
use crate::routers::{
    accounts, auth as auth_router, browser, chat, docker, events, fleet, fs, groups, internal,
    library, marketplace, mcp, messages, plugins, prompt, prompts, providers, routing, runtime,
    sessions, ssh, user, workflows, workspace, AppState,
};

/// The health route. It answers `{"status":"ok","version":…}`, and the
/// shell polls it at startup before its warm-up talks to the backend.
pub const HEALTH_PATH: &str = "/healthz";

/// Build the axum app. Single origin: `/healthz`, `/api/*` (auth'd),
/// `/events/status` SSE, and the built React assets (when `static_dir`).
/// No CORS: the app's pages come from this origin (or, in dev, through the
/// Vite proxy). [`access::guard`] wraps all of it, the static files and the
/// 404s included.
pub fn app(state: AppState, static_dir: Option<PathBuf>, policy: AccessPolicy) -> Router {
    let api = sessions::router()
        .merge(messages::router())
        .merge(groups::router())
        .merge(fs::router())
        .merge(ssh::router())
        .merge(docker::router())
        .merge(providers::router())
        .merge(accounts::router())
        .merge(plugins::router())
        .merge(marketplace::router())
        .merge(library::router())
        .merge(prompts::router())
        .merge(routing::router())
        .merge(runtime::router())
        .merge(workflows::router())
        .merge(mcp::router())
        .merge(auth_router::router())
        .merge(fleet::router())
        .merge(user::router())
        .merge(workspace::router())
        .merge(prompt::router())
        .merge(crate::studio::router());

    // Loopback-gated internal endpoints (no JWT auth — the
    // X-Fleet-Internal header is the only authenticator). Mounted at
    // `/api/internal`, which the access guard asks for no API token: the
    // shell and the agents' helper processes call them with the secret.
    let internal_api = internal::router().merge(browser::internal_router());

    let routed = Router::new()
        .route(HEALTH_PATH, get(healthz))
        .nest("/api", api)
        .nest("/api/internal", internal_api)
        .merge(events::router())
        .merge(chat::router())
        .merge(browser::ws_router())
        .with_state(state);

    let routed = match static_dir {
        Some(dir) => routed.fallback_service(ServeDir::new(dir)),
        None => routed,
    };
    // Last, so it is the outermost layer: axum applies a layer only to the
    // routes and fallback added before it.
    routed.layer(from_fn_with_state(policy, access::guard))
}

async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "version": "0.1.0" }))
}
