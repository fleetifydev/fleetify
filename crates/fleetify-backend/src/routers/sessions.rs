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
        .route("/sessions/spawn", post(spawn_session))
        .route("/sessions/empty-drafts", delete(delete_empty_drafts))
        .route("/sessions/stats/overview", get(stats_overview))
        .route("/sessions/stats/bulk", get(stats_bulk))
        .route(
            "/sessions/{id}",
            get(get_session)
                .patch(update_session)
                .delete(delete_session),
        )
        .route("/sessions/{id}/detail", get(session_detail))
        .route("/sessions/{id}/routing", get(get_session_routing))
        .route("/sessions/{id}/claude-history", get(claude_history))
        .route("/sessions/{id}/messages", delete(clear_messages))
        .route("/sessions/{id}/start", post(start_session))
        .route("/sessions/{id}/stop", post(stop_session))
        .route("/sessions/{id}/restart", post(restart_session))
        .route("/sessions/{id}/reset", post(reset_session))
        .route("/sessions/{id}/archive", post(archive_session))
        .route("/sessions/{id}/unarchive", post(unarchive_session))
        .route("/sessions/{id}/fork", post(fork_session))
        .route(
            "/sessions/{id}/worktree/next-round",
            post(next_round_worktree),
        )
        .route("/sessions/{id}/budget", patch(set_budget))
        .route("/sessions/{id}/activity", get(get_activity))
        .route("/sessions/{id}/files", get(get_files))
        .route("/sessions/{id}/diff", get(get_diff))
        .route("/sessions/{id}/memory", get(get_memory).post(create_memory))
        .route("/sessions/{id}/memory-files", get(get_memory_files))
        .route(
            "/sessions/{id}/memory/{item}",
            patch(update_memory).delete(delete_memory),
        )
        .route("/sessions/{id}/skills", get(list_skills))
        .route("/sessions/{id}/hooks", get(list_hooks))
        .route("/sessions/{id}/commands", get(list_commands))
        .route(
            "/sessions/{id}/rules",
            get(get_session_rules).put(set_session_rules),
        )
        .route("/claude-sessions", get(list_claude_sessions))
        .route("/codex-sessions", get(list_codex_sessions))
        .route("/git/repos", get(list_user_repos))
        .route("/git/clone", post(clone_repository))
        .route("/git/check", post(check_repo_accessible))
}

/// `POST /api/sessions/spawn` — create a session from an already-resolved,
/// user-edited `SpawnSpec` (the inline Spawn Form card's "Create"). The spec
/// is canonical here; we only re-validate `project_path` (required, must be a
/// real dir), mirroring `create_session`, before delegating to the shared
/// spawn core.
async fn spawn_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Json(spec): Json<crate::services::spawn::SpawnSpec>,
) -> Result<Json<Session>, ApiError> {
    // Re-resolve through the canonicaliser so the form can pass human-ish
    // edits (e.g. "opus 4.8" / "claude code"); the folder picker supplies an
    // absolute project_path, which resolves to itself.
    let raw = crate::services::spawn::RawSpawn {
        title: spec.title,
        project: spec.project_path,
        tool: spec.tool,
        model: spec.model_name,
        perm: spec.permission_mode,
        template: spec.agent_template,
        effort: spec.effort,
        task: spec.first_task,
        worktree: spec.use_worktree,
    };
    let known = crate::services::spawn::known_project_paths(&st.auth.pool, Some(&user.id)).await;
    let mut resolved = crate::services::spawn::resolve(&raw, &known);
    // User-facing path: an absent first task falls back to the kickoff
    // message (agents are never created idle from the chat/picker flow).
    if resolved.spec.first_task.is_none() {
        resolved.spec.first_task = Some(crate::services::spawn::DEFAULT_KICKOFF_TASK.to_string());
    }
    if !resolved.gaps.is_empty() {
        let fields: Vec<String> = resolved.gaps.iter().map(|g| g.field.clone()).collect();
        return Err(ApiError::BadRequest(format!(
            "spawn spec incomplete; unresolved fields: {}",
            fields.join(", ")
        )));
    }
    // project_path must be a real directory (mirror create_session).
    if let Some(p) = resolved.spec.project_path.as_deref() {
        let canon = fleetify_core::canonicalize_or_keep(std::path::Path::new(p));
        if !canon.is_dir() {
            return Err(ApiError::BadRequest(format!(
                "Project path does not exist or is not a directory: {p}"
            )));
        }
    }
    let s = crate::services::spawn::create(&st, Some(&user.id), &resolved.spec, None)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    Ok(Json(s))
}

async fn owned(st: &AppState, id: &str, user_id: &str) -> Result<Session, ApiError> {
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
    let mut rows = sqlx::query_as::<_, Session>(sql)
        .bind(&user.id)
        .fetch_all(&st.auth.pool)
        .await?;
    // Claim unclaimed (legacy user_id NULL) rows for this user in ONE batched
    // UPDATE instead of N round-trips, then reflect the claim in the returned
    // rows so the UI sees the owned state immediately (no extra refetch).
    let unclaimed: Vec<String> = rows
        .iter()
        .filter(|s| s.user_id.is_none())
        .map(|s| s.id.clone())
        .collect();
    if !unclaimed.is_empty() {
        let placeholders = vec!["?"; unclaimed.len()].join(",");
        let update_sql = format!("UPDATE sessions SET user_id = ? WHERE id IN ({placeholders})");
        let mut q = sqlx::query(&update_sql).bind(&user.id);
        for sid in &unclaimed {
            q = q.bind(sid);
        }
        q.execute(&st.auth.pool).await?;
        for s in rows.iter_mut().filter(|s| s.user_id.is_none()) {
            s.user_id = Some(user.id.clone());
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
    let is_studio = crate::studio::registry::find_studio_tool(&data.tool).is_some();

    // Staff session is unique per user. Returning the existing row keeps
    // the renderer's lazy "create on first send" path idempotent across
    // cold-starts — without this, every race between localStorage hydration
    // and the user typing in Fleet produced a fresh "Staff Agent" row that
    // then leaked into the sidebar as a duplicate agent.
    //
    // We also archive any older Staff Agent rows for the same user so
    // legacy duplicates (created by earlier builds) stop polluting the
    // session list on the next fetch.
    if is_staff {
        let mut staff_rows: Vec<Session> = sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions \
             WHERE user_id = ? AND title = 'Staff Agent' AND archived_at IS NULL \
             ORDER BY created_at ASC",
        )
        .bind(&user.id)
        .fetch_all(&st.auth.pool)
        .await?;
        if let Some(keeper) = staff_rows.first().cloned() {
            // Archive every extra Staff Agent row beyond the first so the
            // user converges to exactly one canonical staff session.
            for extra in staff_rows.drain(1..) {
                let _ = sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ?")
                    .bind(chrono::Utc::now().to_rfc3339())
                    .bind(&extra.id)
                    .execute(&st.auth.pool)
                    .await;
            }
            return Ok(Json(keeper));
        }
    }

    if !raw.is_empty() {
        let p = std::path::Path::new(&raw);
        // Strip Windows verbatim (`\\?\`) prefix — `std::fs::canonicalize`
        // returns it on Windows, and some ACP agents reject it with
        // `EISDIR: illegal operation on a directory, lstat 'C:'`. Storing
        // the normalized form keeps every downstream bridge (claude/codex)
        // happy.
        let resolved = fleetify_core::canonicalize_or_keep(p);
        if !resolved.is_dir() {
            return Err(ApiError::BadRequest(format!(
                "Project path does not exist or is not a directory: {raw}"
            )));
        }
        data.project_path = resolved.to_string_lossy().to_string();
    } else if is_staff || is_studio {
        data.project_path = dirs_home();
    } else {
        return Err(ApiError::BadRequest("project_path is required".into()));
    }
    if is_studio {
        data.use_worktree = false;
    }
    let s = st
        .sm
        .create_session(&st.auth.pool, st.app_cfg.as_ref(), &data, Some(&user.id))
        .await?;
    // Seed the routing pin from the caller-provided (tool, model) so the
    // first turn's `resolve_routing_for_turn` Branch 1 returns the user's
    // choice without ever running the decision router. Mirrors the PATCH
    // path's pin refresh — without this seed, the first message's
    // auto-routing decision would override the user's onboarding/composer
    // pick (e.g. user picks Codex+gpt-5.2 in the composer, first turn
    // routes to Claude because the decision router has no reason to favour
    // the user's manual model when no pin exists yet). `model_name`
    // arrives as `Option<String>` from `SessionCreate`; when None, we
    // leave the pin's model column NULL so a subsequent picker pick can
    // initialise it cleanly.
    if let Some(model) = s.model_name.as_deref() {
        let _ = sqlx::query(
            "UPDATE sessions \
             SET pinned_agent = ?, pinned_model = ?, routing_decision_id = NULL \
             WHERE id = ?",
        )
        .bind(&s.tool)
        .bind(model)
        .bind(&s.id)
        .execute(&st.auth.pool)
        .await;
    }
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
    set!("sandbox", p.sandbox.clone());
    set!("tool_overrides", p.tool_overrides.clone());
    set!("project_path", p.project_path.clone());
    set!("tool", p.tool.clone());
    set!("claude_session_id", p.claude_session_id.clone());
    set!("use_worktree", p.use_worktree);
    set!("account_id", p.account_id.clone());
    // Manual picker selection wins over any prior routing decision.
    // `pinned_agent` / `pinned_model` are sticky across the session's
    // lifetime (Branch 1 of `resolve_routing_for_turn`), so without
    // this refresh the very first auto-routed turn would lock the
    // session to (Claude, claude-sonnet-4-6) forever — every later
    // picker switch would log "decision picked a different agent than
    // session.tool; keeping bridge identity, applying model override
    // only", which for Codex / Antigravity (TOML-only model config)
    // is unrecoverable: the bridge ignores the override and stalls
    // because the staff turn never actually dispatches to the model
    // the user selected. Refreshing the pin to mirror the latest
    // tool / model_name turns the user's pick into the next turn's
    // Branch-1 hit, no warning, no override mismatch.
    if p.tool.is_some() || p.model_name.is_some() {
        let refreshed_session = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_one(&st.auth.pool)
            .await?;
        sqlx::query(
            "UPDATE sessions \
             SET pinned_agent = ?, pinned_model = ?, routing_decision_id = NULL \
             WHERE id = ?",
        )
        .bind(&refreshed_session.tool)
        .bind(refreshed_session.model_name.as_deref())
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    }
    // ── Empty→non-empty project_path upgrades trigger worktree carve ──
    // A session created without a folder (the "scratch" path) becomes a
    // real workspace the first time the user binds it to a directory.
    // Same idempotent worktree/branch logic the create_session flow
    // runs, so the user's first PATCH lands a fleet/<slug>-<id> branch
    // exactly like a brand-new agent.
    let upgraded_project = matches!(
        (&p.project_path, s.project_path.is_empty()),
        (Some(new_path), true) if !new_path.trim().is_empty(),
    );
    if upgraded_project {
        // Re-fetch the row so attach_git_setup sees the new path.
        let refreshed = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_one(&st.auth.pool)
            .await?;
        st.sm.attach_git_setup(&st.auth.pool, &refreshed).await;
    }
    let updated = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_one(&st.auth.pool)
        .await?;
    Ok(Json(updated))
}

#[derive(Deserialize, Default)]
struct NextRoundReq {
    /// Base branch to carve the next round from; None → resolved server-side.
    base: Option<String>,
}

/// `POST /api/sessions/{id}/worktree/next-round` — advance a worktree session
/// to its next round: carve a fresh pristine worktree on a new `-r<N>` branch
/// off `origin/<base>` (local `<base>` fallback when offline), repoint the
/// session (its cwd follows on the next turn), then tear down the merged
/// round's worktree + its local branch. Repoint happens BEFORE teardown so the
/// session is never pointing at a missing directory (create-before-remove —
/// zero window). LOCAL git + DB only; remote-branch deletion is the renderer's
/// best-effort job (auth lives in the Tauri shell).
async fn next_round_worktree(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(req): Json<NextRoundReq>,
) -> Result<Json<Value>, ApiError> {
    use crate::services::worktree;
    let s = owned(&st, &id, &user.id).await?;
    if !s.use_worktree {
        return Err(ApiError::BadRequest(
            "session is not in worktree mode".into(),
        ));
    }
    let Some(old_path) = s.worktree_path.clone().filter(|p| !p.is_empty()) else {
        return Err(ApiError::BadRequest(
            "session has no worktree to advance".into(),
        ));
    };
    let label = if s.title.trim().is_empty() {
        "session".to_string()
    } else {
        s.title.clone()
    };
    let (new_path, new_branch) = worktree::carve_next_round_worktree(
        &s.project_path,
        &s.id,
        Some(&label),
        s.worktree_branch.as_deref(),
        req.base.as_deref(),
    )
    .await
    .map_err(|e| ApiError::Internal(e.0))?;

    // Repoint BEFORE teardown so the session is never pointing at a missing dir.
    sqlx::query("UPDATE sessions SET worktree_path = ?, worktree_branch = ? WHERE id = ?")
        .bind(&new_path)
        .bind(&new_branch)
        .bind(&s.id)
        .execute(&st.auth.pool)
        .await?;

    // Best-effort teardown of the merged round (local only).
    let old_branch = s.worktree_branch.clone().unwrap_or_default();
    let _ = worktree::remove_worktree(&s.project_path, &old_path).await;
    if !old_branch.is_empty() && old_branch != new_branch {
        let _ = worktree::delete_local_branch(&s.project_path, &old_branch).await;
    }

    let updated = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
        .bind(&s.id)
        .fetch_one(&st.auth.pool)
        .await?;
    tracing::info!(session_id=%s.id, %new_path, %new_branch, removed=%old_branch,
        "session.worktree.next_round");
    Ok(Json(
        json!({ "ok": true, "session": updated, "removedBranch": old_branch }),
    ))
}

/// Hard-delete a session row for real.
///
/// Four tables reference `sessions(id)` without ON DELETE CASCADE (`messages`,
/// `cost_events`, `session_activity`, `session_memory` — 0001_init.sql), and
/// the pool runs with `foreign_keys=ON` (db.rs). So a bare
/// `DELETE FROM sessions` fails with SQLITE_CONSTRAINT_FOREIGNKEY the moment
/// the session has a single message — which is every session that ever ran a
/// turn. That was the "deleted session comes back after restart" bug: the
/// handler 500'd, the sidebar swallowed the rejection, and the in-memory
/// `_removedIds` tombstone hid the row until the next launch resurfaced it.
///
/// One transaction, children first, so a crash mid-way can never leave a
/// session stripped of its transcript but still alive.
async fn hard_delete_session(pool: &sqlx::SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for sql in [
        "DELETE FROM messages WHERE session_id = ?",
        "DELETE FROM cost_events WHERE session_id = ?",
        "DELETE FROM session_activity WHERE session_id = ?",
        "DELETE FROM session_memory WHERE session_id = ?",
        "DELETE FROM sessions WHERE id = ?",
    ] {
        sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await
}

async fn delete_session(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    st.sm.stop_session(&st.auth.pool, &id).await?;
    let s = owned(&st, &id, &user.id).await?;
    // Tear down the session's git worktree (if any) BEFORE removing the
    // row — once the DB forgets `worktree_path` we can't reconstruct
    // where to look. The branch itself is intentionally preserved so
    // the user can resume the work on another machine or by carving a
    // new session off the same name.
    if let Some(wt) = s.worktree_path.as_deref() {
        let _ = crate::services::worktree::remove_worktree(&s.project_path, wt).await;
    }
    if s.origin.as_deref() == Some("claude-bg") {
        // Auto-surfaced background session: ARCHIVE instead of hard-deleting so
        // a tombstone remains. The background-agent poller respects an archived
        // bg row and never re-surfaces that conversation — otherwise deleting it
        // while its Claude agent is still alive would just spawn the row back.
        sqlx::query("UPDATE sessions SET archived_at = ? WHERE id = ?")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&id)
            .execute(&st.auth.pool)
            .await?;
    } else {
        hard_delete_session(&st.auth.pool, &id).await?;
    }
    // Cloud telemetry — record the session stop.
    let sid_owned = s.id.clone();
    let tool_owned = s.tool.clone();
    let when = chrono::Utc::now();
    tokio::spawn(async move {
        let _ = crate::services::telemetry::emit_session_stop(&sid_owned, &tool_owned, when).await;
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
        // Same FK trap as delete_session: "no messages" does NOT mean "no
        // children" — a draft that was started once can still own
        // session_activity / cost_events rows, and those block the bare DELETE.
        hard_delete_session(&st.auth.pool, sid).await?;
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
    Ok(Json(
        json!({"ok": true, "status": "idle", "claude_session_id": null}),
    ))
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
         account_id,pinned,order_idx,budget_used) \
         VALUES (?,?,?,?,?,?,'idle',?,?,?,?,1,'default','new',?,0,0,0.0)",
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
    .bind(&s.account_id)
    .execute(&st.auth.pool)
    .await?;
    let msgs = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp",
    )
    .bind(&id)
    .fetch_all(&st.auth.pool)
    .await?;
    // Copy every message under ONE transaction so the fork commits once
    // instead of fsync-ing per message (the N+1 round-trips under WAL+NORMAL).
    if !msgs.is_empty() {
        let mut tx = st.auth.pool.begin().await?;
        for m in &msgs {
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
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
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
    Ok(Json(
        json!({"ok": true, "budget_limit": s.budget_limit, "budget_used": s.budget_used}),
    ))
}

// ── per-session rules ────────────────────────────────────────────────
#[derive(Deserialize)]
struct RulesBody {
    #[serde(default)]
    rules: String,
}

/// `GET /api/sessions/{id}/rules` — the session's current rule text (or "").
async fn get_session_rules(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    Ok(Json(
        json!({ "rules": s.session_rules.unwrap_or_default() }),
    ))
}

/// `PUT /api/sessions/{id}/rules` — persist the session's rule text and
/// materialize it (or strip it, when empty) into the session's working-dir
/// rule file for its provider, so the CLI reads it automatically on next spawn.
async fn set_session_rules(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(b): Json<RulesBody>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let rules = b.rules.trim().to_string();
    apply_session_rules(&s, &rules);
    let stored: Option<String> = (!rules.is_empty()).then(|| rules.clone());
    sqlx::query("UPDATE sessions SET session_rules = ? WHERE id = ?")
        .bind(&stored)
        .bind(&id)
        .execute(&st.auth.pool)
        .await?;
    Ok(Json(
        json!({ "ok": true, "rules": stored.unwrap_or_default() }),
    ))
}

/// The working directory a session's provider spawns in (mirrors chat.rs:
/// worktree checkout when present, else the in-place project path).
fn session_workdir(s: &Session) -> Option<std::path::PathBuf> {
    let dir = s
        .worktree_path
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| s.project_path.clone());
    (!dir.trim().is_empty()).then(|| std::path::PathBuf::from(dir))
}

/// Materialize (or strip, when `rules` is empty) the session rule into its
/// working-dir rule file for the session's provider. Best-effort: filesystem
/// errors are swallowed — the DB row is the source of truth and the next spawn
/// re-applies. The block is keyed by session id so it coexists with the user's
/// own project rule file and any sibling session in the same in-place dir.
fn apply_session_rules(s: &Session, rules: &str) {
    use crate::services::plugins::rule_merge::{self, RuleMergeRecord};

    let Some(dir) = session_workdir(s) else {
        return;
    };
    // `s.tool` is already the canonical provider id (migrations keep it current).
    let provider = s.tool.clone();
    let slug = format!("session-{}", s.id);

    // Cursor: a project-scoped standalone `.cursor/rules/<slug>.mdc`.
    if provider == "cursor-cli" {
        let mdc = dir
            .join(".cursor")
            .join("rules")
            .join(format!("{slug}.mdc"));
        if rules.is_empty() {
            let _ = std::fs::remove_file(&mdc);
        } else if mdc
            .parent()
            .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
        {
            let body = format!(
                "---\ndescription: Session rule\nalwaysApply: true\n---\n\n{}\n",
                rules.trim_end()
            );
            let _ = std::fs::write(&mdc, body);
        }
        return;
    }

    // Everything else: a slug-fenced block merged into the project rule file.
    let Some(file) = rule_merge::project_rule_file(&provider, &dir) else {
        return;
    };
    if rules.is_empty() {
        rule_merge::unmaterialize_rule(&RuleMergeRecord {
            provider,
            file: file.to_string_lossy().into_owned(),
            slug,
        });
    } else {
        let _ = rule_merge::write_block(&provider, &slug, rules, &file);
    }
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

struct WorkingDiff {
    diff: String,
    file_count: usize,
    is_repo: bool,
}

/// Working-tree (uncommitted, tracked) diff via the `git` CLI. Empty cwd or a
/// non-repo returns `is_repo: false`; diff text is capped so the card stays sane.
async fn git_working_diff(cwd: &str) -> WorkingDiff {
    if cwd.is_empty() {
        return WorkingDiff {
            diff: String::new(),
            file_count: 0,
            is_repo: false,
        };
    }
    let inside = tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(cwd)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !inside {
        return WorkingDiff {
            diff: String::new(),
            file_count: 0,
            is_repo: false,
        };
    }
    let mut diff = tokio::process::Command::new("git")
        .args(["diff"])
        .current_dir(cwd)
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    const CAP: usize = 100_000;
    if diff.len() > CAP {
        diff = format!("{}\n… (diff truncated)", trunc(&diff, CAP));
    }
    let file_count = tokio::process::Command::new("git")
        .args(["diff", "--name-only"])
        .current_dir(cwd)
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        })
        .unwrap_or(0);
    WorkingDiff {
        diff,
        file_count,
        is_repo: true,
    }
}

/// `GET /api/sessions/{id}/diff` — the session's working-tree git diff, rendered
/// as a card. Worktree-aware (uses `worktree_path` when set, else `project_path`).
async fn get_diff(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let cwd = s
        .worktree_path
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| s.project_path.clone());
    let r = git_working_diff(&cwd).await;
    Ok(Json(json!({
        "diff": r.diff,
        "file_count": r.file_count,
        "is_repo": r.is_repo,
        "cwd": cwd,
    })))
}

/// The CLAUDE.md memory files that govern a session: the project CLAUDE.md (in
/// the session cwd) and the user-global ~/.claude/CLAUDE.md. Missing files are
/// omitted. Distinct from `get_memory` (the session_memory notes table).
fn collect_claude_memory_files(cwd: &str, home: &str) -> Vec<Value> {
    let mut candidates: Vec<(std::path::PathBuf, &str)> = Vec::new();
    if !cwd.is_empty() {
        candidates.push((std::path::Path::new(cwd).join("CLAUDE.md"), "project"));
    }
    if !home.is_empty() {
        candidates.push((
            std::path::Path::new(home).join(".claude").join("CLAUDE.md"),
            "user",
        ));
    }
    let mut out: Vec<Value> = Vec::new();
    for (path, scope) in candidates {
        if let Ok(content) = std::fs::read_to_string(&path) {
            out.push(json!({
                "path": path.to_string_lossy(),
                "content": trunc(&content, 20_000),
                "scope": scope,
            }));
        }
    }
    out
}

/// `GET /api/sessions/{id}/memory-files` — the CLAUDE.md memory files governing
/// the session (project + user-global). Distinct from `/memory` (session_memory).
async fn get_memory_files(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let cwd = s
        .worktree_path
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| s.project_path.clone());
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let files = collect_claude_memory_files(&cwd, &home);
    Ok(Json(json!({ "files": files })))
}

async fn get_memory(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let rows: Vec<(String, String, String, String, String, String, String)> = sqlx::query_as(
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
        return Err(ApiError::BadRequest(
            "title and content are required".into(),
        ));
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
    Ok(Json(
        json!({"id": rid, "title": title_t, "content": content_t,
        "kind": kind, "created_at": created, "created_by": "user"}),
    ))
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
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM session_memory WHERE id = ? AND session_id = ?")
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
    if let Some(c) = b
        .content
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
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
    Ok(Json(
        json!({"id": r.0, "title": r.1, "content": r.2, "kind": r.3,
        "created_at": r.4, "created_by": r.5}),
    ))
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
    // Aggregate the per-session activity ledger into the detail surface the
    // Fleet panel renders: tool-call counts (bucketed), the latest todo list,
    // and the persisted memory items. These used to be hard-coded empty, so
    // the panel always looked bare regardless of what the agent had done.
    let acts = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT kind, payload_json FROM session_activity WHERE session_id = ? ORDER BY ts",
    )
    .bind(&id)
    .fetch_all(&st.auth.pool)
    .await
    .unwrap_or_default();
    let mut tools: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut todos: Value = json!([]);
    for (kind, payload) in &acts {
        let parsed = payload
            .as_ref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok());
        let name = match kind.as_str() {
            "file_edit" => "Edit".to_string(),
            "file_read" => "Read".to_string(),
            "command" => "Bash".to_string(),
            "web_fetch" => "WebFetch".to_string(),
            "todo" => {
                if let Some(v) = &parsed {
                    todos = if v.is_array() {
                        v.clone()
                    } else {
                        v.get("todos").cloned().unwrap_or_else(|| json!([]))
                    };
                }
                continue;
            }
            "plan" | "note" | "error" => continue,
            _ => parsed
                .as_ref()
                .and_then(|v| v.get("tool").and_then(|t| t.as_str()).map(String::from))
                .unwrap_or_else(|| kind.clone()),
        };
        *tools.entry(name).or_insert(0) += 1;
    }
    let mem_rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT title, content, kind, created_at FROM session_memory \
         WHERE session_id = ? ORDER BY created_at DESC",
    )
    .bind(&id)
    .fetch_all(&st.auth.pool)
    .await
    .unwrap_or_default();
    let memory_items: Vec<Value> = mem_rows
        .into_iter()
        .map(|(title, content, kind, created_at)| {
            json!({ "title": title, "content": content, "kind": kind, "created_at": created_at })
        })
        .collect();

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
        "tools": tools,
        "todos": todos,
        "memory_items": memory_items,
        "plans": []
    })))
}

/// `GET /api/sessions/:id/routing` — returns the session's current routing
/// pin joined against its originating `routing_decisions` row, so the chat
/// header can render a "Auto-routed → claude-sonnet-4-6" chip with the
/// rationale visible on hover.
///
/// Response shape:
///   { ok: true, routing: { agent, model, source, rationale } | null }
///
/// `routing` is `null` when the session hasn't been pinned/routed yet
/// (fresh session before the first turn lands). Ownership is enforced
/// the same way `get_session` does it — a foreign user reading another
/// user's session id gets a 403.
async fn get_session_routing(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let _ = owned(&st, &id, &user.id).await?;
    let info = crate::services::routing::persist::load_session_routing(&st.auth.pool, &id).await;
    let routing = info.map(|r| {
        json!({
            "agent": r.agent,
            "model": r.model,
            "source": r.source,
            "rationale": r.rationale,
        })
    });
    Ok(Json(json!({ "ok": true, "routing": routing })))
}

async fn stats_bulk(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows: Vec<(String, i64, f64)> = sqlx::query_as(
        "SELECT m.session_id, COUNT(m.id), COALESCE(SUM(m.cost_usd),0.0) \
         FROM messages m JOIN sessions s ON s.id = m.session_id \
         WHERE s.user_id = ? GROUP BY m.session_id",
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
    let (sessions,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
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
        // Two-stage lookup so a resume from ANY account's history works:
        //  1) Same-project, primary `~/.claude` (legacy fast path).
        //  2) Global walk across `~/.claude*/projects/*/<id>.jsonl` —
        //     the picker now surfaces transcripts from sibling accounts
        //     (".claude-2", ".claude-3"), and the original path-scoped
        //     lookup couldn't find them.
        if let Some(project_dir) =
            crate::services::claude_history::find_claude_project_dir(&project_path)
        {
            let jsonl = project_dir.join(format!("{claude_sid_owned}.jsonl"));
            if jsonl.exists() {
                return crate::services::claude_history::parse_jsonl(&jsonl);
            }
        }
        if let Some(jsonl) = crate::services::claude_history::find_jsonl_anywhere(&claude_sid_owned)
        {
            return crate::services::claude_history::parse_jsonl(&jsonl);
        }
        Vec::new()
    })
    .await
    .unwrap_or_default();
    let v: Vec<Value> = messages
        .into_iter()
        .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
        .collect();
    Ok(Json(Value::Array(v)))
}

async fn list_hooks(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let provider = s.tool.as_str();
    if !matches!(provider, "claude-code" | "codex-cli") {
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
    let items = crate::services::provider_inspector::list_hooks_for_provider(
        provider,
        &home,
        project.as_deref(),
    );
    let v: Vec<Value> = items
        .into_iter()
        .map(|x| serde_json::to_value(x).unwrap_or(Value::Null))
        .collect();
    Ok(Json(json!({ "items": v })))
}

async fn list_commands(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let provider = s.tool.as_str();
    if !matches!(provider, "claude-code" | "codex-cli") {
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
    let items = crate::services::provider_inspector::list_commands_for_provider(
        provider,
        &home,
        project.as_deref(),
    );
    let v: Vec<Value> = items
        .into_iter()
        .map(|x| serde_json::to_value(x).unwrap_or(Value::Null))
        .collect();
    Ok(Json(json!({ "items": v })))
}

/// `/sessions/{id}/skills` — provider-aware skill scan via
/// services::provider_inspector. Claude / Codex each have
/// their own directory matrix (user, project, system tiers); unknown
/// tools return `{items: []}`.
async fn list_skills(
    State(st): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let s = owned(&st, &id, &user.id).await?;
    let provider = s.tool.as_str();
    if !matches!(provider, "claude-code" | "codex-cli") {
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
    let items = crate::services::provider_inspector::list_skills_for_provider(
        provider,
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

#[derive(Deserialize)]
struct OptionalPathQ {
    #[serde(default)]
    path: Option<String>,
}

async fn list_claude_sessions(
    AuthUser(_u): AuthUser,
    Query(q): Query<OptionalPathQ>,
) -> Json<Value> {
    // Multi-account, multi-project: walk every `~/.claude*` config dir AND
    // every project inside it so the resume picker shows the user's full
    // Claude conversation history across accounts. Pass a non-empty `path`
    // query param to filter to a single project (legacy back-compat).
    let project_path = q.path.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let rows = tokio::task::spawn_blocking(move || {
        crate::services::claude_history::scan_sessions_all_accounts(project_path.as_deref())
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

async fn list_user_repos(AuthUser(_u): AuthUser) -> Result<Json<Value>, ApiError> {
    // Lists every repo the gh-authed user can reach — owned, collaborator,
    // AND organization-member — via `gh api /user/repos` with an explicit
    // `affiliation` filter. `gh repo list` (no owner) only returns *owned*
    // repos and silently drops org repos, so we use the REST endpoint and map
    // its raw fields into the renderer's `GhRepo` shape. Inherits whatever
    // auth state the user configured (web login, token, SSH).
    let gh = match which::which("gh") {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => {
            return Err(ApiError::Internal(
                "gh CLI is not installed — install it from cli.github.com to list repos".into(),
            ));
        }
    };
    let proc = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(&gh)
            .args([
                "api",
                "user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100",
            ])
            .output(),
    )
    .await
    .map_err(|_| ApiError::Internal("gh api user/repos timed out".into()))?
    .map_err(|e| ApiError::Internal(format!("spawn gh failed: {e}")))?;
    if !proc.status.success() {
        let stderr = String::from_utf8_lossy(&proc.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "gh api user/repos failed".to_string()
        } else {
            stderr
        };
        let low = msg.to_lowercase();
        if low.contains("authentication")
            || low.contains("logged in")
            || low.contains("gh auth login")
            || low.contains("bad credentials")
            || low.contains("http 401")
        {
            return Err(ApiError::Forbidden(
                "Not signed in to gh — run `gh auth login` in your terminal".into(),
            ));
        }
        return Err(ApiError::BadRequest(msg));
    }
    let raw: Vec<Value> = serde_json::from_slice(&proc.stdout).unwrap_or_default();
    Ok(Json(Value::Array(rest_repos_to_gh_shape(&raw))))
}

/// Map a raw GitHub REST `/user/repos` array into the renderer's `GhRepo`
/// shape (`nameWithOwner`/`description`/`url`/`sshUrl`/`isPrivate`/
/// `updatedAt`), dedupe by `nameWithOwner`, and sort newest-first. Kept in
/// sync with the Tauri shell's `map_gh_repo` + `parse_gh_api_repos`
/// (src-tauri/src/shell/github_link.rs), which feed the same shape to the
/// renderer's `GhRepo` type.
fn rest_repos_to_gh_shape(raw: &[Value]) -> Vec<Value> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for r in raw {
        let name = r.get("full_name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() || !seen.insert(name.to_string()) {
            continue;
        }
        out.push(json!({
            "nameWithOwner": name,
            "description":   r.get("description").cloned().unwrap_or(Value::Null),
            "url":           r.get("html_url").and_then(|v| v.as_str()).unwrap_or(""),
            "sshUrl":        r.get("ssh_url").and_then(|v| v.as_str()).unwrap_or(""),
            "isPrivate":     r.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
            "updatedAt":     r.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
        }));
    }
    out.sort_by(|a, b| {
        let av = a.get("updatedAt").and_then(|x| x.as_str()).unwrap_or("");
        let bv = b.get("updatedAt").and_then(|x| x.as_str()).unwrap_or("");
        bv.cmp(av)
    });
    out
}

#[derive(Deserialize)]
struct CloneBody {
    url: String,
    #[serde(default)]
    branch: Option<String>,
}
async fn clone_repository(
    AuthUser(_u): AuthUser,
    Json(b): Json<CloneBody>,
) -> Result<Json<Value>, ApiError> {
    let result = crate::services::clone::clone_or_pull(&b.url, b.branch.as_deref()).await;
    match result {
        Ok((path, branch)) => Ok(Json(json!({
            "path": path,
            "branch": branch,
        }))),
        Err(crate::services::clone::CloneError::Failed(msg)) => Err(ApiError::BadRequest(msg)),
    }
}

#[derive(Deserialize)]
struct CheckBody {
    url: String,
}
async fn check_repo_accessible(
    AuthUser(_u): AuthUser,
    Json(b): Json<CheckBody>,
) -> Result<Json<Value>, ApiError> {
    match crate::services::clone::check_accessible(&b.url).await {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(crate::services::clone::CloneError::Failed(msg)) => Err(ApiError::BadRequest(msg)),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: deleting a session that has a transcript must actually
    /// delete it. `messages` / `cost_events` / `session_activity` /
    /// `session_memory` all reference `sessions(id)` WITHOUT cascade and the
    /// pool enforces foreign keys, so the old bare `DELETE FROM sessions`
    /// failed with a constraint error for any session that ever ran a turn.
    /// The renderer swallowed that 500, hid the row behind its in-memory
    /// tombstone, and the "deleted" session came back on the next launch.
    #[tokio::test]
    async fn hard_delete_removes_session_and_all_child_rows() {
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        let sid = "del-fk-01";
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,use_worktree,\
              permission_mode,session_mode,pinned,order_idx,created_at,budget_used) \
             VALUES (?,?,?,'','claude-code','claude-code','stopped',0,'default','new',0,0,\
                     '2026-01-01T00:00:00Z',0.0)",
        )
        .bind(sid)
        .bind("Doomed")
        .bind("/tmp/doomed")
        .execute(&pool)
        .await
        .unwrap();
        // One row in EVERY table that references sessions(id) — each alone was
        // enough to block the old single-statement delete.
        sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
             VALUES ('m1',?,'user','hi',0.0,'2026-01-01T00:00:01Z')",
        )
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO cost_events (id,session_id,model,cost_usd,timestamp) \
             VALUES ('c1',?,'claude-opus-5',0.01,'2026-01-01T00:00:02Z')",
        )
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO session_activity (id,session_id,kind,summary,ts) \
             VALUES ('a1',?,'status','running','2026-01-01T00:00:03Z')",
        )
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO session_memory (id,session_id,title,content,created_at) \
             VALUES ('sm1',?,'note','remember','2026-01-01T00:00:04Z')",
        )
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();

        hard_delete_session(&pool, sid)
            .await
            .expect("delete must succeed even though the session has children");

        for (table, col) in [
            ("sessions", "id"),
            ("messages", "session_id"),
            ("cost_events", "session_id"),
            ("session_activity", "session_id"),
            ("session_memory", "session_id"),
        ] {
            let (n,): (i64,) =
                sqlx::query_as(&format!("SELECT COUNT(*) FROM {table} WHERE {col} = ?"))
                    .bind(sid)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(n, 0, "{table} still holds rows for the deleted session");
        }
    }

    #[tokio::test]
    async fn working_diff_reports_changes_and_flags_non_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t.t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();

        let r = git_working_diff(repo.to_str().unwrap()).await;
        assert!(r.is_repo);
        assert_eq!(r.file_count, 1);
        assert!(r.diff.contains("a.txt"));

        // Empty cwd → not a usable repo (deterministic; avoids depending on
        // whether the OS temp dir happens to sit inside a git work tree).
        let nr = git_working_diff("").await;
        assert!(!nr.is_repo);
        assert_eq!(nr.file_count, 0);
    }

    #[test]
    fn claude_memory_files_collect_and_omit_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("proj");
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(proj.join("CLAUDE.md"), "# project rules").unwrap();
        std::fs::write(home.join(".claude").join("CLAUDE.md"), "# global rules").unwrap();

        let files = collect_claude_memory_files(proj.to_str().unwrap(), home.to_str().unwrap());
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["scope"], "project");
        assert!(files[0]["content"]
            .as_str()
            .unwrap()
            .contains("project rules"));
        assert_eq!(files[1]["scope"], "user");

        // Missing project CLAUDE.md → omitted (only the user file remains).
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let only_user =
            collect_claude_memory_files(empty.to_str().unwrap(), home.to_str().unwrap());
        assert_eq!(only_user.len(), 1);
        assert_eq!(only_user[0]["scope"], "user");
    }

    #[test]
    fn rest_repos_to_gh_shape_maps_fields_and_keeps_org_repos() {
        // Raw `gh api /user/repos` payload: a personal repo and an ORG repo.
        // The org repo must survive (the reason we moved off `gh repo list`),
        // REST field names must map to the renderer's `GhRepo` shape, and the
        // result must be newest-first.
        let raw: Vec<Value> = serde_json::from_str(
            r#"[
                {"full_name":"me/personal","description":null,"html_url":"https://github.com/me/personal","ssh_url":"git@github.com:me/personal.git","private":false,"updated_at":"2024-01-01T00:00:00Z"},
                {"full_name":"acme/widget","description":"org repo","html_url":"https://github.com/acme/widget","ssh_url":"git@github.com:acme/widget.git","private":true,"updated_at":"2026-01-01T00:00:00Z"}
            ]"#,
        )
        .unwrap();
        let out = rest_repos_to_gh_shape(&raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["nameWithOwner"], "acme/widget"); // newest first
        assert_eq!(out[0]["isPrivate"], true);
        assert_eq!(out[0]["url"], "https://github.com/acme/widget");
        assert_eq!(out[0]["sshUrl"], "git@github.com:acme/widget.git");
        assert_eq!(out[1]["nameWithOwner"], "me/personal");
        assert_eq!(out[1]["description"], Value::Null);
    }

    #[test]
    fn rest_repos_to_gh_shape_dedupes_and_skips_nameless() {
        let raw: Vec<Value> = serde_json::from_str(
            r#"[
                {"full_name":"o/dup","html_url":"u","ssh_url":"s","private":false,"updated_at":"2025-01-01T00:00:00Z"},
                {"full_name":"o/dup","html_url":"u","ssh_url":"s","private":false,"updated_at":"2025-01-01T00:00:00Z"},
                {"html_url":"x","ssh_url":"y","private":false,"updated_at":"2025-01-01T00:00:00Z"}
            ]"#,
        )
        .unwrap();
        let out = rest_repos_to_gh_shape(&raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["nameWithOwner"], "o/dup");
    }

    /// Session rules materialize a fenced block into the session's working-dir
    /// `CLAUDE.md` (in-place project path here) and strip cleanly when cleared.
    #[tokio::test]
    async fn session_rules_materialize_and_strip_in_project_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let pool = crate::db::init_pool("sqlite::memory:").await.unwrap();
        let id = "rules-rt-01";
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,use_worktree,\
              permission_mode,session_mode,pinned,order_idx,created_at,budget_used) \
             VALUES (?,?,?,'','claude-code','claude-code','idle',0,'default','new',0,0,\
                     '2026-01-01T00:00:00Z',0.0)",
        )
        .bind(id)
        .bind("Rules RT")
        .bind(proj.to_string_lossy().as_ref())
        .execute(&pool)
        .await
        .unwrap();
        let s = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();

        apply_session_rules(&s, "Always run tests before commit.");
        let claude = proj.join("CLAUDE.md");
        let txt = std::fs::read_to_string(&claude).unwrap();
        assert!(txt.contains("Always run tests before commit."));
        assert!(txt.contains("fleetify:rule:session-rules-rt-01 START"));

        apply_session_rules(&s, "");
        let txt2 = std::fs::read_to_string(&claude).unwrap_or_default();
        assert!(!txt2.contains("Always run tests before commit."));
        assert!(!txt2.contains("fleetify:rule"));
    }
}
