//! Auto-surface backgrounded Claude Code CLI sessions as Fleetify rows.
//!
//! When a user runs `/background` (alias `/bg`) inside the Claude Code CLI, the
//! session detaches to run under Claude's supervisor daemon and the terminal is
//! freed. Claude exposes the live roster with `claude agents --json` (verified
//! against Claude Code 2.1.150): a JSON array of `{ pid, cwd, kind, sessionId,
//! status, startedAt }` where `kind` is `"interactive"` or `"background"`.
//!
//! This module polls that roster, filters to `kind == "background"`, and
//! reconciles each into the `sessions` table as a real row tagged
//! `origin = 'claude-bg'`. Because the renderer already polls `GET /api/sessions`
//! every ~5 s, no broadcast is needed — the rows simply appear in the Fleet
//! panel. Reconciliation keys on `(origin='claude-bg', claude_session_id)`, so
//! re-polling never duplicates a row, and adopting one reuses the existing
//! `--resume <claude_session_id>` wiring in `bridges::claude`.
//!
//! Scope (v1): the default Claude config dir / account. Multi-account daemons
//! (`~/.claude-2`, …) are not yet polled — noted in the PR.

use std::collections::HashSet;
use std::time::Duration;

use serde::Deserialize;
use sqlx::SqlitePool;

use crate::config::AppConfig;
use crate::models::session::{Session, SessionCreate};
use crate::session_manager::SessionManager;

/// One entry from `claude agents --json`. Unknown fields are ignored; every
/// field is optional-friendly because the shape varies by session state
/// (e.g. a working session omits `status`, a blocked one carries `waitingFor`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgent {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// "interactive" | "background".
    #[serde(default)]
    pub kind: Option<String>,
    /// Present when idle/blocked/done; absent while actively working.
    #[serde(default)]
    pub status: Option<String>,
    /// Some Claude builds report `state` instead of `status`.
    #[serde(default)]
    pub state: Option<String>,
    /// Human-friendly session name Claude assigns when backgrounding
    /// (e.g. "Check bounty work files"). Preferred over the cwd basename
    /// for the surfaced row's title when present.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub pid: Option<i64>,
}

impl LiveAgent {
    fn is_background(&self) -> bool {
        self.kind.as_deref() == Some("background")
    }

    /// Map the live roster state to the Fleetify `sessions.status` column.
    /// Anything that isn't an explicit terminal/idle token is treated as
    /// actively working ("running") so the panel shows a live indicator.
    fn fleet_status(&self) -> &'static str {
        let s = self.status.as_deref().or(self.state.as_deref());
        match s {
            Some("idle") | Some("done") | Some("stopped") | Some("failed") | Some("blocked")
            | Some("completed") | Some("error") => "idle",
            _ => "running",
        }
    }
}

/// Run `claude agents --json` and return the **backgrounded** sessions only.
///
/// Best-effort: a missing `claude` binary, a non-zero exit, a parse failure, or
/// a timeout all yield an empty list (logged at debug, never panics). The poll
/// must never take down the server or spam logs every few seconds.
pub async fn list_background_agents() -> Vec<LiveAgent> {
    let fut = tokio::process::Command::new("claude")
        .args(["agents", "--json"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();

    let out = match tokio::time::timeout(Duration::from_secs(8), fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            tracing::debug!("claude agents --json failed to spawn: {e}");
            return Vec::new();
        }
        Err(_) => {
            tracing::debug!("claude agents --json timed out");
            return Vec::new();
        }
    };
    if !out.status.success() {
        tracing::debug!("claude agents --json exited {:?}", out.status.code());
        return Vec::new();
    }

    match serde_json::from_slice::<Vec<LiveAgent>>(&out.stdout) {
        Ok(list) => list
            .into_iter()
            .filter(|a| a.is_background() && a.session_id.is_some() && a.cwd.is_some())
            .collect(),
        Err(e) => {
            tracing::debug!("claude agents --json parse error: {e}");
            Vec::new()
        }
    }
}

/// A readable title for an auto-created row: the project folder's basename
/// (e.g. `/Users/me/projects/app` → "app"), falling back to a generic label.
fn title_for(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Background session".to_string())
}

/// One reconciliation pass: create rows for new background agents, refresh the
/// status of known ones, and mark vanished ones idle. Returns the number of
/// rows created (for logging). Errors on individual rows are swallowed so one
/// bad row never aborts the whole pass.
pub async fn reconcile_once(
    pool: &SqlitePool,
    sm: &'static SessionManager,
    cfg: &AppConfig,
) -> anyhow::Result<usize> {
    let agents = list_background_agents().await;

    // Every row this module owns (regardless of user, since auto-created rows
    // are user_id NULL — visible to every local profile on a desktop install).
    let existing: Vec<Session> = sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE origin = 'claude-bg' AND archived_at IS NULL",
    )
    .fetch_all(pool)
    .await?;

    let live_sids: HashSet<&str> = agents
        .iter()
        .filter_map(|a| a.session_id.as_deref())
        .collect();

    let mut created = 0usize;

    for a in &agents {
        let sid = a.session_id.as_deref().unwrap_or_default();
        let cwd = a.cwd.as_deref().unwrap_or_default();
        if sid.is_empty() || cwd.is_empty() {
            continue;
        }
        let status = a.fleet_status();

        if let Some(row) = existing
            .iter()
            .find(|r| r.claude_session_id.as_deref() == Some(sid))
        {
            // Known row — only touch the DB when the live status actually moved.
            if row.status != status {
                let _ = sqlx::query("UPDATE sessions SET status = ? WHERE id = ?")
                    .bind(status)
                    .bind(&row.id)
                    .execute(pool)
                    .await;
            }
            continue;
        }

        // Don't shadow a session the user already owns for this conversation
        // (e.g. one they resumed manually via "Resume from Claude CLI").
        let dup: Option<(String,)> =
            sqlx::query_as("SELECT id FROM sessions WHERE claude_session_id = ? LIMIT 1")
                .bind(sid)
                .fetch_optional(pool)
                .await?;
        if dup.is_some() {
            continue;
        }

        let data = SessionCreate {
            // Prefer Claude's own session name; fall back to the folder basename.
            title: a
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| title_for(cwd)),
            project_path: cwd.to_string(),
            tool: "claude-code".to_string(),
            group_path: String::new(),
            notes: None,
            model_name: None,
            permission_mode: "default".to_string(),
            session_mode: "new".to_string(),
            claude_session_id: Some(sid.to_string()),
            // Never spin up a worktree — this mirrors a session already running
            // in the user's real working directory.
            use_worktree: false,
            agent_template: None,
            account_id: None,
            origin: Some("claude-bg".to_string()),
        };

        match sm.create_session(pool, cfg, &data, None).await {
            Ok(s) => {
                // create_session hard-codes status='stopped'; reflect live state.
                let _ = sqlx::query("UPDATE sessions SET status = ? WHERE id = ?")
                    .bind(status)
                    .bind(&s.id)
                    .execute(pool)
                    .await;
                created += 1;
                tracing::info!(session_id = %sid, cwd = %cwd, "surfaced backgrounded Claude CLI session");
            }
            Err(e) => tracing::warn!("failed to surface background session {sid}: {e}"),
        }
    }

    // A previously-surfaced background session that's no longer in the roster
    // was foregrounded, stopped, or finished. Keep the row (it stays resumable
    // and preserves history) but drop its live "running" indicator.
    for row in &existing {
        if let Some(sid) = row.claude_session_id.as_deref() {
            if !live_sids.contains(sid) && row.status == "running" {
                let _ = sqlx::query("UPDATE sessions SET status = 'idle' WHERE id = ?")
                    .bind(&row.id)
                    .execute(pool)
                    .await;
            }
        }
    }

    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_to_background_with_ids() {
        let json = r#"[
            {"pid":1,"cwd":"/a","kind":"interactive","sessionId":"i1","status":"idle"},
            {"pid":2,"cwd":"/b","kind":"background","sessionId":"b1"},
            {"pid":3,"cwd":"/c","kind":"background","sessionId":"b2","status":"idle"},
            {"pid":4,"kind":"background","sessionId":"nocwd"},
            {"pid":5,"cwd":"/d","kind":"background"}
        ]"#;
        let all: Vec<LiveAgent> = serde_json::from_str(json).unwrap();
        let bg: Vec<_> = all
            .into_iter()
            .filter(|a| a.is_background() && a.session_id.is_some() && a.cwd.is_some())
            .collect();
        assert_eq!(bg.len(), 2);
        assert_eq!(bg[0].session_id.as_deref(), Some("b1"));
        assert_eq!(bg[1].session_id.as_deref(), Some("b2"));
    }

    #[test]
    fn working_session_maps_to_running() {
        // No status field ⇒ actively working ⇒ "running".
        let a: LiveAgent =
            serde_json::from_str(r#"{"cwd":"/a","kind":"background","sessionId":"x"}"#).unwrap();
        assert_eq!(a.fleet_status(), "running");
        let idle: LiveAgent = serde_json::from_str(
            r#"{"cwd":"/a","kind":"background","sessionId":"x","status":"idle"}"#,
        )
        .unwrap();
        assert_eq!(idle.fleet_status(), "idle");
    }

    #[test]
    fn title_is_basename() {
        assert_eq!(title_for("/Users/me/projects/app"), "app");
        assert_eq!(title_for(""), "Background session");
    }
}
