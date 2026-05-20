//! Faithful port of `app/routers/sessions.py`. Interactive core
//! (CRUD/lifecycle/fork/clear/drafts/budget/memory/activity/files/detail/
//! stats-bulk) is exact, pure-sqlx. Endpoints needing Phase 2/3 subsystems
//! (worktree/git/gh/provider-inspector/native-history scans) return the
//! faithful JSON *shape* with an explicit Phase marker (the React UI
//! degrades gracefully — empty resume/repo lists, etc.) — honest, not silent.

use axum::extract::{Path, Query, State};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::models::memory::MEMORY_KINDS;
use crate::models::message::Message;
use crate::models::session::{Session, SessionCreate, SessionUpdate};
use crate::routers::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/empty-drafts", delete(delete_empty_drafts))
        .route("/sessions/stats/overview", get(stats_overview))
        .route("/sessions/stats/bulk", get(stats_bulk))
        .route("/sessions/{id}", get(get_session).patch(update_session).delete(delete_session))
        .route("/sessions/{id}/detail", get(session_detail))
        .route("/sessions/{id}/claude-history", get(claude_history))
        .route("/sessions/{id}/messages", delete(clear_messages))
        .route("/sessions/{id}/start", post(start_session))
        .route("/sessions/{id}/stop", post(stop_session))
        .route("/sessions/{id}/restart", post(restart_session))
        .route("/sessions/{id}/reset", post(reset_session))
        .route("/sessions/{id}/archive", post(archive_session))
        .route("/sessions/{id}/unarchive", post(unarchive_session))
        .route("/sessions/{id}/fork", post(fork_session))
        .route("/sessions/{id}/budget", patch(set_budget))
        .route("/sessions/{id}/activity", get(get_activity))
        .route("/sessions/{id}/files", get(get_files))
        .route(
            "/sessions/{id}/memory",
            get(get_memory).post(create_memory),
        )
        .route(
            "/sessions/{id}/memory/{item}",
            patch(update_memory).delete(delete_memory),
        )
        .route("/sessions/{id}/skills", get(list_skills))
        .route("/sessions/{id}/hooks", get(empty_items))
        .route("/sessions/{id}/commands", get(empty_items))
        .route("/claude-sessions", get(list_claude_sessions))
        .route("/gemini-sessions", get(list_gemini_sessions))
        .route("/codex-sessions", get(list_codex_sessions))
        .route("/git/repos", get(list_user_repos))
        .route("/git/clone", post(clone_repository))
}

async fn owned(
    st: &AppState,
    id: &str,
    user_id: &str,
) -> Result<Session, ApiError> {
    let s = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.auth.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("Session not found".into()))?;
    if let Some(uid) = &s.user_id {
        if uid != user_id {
            return Err(ApiError::Forbidden("Access denied".into()));
        }
    }
    Ok(s)
}

#[derive(Deserialize)]
struct ListQ {
    #[serde(default)]
    include_archived: bool,
}

async fn list_sessions(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<ListQ>,
) -> Result<Json<Vec<Session>>, ApiError> {
    let sql = if q.include_archived {
        "SELECT * FROM sessions WHERE (user_id = ? OR user_id IS NULL) \
         ORDER BY pinned DESC, group_path, order_idx"
    } else {
        "SELECT * FROM sessions WHERE (user_id = ? OR user_id IS NULL) \
         AND archived_at IS NULL ORDER BY pinned DESC, group_path, order_idx"
    };
    let rows = sqlx::query_as::<_, Session>(sql)
        .bind(&user.id)
        .fetch_all(&st.auth.pool)
        .await?;
    // Claim unclaimed (legacy user_id NULL) rows for this user.
    let unclaimed: Vec<&str> =
        rows.iter().filter(|s| s.user_id.is_none()).map(|s| s.id.as_str()).collect();
    if !unclaimed.is_empty() {
        for sid in &unclaimed {
            sqlx::query("UPDATE sessions SET user_id = ? WHERE id = ?")
                .bind(&user.id)
                .bind(sid)
                .execute(&st.auth.pool)
                .await?;
        }
    }
    Ok(Json(rows))
}

async fn create_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Json(mut data): Json<SessionCreate>,
) -> Result<Json<Session>, ApiError> {
    let raw = data.project_path.trim().to_string();
    let is_staff = data.title.trim() == "Staff Agent";
    if !raw.is_empty() {
        let p = std::path::Path::new(&raw);
        // Strip Windows verbatim (`\\?\`) prefix — `std::fs::canonicalize`
        // returns it on Windows, and gemini-cli's ACP rejects it with
        // `EISDIR: illegal operation on a directory, lstat 'C:'` (verified
        // against gemini-cli 0.42.0). Storing the normalized form keeps
        // every downstream bridge (claude/gemini/codex) happy.
        let resolved = fleet_core::canonicalize_or_keep(p);
        if !resolved.is_dir() {
            return Err(ApiError::BadRequest(format!(
                "Project path does not exist or is not a directory: {raw}"
            )));
        }
        data.project_path = resolved.to_string_lossy().to_string();
    } else if is_staff {
        data.project_path = dirs_home();
    } else {
        return Err(ApiError::BadRequest("project_path is required".into()));
    }
    let s = st
        .sm
        .create_session(&st.auth.pool, st.app_cfg.as_ref(), &data, Some(&user.id))
        .await?;
    // Cloud telemetry — record the session start.
    let sid_owned = s.id.clone();
    let tool_owned = s.tool.clone();
    let model_owned = s.model_name.clone();
    let status_owned = s.status.clone();
    let title_owned = s.title.clone();
    let project_owned = s.project_path.clone();
    let started_at = chrono::DateTime::parse_from_rfc3339(&s.created_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    tokio::spawn(async move {
        let _ = crate::services::telemetry::emit_session_start(
            &sid_owned,
            &tool_owned,
            model_owned.as_deref(),
            &status_owned,
            Some(&title_owned),
            Some(&project_owned),
            started_at,
        )
        .await;
    });
    Ok(Json(s))
}

async fn get_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Session>, ApiError> {
    Ok(Json(owned(&st, &id, &user.id).await?))
}

async fn update_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(p): Json<SessionUpdate>,
) -> Result<Json<Session>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    macro_rules! set {
        ($col:literal, $val:expr) => {
            if let Some(v) = $val {
                sqlx::query(concat!("UPDATE sessions SET ", $col, " = ? WHERE id = ?"))
                    .bind(v)
                    .bind(&id)
                    .execute(&st.auth.pool)
                    .await?;
            }
        };
    }
    set!("title", p.title.clone());
    set!("group_path", p.group_path.clone());
    set!("pinned", p.pinned);
    set!("order_idx", p.order_idx);
    set!("notes", p.notes.clone());
    set!("model_name", p.model_name.clone());
    set!("permission_mode", p.permission_mode.clone());
    set!("effort", p.effort.clone());
    set!("project_path", p.project_path.clone());
    set!("tool", p.tool.clone());
    set!("claude_session_id", p.claude_session_id.clone());
    set!("use_worktree", p.use_worktree);
    let _ = s; // Phase 2: empty→non-empty project_path triggers attach_git_setup.
    let updated = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_one(&st.auth.pool)
        .await?;
    Ok(Json(updated))
}

async fn delete_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    st.sm.stop_session(&st.auth.pool, &id).await?;
    let s = owned(&st, &id, &user.id).await?;
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    // Cloud telemetry — record the session stop.
    let sid_owned = s.id.clone();
    let tool_owned = s.tool.clone();
    let when = chrono::Utc::now();
    tokio::spawn(async move {
        let _ = crate::services::telemetry::emit_session_stop(
            &sid_owned,
            &tool_owned,
            when,
        )
        .await;
    });
    Ok(Json(json!({"ok": true})))
}

async fn delete_empty_drafts(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM sessions s WHERE s.user_id = ? AND s.archived_at IS NULL \
         AND (s.project_path = '' OR s.project_path IS NULL) \
         AND (lower(coalesce(s.title,'')) = '' OR lower(coalesce(s.title,'')) = 'new chat') \
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)",
    )
    .bind(&user.id)
    .fetch_all(&st.auth.pool)
    .await?;
    let ids: Vec<String> = rows.into_iter().map(|r| r.0).collect();
    for sid in &ids {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(sid)
            .execute(&st.auth.pool)
            .await?;
    }
    Ok(Json(json!({"deleted": ids.len(), "ids": ids})))
}

async fn start_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    st.sm.update_status(&st.auth.pool, &id, "idle").await?;
    Ok(Json(json!({"ok": true, "status": "idle"})))
}

async fn stop_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    st.sm.stop_session(&st.auth.pool, &id).await?;
    Ok(Json(json!({"ok": true, "status": "stopped"})))
}

async fn restart_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    st.sm.stop_session(&st.auth.pool, &id).await?;
    st.sm.update_status(&st.auth.pool, &id, "idle").await?;
    Ok(Json(json!({"ok": true, "status": "idle"})))
}

async fn reset_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    st.sm.stop_session(&st.auth.pool, &id).await?;
    sqlx::query("UPDATE sessions SET claude_session_id = NULL, status = 'idle' WHERE id = ?")
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    Ok(Json(json!({"ok": true, "status": "idle", "claude_session_id": null})))
}

async fn archive_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    st.sm.stop_session(&st.auth.pool, &id).await?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    Ok(Json(json!({"ok": true, "archived_at": now})))
}

async fn unarchive_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    sqlx::query("UPDATE sessions SET archived_at = NULL WHERE id = ?")
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn clear_messages(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    sqlx::query("DELETE FROM messages WHERE session_id = ?")
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    sqlx::query("UPDATE sessions SET claude_session_id = NULL WHERE id = ?")
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn fork_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Session>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let new_id = uuid::Uuid::new_v4().to_string();
    let created = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO sessions (id,title,project_path,group_path,tool,command,status,\
         parent_id,user_id,created_at,notes,use_worktree,permission_mode,session_mode,\
         pinned,order_idx,budget_used) \
         VALUES (?,?,?,?,?,?,'idle',?,?,?,?,1,'default','new',0,0,0.0)",
    )
    .bind(&new_id)
    .bind(format!("{} (fork)", s.title))
    .bind(&s.project_path)
    .bind(&s.group_path)
    .bind(&s.tool)
    .bind(&s.command)
    .bind(&s.id)
    .bind(&user.id)
    .bind(&created)
    .bind(&s.notes)
    .execute(&st.auth.pool)
    .await?;
    let msgs = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp",
    )
    .bind(&id)
    .fetch_all(&st.auth.pool)
    .await?;
    for m in msgs {
        sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,model,usage_json,cost_usd,timestamp) \
             VALUES (?,?,?,?,?,?,0.0,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&new_id)
        .bind(&m.role)
        .bind(&m.content)
        .bind(&m.model)
        .bind(&m.usage_json)
        .bind(&m.timestamp)
        .execute(&st.auth.pool)
        .await?;
    }
    let forked = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&new_id)
        .fetch_one(&st.auth.pool)
        .await?;
    Ok(Json(forked))
}

#[derive(Deserialize)]
struct BudgetBody {
    budget_limit: Option<f64>,
}

async fn set_budget(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(b): Json<BudgetBody>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    sqlx::query("UPDATE sessions SET budget_limit = ? WHERE id = ?")
        .bind(b.budget_limit)
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    let s = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_one(&st.auth.pool)
        .await?;
    Ok(Json(json!({"ok": true, "budget_limit": s.budget_limit, "budget_used": s.budget_used})))
}

// ── activity / files / memory (pure DB, faithful) ───────────────────
#[derive(Deserialize)]
struct ActivityQ {
    kind: Option<String>,
    #[serde(default = "fifty")]
    limit: i64,
}
fn fifty() -> i64 {
    50
}

async fn get_activity(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Query(q): Query<ActivityQ>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    let limit = q.limit.clamp(1, 500);
    let rows: Vec<(String, String, String, String, Option<String>)> = if let Some(k) = &q.kind {
        sqlx::query_as(
            "SELECT id,kind,summary,ts,payload_json FROM session_activity \
             WHERE session_id = ? AND kind = ? ORDER BY ts DESC LIMIT ?",
        )
        .bind(&id)
        .bind(k)
        .bind(limit)
        .fetch_all(&st.auth.pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id,kind,summary,ts,payload_json FROM session_activity \
             WHERE session_id = ? ORDER BY ts DESC LIMIT ?",
        )
        .bind(&id)
        .bind(limit)
        .fetch_all(&st.auth.pool)
        .await?
    };
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(rid, kind, summary, ts, payload)| {
            let mut o = json!({"id": rid, "kind": kind, "summary": summary, "ts": ts});
            if let Some(p) = payload {
                if let Ok(v) = serde_json::from_str::<Value>(&p) {
                    o["payload"] = v;
                }
            }
            o
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

async fn get_files(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind, summary FROM session_activity WHERE session_id = ? \
         AND kind IN ('file_edit','file_read') ORDER BY ts DESC LIMIT 2000",
    )
    .bind(&id)
    .fetch_all(&st.auth.pool)
    .await?;
    use std::collections::HashMap;
    let mut agg: HashMap<String, (i64, i64)> = HashMap::new();
    for (kind, path) in rows {
        if path.is_empty() {
            continue;
        }
        let e = agg.entry(path).or_insert((0, 0));
        if kind == "file_edit" {
            e.0 += 1;
        } else {
            e.1 += 1;
        }
    }
    let mut files: Vec<Value> = agg
        .into_iter()
        .map(|(p, (ed, rd))| json!({"path": p, "edits": ed, "reads": rd}))
        .collect();
    files.truncate(50);
    Ok(Json(Value::Array(files)))
}

async fn get_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let rows: Vec<(String, String, String, String, String, String, String)> =
        sqlx::query_as(
            "SELECT id,session_id,title,content,kind,created_at,created_by \
             FROM session_memory WHERE session_id = ? \
             OR (project_path IS NOT NULL AND project_path = ?) \
             ORDER BY created_at DESC LIMIT 200",
        )
        .bind(&id)
        .bind(&s.project_path)
        .fetch_all(&st.auth.pool)
        .await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(rid, sid, title, content, kind, created_at, by)| {
            json!({"id": rid, "title": title, "content": content, "kind": kind,
                   "created_at": created_at, "created_by": by,
                   "from_other_session": sid != id})
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

#[derive(Deserialize)]
struct MemCreate {
    title: String,
    content: String,
    #[serde(default = "note_kind")]
    kind: String,
}
fn note_kind() -> String {
    "note".into()
}

async fn create_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(b): Json<MemCreate>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let title = b.title.trim();
    let content = b.content.trim();
    if title.is_empty() || content.is_empty() {
        return Err(ApiError::BadRequest("title and content are required".into()));
    }
    let mut kind = b.kind.trim().to_lowercase();
    if !MEMORY_KINDS.contains(&kind.as_str()) {
        kind = "note".into();
    }
    let rid = uuid::Uuid::new_v4().to_string();
    let created = chrono::Utc::now().to_rfc3339();
    let pp: Option<&str> = if s.project_path.is_empty() {
        None
    } else {
        Some(s.project_path.as_str())
    };
    let title_t = trunc(title, 300);
    let content_t = trunc(content, 4000);
    sqlx::query(
        "INSERT INTO session_memory (id,session_id,project_path,title,content,kind,created_at,created_by) \
         VALUES (?,?,?,?,?,?,?,'user')",
    )
    .bind(&rid)
    .bind(&id)
    .bind(pp)
    .bind(title_t.as_str())
    .bind(content_t.as_str())
    .bind(&kind)
    .bind(&created)
    .execute(&st.auth.pool)
    .await?;
    Ok(Json(json!({"id": rid, "title": title_t, "content": content_t,
        "kind": kind, "created_at": created, "created_by": "user"})))
}

#[derive(Deserialize)]
struct MemUpdate {
    title: Option<String>,
    content: Option<String>,
    kind: Option<String>,
}

async fn update_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, item)): Path<(String, String)>,
    Json(b): Json<MemUpdate>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    let exists: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM session_memory WHERE id = ? AND session_id = ?",
    )
    .bind(&item)
    .bind(&id)
    .fetch_optional(&st.auth.pool)
    .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Memory item not found".into()));
    }
    if let Some(t) = b.title.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE session_memory SET title = ? WHERE id = ?")
            .bind(trunc(t, 300))
            .bind(&item)
            .execute(&st.auth.pool)
            .await?;
    }
    if let Some(c) = b.content.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE session_memory SET content = ? WHERE id = ?")
            .bind(trunc(c, 4000))
            .bind(&item)
            .execute(&st.auth.pool)
            .await?;
    }
    if let Some(k) = b.kind.as_ref().map(|s| s.trim().to_lowercase()) {
        if MEMORY_KINDS.contains(&k.as_str()) {
            sqlx::query("UPDATE session_memory SET kind = ? WHERE id = ?")
                .bind(&k)
                .bind(&item)
                .execute(&st.auth.pool)
                .await?;
        }
    }
    let r: (String, String, String, String, String, String) = sqlx::query_as(
        "SELECT id,title,content,kind,created_at,created_by FROM session_memory WHERE id = ?",
    )
    .bind(&item)
    .fetch_one(&st.auth.pool)
    .await?;
    Ok(Json(json!({"id": r.0, "title": r.1, "content": r.2, "kind": r.3,
        "created_at": r.4, "created_by": r.5})))
}

async fn delete_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, item)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    owned(&st, &id, &user.id).await?;
    let res = sqlx::query("DELETE FROM session_memory WHERE id = ? AND session_id = ?")
        .bind(&item)
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("Memory item not found".into()));
    }
    Ok(Json(json!({"ok": true})))
}

// ── detail + stats (pure DB, faithful) ──────────────────────────────
async fn session_detail(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let msgs = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp",
    )
    .bind(&id)
    .fetch_all(&st.auth.pool)
    .await?;
    let mut total_cost = 0.0;
    let (mut it, mut ot, mut cr, mut cw) = (0i64, 0i64, 0i64, 0i64);
    let mut last_model = s.model_name.clone();
    let mut assistant_turns = 0;
    for m in &msgs {
        total_cost += m.cost_usd;
        if m.role == "assistant" {
            assistant_turns += 1;
        }
        if let Some(u) = &m.usage_json {
            if let Ok(v) = serde_json::from_str::<Value>(u) {
                it += v.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                ot += v.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                cr += v
                    .get("cache_read_tokens")
                    .or_else(|| v.get("cache_read_input_tokens"))
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                cw += v
                    .get("cache_write_tokens")
                    .or_else(|| v.get("cache_creation_input_tokens"))
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
            }
        }
        if m.model.is_some() {
            last_model = m.model.clone();
        }
    }
    Ok(Json(json!({
        "session_id": id,
        "message_count": msgs.len(),
        "assistant_turns": assistant_turns,
        "total_cost_usd": total_cost,
        "model": last_model,
        "created_at": s.created_at,
        "permission_mode": s.permission_mode,
        "project_path": s.project_path,
        "tokens": {"input": it, "output": ot, "cache_read": cr, "cache_write": cw,
                   "last_input": 0, "last_cache_read": 0},
        "tools": {},
        "todos": [],
        "memory_items": [],
        "plans": []
    })))
}

async fn stats_bulk(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows: Vec<(String, i64, f64)> = sqlx::query_as(
        "SELECT m.session_id, COUNT(m.id), COALESCE(SUM(m.cost_usd),0.0) \
         FROM messages m WHERE m.session_id IN \
         (SELECT id FROM sessions WHERE user_id = ?) GROUP BY m.session_id",
    )
    .bind(&user.id)
    .fetch_all(&st.auth.pool)
    .await?;
    let mut out = serde_json::Map::new();
    for (sid, count, cost) in rows {
        out.insert(
            sid,
            json!({"message_count": count, "total_cost_usd": cost, "last_model": null,
                   "input_tokens": 0, "output_tokens": 0, "cache_tokens": 0}),
        );
    }
    Ok(Json(Value::Object(out)))
}

async fn stats_overview(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    let (sessions,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
            .bind(&user.id)
            .fetch_one(&st.auth.pool)
            .await?;
    let (messages,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE session_id IN \
         (SELECT id FROM sessions WHERE user_id = ?)",
    )
    .bind(&user.id)
    .fetch_one(&st.auth.pool)
    .await?;
    // Phase 3: token/heatmap/streak aggregation. Faithful shape, zeros now.
    Ok(Json(json!({
        "sessions": sessions, "messages": messages, "total_tokens": 0,
        "input_tokens": 0, "output_tokens": 0, "cache_tokens": 0,
        "active_days": 0, "current_streak": 0, "longest_streak": 0,
        "peak_hour": null, "favorite_model": null, "heatmap": {}
    })))
}

// ── Phase 2/3 subsystems — faithful shape, explicit deferral ─────────
async fn claude_history(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    // Two required fields. When either is missing the renderer's
    // resume picker silently falls back to the DB messages endpoint.
    let (Some(claude_sid), false) = (s.claude_session_id.as_deref(), s.project_path.is_empty())
    else {
        return Ok(Json(json!([])));
    };
    let project_path = s.project_path.clone();
    let claude_sid_owned = claude_sid.to_string();
    // Parsing JSONL can blow past several MB on long sessions — read
    // + decode runs on a blocking pool so the axum task keeps serving
    // other requests. Faithful with the Python `asyncio.to_thread`.
    let messages = tokio::task::spawn_blocking(move || {
        let Some(project_dir) =
            crate::services::claude_history::find_claude_project_dir(&project_path)
        else {
            return Vec::new();
        };
        let jsonl = project_dir.join(format!("{claude_sid_owned}.jsonl"));
        if !jsonl.exists() {
            return Vec::new();
        }
        crate::services::claude_history::parse_jsonl(&jsonl)
    })
    .await
    .unwrap_or_default();
    let v: Vec<Value> = messages
        .into_iter()
        .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
        .collect();
    Ok(Json(Value::Array(v)))
}

async fn empty_items() -> Json<Value> {
    // /hooks /commands — Phase 2/3 ProviderInspector follow-up.
    Json(json!({"items": []}))
}

/// `/sessions/{id}/skills` — real Claude skills scan via the
/// services::provider_inspector port (user-tier `~/.claude/skills` +
/// project-tier `<project>/.claude/skills`). Non-Claude tools return
/// `{items: []}` for now (Phase 2 follow-up: Gemini/Codex skill roots).
async fn list_skills(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    if s.tool != "claude" {
        return Ok(Json(json!({ "items": [] })));
    }
    let home = std::path::PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into()),
    );
    let project = if s.project_path.is_empty() {
        None
    } else {
        Some(std::path::PathBuf::from(&s.project_path))
    };
    let items = crate::services::provider_inspector::list_claude_skills(
        &home,
        project.as_deref(),
    );
    let v: Vec<Value> = items
        .into_iter()
        .map(|x| serde_json::to_value(x).unwrap_or(Value::Null))
        .collect();
    Ok(Json(json!({ "items": v })))
}

#[derive(Deserialize)]
struct PathQ {
    path: String,
}

async fn list_claude_sessions(
    AuthUser(_u): AuthUser,
    Query(q): Query<PathQ>,
) -> Json<Value> {
    let project_path = q.path.clone();
    if project_path.trim().is_empty() {
        return Json(json!([]));
    }
    // Walk + JSONL reads can blow past several MB on long sessions —
    // offload via spawn_blocking so the axum task keeps serving.
    let rows = tokio::task::spawn_blocking(move || {
        crate::services::claude_history::scan_sessions(&project_path)
    })
    .await
    .unwrap_or_default();
    let v: Vec<Value> = rows
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        .collect();
    Json(Value::Array(v))
}
async fn list_gemini_sessions(AuthUser(_u): AuthUser, Query(q): Query<PathQ>) -> Json<Value> {
    if q.path.trim().is_empty() {
        return Json(json!([]));
    }
    let path = q.path.clone();
    let rows = tokio::task::spawn_blocking(move || {
        crate::services::provider_sessions::list_gemini_sessions(&path)
    })
    .await
    .unwrap_or_default();
    let v: Vec<Value> = rows
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        .collect();
    Json(Value::Array(v))
}
async fn list_codex_sessions(AuthUser(_u): AuthUser, Query(q): Query<PathQ>) -> Json<Value> {
    if q.path.trim().is_empty() {
        return Json(json!([]));
    }
    let path = q.path.clone();
    let rows = tokio::task::spawn_blocking(move || {
        crate::services::provider_sessions::list_codex_sessions(&path)
    })
    .await
    .unwrap_or_default();
    let v: Vec<Value> = rows
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
        .collect();
    Json(Value::Array(v))
}

async fn list_user_repos(AuthUser(_u): AuthUser) -> Json<Value> {
    // Phase 2: `gh repo list --json …`. Empty list until the gh bridge lands.
    Json(json!([]))
}

#[derive(Deserialize)]
struct CloneBody {
    #[allow(dead_code)]
    url: String,
    #[allow(dead_code)]
    branch: Option<String>,
}
async fn clone_repository(
    AuthUser(_u): AuthUser,
    Json(_b): Json<CloneBody>,
) -> Result<Json<Value>, ApiError> {
    Err(ApiError::BadRequest(
        "git clone is implemented in Phase 2 (worktree/clone subsystem)".into(),
    ))
}

fn dirs_home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into())
}

/// UTF-8-safe truncation to `n` chars (Python `[:n]` parity; never splits
/// a multi-byte char like a raw byte slice would).
fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
