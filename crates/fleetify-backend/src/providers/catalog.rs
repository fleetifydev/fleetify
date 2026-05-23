//! `'static` provider catalog — single source of truth for the renderer's
//! Settings tiles, the chat composer's model picker, and the chat-dispatch
//! site in `routers/chat.rs`.
//!
//! Schema is shaped by what the renderer needs to render a tile (display
//! name, kind, default models, auth flavor) plus what the backend needs to
//! dispatch (default base URL, env-var hint for legacy migration). Anything
//! provider-specific that doesn't fit (Perplexity citations, NVIDIA NIM
//! provider-prefixed model ids, Ollama dynamic models) lives in
//! `ProviderExtras` so the renderer can branch on capability flags without
//! hard-coding provider ids.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Cloud HTTP API the user supplies a key for (OpenAI, DeepSeek, ...).
    Api,
    /// Local HTTP daemon (Ollama). Same dispatch shape as `Api` minus the
    /// keychain entry; renderer surfaces a base-URL input instead of a key.
    LocalHttp,
    /// Subprocess agent driven over ACP / stdio (claude / codex / gemini /
    /// kimi). Not a chat provider — appears in Settings → Agents only.
    Cli,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthSpec {
    /// `Authorization: Bearer <key>`. `env_hint` is the legacy environment
    /// variable users may already have set — surfaced in the renderer as a
    /// "fall back to env" placeholder and consulted by the one-shot
    /// migration when no JSON / keychain entry is present.
    Bearer { env_hint: Option<&'static str> },
    /// Custom header name (e.g. `x-api-key`). Same `env_hint` semantics.
    ApiKey {
        header: &'static str,
        env_hint: Option<&'static str>,
    },
    /// No credential needed (Ollama on localhost, CLI agents that handle
    /// auth out-of-band).
    None,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// Human-readable context window (e.g. `"128K"`, `"1M"`) — purely
    /// display, never parsed for routing decisions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<&'static str>,
    /// "Legacy", "Preview", etc. Surfaces as a small badge next to the
    /// model in the picker so users can tell newer variants apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct ProviderExtras {
    /// Provider returns `citations: [{url, ...}]` alongside text deltas
    /// (Perplexity Sonar family). Renderer reserves a `<CitationCard>` slot
    /// under the assistant message when this is set.
    #[serde(default)]
    pub citations: bool,
    /// Provider returns `search_results: [{url, title, snippet}]`
    /// (Perplexity again). Same renderer slot, different schema.
    #[serde(default)]
    pub search_results: bool,
    /// Model list is fetched at runtime instead of being curated in this
    /// table (Ollama). Renderer hides the static checkbox grid and shows a
    /// "Detect models" button instead.
    #[serde(default)]
    pub dynamic_models: bool,
    /// Provider supports SSE / chunked streaming. Default for all the
    /// catalog entries below, but breaking it out explicitly leaves room
    /// for a future polling-only fallback without rewriting the schema.
    #[serde(default)]
    pub supports_streaming: bool,
}

/// File / env-var indicator that tells us a CLI agent is logged in. Backs
/// the "Detected" / "Login required" pill in Settings → Agents. Order
/// matters — the first hit wins, so put the cheapest / most specific
/// check first.
///
/// Variants use struct form because serde's internally-tagged enums refuse
/// newtype variants wrapping a primitive (the renderer reads the catalog
/// as JSON, so this needs to serialize cleanly).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthIndicator {
    /// Path relative to the user's home dir (`~`). Existence ⇒ authed.
    HomeDir { path: &'static str },
    /// Environment variable presence ⇒ authed. Used for headless / CI
    /// flows that skip the interactive `login` browser dance.
    EnvVar { name: &'static str },
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub kind: ProviderKind,
    /// Default API endpoint. Overridable per-install for `LocalHttp`
    /// (Ollama remote) via `ProvidersConfig::ollama_base_url`; static for
    /// every cloud provider.
    pub default_base_url: &'static str,
    pub auth: AuthSpec,
    /// Curated model list shown in the chat composer's picker. Each entry
    /// is opt-in / opt-out per user via `ProvidersConfig::enabled_models`
    /// (Settings → Models → checkboxes).
    pub default_models: &'static [ModelSpec],
    pub extras: ProviderExtras,
    /// CLI-only: PATH binary the renderer checks via `which`. `""` for HTTP
    /// providers.
    pub bin: &'static str,
    /// CLI-only: indicators that flag the agent as authenticated. Empty
    /// for HTTP providers.
    pub auth_indicators: &'static [AuthIndicator],
    /// Shown verbatim in Settings → Agents when the binary isn't on PATH
    /// (e.g. `"npm install -g @anthropic-ai/claude-code"`). Empty for HTTP
    /// providers, which surface their own "Get an API key" link instead.
    pub install_hint: &'static str,
    /// Shown verbatim when the binary is installed but the auth indicator
    /// hasn't fired (e.g. `"claude login"`). Empty otherwise.
    pub login_hint: &'static str,
}

// ─── HTTP providers ──────────────────────────────────────────────────────

const OPENAI_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "o3",
        label: "o3",
        context_window: Some("200K"),
        note: None,
    },
    ModelSpec {
        id: "o3-mini",
        label: "o3 mini",
        context_window: Some("200K"),
        note: None,
    },
    ModelSpec {
        id: "o4-mini",
        label: "o4 mini",
        context_window: Some("200K"),
        note: None,
    },
    ModelSpec {
        id: "gpt-4o",
        label: "GPT-4o",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "gpt-4o-mini",
        label: "GPT-4o mini",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "gpt-4-turbo",
        label: "GPT-4 Turbo",
        context_window: Some("128K"),
        note: Some("Legacy"),
    },
    ModelSpec {
        id: "gpt-3.5-turbo",
        label: "GPT-3.5 Turbo",
        context_window: Some("16K"),
        note: Some("Legacy"),
    },
];

const DEEPSEEK_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "deepseek-chat",
        label: "DeepSeek Chat",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "deepseek-coder",
        label: "DeepSeek Coder",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "deepseek-reasoner",
        label: "DeepSeek Reasoner",
        context_window: Some("128K"),
        note: None,
    },
];

const GROK_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "grok-4.3",
        label: "Grok 4.3",
        context_window: Some("256K"),
        note: None,
    },
    ModelSpec {
        id: "grok-3",
        label: "Grok 3",
        context_window: Some("256K"),
        note: None,
    },
    ModelSpec {
        id: "grok-3-mini",
        label: "Grok 3 mini",
        context_window: Some("256K"),
        note: None,
    },
];

/// NVIDIA NIM curated subset of build.nvidia.com — keep ~20 to avoid
/// drowning the picker. Provider-prefixed ids (`vendor/model`) are
/// canonical for NIM and passed through to the SSE call as-is.
const NVIDIA_NIM_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "meta/llama-3.3-70b-instruct",
        label: "Llama 3.3 70B Instruct",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "qwen/qwen3-coder-480b-a35b",
        label: "Qwen3 Coder 480B",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "deepseek-ai/deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "moonshotai/kimi-k2-thinking",
        label: "Kimi K2 Thinking",
        context_window: Some("200K"),
        note: None,
    },
    ModelSpec {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "nvidia/nemotron-3-super-120b-a12b",
        label: "Nemotron 3 Super 120B",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "mistralai/mistral-nemotron",
        label: "Mistral Nemotron",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "microsoft/phi-4-mini-flash-reasoning",
        label: "Phi-4 Mini Flash Reasoning",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "z-ai/glm5.1",
        label: "GLM 5.1",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "minimaxai/minimax-m2.7",
        label: "MiniMax M2.7",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "qwen/qwen3-next-80b-a3b-thinking",
        label: "Qwen3 Next 80B Thinking",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "qwen/qwen2.5-coder-32b-instruct",
        label: "Qwen2.5 Coder 32B",
        context_window: Some("128K"),
        note: None,
    },
];

const KIMI_API_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "moonshot-v1-128k",
        label: "Moonshot v1 128K",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "kimi-k2-0905",
        label: "Kimi K2 (0905)",
        context_window: Some("200K"),
        note: None,
    },
    ModelSpec {
        id: "moonshot-v1-32k",
        label: "Moonshot v1 32K",
        context_window: Some("32K"),
        note: None,
    },
];

const GEMINI_API_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        context_window: Some("1M"),
        note: None,
    },
    ModelSpec {
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        context_window: Some("1M"),
        note: None,
    },
    ModelSpec {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        context_window: Some("1M"),
        note: Some("Preview"),
    },
];

const PERPLEXITY_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "sonar",
        label: "Sonar",
        context_window: Some("128K"),
        note: None,
    },
    ModelSpec {
        id: "sonar-pro",
        label: "Sonar Pro",
        context_window: Some("200K"),
        note: None,
    },
    ModelSpec {
        id: "sonar-reasoning",
        label: "Sonar Reasoning",
        context_window: Some("128K"),
        note: None,
    },
];

// ─── CLI-agent auth indicators ───────────────────────────────────────────

const CLAUDE_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir {
        path: ".claude/projects",
    },
    AuthIndicator::HomeDir {
        path: ".claude/sessions",
    },
    AuthIndicator::HomeDir {
        path: ".claude/history.jsonl",
    },
    AuthIndicator::HomeDir {
        path: ".config/anthropic/credentials.json",
    },
    AuthIndicator::EnvVar {
        name: "ANTHROPIC_API_KEY",
    },
];

const GEMINI_CLI_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir {
        path: ".gemini/oauth_creds.json",
    },
    AuthIndicator::EnvVar {
        name: "GEMINI_API_KEY",
    },
    AuthIndicator::EnvVar {
        name: "GOOGLE_API_KEY",
    },
];

const CODEX_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir {
        path: ".codex/auth.json",
    },
    AuthIndicator::EnvVar {
        name: "OPENAI_API_KEY",
    },
];

const KIMI_CLI_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir {
        path: ".kimi/auth.json",
    },
    AuthIndicator::EnvVar {
        name: "KIMI_API_KEY",
    },
];

// Ollama CLI is detect-only: no `login` flow exists. Presence of the
// binary alone counts as "ready" (the daemon may or may not be running,
// which the LocalHttp probe answers separately).
const OLLAMA_CLI_INDICATORS: &[AuthIndicator] = &[];

// ─── Catalog ─────────────────────────────────────────────────────────────

pub static CATALOG: &[ProviderSpec] = &[
    // ── API providers ────
    ProviderSpec {
        id: "openai",
        display_name: "OpenAI",
        kind: ProviderKind::Api,
        default_base_url: "https://api.openai.com/v1",
        auth: AuthSpec::Bearer {
            env_hint: Some("OPENAI_API_KEY"),
        },
        default_models: OPENAI_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "deepseek",
        display_name: "DeepSeek",
        kind: ProviderKind::Api,
        default_base_url: "https://api.deepseek.com",
        auth: AuthSpec::Bearer {
            env_hint: Some("DEEPSEEK_API_KEY"),
        },
        default_models: DEEPSEEK_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "grok",
        display_name: "Grok (xAI)",
        kind: ProviderKind::Api,
        default_base_url: "https://api.x.ai/v1",
        auth: AuthSpec::Bearer {
            env_hint: Some("XAI_API_KEY"),
        },
        default_models: GROK_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "nvidia-nim",
        display_name: "NVIDIA NIM",
        kind: ProviderKind::Api,
        default_base_url: "https://integrate.api.nvidia.com",
        auth: AuthSpec::Bearer {
            env_hint: Some("NVIDIA_API_KEY"),
        },
        default_models: NVIDIA_NIM_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "kimi-api",
        display_name: "Kimi (Moonshot)",
        kind: ProviderKind::Api,
        default_base_url: "https://api.moonshot.ai/v1",
        auth: AuthSpec::Bearer {
            env_hint: Some("MOONSHOT_API_KEY"),
        },
        default_models: KIMI_API_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "gemini-api",
        display_name: "Gemini (Google API)",
        kind: ProviderKind::Api,
        // OpenAI-compat shim — different from the native gemini-cli endpoint.
        default_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        auth: AuthSpec::Bearer {
            env_hint: Some("GEMINI_API_KEY"),
        },
        default_models: GEMINI_API_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "perplexity",
        display_name: "Perplexity",
        kind: ProviderKind::Api,
        default_base_url: "https://api.perplexity.ai",
        auth: AuthSpec::Bearer {
            env_hint: Some("PERPLEXITY_API_KEY"),
        },
        default_models: PERPLEXITY_MODELS,
        extras: ProviderExtras {
            citations: true,
            search_results: true,
            supports_streaming: true,
            dynamic_models: false,
        },
        bin: "",
        auth_indicators: &[],
        install_hint: "",
        login_hint: "",
    },
    ProviderSpec {
        id: "ollama",
        display_name: "Ollama",
        kind: ProviderKind::LocalHttp,
        default_base_url: "http://localhost:11434",
        auth: AuthSpec::None,
        // Models are fetched live via `/api/tags`; the empty curated list
        // tells the renderer to skip the checkbox grid.
        default_models: &[],
        extras: ProviderExtras {
            dynamic_models: true,
            supports_streaming: true,
            citations: false,
            search_results: false,
        },
        bin: "ollama",
        auth_indicators: OLLAMA_CLI_INDICATORS,
        install_hint: "Install Ollama from https://ollama.com/download",
        login_hint: "",
    },
    // ── CLI agents ────
    ProviderSpec {
        id: "claude",
        display_name: "Claude Code",
        kind: ProviderKind::Cli,
        default_base_url: "",
        auth: AuthSpec::None,
        default_models: &[],
        extras: ProviderExtras::DEFAULT,
        bin: "claude",
        auth_indicators: CLAUDE_INDICATORS,
        install_hint: "npm install -g @anthropic-ai/claude-code",
        login_hint: "claude login",
    },
    ProviderSpec {
        id: "codex",
        display_name: "Codex CLI",
        kind: ProviderKind::Cli,
        default_base_url: "",
        auth: AuthSpec::None,
        default_models: &[],
        extras: ProviderExtras::DEFAULT,
        bin: "codex",
        auth_indicators: CODEX_INDICATORS,
        install_hint: "npm install -g @openai/codex",
        login_hint: "codex login",
    },
    ProviderSpec {
        id: "gemini",
        display_name: "Gemini CLI",
        kind: ProviderKind::Cli,
        default_base_url: "",
        auth: AuthSpec::None,
        default_models: &[],
        extras: ProviderExtras::DEFAULT,
        bin: "gemini",
        auth_indicators: GEMINI_CLI_INDICATORS,
        install_hint: "npm install -g @google/gemini-cli",
        login_hint: "gemini",
    },
    ProviderSpec {
        id: "kimi",
        display_name: "Kimi Code CLI",
        kind: ProviderKind::Cli,
        default_base_url: "",
        auth: AuthSpec::None,
        default_models: &[],
        extras: ProviderExtras::DEFAULT,
        bin: "kimi",
        auth_indicators: KIMI_CLI_INDICATORS,
        install_hint: "npm install -g @moonshot-ai/kimi-code",
        login_hint: "kimi login",
    },
];

impl ProviderExtras {
    /// Default extras with every flag off. Used as `..ProviderExtras::DEFAULT`
    /// in struct expressions so a single line can flip one capability without
    /// re-listing the others.
    pub const DEFAULT: ProviderExtras = ProviderExtras {
        citations: false,
        search_results: false,
        dynamic_models: false,
        supports_streaming: false,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let count_before = ids.len();
        ids.dedup();
        assert_eq!(
            ids.len(),
            count_before,
            "duplicate provider id in CATALOG (after dedup: {ids:?})",
        );
    }

    #[test]
    fn catalog_has_expected_split() {
        let api = CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::Api))
            .count();
        let local = CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::LocalHttp))
            .count();
        let cli = CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::Cli))
            .count();
        // 7 cloud HTTP providers + 1 local (ollama) + 4 CLI agents.
        // If you intentionally added/removed a provider, update these
        // constants together with the catalog.
        assert_eq!(api, 7, "expected 7 Api providers, got {api}");
        assert_eq!(local, 1, "expected 1 LocalHttp provider, got {local}");
        assert_eq!(cli, 4, "expected 4 Cli agents, got {cli}");
    }

    #[test]
    fn cli_agents_carry_bin_and_install_hint() {
        for p in CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::Cli))
        {
            assert!(!p.bin.is_empty(), "{} has empty bin", p.id);
            assert!(
                !p.install_hint.is_empty(),
                "{} has empty install_hint",
                p.id
            );
        }
    }

    #[test]
    fn api_providers_have_non_empty_curated_models() {
        // LocalHttp (ollama) is explicitly dynamic; all cloud Api providers
        // must ship a curated list so the picker has something to show at
        // first connect.
        for p in CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::Api))
        {
            assert!(
                !p.default_models.is_empty(),
                "{} has no default_models",
                p.id
            );
        }
    }

    #[test]
    fn perplexity_has_citation_extras() {
        let perplexity = CATALOG.iter().find(|p| p.id == "perplexity").unwrap();
        assert!(perplexity.extras.citations);
        assert!(perplexity.extras.search_results);
    }

    #[test]
    fn ollama_has_dynamic_models_flag() {
        let ollama = CATALOG.iter().find(|p| p.id == "ollama").unwrap();
        assert!(ollama.extras.dynamic_models);
        assert!(ollama.default_models.is_empty());
    }

    #[test]
    fn catalog_serializes_to_json_round_trip() {
        // The renderer reads this via `GET /providers/catalog` — make sure
        // the static catalog can actually be JSON-serialized without panic.
        let s = serde_json::to_string(CATALOG).expect("serialize");
        assert!(s.contains("\"openai\""));
        assert!(s.contains("\"perplexity\""));
        assert!(s.contains("\"claude\""));
    }
}
