//! `/api/auth/me` — returns the JIT-resolved User row for the current
//! Bearer token (faithful port of routers/auth.py).

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::routers::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/auth/me", get(me))
}

async fn me(AuthUser(user): AuthUser) -> Json<Value> {
    Json(json!({
        "id": user.id,
        "external_sub": user.external_sub,
        "name": user.name,
        "email": user.email,
    }))
}
