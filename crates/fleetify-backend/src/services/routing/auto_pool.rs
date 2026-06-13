//! Active-provider-scoped candidate pool for the picker's **Auto** mode.
//!
//! Auto must only ever offer Not Diamond models the user can ACTUALLY run, and
//! it picks the execution route per model family from which providers are
//! currently active. Otherwise Not Diamond can recommend (say) OpenAI while the
//! user has no OpenAI execution path, and the turn dies with
//! "no API key for provider `openai`".
//!
//! Two id-spaces are in play (see [`nd_model_to_dispatch`]): the **Not Diamond
//! catalog id** we send + ND echoes back, and the **Fleet dispatch id** the
//! bridge runs. They mostly match, but Not Diamond spells the newest Claudes
//! with a dot (`claude-sonnet-4.6`) where the Claude CLI / Anthropic API use a
//! dash (`claude-sonnet-4-6`).
//!
//! Pure + unit-testable: callers pass in the active-state probes (CLI-agent
//! authenticated; API key on file), so no `AppState` / network / DB is needed
//! here. The chat send-flow builds those probes from `st` and feeds them in.
//!
//! Every `nd_models` id MUST appear in Not Diamond's live catalog
//! (`GET https://api.notdiamond.ai/v2/models`) — ND 400s the WHOLE request on a
//! single unknown id, which silently demotes Auto to the built-in fallback.
//! These lists are deliberately tunable; treat them as the verified-good
//! intersection of (ND catalog) ∩ (dispatchable on the chosen route).

use crate::services::routing::traits::{AgentCandidate, AgentKind};

/// One model family's resolved execution route plus the Not Diamond-form model
/// ids Auto offers for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoRoute {
    /// Not Diamond provider family (maps to ND's `anthropic`/`openai`/`google`
    /// prefix via the router's `provider_prefix`).
    pub agent: AgentKind,
    /// The `session.tool` the bridge dispatches for this family — the actual
    /// execution path chosen from active providers (e.g. `claude` for the
    /// Claude Code CLI vs `anthropic` for the direct API; `codex` vs `openai`;
    /// `gemini` vs `gemini-api`).
    pub execution_tool: String,
    /// Not Diamond-catalog ids to send for this family. Cheap→strong spread so
    /// ND's `tradeoff:"cost"` has room to trade.
    pub nd_models: Vec<String>,
}

// ── Per-route Not Diamond-form model lists (verified against the live catalog) ──
// Claude Code / Anthropic API dispatch dash forms; we send ND its dot forms for
// the 4.x models and map back in `nd_model_to_dispatch`.
fn claude_nd_models() -> Vec<String> {
    vec![
        "claude-haiku-4-5".into(),
        "claude-sonnet-4.6".into(),
        "claude-opus-4.7".into(),
    ]
}
// Codex CLI dispatches gpt-5.2 / gpt-5.4 / gpt-5.5; ND knows 5.2 + 5.5 (bare 5.4
// is absent from ND's catalog, only 5.4-mini/-nano/-pro).
fn openai_codex_nd_models() -> Vec<String> {
    vec!["gpt-5.2".into(), "gpt-5.5".into()]
}
// OpenAI API: Fleet's catalog carries gpt-5-mini / gpt-5 / gpt-5.5, all in ND.
fn openai_api_nd_models() -> Vec<String> {
    vec!["gpt-5-mini".into(), "gpt-5".into(), "gpt-5.5".into()]
}
// Gemini CLI surfaces the 3.x line; ND knows the previews.
fn gemini_cli_nd_models() -> Vec<String> {
    vec![
        "gemini-3-flash-preview".into(),
        "gemini-3.1-pro-preview".into(),
    ]
}
// Gemini API: Fleet's catalog spans 2.5 + 3.1; these are all in ND.
fn gemini_api_nd_models() -> Vec<String> {
    vec![
        "gemini-2.5-flash".into(),
        "gemini-2.5-pro".into(),
        "gemini-3.1-pro-preview".into(),
    ]
}

/// Resolve the Auto routes from active-provider state, in execution-preference
/// order per family.
///
/// * `cli_authed(id)` — that CLI agent (`claude`/`codex`/`gemini`) is installed
///   AND authenticated (from the agent scan cache).
/// * `has_key(id)` — an API key is on file for that provider id
///   (`anthropic`/`openai`/`gemini-api`), via `providers::keys::get_key`.
///
/// A family with no active execution path is omitted entirely, so Not Diamond
/// can never recommend something Fleet can't run.
///
/// NOTE: the Anthropic-API fallback (`execution_tool == "anthropic"`) is gated
/// behind `anthropic_api_available` because Fleet has no Anthropic-native
/// adapter yet (that bridge is Phase 2). Pass `false` until it exists so we
/// never route to a tool with no bridge.
pub fn select_routes(
    cli_authed: &dyn Fn(&str) -> bool,
    has_key: &dyn Fn(&str) -> bool,
    anthropic_api_available: bool,
) -> Vec<AutoRoute> {
    let mut routes = Vec::new();

    // Claude family: Claude Code CLI first, then the direct Anthropic API.
    if cli_authed("claude-code") {
        routes.push(AutoRoute {
            agent: AgentKind::Claude,
            execution_tool: "claude-code".into(),
            nd_models: claude_nd_models(),
        });
    } else if anthropic_api_available && has_key("anthropic") {
        routes.push(AutoRoute {
            agent: AgentKind::Claude,
            execution_tool: "anthropic".into(),
            nd_models: claude_nd_models(),
        });
    }

    // OpenAI family: Codex CLI first, then the direct OpenAI API.
    if cli_authed("codex-cli") {
        routes.push(AutoRoute {
            agent: AgentKind::OpenAI,
            execution_tool: "codex-cli".into(),
            nd_models: openai_codex_nd_models(),
        });
    } else if has_key("openai") {
        routes.push(AutoRoute {
            agent: AgentKind::OpenAI,
            execution_tool: "openai".into(),
            nd_models: openai_api_nd_models(),
        });
    }

    // Gemini family: Gemini CLI first, then the direct Google API.
    if cli_authed("gemini-cli") {
        routes.push(AutoRoute {
            agent: AgentKind::Gemini,
            execution_tool: "gemini-cli".into(),
            nd_models: gemini_cli_nd_models(),
        });
    } else if has_key("gemini-api") {
        routes.push(AutoRoute {
            agent: AgentKind::Gemini,
            execution_tool: "gemini-api".into(),
            nd_models: gemini_api_nd_models(),
        });
    }

    routes
}

/// Candidate set to hand Not Diamond (and the built-in fallback) — one
/// `AgentCandidate` per resolved route.
pub fn candidates(routes: &[AutoRoute]) -> Vec<AgentCandidate> {
    routes
        .iter()
        .map(|r| AgentCandidate {
            agent: r.agent,
            tiers: r.nd_models.clone(),
        })
        .collect()
}

/// The `execution_tool` chosen for the family Not Diamond picked, if that
/// family is in the resolved routes.
pub fn execution_tool_for(routes: &[AutoRoute], agent: AgentKind) -> Option<String> {
    routes
        .iter()
        .find(|r| r.agent == agent)
        .map(|r| r.execution_tool.clone())
}

/// Map a Not Diamond catalog model id to the id Fleet's bridge dispatches. Not
/// Diamond spells the newest Claudes with a DOT (`claude-sonnet-4.6`,
/// `claude-opus-4.7`) while the Claude CLI / Anthropic API use a DASH
/// (`claude-sonnet-4-6`, `claude-opus-4-7`) — same model, different string.
/// Every other candidate id is byte-identical in both systems.
pub fn nd_model_to_dispatch(agent: AgentKind, nd_model: &str) -> String {
    match (agent, nd_model) {
        (AgentKind::Claude, "claude-sonnet-4.6") => "claude-sonnet-4-6".to_string(),
        (AgentKind::Claude, "claude-opus-4.7") => "claude-opus-4-7".to_string(),
        _ => nd_model.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &str) -> bool {
        false
    }

    #[test]
    fn only_active_families_are_offered() {
        // Only Claude Code authed → only the Claude family, via the CLI.
        let routes = select_routes(&|id| id == "claude-code", &none, false);
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].agent, AgentKind::Claude);
        assert_eq!(routes[0].execution_tool, "claude-code");
    }

    #[test]
    fn no_active_provider_yields_empty_pool() {
        let routes = select_routes(&none, &none, false);
        assert!(routes.is_empty());
    }

    #[test]
    fn cli_wins_over_api_for_openai_and_gemini() {
        // Codex + Gemini CLI authed AND their API keys present → CLI wins.
        let routes = select_routes(
            &|id| matches!(id, "codex-cli" | "gemini-cli"),
            &|id| matches!(id, "openai" | "gemini-api"),
            false,
        );
        let openai = routes
            .iter()
            .find(|r| r.agent == AgentKind::OpenAI)
            .unwrap();
        assert_eq!(openai.execution_tool, "codex-cli");
        let gemini = routes
            .iter()
            .find(|r| r.agent == AgentKind::Gemini)
            .unwrap();
        assert_eq!(gemini.execution_tool, "gemini-cli");
    }

    #[test]
    fn api_fallback_when_cli_absent() {
        // No CLIs, but OpenAI + Gemini API keys present → API routes.
        let routes = select_routes(&none, &|id| matches!(id, "openai" | "gemini-api"), false);
        assert_eq!(
            execution_tool_for(&routes, AgentKind::OpenAI).as_deref(),
            Some("openai")
        );
        assert_eq!(
            execution_tool_for(&routes, AgentKind::Gemini).as_deref(),
            Some("gemini-api")
        );
        // Claude has no path (no CLI, anthropic adapter unavailable) → omitted.
        assert!(execution_tool_for(&routes, AgentKind::Claude).is_none());
    }

    #[test]
    fn anthropic_api_route_gated_on_adapter_availability() {
        // Anthropic key present but adapter unavailable (Phase 1) → no Claude.
        let routes = select_routes(&none, &|id| id == "anthropic", false);
        assert!(execution_tool_for(&routes, AgentKind::Claude).is_none());
        // Adapter available (Phase 2) → Claude via the anthropic API tool.
        let routes = select_routes(&none, &|id| id == "anthropic", true);
        assert_eq!(
            execution_tool_for(&routes, AgentKind::Claude).as_deref(),
            Some("anthropic")
        );
    }

    #[test]
    fn candidates_mirror_routes() {
        let routes = select_routes(&|id| id == "claude-code", &none, false);
        let c = candidates(&routes);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].agent, AgentKind::Claude);
        // ND-form ids: dotted sonnet/opus are what we SEND.
        assert!(c[0].tiers.iter().any(|m| m == "claude-sonnet-4.6"));
        assert!(c[0].tiers.iter().any(|m| m == "claude-opus-4.7"));
    }

    #[test]
    fn dispatch_mapping_dot_to_dash_for_claude_only() {
        assert_eq!(
            nd_model_to_dispatch(AgentKind::Claude, "claude-sonnet-4.6"),
            "claude-sonnet-4-6"
        );
        assert_eq!(
            nd_model_to_dispatch(AgentKind::Claude, "claude-opus-4.7"),
            "claude-opus-4-7"
        );
        // Haiku is already dash-form; identical.
        assert_eq!(
            nd_model_to_dispatch(AgentKind::Claude, "claude-haiku-4-5"),
            "claude-haiku-4-5"
        );
        // Other families pass through untouched (OpenAI/Google use dots natively).
        assert_eq!(
            nd_model_to_dispatch(AgentKind::OpenAI, "gpt-5.5"),
            "gpt-5.5"
        );
        assert_eq!(
            nd_model_to_dispatch(AgentKind::Gemini, "gemini-2.5-pro"),
            "gemini-2.5-pro"
        );
    }
}
