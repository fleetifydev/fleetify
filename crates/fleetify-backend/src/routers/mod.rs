//! axum routers = the FastAPI router surface. Phase 1c: sessions /
//! messages / events. AppState carries auth + the SessionManager.

pub mod accounts;
pub mod auth;
pub mod browser;
pub mod chat;
pub mod docker;
pub mod events;
pub mod fleet;
pub mod fs;
pub mod groups;
pub mod internal;
pub mod library;
pub mod marketplace;
pub mod mcp;
pub mod messages;
pub mod plugins;
pub mod prompt;
pub mod prompts;
pub mod providers;
pub mod runtime;
pub mod sessions;
pub mod ssh;
pub mod workflows;
pub mod workspace;

use axum::extract::FromRef;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::auth::AuthState;
use crate::services::routing::RoutingOrchestrator;
use crate::session_manager::SessionManager;

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthState,
    pub app_cfg: std::sync::Arc<crate::config::AppConfig>,
    pub sm: &'static SessionManager,
    /// One-shot loopback secret shared between the in-process backend
    /// and its child stdio MCP servers (fleet-memory-mcp /
    /// fleet-dispatch-mcp / fleet-reveng-mcp). Generated at startup
    /// and injected into the MCPs' env via ClaudeBridge's
    /// build_mcp_config. Lets `POST /api/internal/dispatch` skip JWT
    /// auth without exposing the user's bearer to a subprocess. Not
    /// routed past localhost — anything off-loopback ignores it.
    pub internal_secret: std::sync::Arc<String>,
    /// Provider router orchestrator. Holds the active DecisionRouter +
    /// ProxyGateway registries and the master `enabled` toggle. Chat /
    /// dispatch flows consult this on every turn (when enabled) to pick
    /// (agent, model) and resolve proxy base URLs / headers.
    pub routing: std::sync::Arc<RoutingOrchestrator>,
    /// session_id → live PermissionHandler. Populated by chat.rs WS
    /// handler when a session opens (currently used only by Claude —
    /// Codex/Gemini bridge their approval hooks in-process). Consumed
    /// by the in-process permission MCP server (and the legacy
    /// /permission_prompt loopback), which calls the handler so the WS
    /// dialog round-trip stays the single source of truth across bridges.
    pub permission_registry: std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, crate::bridges::permission::PermissionHandler>,
        >,
    >,
    /// session_id → live AskUserQuestion handler. Populated by chat.rs
    /// when a Claude session's WS opens. Consumed by the fleet-permission
    /// loopback (`/api/internal/permission_prompt`): when Claude calls the
    /// built-in `AskUserQuestion` tool (which can't render headlessly), the
    /// loopback routes to this handler instead of the yes/no permission
    /// flow — it ships the question card to the renderer, awaits the user's
    /// selection, and returns it as the tool result. Returns a JSON outcome
    /// (`{answered, answers:[…]}`), not a bool, hence a separate registry.
    pub ask_registry: std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, crate::bridges::acp::RequestHandler>>,
    >,
    /// CLI agent scan result, primed at backend startup and refreshed
    /// on install / manual ?refresh=1 hits. See routers::providers.
    pub agent_scan_cache: crate::routers::providers::AgentScanCache,
    /// HTTP provider health snapshots, primed at backend startup by the
    /// Tauri warm-up hook. Read by `/api/providers/health`; invalidated
    /// by `providers_test_connection` IPC after a manual Test. See
    /// routers::providers::HttpHealthCache.
    pub http_health_cache: crate::routers::providers::HttpHealthCache,
}

impl FromRef<AppState> for AuthState {
    fn from_ref(s: &AppState) -> AuthState {
        s.auth.clone()
    }
}

/// Router error → HTTP, mirroring the Python `HTTPException` codes.
#[derive(Debug)]
pub enum ApiError {
    NotFound(String),
    Forbidden(String),
    BadRequest(String),
    Conflict(serde_json::Value),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, m).into_response(),
            ApiError::Forbidden(m) => (StatusCode::FORBIDDEN, m).into_response(),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m).into_response(),
            ApiError::Conflict(v) => (StatusCode::CONFLICT, axum::Json(v)).into_response(),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m).into_response(),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::Internal(format!("db error: {e}"))
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::Internal(format!("json error: {e}"))
    }
}
