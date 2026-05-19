//! axum routers = the FastAPI router surface. Phase 1c: sessions /
//! messages / events. AppState carries auth + the SessionManager.

pub mod auth;
pub mod chat;
pub mod docker;
pub mod events;
pub mod fleet;
pub mod fs;
pub mod groups;
pub mod marketplace;
pub mod mcp;
pub mod messages;
pub mod plugins;
pub mod providers;
pub mod runtime;
pub mod sessions;
pub mod ssh;
pub mod workflows;

use axum::extract::FromRef;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::auth::AuthState;
use crate::session_manager::SessionManager;

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthState,
    pub app_cfg: std::sync::Arc<crate::config::AppConfig>,
    pub sm: &'static SessionManager,
}

impl FromRef<AppState> for AuthState {
    fn from_ref(s: &AppState) -> AuthState {
        s.auth.clone()
    }
}

/// Router error → HTTP, mirroring the Python `HTTPException` codes.
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
            ApiError::Conflict(v) => {
                (StatusCode::CONFLICT, axum::Json(v)).into_response()
            }
            ApiError::Internal(m) => {
                (StatusCode::INTERNAL_SERVER_ERROR, m).into_response()
            }
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
