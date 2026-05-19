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

    /// Phase 2: ensure_worktree / ensure_session_branch. No-op stub now so
    /// the row shape is faithful; staff/no-project sessions skip anyway.
    async fn attach_git_setup(&self, session: &Session) {
        let is_staff = session.title.trim().eq_ignore_ascii_case("staff agent");
        if session.project_path.is_empty() || is_staff {
            return;
        }
        tracing::debug!(
            session_id = %session.id,
            "attach_git_setup deferred to Phase 2 (worktree/branch)"
        );
    }

    /// Phase 4: telemetry emitters. No-op stub now.
    fn fire_telemetry(&self, kind: &str, session_id: &str) {
        tracing::debug!(%kind, %session_id, "telemetry deferred to Phase 4");
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

        self.attach_git_setup(&session).await;
        // Persist any worktree fields attach_git_setup set (none in Phase 1c).
        session = sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_one(pool)
            .await?;

        tracing::info!(session_id = %id, tool = %session.tool, "session.created");
        self.fire_telemetry("session_start", &id);
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
        self.fire_telemetry("session_stop", session_id);
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
        self.fire_telemetry("status_change", session_id);
        Ok(())
    }
}

/// Process-wide singleton (parity with the module-level `session_manager`).
pub fn session_manager() -> &'static SessionManager {
    static SM: OnceLock<SessionManager> = OnceLock::new();
    SM.get_or_init(SessionManager::new)
}
