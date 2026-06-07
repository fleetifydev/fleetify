use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::AuthUser;
use crate::models::session::Session;
use crate::routers::{ApiError, AppState};

use super::{adapter, registry};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/studio/tools", get(tools))
        .route("/studio/higgsfield/models", get(models))
        .route("/studio/higgsfield/models/{id}", get(model_detail))
        .route("/studio/higgsfield/account", get(account))
        .route("/studio/higgsfield/cost", post(cost))
        .route("/studio/higgsfield/generate", post(generate))
}

#[derive(Serialize)]
struct ToolStatus {
    id: &'static str,
    display_name: &'static str,
    install_hint: &'static str,
    installed: bool,
    authenticated: bool,
}

async fn tools(
    State(_st): State<AppState>,
    AuthUser(_u): AuthUser,
) -> Result<Json<Vec<ToolStatus>>, ApiError> {
    let installed = adapter::hf_path().await.is_some();
    let authenticated = installed && adapter::hf_authenticated().await;
    let out = registry::STUDIO_TOOLS
        .iter()
        .map(|t| ToolStatus {
            id: t.id,
            display_name: t.display_name,
            install_hint: t.install_hint,
            installed,
            authenticated,
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct ModelsQ {
    #[serde(default)]
    r#type: Option<String>,
}

async fn models(
    State(_st): State<AppState>,
    AuthUser(_u): AuthUser,
    Query(q): Query<ModelsQ>,
) -> Result<Json<Vec<adapter::HfModel>>, ApiError> {
    let mut args: Vec<&str> = vec!["model", "list"];
    match q.r#type.as_deref() {
        Some("image") => args.push("--image"),
        Some("video") => args.push("--video"),
        Some("text") => args.push("--text"),
        _ => {}
    }
    args.push("--json");
    let (_c, out, _e) = adapter::run_hf(&args, 20).await;
    Ok(Json(adapter::parse_model_list(&out)?))
}

async fn model_detail(
    State(_st): State<AppState>,
    AuthUser(_u): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<adapter::HfModelDetail>, ApiError> {
    let (_c, out, _e) = adapter::run_hf(&["model", "get", &id, "--json"], 20).await;
    Ok(Json(adapter::parse_model_detail(&out)?))
}

async fn account(
    State(_st): State<AppState>,
    AuthUser(_u): AuthUser,
) -> Result<Json<adapter::HfAccount>, ApiError> {
    let (_c, out, _e) = adapter::run_hf(&["account", "status", "--json"], 15).await;
    Ok(Json(adapter::parse_account(&out)?))
}

#[derive(Deserialize)]
struct CostBody {
    model: String,
    #[serde(default)]
    params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct GenBody {
    session_id: String,
    model: String,
    #[serde(default)]
    params: serde_json::Map<String, serde_json::Value>,
}

async fn cost(
    State(_st): State<AppState>,
    AuthUser(_u): AuthUser,
    Json(body): Json<CostBody>,
) -> Result<Json<adapter::HfCost>, ApiError> {
    let mut args: Vec<String> = vec!["generate".into(), "cost".into(), body.model.clone()];
    args.extend(adapter::params_to_args(&body.params));
    args.push("--json".into());
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_c, out, _e) = adapter::run_hf(&argrefs, 30).await;
    Ok(Json(adapter::parse_cost(&out)?))
}

async fn generate(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<GenBody>,
) -> Result<Json<adapter::HfJob>, ApiError> {
    // 1) create (no --wait) → job id
    let mut args: Vec<String> = vec!["generate".into(), "create".into(), body.model.clone()];
    args.extend(adapter::params_to_args(&body.params));
    args.push("--json".into());
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_c, out, _e) = adapter::run_hf(&argrefs, 60).await;
    let job_id = adapter::parse_job_id(&out)?;

    // 2) poll generate get until done / failed / timeout (~5 min)
    //    tolerate up to 5 consecutive parse failures before giving up
    let mut polls = 0u32;
    let mut parse_fails = 0u32;
    let job: adapter::HfJob = loop {
        let (_c, gout, _e) = adapter::run_hf(&["generate", "get", &job_id, "--json"], 20).await;
        match adapter::parse_job(&gout) {
            Ok(j) => {
                let done = j.is_done() || j.is_failed();
                parse_fails = 0;
                if done {
                    break j;
                }
            }
            Err(e) => {
                parse_fails += 1;
                if parse_fails > 5 {
                    return Err(e);
                }
            }
        }
        polls += 1;
        if polls > 100 {
            return Err(ApiError::Internal(
                "Generation timed out — please try again.".into(),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    };
    if job.is_failed() {
        return Err(ApiError::BadRequest(match job.failure_reason() {
            Some(w) => format!("Generation {} — {w}", job.status),
            None => format!("Generation {}.", job.status),
        }));
    }

    // 3) verify session ownership before persisting
    let sess = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&body.session_id)
        .fetch_optional(&st.auth.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("Session not found".into()))?;
    if let Some(uid) = &sess.user_id {
        if uid != &user.id {
            return Err(ApiError::Forbidden("Access denied".into()));
        }
    }

    // 4) persist a user turn + an assistant artifact turn into the session
    let prompt = body
        .params
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_text = format!("{prompt} · {}", body.model);
    super::persist::persist_studio_message(
        &st.auth.pool,
        &body.session_id,
        "user",
        &json!([{ "type": "text", "text": user_text }]),
        0.0,
    )
    .await?;
    // Best-effort: save each asset into the session folder so the user keeps a
    // local copy. Display still uses the remote URL; `saved_path` is null when
    // the folder is unset or the download fails (generation already succeeded —
    // a save failure must not lose the result).
    let dir = std::path::PathBuf::from(&sess.project_path);
    let mut blocks: Vec<serde_json::Value> = Vec::new();
    for u in job.urls() {
        let kind = if adapter::is_video_url(&u) {
            "video"
        } else {
            "image"
        };
        let saved_path: Option<String> = if sess.project_path.is_empty() {
            None
        } else {
            adapter::download_asset(&u, &dir)
                .await
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        };
        blocks.push(json!({
            "type": "artifact",
            "artifact_type": kind,
            "content": u,
            "job_id": &job.id,
            "saved_path": saved_path,
        }));
    }
    if !blocks.is_empty() {
        super::persist::persist_studio_message(
            &st.auth.pool,
            &body.session_id,
            "assistant",
            &serde_json::Value::Array(blocks),
            0.0,
        )
        .await?;
    }
    Ok(Json(job))
}
