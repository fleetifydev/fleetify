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

use std::collections::HashMap;
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
/// Returns `Some(list)` ONLY on an authoritative success (the command ran, exited
/// 0, and parsed). A missing `claude` binary, non-zero exit, timeout, or parse
/// failure returns `None` — the caller MUST treat `None` as "unknown" and skip
/// reconciliation, never as "no background sessions". Conflating the two would
/// let a transient hiccup archive every live row.
pub async fn list_background_agents() -> Option<Vec<LiveAgent>> {
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
            return None;
        }
        Err(_) => {
            tracing::debug!("claude agents --json timed out");
            return None;
        }
    };
    if !out.status.success() {
        tracing::debug!("claude agents --json exited {:?}", out.status.code());
        return None;
    }

    match serde_json::from_slice::<Vec<LiveAgent>>(&out.stdout) {
        Ok(list) => Some(
            list.into_iter()
                .filter(|a| a.is_background() && a.session_id.is_some() && a.cwd.is_some())
                .collect(),
        ),
        Err(e) => {
            tracing::debug!("claude agents --json parse error: {e}");
            None
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

/// Extract a 36-char UUID from a transcript path's basename (`<uuid>.jsonl`),
/// or accept a bare UUID. Returns None for anything not UUID-shaped.
fn origin_id_from_path(s: &str) -> Option<String> {
    let stem = std::path::Path::new(s)
        .file_stem()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| s.to_string());
    let ok = stem.len() == 36
        && stem.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 8 || i == 13 || i == 18 || i == 23 {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        });
    ok.then_some(stem)
}

/// Map each live background session id → the ORIGINAL conversation it forked
/// from, read from Claude's supervisor roster (`~/.claude/daemon/roster.json`).
///
/// `/background` mints a *fresh* background session id whose transcript starts
/// empty, but records the conversation it detached from under
/// `workers.<id>.dispatch.launch.sessionId` (a path to the original `.jsonl`).
/// That's the only reliable link back — `claude agents --json` doesn't expose
/// it. Surfacing the ORIGIN id (not the throwaway fork id) is what makes the
/// Fleet row load the real prior conversation and resume it where the user left
/// off, and collapses repeated `/bg` of one conversation into a single row.
/// Missing/unreadable roster → empty map (callers fall back to the fork id).
fn origin_conversation_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let roster = fleetify_core::user_home()
        .join(".claude")
        .join("daemon")
        .join("roster.json");
    let Ok(bytes) = std::fs::read(&roster) else {
        return map;
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return map;
    };
    let Some(workers) = json.get("workers").and_then(|w| w.as_object()) else {
        return map;
    };
    for worker in workers.values() {
        let sid = worker.get("sessionId").and_then(|v| v.as_str());
        let launch = worker.get("dispatch").and_then(|d| d.get("launch"));
        let mode = launch.and_then(|l| l.get("mode")).and_then(|v| v.as_str());
        let src = launch
            .and_then(|l| l.get("sessionId"))
            .and_then(|v| v.as_str());
        if let (Some(sid), Some("resume"), Some(src)) = (sid, mode, src) {
            if let Some(orig) = origin_id_from_path(src) {
                if orig != sid {
                    map.insert(sid.to_string(), orig);
                }
            }
        }
    }
    map
}

/// One reconciliation pass. For each ORIGINAL conversation that has a live
/// background fork, ensure exactly one row exists (keyed on the conversation id,
/// not the throwaway fork id) so the Fleet row loads the real transcript and
/// resumes where the user left off. Rows whose conversation no longer has a
/// live fork are archived. Returns the number of rows created. Per-row errors
/// are swallowed so one bad row never aborts the pass.
pub async fn reconcile_once(
    pool: &SqlitePool,
    sm: &'static SessionManager,
    cfg: &AppConfig,
) -> anyhow::Result<usize> {
    // `None` ⇒ the listing failed (timeout, no binary, parse error). Skip the
    // whole pass — never archive live rows on a transient hiccup. Only an
    // authoritative `Some` (possibly empty) drives reconciliation.
    let Some(agents) = list_background_agents().await else {
        return Ok(0);
    };
    let origins = origin_conversation_map();

    // Resolve every live fork to the conversation it detached from (fork id →
    // origin id; bare fork id when unlinked, e.g. a fresh `claude --bg "task"`).
    // Keying on the origin collapses multiple `/bg` forks of one conversation
    // into a single row and points it at the real, resumable transcript. When
    // more than one fork maps to the same conversation, a working fork's status
    // wins so the row reflects live activity.
    let mut desired: HashMap<String, &LiveAgent> = HashMap::new();
    for a in &agents {
        let Some(sid) = a.session_id.as_deref() else {
            continue;
        };
        let cwd = a.cwd.as_deref().unwrap_or_default();
        if cwd.is_empty() {
            continue;
        }
        let key = origins.get(sid).cloned().unwrap_or_else(|| sid.to_string());
        desired
            .entry(key)
            .and_modify(|cur| {
                if cur.fleet_status() != "running" && a.fleet_status() == "running" {
                    *cur = a;
                }
            })
            .or_insert(a);
    }

    // Every row this module owns, INCLUDING archived ones, so a conversation
    // that's backgrounded again is REVIVED (un-archived) rather than blocked by
    // a stale archived row or duplicated. (user_id is NULL — visible to every
    // local profile on a desktop install.)
    let all_bg: Vec<Session> =
        sqlx::query_as::<_, Session>("SELECT * FROM sessions WHERE origin = 'claude-bg'")
            .fetch_all(pool)
            .await?;

    let mut created = 0usize;

    for (conv_id, a) in &desired {
        let cwd = a.cwd.as_deref().unwrap_or_default();
        let status = a.fleet_status();

        if let Some(row) = all_bg
            .iter()
            .find(|r| r.claude_session_id.as_deref() == Some(conv_id.as_str()))
        {
            // Known row — ensure it's active (un-archive) and status is current.
            // Only write when something actually changed.
            if row.archived_at.is_some() || row.status != status {
                let _ =
                    sqlx::query("UPDATE sessions SET archived_at = NULL, status = ? WHERE id = ?")
                        .bind(status)
                        .bind(&row.id)
                        .execute(pool)
                        .await;
            }
            continue;
        }

        // Don't shadow a NON-bg session the user already owns for this
        // conversation (e.g. one resumed manually via "Resume from Claude CLI").
        // Scoped to non-bg rows so our own archived rows never block creation —
        // those are handled by the revive branch above.
        let dup: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM sessions \
             WHERE claude_session_id = ? AND (origin IS NULL OR origin <> 'claude-bg') LIMIT 1",
        )
        .bind(conv_id)
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
            // The ORIGINAL conversation id — its transcript has the full history
            // and `--resume`ing it continues where the user left off.
            claude_session_id: Some(conv_id.clone()),
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
                tracing::info!(conversation = %conv_id, cwd = %cwd, "surfaced backgrounded Claude CLI conversation");
            }
            Err(e) => {
                tracing::warn!("failed to surface background conversation {conv_id}: {e}")
            }
        }
    }

    // Archive ACTIVE rows whose conversation no longer has a live background
    // fork (the listing succeeded, so `desired` is authoritative). This also
    // retires legacy rows keyed on a throwaway fork id from before origin
    // resolution landed: the list converges to exactly the conversations
    // currently backgrounded. The transcript stays on disk, so the user can
    // still re-open it any time via "Resume from Claude CLI" — and if the
    // conversation is backgrounded again the revive branch above brings it back.
    let now = chrono::Utc::now().to_rfc3339();
    for row in all_bg.iter().filter(|r| r.archived_at.is_none()) {
        if let Some(cid) = row.claude_session_id.as_deref() {
            if !desired.contains_key(cid) {
                let _ = sqlx::query(
                    "UPDATE sessions SET archived_at = ?, status = 'idle' WHERE id = ?",
                )
                .bind(&now)
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

    #[test]
    fn origin_id_parses_from_transcript_path_or_bare_uuid() {
        let uuid = "9277b016-9e92-47a5-9dbd-224598bd21d5";
        // From a full transcript path (the roster's launch.sessionId shape).
        assert_eq!(
            origin_id_from_path(&format!(
                "/Users/me/.claude/projects/-Users-me-proj/{uuid}.jsonl"
            )),
            Some(uuid.to_string())
        );
        // From a bare uuid.
        assert_eq!(origin_id_from_path(uuid), Some(uuid.to_string()));
        // Non-uuid junk → None.
        assert_eq!(origin_id_from_path("/tmp/notauuid.jsonl"), None);
        assert_eq!(origin_id_from_path(""), None);
    }
}
