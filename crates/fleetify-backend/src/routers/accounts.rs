//! Multiple accounts per provider/agent — the REST surface over
//! `services::accounts`. Mounted under `/api`, so paths are
//! `/api/providers/{id}/accounts…`. Secrets never transit here: HTTP keys
//! live in the OS keychain (written shell-side), CLI credentials in each
//! account's isolated HOME (written by the agent's own login flow).

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::models::account::{AccountCreate, AccountUpdate};
use crate::routers::{ApiError, AppState};
use crate::services::accounts::{self, AccountError};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/providers/{id}/accounts",
            get(list_accounts).post(create_account),
        )
        .route(
            "/providers/{id}/accounts/{account_id}",
            axum::routing::delete(delete_account).patch(patch_account),
        )
        .route(
            "/providers/{id}/accounts/{account_id}/default",
            post(set_default_account),
        )
}

impl From<AccountError> for ApiError {
    fn from(e: AccountError) -> Self {
        match e {
            AccountError::InUse(n) => ApiError::Conflict(json!({
                "error": "account_in_use",
                "sessions": n,
                "message": format!("{n} active session(s) still use this account"),
            })),
            AccountError::NotFound => ApiError::NotFound("account not found".into()),
            AccountError::SystemImmutable => {
                ApiError::BadRequest("the System account cannot be modified".into())
            }
            AccountError::Db(e) => ApiError::Internal(format!("db error: {e}")),
            AccountError::Io(e) => ApiError::Internal(format!("io error: {e}")),
        }
    }
}

async fn list_accounts(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let accounts = accounts::list(&st.auth.pool, &id, &user.id).await?;
    Ok(Json(json!({ "accounts": accounts })))
}

async fn create_account(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<AccountCreate>,
) -> Result<Json<Value>, ApiError> {
    if body.label.trim().is_empty() {
        return Err(ApiError::BadRequest("label is required".into()));
    }
    let acc = accounts::create(&st.auth.pool, &id, &body, &user.id).await?;
    Ok(Json(json!({ "ok": true, "account": acc })))
}

#[derive(Debug, Deserialize)]
struct DeleteQ {
    #[serde(default)]
    force: Option<u8>,
}

async fn delete_account(
    State(st): State<AppState>,
    AuthUser(_user): AuthUser,
    Path((_id, account_id)): Path<(String, String)>,
    Query(q): Query<DeleteQ>,
) -> Result<Json<Value>, ApiError> {
    let force = matches!(q.force, Some(n) if n != 0);
    accounts::delete(&st.auth.pool, &account_id, force).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn patch_account(
    State(st): State<AppState>,
    AuthUser(_user): AuthUser,
    Path((_id, account_id)): Path<(String, String)>,
    Json(body): Json<AccountUpdate>,
) -> Result<Json<Value>, ApiError> {
    if let Some(label) = body.label.as_deref() {
        if label.trim().is_empty() {
            return Err(ApiError::BadRequest("label cannot be empty".into()));
        }
        accounts::rename(&st.auth.pool, &account_id, label).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn set_default_account(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, account_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    accounts::set_default(&st.auth.pool, &id, &account_id, &user.id).await?;
    Ok(Json(json!({ "ok": true })))
}
