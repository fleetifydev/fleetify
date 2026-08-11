//! Agent-spawn core. Turns a free-text spawn request (from the staff
//! `[[SPAWN:{…}]]` directive or the `spawn_agent` MCP tool) into a
//! validated, canonical `SpawnSpec` + a list of `Gap`s the user must
//! resolve, then creates the session via `session_manager::create_session`.
//!
//! Single source of truth shared by:
//!   • routers::chat (staff directive → spawn_form WS event)
//!   • routers::sessions (POST /api/sessions/spawn — the form's Create)
//!   • routers::internal (POST /api/internal/spawn — the MCP tool)

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::models::session::{Session, SessionCreate};
use crate::routers::AppState;

/// One spawn directive as emitted by the staff LLM — best-effort, raw,
/// every field optional. Deserialized from the `[[SPAWN:{json}]]` payload.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct RawSpawn {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub perm: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    /// Git worktree isolation. Default OFF — only `true` when the user
    /// explicitly asked for an isolated worktree/branch.
    #[serde(default)]
    pub worktree: Option<bool>,
}

/// A resolved, canonical spawn spec — a subset of `SessionCreate` plus
/// the optional first task. Serialized into the `spawn_form` WS event's
/// `draft` and accepted verbatim by `POST /api/sessions/spawn`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SpawnSpec {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub agent_template: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub first_task: Option<String>,
    /// Git worktree isolation. `None`/`Some(false)` → work in the project
    /// folder directly (the default); `Some(true)` → eager worktree carve.
    #[serde(default)]
    pub use_worktree: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    Missing,
    Ambiguous,
}

/// A field the resolver could not pin down. `candidates` is non-empty only
/// for `Ambiguous` (the choices to surface in the form's picker).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gap {
    pub field: String,
    pub reason: GapReason,
    #[serde(default)]
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedSpawn {
    pub spec: SpawnSpec,
    pub gaps: Vec<Gap>,
}

/// Lowercase + keep only ASCII alphanumerics. `"Claude Code"` → `"claudecode"`,
/// `"opus 4.8"` → `"opus48"`. Used for tolerant fuzzy comparison.
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Fuzzy-match a free-text provider name to a catalog provider id.
pub fn resolve_tool(hint: &str) -> Option<&'static str> {
    let n = norm(hint);
    if n.is_empty() {
        return None;
    }
    // 1. exact id
    if let Some(p) = crate::providers::find_provider(hint.trim().to_lowercase().as_str()) {
        return Some(p.id);
    }
    // 2. exact normalized id or display_name
    for p in crate::providers::CATALOG {
        if norm(p.id) == n || norm(p.display_name) == n {
            return Some(p.id);
        }
    }
    // 3. curated aliases
    let alias = match n.as_str() {
        "claudecode" | "cc" => Some("claude-code"),
        "gpt" | "chatgpt" => Some("openai"),
        "codexcli" => Some("codex-cli"),
        _ => None,
    };
    if alias.is_some() {
        return alias;
    }
    // 4. the hint normalized-contains a provider id (longest id wins to avoid
    //    short-id false positives)
    let mut best: Option<&'static str> = None;
    for p in crate::providers::CATALOG {
        if n.contains(&norm(p.id)) && best.is_none_or(|b| norm(p.id).len() > norm(b).len()) {
            best = Some(p.id);
        }
    }
    best
}

#[derive(Debug, Clone, PartialEq)]
pub enum ModelResolution {
    None,
    One(&'static str),
    Many(Vec<&'static str>),
}

/// Scan a set of providers' models for a normalized hint. Exact (normalized)
/// id/label match wins outright; otherwise normalized-substring matches are
/// collected and deduped.
fn scan_models(providers: &[&'static crate::providers::ProviderSpec], n: &str) -> ModelResolution {
    let mut hits: Vec<&'static str> = Vec::new();
    for p in providers {
        for m in p.default_models {
            if norm(m.id) == n || norm(m.label) == n {
                return ModelResolution::One(m.id);
            }
            if norm(m.id).contains(n) || norm(m.label).contains(n) {
                hits.push(m.id);
            }
        }
    }
    hits.sort_unstable();
    hits.dedup();
    match hits.len() {
        0 => ModelResolution::None,
        1 => ModelResolution::One(hits[0]),
        _ => ModelResolution::Many(hits),
    }
}

/// Fuzzy-match a model hint to a catalog model id. Tries the scoped provider
/// first, then falls back to a global scan. CLI agents (claude/codex)
/// carry empty `default_models` in the backend catalog — their picker lists
/// live frontend-side — but the canonical dash-form ids (exactly what the CLI
/// dispatches, e.g. `claude-opus-4-8`) live on the API-provider consts, so the
/// global fallback is what actually resolves a CLI agent's model.
pub fn resolve_model(provider_id: Option<&str>, hint: &str) -> ModelResolution {
    let n = norm(hint);
    if n.is_empty() {
        return ModelResolution::None;
    }
    if let Some(p) = provider_id.and_then(crate::providers::find_provider) {
        match scan_models(&[p], n.as_str()) {
            ModelResolution::None => {} // fall through to global
            hit => return hit,
        }
    }
    let all: Vec<&'static crate::providers::ProviderSpec> =
        crate::providers::CATALOG.iter().collect();
    scan_models(&all, n.as_str())
}

/// Map a free-text permission hint to a canonical mode id valid for the
/// given provider. Validates against `permission_capability`. Returns
/// `None` when the provider has no modes axis or the hint is unrecognised.
pub fn resolve_permission(provider_id: &str, hint: &str) -> Option<&'static str> {
    use crate::providers::capabilities::{permission_capability, PermissionCapability};
    let h = hint.trim().to_lowercase();
    if h.is_empty() {
        return None;
    }
    let modes = match permission_capability(provider_id) {
        PermissionCapability::Modes { modes, .. } => modes,
        _ => return None,
    };
    // 1. exact id (case-insensitive)
    if let Some(m) = modes.iter().find(|m| m.id.to_lowercase() == h) {
        return Some(m.id);
    }
    // 2. phrase → canonical id
    let want = if h.contains("bypass")
        || h.contains("full auto")
        || h.contains("yolo")
        || h.contains("danger")
    {
        "bypassPermissions"
    } else if h.contains("accept") {
        "acceptEdits"
    } else if h.contains("plan") {
        "plan"
    } else if h.contains("ask") || h.contains("default") {
        "default"
    } else {
        return None;
    };
    modes.iter().find(|m| m.id == want).map(|m| m.id)
}

/// Privilege ordering for the worker permission clamp (K3): least → most.
pub fn perm_rank(mode: &str) -> u8 {
    match mode {
        "plan" => 0,
        "default" => 1,
        "acceptEdits" => 2,
        "bypassPermissions" => 3,
        _ => 1,
    }
}

/// True if `id` is a real backend builtin template (so we never set an
/// invalid `agent_template`). NB: `code_review` is a frontend UX preset,
/// not a backend template — only `reverse_engineering` validates today.
fn valid_template(id: &str) -> bool {
    crate::services::builtin_templates::get(Some(id)).is_some()
}

/// Best-effort keyword → builtin-template id. Optional field: returns
/// `None` (never a gap) when nothing maps to a *real* backend template.
pub fn resolve_template(hint: &str) -> Option<&'static str> {
    let h = hint.trim().to_lowercase();
    if h.is_empty() {
        return None;
    }
    let id = if h.contains("review") {
        "code_review"
    } else if h.contains("revers") || h.contains("reveng") {
        "reverse_engineering"
    } else {
        return None;
    };
    // Only return ids that resolve to a real backend template; a reviewer
    // with no backend template is still a reviewer by title + first task.
    if valid_template(id) {
        Some(id)
    } else {
        None
    }
}

/// Default model id for a CLI agent spawned WITHOUT an explicit model, so the
/// agent starts on a concrete, real model from its available lineup instead of
/// the CLI's own opaque "auto" default. Only agents we deliberately pin return
/// `Some`; `None` keeps the agent on its built-in default (the prior
/// behaviour). No agent is currently pinned.
pub fn default_model_for(_tool: &str) -> Option<&'static str> {
    None
}

/// Map an effort hint to a canonical level. Optional field (never a gap).
pub fn resolve_effort(hint: &str) -> Option<&'static str> {
    match hint.trim().to_lowercase().as_str() {
        "low" => Some("low"),
        "medium" | "med" => Some("medium"),
        "high" => Some("high"),
        "extra_high" | "xhigh" | "extra high" => Some("extra_high"),
        "max" | "maximum" => Some("max"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProjectResolution {
    None,
    One(String),
    Many(Vec<String>),
}

/// Resolve a free-text project hint. An absolute path that exists on disk
/// wins outright. Otherwise match by basename/substring against the known
/// project paths (the caller's existing sessions). Exactly one match →
/// `One`; zero → `None`; many → `Many` (the form surfaces candidates).
pub fn resolve_project(hint: &str, known: &[String]) -> ProjectResolution {
    let raw = hint.trim();
    let h = raw.to_lowercase();
    if h.is_empty() {
        return ProjectResolution::None;
    }
    if std::path::Path::new(raw).is_dir() {
        return ProjectResolution::One(raw.to_string());
    }
    let mut hits: Vec<String> = known
        .iter()
        .filter(|kp| {
            let base = std::path::Path::new(kp)
                .file_name()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            base == h || base.contains(&h) || kp.to_lowercase().contains(&h)
        })
        .cloned()
        .collect();
    hits.sort_unstable();
    hits.dedup();
    match hits.len() {
        0 => ProjectResolution::None,
        1 => ProjectResolution::One(hits.remove(0)),
        _ => ProjectResolution::Many(hits),
    }
}

/// Resolve a raw spawn request into a canonical spec + the unresolved gaps.
/// `known_project_paths` are the caller's existing session folders (used to
/// resolve a bare project name like "xyz-backend").
///
/// Gap policy: only `project_path` can gap. Every other field falls back to
/// an auto-pick/default (tool → best active provider, model → provider
/// default, perm → ask, task → kickoff message) so spawning never blocks on
/// a form — the renderer only ever shows an inline folder picker.
pub fn resolve(raw: &RawSpawn, known_project_paths: &[String]) -> ResolvedSpawn {
    let mut gaps = Vec::new();

    // tool — an unresolvable hint falls back to the auto-pick (never a gap).
    let tool: Option<String> = raw
        .tool
        .as_deref()
        .filter(|h| !h.trim().is_empty())
        .and_then(resolve_tool)
        .map(str::to_string);

    // model (scoped to tool when known) — ambiguous/unknown hints fall back
    // to the provider's default model (never a gap).
    let model_name: Option<String> = match raw.model.as_deref() {
        Some(h) if !h.trim().is_empty() => match resolve_model(tool.as_deref(), h) {
            ModelResolution::One(id) => Some(id.to_string()),
            _ => None,
        },
        _ => None,
    };

    // permission — validated against the tool surface; an unrecognised hint
    // falls back to "default" (ask) at create time (never a gap).
    let permission_mode: Option<String> = raw.perm.as_deref().and_then(|h| {
        let pid = tool.as_deref().unwrap_or("claude-code");
        resolve_permission(pid, h).map(str::to_string)
    });

    let agent_template = raw
        .template
        .as_deref()
        .and_then(resolve_template)
        .map(str::to_string);
    let effort = raw
        .effort
        .as_deref()
        .and_then(resolve_effort)
        .map(str::to_string);

    // project_path — REQUIRED
    let project_path: Option<String> = match raw.project.as_deref() {
        Some(h) if !h.trim().is_empty() => match resolve_project(h, known_project_paths) {
            ProjectResolution::One(p) => Some(p),
            ProjectResolution::Many(ps) => {
                gaps.push(Gap {
                    field: "project_path".into(),
                    reason: GapReason::Ambiguous,
                    candidates: ps,
                });
                None
            }
            ProjectResolution::None => {
                gaps.push(Gap {
                    field: "project_path".into(),
                    reason: GapReason::Missing,
                    candidates: vec![],
                });
                None
            }
        },
        _ => {
            gaps.push(Gap {
                field: "project_path".into(),
                reason: GapReason::Missing,
                candidates: vec![],
            });
            None
        }
    };

    // first_task — optional at the resolve layer; the user-facing spawn
    // paths (staff directive + folder-picker Create) substitute
    // DEFAULT_KICKOFF_TASK when absent so the agent always starts.
    let first_task = raw.task.clone().filter(|s| !s.trim().is_empty());

    ResolvedSpawn {
        spec: SpawnSpec {
            title: raw.title.clone().filter(|s| !s.trim().is_empty()),
            project_path,
            tool,
            model_name,
            permission_mode,
            agent_template,
            effort,
            first_task,
            use_worktree: raw.worktree,
        },
        gaps,
    }
}

/// Fallback first task when neither the user nor the staff model supplied
/// one — a cheap activation turn so the new agent comes alive, introduces
/// itself, and is ready for follow-up dispatches. Applied by the
/// user-facing spawn paths only (staff directive + folder-picker Create);
/// the worker MCP path keeps spawn-idle semantics for its
/// spawn-then-dispatch flow.
pub const DEFAULT_KICKOFF_TASK: &str = "Briefly introduce yourself and give a short overview of \
     this project's structure, then wait for further instructions.";

/// Pick the best available CLI agent — no local preference list. The two
/// canonical sources the rest of the app already uses are crossed here:
///   • `providers::list_cli_agents()` — the catalog, in its declared order
///     (the same order Settings → Agents renders); first entry = primary.
///   • `AgentScanCache` — the live installed/authenticated scan, warmed at
///     boot and refreshed by Settings → Agents.
/// First catalog agent that is installed AND authenticated wins; else the
/// first merely installed; cold cache or nothing installed → "claude-code".
pub async fn auto_pick_tool(st: &AppState) -> String {
    let Some(scan) = st.agent_scan_cache.get().await else {
        return "claude-code".into();
    };
    let flag = |id: &str, key: &str| {
        scan.get(id)
            .and_then(|v| v.get(key))
            .and_then(|b| b.as_bool())
            .unwrap_or(false)
    };
    let agents = crate::providers::list_cli_agents();
    if let Some(p) = agents
        .iter()
        .find(|p| flag(p.id, "installed") && flag(p.id, "authenticated"))
    {
        return p.id.to_string();
    }
    if let Some(p) = agents.iter().find(|p| flag(p.id, "installed")) {
        return p.id.to_string();
    }
    "claude-code".into()
}

/// Distinct, non-empty project folders the user already has sessions in —
/// the candidate pool for resolving a bare project name.
pub async fn known_project_paths(pool: &SqlitePool, user_id: Option<&str>) -> Vec<String> {
    let rows: Vec<(String,)> = match user_id {
        Some(uid) => sqlx::query_as(
            "SELECT DISTINCT project_path FROM sessions \
             WHERE user_id = ? AND project_path <> '' AND archived_at IS NULL",
        )
        .bind(uid)
        .fetch_all(pool)
        .await
        .unwrap_or_default(),
        None => sqlx::query_as(
            "SELECT DISTINCT project_path FROM sessions \
             WHERE project_path <> '' AND archived_at IS NULL",
        )
        .fetch_all(pool)
        .await
        .unwrap_or_default(),
    };
    rows.into_iter().map(|(p,)| p).collect()
}

/// Create a session from a fully-resolved spec, reusing
/// `session_manager::create_session`. When `spec.first_task` is set, seed it
/// as the agent's first user message and kick its first turn in the
/// background (reusing the dispatch run machinery). `kick_result_sid` is the
/// session that receives the completion card — the staff session for the
/// staff path, the caller for the MCP path; falls back to the new session
/// itself.
pub async fn create(
    st: &AppState,
    user_id: Option<&str>,
    spec: &SpawnSpec,
    kick_result_sid: Option<&str>,
) -> anyhow::Result<Session> {
    // No provider named → the best active one (scan-cache preference order),
    // not a blind "claude-code" (which may not even be installed on this machine).
    let tool = match spec.tool.clone() {
        Some(t) => t,
        None => auto_pick_tool(st).await,
    };
    // No explicit model → pin the agent's concrete default when one is
    // configured; agents without a pin keep their own built-in default. An
    // explicit model is always honoured.
    let model_name = spec
        .model_name
        .clone()
        .or_else(|| default_model_for(&tool).map(str::to_string));
    let data = SessionCreate {
        title: spec.title.clone().unwrap_or_else(|| "Agent".into()),
        project_path: spec.project_path.clone().unwrap_or_default(),
        tool,
        group_path: String::new(),
        notes: None,
        model_name,
        permission_mode: spec
            .permission_mode
            .clone()
            .unwrap_or_else(|| "default".into()),
        session_mode: "new".into(),
        claude_session_id: None,
        // Worktree isolation is opt-in: spawned agents work directly in the
        // project folder unless the user explicitly asked for a worktree
        // (form toggle or "worktree":true in the spawn directive).
        use_worktree: spec.use_worktree.unwrap_or(false),
        agent_template: spec.agent_template.clone(),
        account_id: None,
        origin: None,
        effort: None,
        base_branch: None,
        // Spawn-form sessions are host sessions. A container target is
        // picked in the composer, which goes through create_session.
        exec_mode: None,
        container_id: None,
        container_workdir: None,
        container_image: None,
        container_mount_credentials: None,
        container_source: None,
        container_file: None,
        container_service: None,
    };

    let session = st
        .sm
        .create_session(&st.auth.pool, st.app_cfg.as_ref(), &data, user_id)
        .await?;

    // Seed the routing pin so the first turn respects the chosen (tool, model)
    // — mirrors routers::sessions::create_session.
    if let Some(model) = session.model_name.as_deref() {
        let _ = sqlx::query(
            "UPDATE sessions SET pinned_agent = ?, pinned_model = ?, routing_decision_id = NULL WHERE id = ?",
        )
        .bind(&session.tool)
        .bind(model)
        .bind(&session.id)
        .execute(&st.auth.pool)
        .await;
    }

    // First task → start the agent immediately.
    if let Some(task) = spec.first_task.as_deref().filter(|t| !t.trim().is_empty()) {
        let _ = sqlx::query(
            "INSERT INTO messages (id,session_id,role,content,cost_usd,timestamp) \
             VALUES (?,?,?,?,0.0,?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&session.id)
        .bind("user")
        .bind(serde_json::json!([{"type":"text","text":task}]).to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&st.auth.pool)
        .await;

        // `FLEETIFY_SPAWN_NO_KICK=1` is a test seam (mirrors FLEETIFY_NOAUTH):
        // integration tests exercise the full create+seed path without
        // launching a real CLI bridge turn.
        if std::env::var("FLEETIFY_SPAWN_NO_KICK").is_ok_and(|v| v == "1") {
            return Ok(session);
        }

        let routing_res = crate::services::routing::persist::resolve_routing_for_dispatch(
            &st.auth.pool,
            &st.routing,
            &session.id,
            &session.id,
            &session.tool,
            session.model_name.as_deref(),
            task,
        )
        .await;

        let pool = st.auth.pool.clone();
        let sm = st.sm;
        let result_sid = kick_result_sid.unwrap_or(&session.id).to_string();
        let target = session.clone();
        let task_owned = task.to_string();
        let task_card = task.to_string();
        tokio::spawn(async move {
            crate::routers::chat::run_dispatched_task_internal(
                pool,
                sm,
                result_sid,
                target,
                task_owned,
                task_card,
                routing_res,
            )
            .await;
        });
    }

    Ok(session)
}

/// Parse every `[[SPAWN:{json}]]` token in document order into a RawSpawn.
/// Malformed payloads are skipped (the staff agent re-emits or the user
/// re-asks) rather than failing the whole turn.
pub fn parse_spawns(text: &str) -> Vec<RawSpawn> {
    crate::services::dispatch::parse_spawn_payloads(text)
        .iter()
        .filter_map(|p| serde_json::from_str::<RawSpawn>(p).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_spawn_parses_from_json() {
        let raw: RawSpawn = serde_json::from_str(
            r#"{"title":"code-reviewer","project":"xyz-backend","tool":"claude-code","model":"opus 4.8","perm":"bypass","template":"code_review"}"#,
        )
        .unwrap();
        assert_eq!(raw.title.as_deref(), Some("code-reviewer"));
        assert_eq!(raw.model.as_deref(), Some("opus 4.8"));
        assert_eq!(raw.task, None);
    }

    fn raw(json: &str) -> RawSpawn {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn resolve_tool_exact_and_alias() {
        assert_eq!(resolve_tool("claude-code"), Some("claude-code"));
        assert_eq!(resolve_tool("Claude Code"), Some("claude-code"));
        assert_eq!(resolve_tool("OpenAI"), Some("openai"));
        assert_eq!(resolve_tool("totally-unknown-xyz"), None);
    }

    #[test]
    fn resolve_model_opus_48() {
        match resolve_model(Some("claude-code"), "opus 4.8") {
            ModelResolution::One(id) => assert_eq!(id, "claude-opus-4-8"),
            other => panic!("expected One(claude-opus-4-8), got {other:?}"),
        }
    }

    #[test]
    fn resolve_model_unknown_is_none() {
        assert!(matches!(
            resolve_model(Some("claude-code"), "totally-made-up-model"),
            ModelResolution::None
        ));
    }

    #[test]
    fn resolve_permission_phrases() {
        assert_eq!(
            resolve_permission("claude-code", "bypass all permissions"),
            Some("bypassPermissions")
        );
        assert_eq!(
            resolve_permission("claude-code", "full auto"),
            Some("bypassPermissions")
        );
        assert_eq!(resolve_permission("claude-code", "ask"), Some("default"));
        assert_eq!(resolve_permission("claude-code", "plan only"), Some("plan"));
        assert_eq!(
            resolve_permission("claude-code", "bypassPermissions"),
            Some("bypassPermissions")
        );
        assert_eq!(resolve_permission("claude-code", "gibberish"), None);
    }

    #[test]
    fn perm_rank_orders_least_to_most() {
        assert!(perm_rank("plan") < perm_rank("default"));
        assert!(perm_rank("default") < perm_rank("acceptEdits"));
        assert!(perm_rank("acceptEdits") < perm_rank("bypassPermissions"));
    }

    #[test]
    fn resolve_template_keywords() {
        // reverse_engineering is the one real backend builtin template.
        assert_eq!(
            resolve_template("reverse engineer this"),
            Some("reverse_engineering")
        );
        // "code review" has no backend builtin template → None (the agent is
        // still a reviewer by name/task; we never set a bogus template id).
        assert_eq!(resolve_template("code reviewer"), None);
        assert_eq!(resolve_template("knitting"), None);
    }

    #[test]
    fn resolve_effort_levels() {
        assert_eq!(resolve_effort("max"), Some("max"));
        assert_eq!(resolve_effort("HIGH"), Some("high"));
        assert_eq!(resolve_effort("nonsense"), None);
    }

    #[test]
    fn default_model_for_pins_nothing_by_default() {
        // No agent is currently pinned — every tool keeps its own built-in
        // default, so `None` ("don't pin") is returned across the board.
        assert_eq!(default_model_for("claude-code"), None);
        assert_eq!(default_model_for("codex-cli"), None);
        assert_eq!(default_model_for("totally-unknown"), None);
    }

    #[test]
    fn resolve_project_basename_match() {
        let known = vec![
            "/home/u/work/xyz-backend".to_string(),
            "/home/u/work/frontend".to_string(),
        ];
        match resolve_project("xyz-backend", &known) {
            ProjectResolution::One(p) => assert_eq!(p, "/home/u/work/xyz-backend"),
            other => panic!("expected One, got {other:?}"),
        }
        assert!(matches!(
            resolve_project("nope", &known),
            ProjectResolution::None
        ));
    }

    #[test]
    fn resolve_project_ambiguous() {
        let known = vec!["/a/api".to_string(), "/b/api".to_string()];
        match resolve_project("api", &known) {
            ProjectResolution::Many(ps) => assert_eq!(ps.len(), 2),
            other => panic!("expected Many, got {other:?}"),
        }
    }

    #[test]
    fn resolve_full_no_gaps() {
        let known = vec!["/home/u/xyz-backend".to_string()];
        let r = resolve(
            &raw(
                r#"{"title":"code-reviewer","project":"xyz-backend","tool":"claude code","model":"opus 4.8","perm":"bypass","template":"code_review","task":"review the open PR"}"#,
            ),
            &known,
        );
        assert!(r.gaps.is_empty(), "expected no gaps, got {:?}", r.gaps);
        assert_eq!(r.spec.tool.as_deref(), Some("claude-code"));
        assert_eq!(r.spec.model_name.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(r.spec.permission_mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(r.spec.project_path.as_deref(), Some("/home/u/xyz-backend"));
        assert_eq!(r.spec.first_task.as_deref(), Some("review the open PR"));
        // "code_review" has no backend builtin template → agent_template stays None.
        assert_eq!(r.spec.agent_template, None);
        // Worktree not mentioned → unset (create() defaults it OFF).
        assert_eq!(r.spec.use_worktree, None);
    }

    #[test]
    fn resolve_missing_project_is_gap() {
        let r = resolve(&raw(r#"{"title":"x","tool":"claude-code"}"#), &[]);
        assert!(r
            .gaps
            .iter()
            .any(|g| g.field == "project_path" && g.reason == GapReason::Missing));
    }

    #[test]
    fn resolve_missing_task_is_not_a_gap() {
        // No first task ⇒ no gap: the user-facing paths substitute
        // DEFAULT_KICKOFF_TASK so the agent is created and started without
        // any confirmation form.
        let known = vec!["/home/u/test_a".to_string()];
        let r = resolve(
            &raw(r#"{"title":"codex-test_a","project":"test_a","tool":"codex-cli"}"#),
            &known,
        );
        assert!(r.gaps.is_empty(), "expected no gaps, got {:?}", r.gaps);
        assert_eq!(r.spec.first_task, None);
        // Whitespace-only task normalises to None the same way.
        let r = resolve(
            &raw(r#"{"project":"test_a","tool":"codex-cli","task":"   "}"#),
            &known,
        );
        assert!(r.gaps.is_empty());
        assert_eq!(r.spec.first_task, None);
    }

    #[test]
    fn resolve_unresolvable_hints_fall_back_without_gaps() {
        // Only project_path can gap — bogus tool/model/perm hints degrade to
        // None (auto-pick / provider default / ask) instead of opening a form.
        let known = vec!["/home/u/test_a".to_string()];
        let r = resolve(
            &raw(
                r#"{"project":"test_a","tool":"qwerty-unknown","model":"made-up-9000","perm":"gibberish","task":"do x"}"#,
            ),
            &known,
        );
        assert!(r.gaps.is_empty(), "expected no gaps, got {:?}", r.gaps);
        assert_eq!(r.spec.tool, None);
        assert_eq!(r.spec.model_name, None);
        assert_eq!(r.spec.permission_mode, None);
    }

    #[test]
    fn resolve_passes_worktree_through() {
        let known = vec!["/home/u/test_a".to_string()];
        let r = resolve(
            &raw(r#"{"project":"test_a","tool":"codex-cli","task":"do x","worktree":true}"#),
            &known,
        );
        assert_eq!(r.spec.use_worktree, Some(true));
        let r = resolve(
            &raw(r#"{"project":"test_a","tool":"codex-cli","task":"do x","worktree":false}"#),
            &known,
        );
        assert_eq!(r.spec.use_worktree, Some(false));
    }

    #[test]
    fn parse_spawns_skips_malformed() {
        let text = r#"[[SPAWN:{"title":"good"}]] [[SPAWN:{not json}]]"#;
        let v = parse_spawns(text);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].title.as_deref(), Some("good"));
    }
}
