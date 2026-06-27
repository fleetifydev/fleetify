//! Lookup helpers over the `'static` provider catalog. Linear scans are
//! fine here — N ≤ 15 today, and a HashMap would force lifetime juggling
//! against `&'static str` keys for negligible speed-up.

use super::catalog::{ProviderKind, ProviderSpec, CATALOG};

/// Return the spec for *any* provider id (HTTP, LocalHttp, or CLI). Ids are
/// looked up as-is — every source (DB rows via migrations, marketplace, the
/// model catalog) uses the canonical id, so no legacy aliasing is needed.
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

/// Resolve the model id to dispatch for an HTTP provider. Valid id ⇒ itself.
/// Invalid id with a known model list ⇒ heal to the first baked model. Empty
/// model list (dynamic / CLI providers) ⇒ fail-open (return as-is). `None`
/// only when the provider has a model list but nothing to heal to.
///
/// This is a SAFETY NET, not the authoring path: it heals to
/// `default_models.first()` (the first baked model), NOT the `default`-flagged
/// model — the frontend owns honouring the flagged default before send.
pub fn resolve_dispatch_model(
    model_name: Option<&str>,
    spec: &'static ProviderSpec,
) -> Option<String> {
    let m = model_name.unwrap_or("");
    if spec.default_models.is_empty() {
        return Some(m.to_string()); // dynamic/CLI — cannot validate, fail-open
    }
    if !m.is_empty() && spec.default_models.iter().any(|x| x.id == m) {
        return Some(m.to_string());
    }
    spec.default_models
        .first()
        .map(|first| first.id.to_string())
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
        assert!(find_provider("claude-code").is_some());
    }

    #[test]
    fn find_provider_returns_none_for_unknown_id() {
        assert!(find_provider("not-a-real-provider").is_none());
        assert!(find_provider("").is_none());
    }

    #[test]
    fn find_agent_filters_to_cli_kind() {
        // `claude-code` is a CLI agent — both lookups succeed.
        assert!(find_agent("claude-code").is_some());
        assert!(find_provider("claude-code").is_some());
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
        assert!(api.iter().all(|p| p.id != "claude-code"));
    }

    #[test]
    fn list_cli_agents_excludes_http_providers() {
        let cli = list_cli_agents();
        assert!(cli.iter().all(|p| matches!(p.kind, ProviderKind::Cli)));
        assert!(cli.iter().any(|p| p.id == "claude-code"));
        assert!(cli.iter().any(|p| p.id == "kimi-code"));
        assert!(cli.iter().all(|p| p.id != "openai"));
        assert!(cli.iter().all(|p| p.id != "ollama"));
    }

    #[test]
    fn cloudflare_workers_ai_is_registered_as_api_provider() {
        use super::super::catalog::{AuthSpec, ProviderKind};
        let spec = super::find_provider("cloudflare-workers-ai")
            .expect("cloudflare-workers-ai should be registered");
        assert_eq!(spec.kind, ProviderKind::Api);
        assert!(matches!(spec.auth, AuthSpec::Bearer { .. }));
        // Base URL is an account-scoped template resolved at dispatch.
        assert!(
            spec.default_base_url.contains("{account_id}")
                && spec.default_base_url.ends_with("/ai/v1"),
            "got {}",
            spec.default_base_url
        );
        // Curated models are all Workers AI `@cf/...` ids.
        assert!(!spec.default_models.is_empty());
        assert!(spec.default_models.iter().all(|m| m.id.starts_with("@cf/")));
        // Shows up in the API-provider list (Settings → Models), not agents.
        assert!(super::list_api_providers()
            .iter()
            .any(|p| p.id == "cloudflare-workers-ai"));
    }

    #[test]
    fn cloudflare_catalog_lists_current_workers_ai_models() {
        let spec = super::find_provider("cloudflare-workers-ai").expect("registered");
        let ids: Vec<&str> = spec.default_models.iter().map(|m| m.id).collect();
        // The refreshed catalog covers the current Workers AI text-generation
        // line-up (every id verified live against /ai/v1), not just the
        // original four. Spot-check flagships across vendors.
        for id in [
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            "@cf/meta/llama-4-scout-17b-16e-instruct",
            "@cf/qwen/qwen3-30b-a3b-fp8",
            "@cf/mistralai/mistral-small-3.1-24b-instruct",
            "@cf/openai/gpt-oss-120b",
        ] {
            assert!(ids.contains(&id), "Cloudflare catalog missing {id}");
        }
        assert!(
            ids.len() >= 18,
            "expected the full Workers AI line-up, got {}",
            ids.len()
        );
        // Excluded on purpose: the safety classifier is not a chat model, and
        // the vision model 403s until the user accepts a separate license.
        assert!(!ids.contains(&"@cf/meta/llama-guard-3-8b"));
        assert!(!ids.contains(&"@cf/meta/llama-3.2-11b-vision-instruct"));
    }

    #[test]
    fn resolve_dispatch_model_valid_passes_through() {
        let s = find_provider("openai").expect("openai in catalog");
        let first = s.default_models.first().expect("openai has models").id;
        assert_eq!(
            resolve_dispatch_model(Some(first), s),
            Some(first.to_string())
        );
    }

    #[test]
    fn resolve_dispatch_model_invalid_heals_to_first() {
        let s = find_provider("openai").expect("openai in catalog");
        let first = s.default_models.first().unwrap().id.to_string();
        assert_eq!(
            resolve_dispatch_model(Some("nonexistent-xyz"), s),
            Some(first)
        );
    }

    #[test]
    fn resolve_dispatch_model_empty_default_models_fail_open() {
        // claude-code is a CLI provider with `default_models == &[]`.
        let s = find_provider("claude-code").expect("claude-code in catalog");
        assert!(s.default_models.is_empty());
        assert_eq!(
            resolve_dispatch_model(Some("whatever"), s),
            Some("whatever".to_string())
        );
    }

    #[test]
    fn resolve_dispatch_model_null_heals_to_first_for_http_provider() {
        let s = find_provider("openai").unwrap();
        let first = s.default_models.first().unwrap().id.to_string();
        assert_eq!(resolve_dispatch_model(None, s), Some(first));
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
