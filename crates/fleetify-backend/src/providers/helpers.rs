//! Lookup helpers over the `'static` provider catalog. Linear scans are
//! fine here — N ≤ 15 today, and a HashMap would force lifetime juggling
//! against `&'static str` keys for negligible speed-up.

use super::catalog::{ProviderKind, ProviderSpec, CATALOG};

/// Return the spec for *any* provider id (HTTP, LocalHttp, or CLI).
pub fn find_provider(id: &str) -> Option<&'static ProviderSpec> {
    CATALOG.iter().find(|p| p.id == id)
}

/// CLI agents only — Settings → Agents tab + `routers/chat.rs` dispatch
/// when `tool` matches a CLI bridge.
pub fn find_agent(id: &str) -> Option<&'static ProviderSpec> {
    CATALOG
        .iter()
        .find(|p| p.id == id && matches!(p.kind, ProviderKind::Cli))
}

/// Cloud HTTP + LocalHttp providers. Drives Settings → Models tile list
/// and the chat composer's grouped model picker.
pub fn list_api_providers() -> Vec<&'static ProviderSpec> {
    CATALOG
        .iter()
        .filter(|p| matches!(p.kind, ProviderKind::Api | ProviderKind::LocalHttp))
        .collect()
}

/// CLI agents only. Drives Settings → Agents tile list.
pub fn list_cli_agents() -> Vec<&'static ProviderSpec> {
    CATALOG
        .iter()
        .filter(|p| matches!(p.kind, ProviderKind::Cli))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_provider_returns_some_for_known_ids() {
        assert!(find_provider("openai").is_some());
        assert!(find_provider("perplexity").is_some());
        assert!(find_provider("ollama").is_some());
        assert!(find_provider("claude").is_some());
    }

    #[test]
    fn find_provider_returns_none_for_unknown_id() {
        assert!(find_provider("not-a-real-provider").is_none());
        assert!(find_provider("").is_none());
    }

    #[test]
    fn find_agent_filters_to_cli_kind() {
        // `claude` is a CLI agent — both lookups succeed.
        assert!(find_agent("claude").is_some());
        assert!(find_provider("claude").is_some());
        // `openai` is an HTTP provider — find_agent must NOT return it
        // even though the id is in the catalog.
        assert!(find_agent("openai").is_none());
        assert!(find_provider("openai").is_some());
    }

    #[test]
    fn list_api_providers_excludes_cli_agents() {
        let api = list_api_providers();
        // Every entry is either Api or LocalHttp — no CLI bleed-through.
        assert!(api
            .iter()
            .all(|p| matches!(p.kind, ProviderKind::Api | ProviderKind::LocalHttp)));
        // Ollama (LocalHttp) is included.
        assert!(api.iter().any(|p| p.id == "ollama"));
        // Claude (CLI) is not.
        assert!(api.iter().all(|p| p.id != "claude"));
    }

    #[test]
    fn list_cli_agents_excludes_http_providers() {
        let cli = list_cli_agents();
        assert!(cli.iter().all(|p| matches!(p.kind, ProviderKind::Cli)));
        assert!(cli.iter().any(|p| p.id == "claude"));
        assert!(cli.iter().any(|p| p.id == "kimi"));
        assert!(cli.iter().all(|p| p.id != "openai"));
        assert!(cli.iter().all(|p| p.id != "ollama"));
    }

    #[test]
    fn find_agent_returns_github_copilot() {
        use super::super::catalog::AuthSpec;
        let spec =
            super::find_agent("github-copilot").expect("github-copilot should be registered");
        assert_eq!(spec.id, "github-copilot");
        assert_eq!(spec.bin, "copilot");
        assert_eq!(spec.kind, super::ProviderKind::Cli);
        assert!(matches!(spec.auth, AuthSpec::None));
        // OAuth file + 3 env vars = 4 indicators
        assert_eq!(spec.auth_indicators.len(), 4);
    }
}
