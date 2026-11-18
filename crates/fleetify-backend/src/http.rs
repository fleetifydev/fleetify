use axum::extract::DefaultBodyLimit;
use axum::http::{Method, Uri};
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::access::{self, AccessPolicy};
use crate::routers::{
    accounts, auth as auth_router, browser, chat, docker, events, fleet, fs, groups, internal,
    library, marketplace, mcp, messages, plugins, prompt, prompts, providers, routing, runtime,
    sessions, ssh, user, workflows, workspace, AppState,
};
use crate::ui::{self, UiAssets, UiFiles};

/// The health route. It answers `{"status":"ok","version":…}`, and the
/// shell polls it at startup before its warm-up talks to the backend.
pub const HEALTH_PATH: &str = "/healthz";

/// Build the axum app. Single origin: `/healthz`, `/api/*` (auth'd),
/// `/events/status` SSE, the CSP report route, and, with `ui`, the release
/// UI's files as the fallback ([`crate::ui`]). No CORS: the app's pages come
/// from this origin (or, in dev, through the Vite proxy). [`access::guard`]
/// wraps all of it, the UI files and the 404s included.
pub fn app(state: AppState, ui: Option<UiAssets>, policy: AccessPolicy) -> Router {
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
        .route(
            ui::CSP_REPORT_PATH,
            post(ui::csp_report).layer(DefaultBodyLimit::max(ui::CSP_REPORT_MAX_BYTES)),
        )
        .nest("/api", api)
        .nest("/api/internal", internal_api)
        .merge(events::router())
        .merge(chat::router())
        .merge(browser::ws_router())
        .with_state(state);

    // The nested routers have no fallback of their own, so a path under
    // `/api` that no route matches ends here too: an empty 404.
    let routed = match ui {
        Some(assets) => {
            let files = UiFiles::new(assets, policy.port);
            routed.fallback(move |method: Method, uri: Uri| {
                let files = files.clone();
                async move { files.respond(&method, uri.path()) }
            })
        }
        None => routed,
    };
    // Last, so it is the outermost layer: axum applies a layer only to the
    // routes and fallback added before it.
    routed.layer(from_fn_with_state(policy, access::guard))
}

async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "version": "0.1.0" }))
}
