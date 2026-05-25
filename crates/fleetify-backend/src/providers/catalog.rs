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
    /// Optional grouping label. Renderer buckets models by this string
    /// inside one provider tile (Perplexity uses "Sonar API" / "Agent
    /// API" today). `None` => render flat, matching current behaviour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<&'static str>,
    /// Optional per-model endpoint override consulted by the backend
    /// dispatch layer (Perplexity's `/v1/agent` lives at a different
    /// path than its Sonar chat completions). `None` => fall back to
    /// `ProviderSpec::default_base_url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<&'static str>,
    /// True when the model exposes a reasoning-effort lever the
    /// composer's Effort column should be enabled for. False for
    /// pure chat models — the column is then rendered greyed out.
    pub supports_effort: bool,
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

/// Per-OS install command set. Resolved at scan time by
/// `routers::providers::resolve_install_hint` using `cfg!()` so the
/// renderer only ever sees the one string that applies to the user's
/// machine.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct InstallHints {
    pub windows: &'static str,
    pub macos: &'static str,
    pub linux: &'static str,
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
    /// Per-OS override for `install_hint`. When `Some`, the scan endpoint
    /// picks the OS-matching string via `cfg!()` and ignores `install_hint`.
    /// When `None` (CLI agents installing via `npm install -g`), the single
    /// `install_hint` works everywhere.
    pub install_hints: Option<InstallHints>,
    /// Shown verbatim when the binary is installed but the auth indicator
    /// hasn't fired (e.g. `"claude login"`). Empty otherwise.
    pub login_hint: &'static str,
}

// ─── HTTP providers ──────────────────────────────────────────────────────

const OPENAI_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "gpt-5.5",
        label: "GPT-5.5",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5.5-pro",
        label: "GPT-5.5 Pro",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5.4",
        label: "GPT-5.4",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 mini",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5.4-nano",
        label: "GPT-5.4 nano",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5",
        label: "GPT-5",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5-mini",
        label: "GPT-5 mini",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5-nano",
        label: "GPT-5 nano",
        context_window: Some("400K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        context_window: Some("400K"),
        note: Some("Coding"),
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gpt-4.1",
        label: "GPT-4.1",
        context_window: Some("1M"),
        note: Some("Long context"),
        group: None,
        endpoint: None,
        supports_effort: false,
    },
];

const DEEPSEEK_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "deepseek-v3.1",
        label: "DeepSeek V3.1",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "deepseek-r1",
        label: "DeepSeek R1",
        context_window: Some("128K"),
        note: Some("Reasoning"),
        group: None,
        endpoint: None,
        supports_effort: true,
    },
];

const GROK_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "grok-4.3",
        label: "Grok 4.3",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "grok-4.1-fast",
        label: "Grok 4.1 Fast",
        context_window: Some("2M"),
        note: Some("Highest context"),
        group: None,
        endpoint: None,
        supports_effort: true,
    },
];

/// NVIDIA NIM curated subset of build.nvidia.com — keep ~20 to avoid
/// drowning the picker. Provider-prefixed ids (`vendor/model`) are
/// canonical for NIM and passed through to the SSE call as-is.
const NVIDIA_NIM_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "deepseek-ai/deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "deepseek-ai/deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "qwen/qwen3.5-coder-480b",
        label: "Qwen 3.5 Coder 480B",
        context_window: Some("256K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "moonshotai/kimi-k2.6",
        label: "Kimi K2.6",
        context_window: Some("256K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "openai/gpt-oss-20b",
        label: "GPT-OSS 20B",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "nvidia/nemotron-3-super-120b-a12b",
        label: "Nemotron 3 Super 120B",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "meta/llama-4-405b-instruct",
        label: "Llama 4 405B Instruct",
        context_window: Some("256K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "meta/llama-4-70b-instruct",
        label: "Llama 4 70B Instruct",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "z-ai/glm-5.1",
        label: "GLM 5.1",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "minimaxai/minimax-m2.7",
        label: "MiniMax M2.7",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "mistralai/mistral-nemotron",
        label: "Mistral Nemotron",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
];

const KIMI_API_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "kimi-k2.6",
        label: "Kimi K2.6",
        context_window: Some("256K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "kimi-k2.6-thinking",
        label: "Kimi K2.6 Thinking",
        context_window: Some("256K"),
        note: Some("Reasoning"),
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "kimi-k2.6-agent",
        label: "Kimi K2.6 Agent",
        context_window: Some("256K"),
        note: Some("Tool use"),
        group: None,
        endpoint: None,
        supports_effort: true,
    },
];

// SDK model lineup matches the picker labels we surfaced earlier from
// agy's `/model` TUI (Gemini 3.5 Flash Medium/High, 3.1 Pro Low/High,
// Claude Sonnet/Opus 4.6 Thinking, GPT-OSS 120B Medium). The id format
// bakes the effort suffix in; the Python sidecar strips it before
// passing to `LocalAgentConfig(model=...)` so the SDK sees a clean
// base name. context_window labels mirror the family-level windows
// agy itself advertises.
const ANTIGRAVITY_SDK_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "gemini-3.5-flash-medium",
        label: "Gemini 3.5 Flash (Medium)",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "gemini-3.5-flash-high",
        label: "Gemini 3.5 Flash (High)",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "gemini-3.1-pro-low",
        label: "Gemini 3.1 Pro (Low)",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "gemini-3.1-pro-high",
        label: "Gemini 3.1 Pro (High)",
        context_window: Some("1M"),
        note: Some("Most capable"),
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "claude-sonnet-4-6-thinking",
        label: "Claude Sonnet 4.6 (Thinking)",
        context_window: Some("200K"),
        note: Some("Reasoning"),
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "claude-opus-4-6-thinking",
        label: "Claude Opus 4.6 (Thinking)",
        context_window: Some("200K"),
        note: Some("Reasoning"),
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "gpt-oss-120b-medium",
        label: "GPT-OSS 120B (Medium)",
        context_window: Some("128K"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
];

const GEMINI_API_MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        context_window: Some("2M"),
        note: Some("Most capable"),
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gemini-3.1-flash-lite",
        label: "Gemini 3.1 Flash-Lite",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "gemini-3-flash",
        label: "Gemini 3 Flash",
        context_window: Some("1M"),
        note: None,
        group: None,
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "gemini-omni",
        label: "Gemini Omni",
        context_window: Some("1M"),
        note: Some("Multimodal"),
        group: None,
        endpoint: None,
        supports_effort: false,
    },
];

const PERPLEXITY_AGENT_EP: &str = "https://api.perplexity.ai/v1/agent";

const PERPLEXITY_MODELS: &[ModelSpec] = &[
    // ── Sonar API (native search models, default base URL) ──────
    ModelSpec {
        id: "sonar",
        label: "Sonar",
        context_window: Some("128K"),
        note: None,
        group: Some("Sonar API"),
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "sonar-pro",
        label: "Sonar Pro",
        context_window: Some("200K"),
        note: None,
        group: Some("Sonar API"),
        endpoint: None,
        supports_effort: false,
    },
    ModelSpec {
        id: "sonar-reasoning-pro",
        label: "Sonar Reasoning Pro",
        context_window: Some("128K"),
        note: Some("Reasoning"),
        group: Some("Sonar API"),
        endpoint: None,
        supports_effort: true,
    },
    ModelSpec {
        id: "sonar-deep-research",
        label: "Sonar Deep Research",
        context_window: Some("128K"),
        note: Some("Research"),
        group: Some("Sonar API"),
        endpoint: None,
        supports_effort: true,
    },
    // ── Agent API (marketplace, base URL = /v1/agent) ───────────
    ModelSpec {
        id: "anthropic/claude-opus-4-7",
        label: "Claude Opus 4.7",
        context_window: Some("200K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "anthropic/claude-opus-4-6",
        label: "Claude Opus 4.6",
        context_window: Some("200K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        context_window: Some("200K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "anthropic/claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        context_window: Some("200K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "openai/gpt-5.5",
        label: "GPT-5.5",
        context_window: Some("400K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "openai/gpt-5.4-mini",
        label: "GPT-5.4 mini",
        context_window: Some("400K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "openai/gpt-5",
        label: "GPT-5",
        context_window: Some("400K"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "google/gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        context_window: Some("2M"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "google/gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        context_window: Some("1M"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "xai/grok-4.3",
        label: "Grok 4.3",
        context_window: Some("1M"),
        note: None,
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
    },
    ModelSpec {
        id: "xai/grok-4.20-reasoning",
        label: "Grok 4.20 Reasoning",
        context_window: Some("1M"),
        note: Some("Reasoning"),
        group: Some("Agent API"),
        endpoint: Some(PERPLEXITY_AGENT_EP),
        supports_effort: true,
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

// Antigravity CLI nests its own runtime data under `~/.gemini/` (shares the
// auth tree with Gemini CLI), so `installation_id` is the agy-specific
// "I've been here" marker. `oauth_creds.json` covers users who only ever
// authed through the Antigravity onboarding (no prior Gemini CLI install).
const AGY_CLI_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir {
        path: ".gemini/antigravity-cli/installation_id",
    },
    AuthIndicator::HomeDir {
        path: ".gemini/oauth_creds.json",
    },
    AuthIndicator::EnvVar {
        name: "GOOGLE_API_KEY",
    },
];

// Antigravity SDK auth detection. The bridge reads `GEMINI_API_KEY` from
// the keychain at dispatch time (service: `Fleetify-Provider-antigravity-sdk`)
// AND the env var as a fallback for scripted launches. Whichever surface
// has a key, the agent counts as "authed" for the Settings → Agents tile.
const ANTIGRAVITY_SDK_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::EnvVar {
        name: "GEMINI_API_KEY",
    },
    AuthIndicator::EnvVar {
        name: "GOOGLE_API_KEY",
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: Some(InstallHints {
            windows: "winget install Ollama.Ollama",
            macos: "brew install --cask ollama",
            linux: "curl -fsSL https://ollama.com/install.sh | sh",
        }),
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
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
        install_hints: None,
        login_hint: "kimi login",
    },
    // Antigravity ships a Go binary outside npm (curl/irm installer), so
    // `install_hint` stays empty and the per-OS `install_hints` carry the
    // real commands. The shell IPC layer branches on this when wiring the
    // Install button.
    ProviderSpec {
        id: "agy",
        display_name: "Antigravity",
        kind: ProviderKind::Cli,
        default_base_url: "",
        auth: AuthSpec::None,
        default_models: &[],
        extras: ProviderExtras::DEFAULT,
        bin: "agy",
        auth_indicators: AGY_CLI_INDICATORS,
        install_hint: "",
        install_hints: Some(InstallHints {
            windows: "irm https://antigravity.google/cli/install.ps1 | iex",
            macos: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        }),
        login_hint: "agy",
    },
    // Antigravity SDK — second face of the same engine, driven from a
    // Python sidecar that wraps `google-antigravity`. Same kind (`Cli`)
    // as the agy CLI so it lands in Settings → Agents next to its
    // sibling, but `bin: "python3"` because the actual binary we spawn
    // is a Python interpreter that loads the SDK; and `auth: ApiKey`
    // because the SDK requires `GEMINI_API_KEY` (no OAuth). The
    // renderer special-cases this id to render a key-input panel inside
    // the AgentCard.
    ProviderSpec {
        id: "antigravity-sdk",
        display_name: "Antigravity SDK",
        kind: ProviderKind::Cli,
        default_base_url: "",
        auth: AuthSpec::ApiKey {
            header: "x-goog-api-key",
            env_hint: Some("GEMINI_API_KEY"),
        },
        // Curated model lineup driven by the SDK's `LocalAgentConfig(
        // model=...)` parameter. Each picker entry maps 1:1 to the
        // base model id the SDK accepts; the `-medium`/`-high`/etc
        // suffix encodes the thinking level (stripped server-side by
        // the sidecar before construction).
        default_models: ANTIGRAVITY_SDK_MODELS,
        extras: ProviderExtras {
            supports_streaming: true,
            ..ProviderExtras::DEFAULT
        },
        bin: "python3",
        auth_indicators: ANTIGRAVITY_SDK_INDICATORS,
        install_hint: "",
        install_hints: Some(InstallHints {
            windows: "pip install google-antigravity",
            macos: "pip3 install google-antigravity",
            linux: "pip3 install google-antigravity",
        }),
        login_hint: "Set GEMINI_API_KEY (Google AI Studio → Get API key)",
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
        // 7 cloud HTTP providers + 1 local (ollama) + 6 CLI agents
        // (Claude, Codex, Gemini, Kimi, Antigravity CLI, Antigravity SDK).
        // If you intentionally added/removed a provider, update these
        // constants together with the catalog.
        assert_eq!(api, 7, "expected 7 Api providers, got {api}");
        assert_eq!(local, 1, "expected 1 LocalHttp provider, got {local}");
        assert_eq!(cli, 6, "expected 6 Cli agents, got {cli}");
    }

    #[test]
    fn cli_agents_carry_bin_and_install_hint() {
        for p in CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::Cli))
        {
            assert!(!p.bin.is_empty(), "{} has empty bin", p.id);
            // Either the universal `install_hint` (npm CLIs) or the per-OS
            // `install_hints` (shell-installer CLIs like agy) must be set —
            // the renderer needs at least one path to render the Install
            // button.
            assert!(
                !p.install_hint.is_empty() || p.install_hints.is_some(),
                "{} has no install_hint and no install_hints",
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
    fn antigravity_cli_and_sdk_are_distinct_siblings() {
        // Two halves of the same engine; same display family ("Antigravity"),
        // separate ids/auth/dispatch. The CLI keeps the picker collapsed to
        // "Auto" (server-side model pin); the SDK exposes a real picker
        // (per-turn LocalAgentConfig(model=...)).
        let cli = CATALOG.iter().find(|p| p.id == "agy").unwrap();
        let sdk = CATALOG.iter().find(|p| p.id == "antigravity-sdk").unwrap();
        assert!(matches!(cli.auth, AuthSpec::None));
        assert!(matches!(sdk.auth, AuthSpec::ApiKey { .. }));
        assert!(cli.default_models.is_empty());
        assert!(!sdk.default_models.is_empty());
        assert_eq!(cli.bin, "agy");
        assert_eq!(sdk.bin, "python3");
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

    #[test]
    fn perplexity_has_two_groups() {
        let p = CATALOG.iter().find(|p| p.id == "perplexity").unwrap();
        let groups: std::collections::HashSet<&str> =
            p.default_models.iter().filter_map(|m| m.group).collect();
        assert_eq!(groups.len(), 2);
        assert!(groups.contains("Sonar API"));
        assert!(groups.contains("Agent API"));
        // Every Perplexity model must carry a group label — no flat fallback.
        assert!(p.default_models.iter().all(|m| m.group.is_some()));
    }

    #[test]
    fn perplexity_agent_models_carry_endpoint() {
        let p = CATALOG.iter().find(|p| p.id == "perplexity").unwrap();
        for m in p.default_models.iter() {
            match m.group {
                Some("Agent API") => {
                    let ep = m.endpoint.expect("Agent API model needs an endpoint");
                    assert!(
                        ep.ends_with("/v1/agent"),
                        "Agent endpoint should point at /v1/agent, got {ep}",
                    );
                }
                Some("Sonar API") => {
                    assert!(
                        m.endpoint.is_none(),
                        "Sonar models fall back to default_base_url",
                    );
                }
                _ => panic!("unexpected group: {:?}", m.group),
            }
        }
    }

    #[test]
    fn perplexity_exposes_anthropic_and_google_via_agent_group() {
        let p = CATALOG.iter().find(|p| p.id == "perplexity").unwrap();
        let agent_ids: Vec<&str> = p
            .default_models
            .iter()
            .filter(|m| m.group == Some("Agent API"))
            .map(|m| m.id)
            .collect();
        // Spot-check that the marketplace is wired up.
        assert!(agent_ids
            .iter()
            .any(|id| id.starts_with("anthropic/claude-")));
        assert!(agent_ids.iter().any(|id| id.starts_with("google/gemini-")));
        assert!(agent_ids.iter().any(|id| id.starts_with("xai/grok-")));
        assert!(agent_ids.iter().any(|id| id.starts_with("openai/gpt-")));
    }

    #[test]
    fn provider_spec_carries_optional_install_hints() {
        let p = CATALOG.iter().find(|p| p.id == "openai").unwrap();
        // OpenAI is HTTP-only; no install command applies. Keep None.
        assert!(p.install_hints.is_none());
    }

    #[test]
    fn openai_lineup_is_2026_flagship_only() {
        let p = CATALOG.iter().find(|p| p.id == "openai").unwrap();
        let ids: Vec<&str> = p.default_models.iter().map(|m| m.id).collect();
        for retired in [
            "gpt-3.5-turbo",
            "gpt-4-turbo",
            "gpt-4o",
            "gpt-4o-mini",
            "o3",
            "o3-mini",
            "o4-mini",
        ] {
            assert!(
                !ids.contains(&retired),
                "retired model still in catalog: {retired}"
            );
        }
        for current in [
            "gpt-5.5",
            "gpt-5.5-pro",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex",
            "gpt-4.1",
        ] {
            assert!(ids.contains(&current), "missing 2026 model: {current}");
        }
    }

    #[test]
    fn deepseek_lineup_drops_chat_and_reasoner_for_v4() {
        let p = CATALOG.iter().find(|p| p.id == "deepseek").unwrap();
        let ids: Vec<&str> = p.default_models.iter().map(|m| m.id).collect();
        for retired in ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"] {
            assert!(!ids.contains(&retired), "retired DeepSeek model: {retired}");
        }
        assert!(ids.contains(&"deepseek-v4-pro"));
        assert!(ids.contains(&"deepseek-v4-flash"));
        assert!(ids.contains(&"deepseek-r1"));
    }

    #[test]
    fn grok_lineup_promotes_4_3() {
        let p = CATALOG.iter().find(|p| p.id == "grok").unwrap();
        let ids: Vec<&str> = p.default_models.iter().map(|m| m.id).collect();
        for retired in ["grok-3", "grok-3-mini"] {
            assert!(!ids.contains(&retired), "retired Grok model: {retired}");
        }
        assert!(ids.contains(&"grok-4.3"));
        assert!(ids.contains(&"grok-4.1-fast"));
    }

    #[test]
    fn kimi_api_lineup_is_k2_6() {
        let p = CATALOG.iter().find(|p| p.id == "kimi-api").unwrap();
        let ids: Vec<&str> = p.default_models.iter().map(|m| m.id).collect();
        for retired in ["moonshot-v1-128k", "moonshot-v1-32k", "kimi-k2-0905"] {
            assert!(!ids.contains(&retired), "retired Kimi model: {retired}");
        }
        assert!(ids.contains(&"kimi-k2.6"));
        assert!(ids.contains(&"kimi-k2.6-thinking"));
        assert!(ids.contains(&"kimi-k2.6-agent"));
    }

    #[test]
    fn gemini_api_lineup_is_3_x_only() {
        let p = CATALOG.iter().find(|p| p.id == "gemini-api").unwrap();
        let ids: Vec<&str> = p.default_models.iter().map(|m| m.id).collect();
        for retired in ["gemini-2.5-pro", "gemini-2.5-flash"] {
            assert!(!ids.contains(&retired), "retired Gemini model: {retired}");
        }
        assert!(ids.contains(&"gemini-3.5-flash"));
        assert!(ids.contains(&"gemini-3.1-pro"));
        assert!(ids.contains(&"gemini-3.1-flash-lite"));
        assert!(ids.contains(&"gemini-omni"));
    }

    #[test]
    fn no_model_carries_legacy_note() {
        // The "Legacy" badge is gone — every entry kept in the 2026 catalog
        // is current.
        for p in CATALOG.iter() {
            for m in p.default_models.iter() {
                assert_ne!(
                    m.note,
                    Some("Legacy"),
                    "model {} on provider {} still flagged Legacy",
                    m.id,
                    p.id
                );
            }
        }
    }

    #[test]
    fn ollama_has_per_os_install_hints() {
        let p = CATALOG.iter().find(|p| p.id == "ollama").unwrap();
        let h = p
            .install_hints
            .as_ref()
            .expect("ollama needs install_hints");
        assert!(h.windows.contains("winget") || h.windows.contains("Ollama"));
        assert!(h.macos.contains("brew") || h.macos.contains("ollama"));
        assert!(h.linux.contains("curl") && h.linux.contains("install.sh"));
    }

    #[test]
    fn npm_cli_agents_have_no_per_os_overrides() {
        // `npm install -g` is portable, so CLIs that ship as npm packages
        // leave `install_hints` None and rely on the single `install_hint`.
        // Antigravity is the exception — its installer is a per-OS shell
        // script (curl/irm), so it populates `install_hints` instead. See
        // `agy_has_per_os_install_hints` below for that side of the contract.
        const NPM_CLI_IDS: &[&str] = &["claude", "codex", "gemini", "kimi"];
        for p in CATALOG
            .iter()
            .filter(|p| matches!(p.kind, ProviderKind::Cli))
            .filter(|p| NPM_CLI_IDS.contains(&p.id))
        {
            assert!(
                p.install_hints.is_none(),
                "{} (npm-installed) should leave install_hints None",
                p.id,
            );
        }
    }

    #[test]
    fn antigravity_sdk_has_api_key_auth_and_pip_install_hints() {
        let p = CATALOG.iter().find(|p| p.id == "antigravity-sdk").unwrap();
        // SDK lives in Settings → Agents (kind: Cli) but auths via API
        // key — distinct from the agy CLI sibling which uses OAuth.
        assert!(matches!(p.kind, ProviderKind::Cli));
        assert!(
            matches!(
                p.auth,
                AuthSpec::ApiKey {
                    env_hint: Some("GEMINI_API_KEY"),
                    ..
                }
            ),
            "SDK must declare GEMINI_API_KEY as the env_hint for its ApiKey auth",
        );
        let h = p
            .install_hints
            .as_ref()
            .expect("antigravity-sdk needs per-OS install_hints");
        // Pip command on every platform — only the binary name (pip vs
        // pip3) differs between Windows and macOS/Linux.
        assert!(h.windows.contains("pip install google-antigravity"));
        assert!(h.macos.contains("pip3 install google-antigravity"));
        assert!(h.linux.contains("pip3 install google-antigravity"));
        // SDK ships a real curated picker list — unlike the agy CLI
        // which collapses to a single "Auto" entry because print mode
        // can't accept a model override.
        assert!(
            !p.default_models.is_empty(),
            "SDK picker should expose per-(model × effort) entries"
        );
        assert!(
            p.default_models.iter().any(|m| m.id.starts_with("gemini-")),
            "SDK lineup includes Gemini variants"
        );
        assert!(
            p.default_models.iter().any(|m| m.id.starts_with("claude-")),
            "SDK lineup includes Claude variants"
        );
    }

    #[test]
    fn agy_has_per_os_install_hints() {
        let p = CATALOG.iter().find(|p| p.id == "agy").unwrap();
        let h = p
            .install_hints
            .as_ref()
            .expect("agy needs per-OS install_hints");
        assert!(h.windows.contains("irm") && h.windows.contains("antigravity.google"));
        assert!(h.macos.contains("curl") && h.macos.contains("install.sh"));
        assert!(h.linux.contains("curl") && h.linux.contains("install.sh"));
        // `install_hint` stays empty so the install IPC doesn't fall
        // back to an npm command for agy.
        assert!(p.install_hint.is_empty());
    }

    #[test]
    fn every_model_declares_supports_effort_flag() {
        // Schema check: the field must exist and be set on every catalog
        // entry. Per-provider value tables are asserted in Task 2.
        for provider in CATALOG {
            for model in provider.default_models {
                let _ = model.supports_effort;
            }
        }
    }

    #[test]
    fn openai_reasoning_models_support_effort() {
        let p = CATALOG.iter().find(|p| p.id == "openai").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        // The entire GPT-5 family carries a reasoning lever.
        for id in [
            "gpt-5",
            "gpt-5-mini",
            "gpt-5-nano",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-5.5",
            "gpt-5.5-pro",
            "gpt-5.3-codex",
        ] {
            assert!(by_id(id).supports_effort, "{id} should support effort");
        }
        // gpt-4.1 is the long-context chat model — no reasoning lever.
        assert!(!by_id("gpt-4.1").supports_effort);
    }

    #[test]
    fn deepseek_reasoning_models_support_effort() {
        let p = CATALOG.iter().find(|p| p.id == "deepseek").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        for id in ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-r1"] {
            assert!(by_id(id).supports_effort, "{id} should support effort");
        }
        assert!(!by_id("deepseek-v3.1").supports_effort);
    }

    #[test]
    fn grok_reasoning_models_support_effort() {
        let p = CATALOG.iter().find(|p| p.id == "grok").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        assert!(by_id("grok-4.3").supports_effort);
        assert!(by_id("grok-4.1-fast").supports_effort);
    }

    #[test]
    fn gemini_api_reasoning_models_support_effort() {
        let p = CATALOG.iter().find(|p| p.id == "gemini-api").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        for id in ["gemini-3.1-pro", "gemini-3-flash", "gemini-3.5-flash"] {
            assert!(by_id(id).supports_effort, "{id} should support effort");
        }
        for id in ["gemini-3.1-flash-lite", "gemini-omni"] {
            assert!(!by_id(id).supports_effort, "{id} should NOT support effort");
        }
    }

    #[test]
    fn kimi_api_thinking_modes_support_effort() {
        let p = CATALOG.iter().find(|p| p.id == "kimi-api").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        assert!(by_id("kimi-k2.6-thinking").supports_effort);
        assert!(by_id("kimi-k2.6-agent").supports_effort);
        assert!(!by_id("kimi-k2.6").supports_effort);
    }

    #[test]
    fn perplexity_sonar_reasoning_supports_effort() {
        let p = CATALOG.iter().find(|p| p.id == "perplexity").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        assert!(by_id("sonar-reasoning-pro").supports_effort);
        assert!(by_id("sonar-deep-research").supports_effort);
        assert!(!by_id("sonar").supports_effort);
        assert!(!by_id("sonar-pro").supports_effort);
    }

    #[test]
    fn perplexity_agent_marketplace_inherits_effort_support() {
        let p = CATALOG.iter().find(|p| p.id == "perplexity").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        // Every Claude / GPT / Gemini / Grok entry routed through
        // Perplexity Agent matches its direct-provider equivalent.
        for id in [
            "anthropic/claude-opus-4-7",
            "anthropic/claude-opus-4-6",
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-haiku-4-5",
            "openai/gpt-5.5",
            "openai/gpt-5.4-mini",
            "openai/gpt-5",
            "google/gemini-3.1-pro-preview",
            "google/gemini-3.5-flash",
            "xai/grok-4.3",
            "xai/grok-4.20-reasoning",
        ] {
            assert!(
                by_id(id).supports_effort,
                "{id} (Agent API) should support effort"
            );
        }
    }

    #[test]
    fn nvidia_nim_reasoning_subset_supports_effort() {
        let p = CATALOG.iter().find(|p| p.id == "nvidia-nim").unwrap();
        let by_id = |id: &str| p.default_models.iter().find(|m| m.id == id).unwrap();
        // Reasoning-capable NIM entries match upstream.
        for id in [
            "moonshotai/kimi-k2.6",
            "openai/gpt-oss-120b",
            "nvidia/nemotron-3-super-120b-a12b",
        ] {
            assert!(by_id(id).supports_effort, "{id} should support effort");
        }
        // Non-reasoning entries (Llama 4 / Qwen / GLM / MiniMax / Mistral) stay false.
        for id in [
            "meta/llama-4-405b-instruct",
            "meta/llama-4-70b-instruct",
            "qwen/qwen3.5-coder-480b",
            "z-ai/glm-5.1",
            "minimaxai/minimax-m2.7",
            "mistralai/mistral-nemotron",
        ] {
            assert!(!by_id(id).supports_effort, "{id} should NOT support effort");
        }
    }
}
