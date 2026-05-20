//! Faithful port of `app/services/session_manager.py`. In-memory runtime
//! state + session lifecycle. `attach_git_setup` (worktree/branch) is
//! Phase 2 and telemetry is Phase 4 — both are explicit typed no-ops here
//! (tracing breadcrumb), so the persisted `sessions` row shape stays
//! faithful while those subsystems land later.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::config::AppConfig;
use crate::models::session::{Session, SessionCreate};

/// (session_id, status) status-change fan-out powering SSE `/events/status`
/// (parity with `_status_callbacks` + `notify_status`).
#[derive(Clone, Debug)]
pub struct StatusEvent {
    pub session_id: String,
    pub status: String,
}

pub struct SessionManager {
    /// Subscribed WebSockets per session id (Phase 1d populates/broadcasts).
    ws: Mutex<HashMap<String, usize>>,
    status_tx: broadcast::Sender<StatusEvent>,
}

impl SessionManager {
    fn new() -> Self {
        let (status_tx, _) = broadcast::channel(256);
        Self { ws: Mutex::new(HashMap::new()), status_tx }
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<StatusEvent> {
        self.status_tx.subscribe()
    }

    fn emit_status(&self, session_id: &str, status: &str) {
        let _ = self.status_tx.send(StatusEvent {
            session_id: session_id.to_string(),
            status: status.to_string(),
        });
    }

    pub fn register_ws(&self, session_id: &str) {
        *self.ws.lock().unwrap().entry(session_id.to_string()).or_insert(0) += 1;
    }
    pub fn unregister_ws(&self, session_id: &str) {
        let mut m = self.ws.lock().unwrap();
        if let Some(n) = m.get_mut(session_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(session_id);
            }
        }
    }

    /// Faithful with `attach_git_setup` (worktree.py): worktree-on →
    /// `fleet/<slug>-<id>` worktree under `<repo>/.fleetify-worktrees/`,
    /// worktree-off → carved (or reused) `fleet/<slug>-<id>` branch in the
    /// main repo. Failures are non-fatal (parity).
    async fn attach_git_setup(&self, pool: &SqlitePool, session: &Session) {
        let is_staff = session.title.trim().eq_ignore_ascii_case("staff agent");
        if session.project_path.is_empty() || is_staff {
            return;
        }
        use crate::services::worktree;
        let label = if session.title.trim().is_empty() {
            "session".to_string()
        } else {
            session.title.clone()
        };
        if session.use_worktree {
            match worktree::ensure_worktree(
                &session.project_path,
                &session.id,
                Some(&label),
                None,
            )
            .await
            {
                Ok((path, branch)) => {
                    let _ = sqlx::query(
                        "UPDATE sessions SET worktree_path = ?, worktree_branch = ? \
                         WHERE id = ?",
                    )
                    .bind(&path)
                    .bind(&branch)
                    .bind(&session.id)
                    .execute(pool)
                    .await;
                    tracing::info!(session_id=%session.id, %path, %branch,
                        "session.worktree.attached");
                }
                Err(e) => tracing::info!(session_id=%session.id, reason=%e.0,
                    "session.git_setup.skipped"),
            }
        } else {
            match worktree::ensure_session_branch(
                &session.project_path,
                &session.id,
                Some(&label),
                None,
            )
            .await
            {
                Ok(branch) => {
                    let _ = sqlx::query(
                        "UPDATE sessions SET worktree_branch = ? WHERE id = ?",
                    )
                    .bind(&branch)
                    .bind(&session.id)
                    .execute(pool)
                    .await;
                    tracing::info!(session_id=%session.id, %branch,
                        "session.branch.attached");
                }
                Err(e) => tracing::info!(session_id=%session.id, reason=%e.0,
                    "session.git_setup.skipped"),
            }
        }
    }

    /// Fire a telemetry event for a session lifecycle transition.
    /// Currently dispatches `status_change` events (session_start +
    /// session_stop live on the routers since they need extra context).
    /// Fire-and-forget — the outbox absorbs the write and the WS client
    /// drains it on its own schedule.
    fn fire_status_change_telemetry(&self, session_id: &str, status: &str) {
        let sid = session_id.to_string();
        let st = status.to_string();
        tokio::spawn(async move {
            let _ = crate::services::telemetry::emit_status_change(
                &sid,
                &st,
                chrono::Utc::now(),
            )
            .await;
        });
    }

    /// Parity with `create_session`: command = `${cmd} ${args…}` from
    /// config.agents, else the raw tool name (custom agent).
    pub async fn create_session(
        &self,
        pool: &SqlitePool,
        cfg: &AppConfig,
        data: &SessionCreate,
        user_id: Option<&str>,
    ) -> anyhow::Result<Session> {
        let command = match cfg.agents.get(&data.tool) {
            Some(a) => {
                let mut c = a.command.clone();
                if !a.args.is_empty() {
                    c.push(' ');
                    c.push_str(&a.args.join(" "));
                }
                c.trim().to_string()
            }
            None => data.tool.clone(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,use_worktree,\
              claude_session_id,model_name,permission_mode,session_mode,\
              agent_template,user_id,pinned,order_idx,created_at,notes,budget_used) \
             VALUES (?,?,?,?,?,?,'stopped',?,?,?,?,?,?,?,0,0,?,?,0.0)",
        )
        .bind(&id)
        .bind(&data.title)
        .bind(&data.project_path)
        .bind(&data.group_path)
        .bind(&data.tool)
        .bind(&command)
        .bind(data.use_worktree)
        .bind(&data.claude_session_id)
        .bind(&data.model_name)
        .bind(&data.permission_mode)
        .bind(&data.session_mode)
        .bind(&data.agent_template)
        .bind(user_id)
        .bind(&created_at)
        .bind(&data.notes)
        .execute(pool)
        .await?;

        let mut session: Session =
            sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
                .bind(&id)
                .fetch_one(pool)
                .await?;

        self.attach_git_setup(pool, &session).await;
        // Persist any worktree fields attach_git_setup set (none in Phase 1c).
        session = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_one(pool)
            .await?;

        tracing::info!(session_id = %id, tool = %session.tool, "session.created");
        // session_start telemetry fires from routers::sessions::create_session
        // where the full row is in scope (title + project_path + …).
        Ok(session)
    }

    /// Parity with `stop_session`: (Phase 1d aborts the live bridge) →
    /// status=stopped + telemetry.
    pub async fn stop_session(&self, pool: &SqlitePool, session_id: &str) -> anyhow::Result<()> {
        // Phase 1d: proc.terminate()/kill + bridge.abort() here.
        sqlx::query("UPDATE sessions SET status = 'stopped' WHERE id = ?")
            .bind(session_id)
            .execute(pool)
            .await?;
        self.emit_status(session_id, "stopped");
        self.fire_status_change_telemetry(session_id, "stopped");
        Ok(())
    }

    /// Parity with `update_status`: status + last_accessed + telemetry +
    /// notify (SSE).
    pub async fn update_status(
        &self,
        pool: &SqlitePool,
        session_id: &str,
        status: &str,
    ) -> anyhow::Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE sessions SET status = ?, last_accessed = ? WHERE id = ?")
            .bind(status)
            .bind(&now)
            .bind(session_id)
            .execute(pool)
            .await?;
        self.emit_status(session_id, status);
        self.fire_status_change_telemetry(session_id, status);
        Ok(())
    }
}

/// Process-wide singleton (parity with the module-level `session_manager`).
pub fn session_manager() -> &'static SessionManager {
    static SM: OnceLock<SessionManager> = OnceLock::new();
    SM.get_or_init(SessionManager::new)
}
