# Provider Architecture

How AI providers — both **CLI agents** (Claude Code, Codex, Hermes, …) and
**HTTP APIs** (OpenAI, OpenRouter, …) — are described, detected, authenticated,
selected, and driven inside Fleetify.

> Informational companions: [`PROVIDERS.md`](PROVIDERS.md) (the current provider
> list) and [`AGENTS.md`](AGENTS.md) (the CLI-agent list). Deeper dives:
> [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md) (transports + WS protocol),
> [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md), [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md).

---

## 1. The single source of truth: the static catalog

Every provider Fleetify knows about is one entry in a `'static` array:

```
crates/fleetify-backend/src/providers/catalog.rs  →  pub static CATALOG: &[ProviderSpec]
```

Adding a provider is a **one-file append**: the renderer (Settings → Models /
Agents, the chat model picker), the IPC layer, key validation, and chat dispatch
all read from `CATALOG`, so a new entry shows up everywhere automatically. There
is no database of providers and no per-provider config file — the catalog *is*
the registry.

### `ProviderSpec` (`catalog.rs`)

| Field | Meaning |
|---|---|
| `id` | Stable id used everywhere (`"claude-code"`, `"openai"`, `"hermes-agent"`, …). The chat dispatch keys on it. |
| `display_name` | Human label in the UI. |
| `kind` | `ProviderKind::{Cli, Api, LocalHttp}` — drives which subsystem handles it. |
| `default_base_url` | HTTP base URL (or a template with `{account_id}` for Cloudflare). `""` for CLI agents. |
| `auth` | `AuthSpec` — how to authenticate (see below). |
| `default_models` | Curated `&[ModelSpec]` for the picker. **Empty** for agents whose models are baked into the binary or fetched live. |
| `extras` | `ProviderExtras` feature flags (`citations`, `search_results`, `dynamic_models`, `supports_streaming`). |
| `bin` | CLI binary name for PATH lookup (`"claude"`, `"hermes"`, …). `""` for HTTP providers. |
| `auth_indicators` | `&[AuthIndicator]` — how to detect a CLI agent is logged in *without* spawning it. |
| `install_hint` / `install_hints` | Install command; `install_hints` overrides per-OS (Windows/macOS/Linux). |
| `login_hint` | Shown when the binary is installed but no auth indicator fired (e.g. `claude login`). |

### `ProviderKind` — the three families

```rust
enum ProviderKind { Api, LocalHttp, Cli }
```

- **`Cli`** — a local subprocess agent (Claude Code, Codex, Kimi,
  OpenCode, Cursor, GitHub Copilot, Grok Build, Hermes, Antigravity CLI,
  Antigravity SDK).
  Auth is **out-of-band** (the agent's own `login`); Fleetify never holds the
  credential. Models usually live inside the binary, so `default_models` is
  often empty and the real list is discovered at runtime (see
  [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md)).
- **`Api`** — a cloud OpenAI-compatible HTTP endpoint (OpenAI, Anthropic,
  DeepSeek, Grok, NVIDIA NIM, Kimi API, Gemini API, Perplexity, OpenRouter,
  Cloudflare Workers AI, Ollama Cloud). Auth is an API key Fleetify stores.
- **`LocalHttp`** — a local HTTP daemon with no auth (Ollama). Models are
  fetched live from `/api/tags`.

### `AuthSpec` — how a provider authenticates

```rust
enum AuthSpec {
    Bearer { env_hint: Option<&'static str> },           // "Authorization: Bearer <key>"
    ApiKey { header: &'static str, env_hint: Option<…> },// custom header (e.g. x-goog-api-key)
    None,                                                // CLI agents + Ollama
}
```

`env_hint` names the conventional environment variable (`OPENAI_API_KEY`, …) so
a key the user already exported is used as a fallback when no keychain entry
exists.

### `ModelSpec` — a curated model entry

`id` (sent to the API verbatim), `label` (picker text), `context_window`
(display-only, e.g. `"200K"`), `note` (a badge), `group` (buckets models within
one tile — Perplexity splits "Sonar" vs "Agent"), `endpoint` (per-model base-URL
override), and `supports_effort` (whether the picker's Effort column is enabled).

---

## 2. Authentication & key storage

Fleetify **never persists API keys on disk in plaintext** and never holds CLI
credentials at all.

### CLI agents → out-of-band, detected (not stored)

A CLI agent authenticates itself (`claude login`, `hermes model`, …) and writes
its own creds under its own home dir (`~/.claude/`, `~/.hermes/`, …). Fleetify
only *detects* that state via the spec's `auth_indicators`:

```rust
enum AuthIndicator {
    HomeDir { path },                         // a file exists (~/.claude/projects)
    EnvVar { name },                          // an env var is set
    JsonExpiry { path, field, unit },         // an OAuth token JSON isn't expired
    JsonFieldPresent { path, field },         // a JSON field is non-null (Cursor authInfo)
}
```

`routers/providers.rs::check_json_expiry()` reads the token JSON and compares the
expiry to now — so an expired OAuth login shows as "not authenticated" without
ever launching the agent.

### HTTP providers → OS keychain, cached in memory

```
Tauri shell (OS keychain)
   │  user adds/changes a key in Settings
   ▼
POST 127.0.0.1:8765/api/internal/providers/reload   (X-Fleet-Internal header)
   │  { keys: { "<id>": "<key>" }, cloudflare_account_id }
   ▼
providers::keys::set_keys(map)   →   in-memory RwLock cache (PROVIDER_KEYS)
```

- Keys live in the **OS keychain** (Windows Credential Manager / macOS Keychain /
  Linux Secret Service) owned by the Tauri shell.
- After any key change, the shell pushes the full set to the backend's loopback
  `/api/internal/providers/reload`, which replaces the in-memory `PROVIDER_KEYS`
  cache (`providers/keys.rs`). **No backend restart needed.**
- At request time the bridge calls `keys::get_key(id)`; if absent it falls back
  to the spec's `auth.env_hint` environment variable.

---

## 3. Detecting installed CLI agents — the scan

`Settings → Agents` renders from `GET /api/agents/scan`
(`routers/providers.rs::scan_all_agents`). For each CLI provider it picks a probe
strategy (`scan_probe_for`):

```rust
enum ScanProbe {
    BinOnly { bin },          // plain PATH lookup (which)
    AgyCli,                   // PATH OR ~/.gemini/antigravity-cli/installation_id marker
    PythonModule { module },  // python -c "import google.antigravity"
    CursorCli,                // PATH OR off-PATH install dirs (Windows)
    GitHubCopilotCli,         // PATH OR npm-global / Homebrew / winget dirs
    HermesCli,                // PATH OR the pip/venv install dirs (off-PATH on Windows)
}
```

Several agents need more than a PATH check because their installers don't update
a running GUI's PATH (Cursor, GitHub Copilot, Hermes) or they're a Python module
(Antigravity SDK). Each scan result is `{ installed, authenticated, path,
install_hint, login_hint }` — the Settings card renders directly from it.

`cli_path()` resolves a binary via the `which` crate (honoring `PATHEXT` for
`.cmd`/`.ps1` npm shims on Windows) and best-effort-verifies it with `--version`.

---

## 4. From a message to a provider: the dispatch

When the renderer sends a chat message over WebSocket, the chat router selects
and constructs a **bridge** based on the session's `tool` (the provider id):

```
WS  { type: "send", session_id, message }
        ▼  routers/chat.rs
match session.tool {
    "claude-code"                              => AnyBridge::Claude(ClaudeBridge…)
    "opencode"                                 => AnyBridge::OpenCode(…)   // ACP
    "cursor-cli"                               => AnyBridge::Cursor(…)     // ACP
    "github-copilot"                           => AnyBridge::GitHubCopilot(…) // ACP
    "hermes-agent"                             => AnyBridge::Hermes(…)     // ACP
    "kimi-code"                                => AnyBridge::Kimi(…)       // ACP
    "grok-build"                               => AnyBridge::GrokCli(…)    // ACP
    "codex-cli"                                => AnyBridge::Codex(…)      // app-server
    "antigravity-cli"                          => AnyBridge::Antigravity(…)// PTY -p
    "antigravity-sdk"                          => AnyBridge::AntigravitySdk(…) // py sidecar
    "openai"|"anthropic"|"deepseek"|"grok"|"nvidia-nim"
      |"kimi-api"|"gemini-api"|"openrouter"
      |"cloudflare-workers-ai"                 => AnyBridge::Agentic(OpenAICompat…) // tool loop
    "ollama"|"ollama-cloud"                    => AnyBridge::OpenAICompat(…)        // single-shot
    "perplexity"                               => AnyBridge::Perplexity(…)
}
        ▼
any_bridge.send_message(text, BridgeContext) -> mpsc::Receiver<BridgeEvent>
        ▼  each BridgeEvent -> JSON -> WebSocket -> renderer
```

- **`AnyBridge`** (`bridges/mod.rs`) is the enum of every bridge implementation;
  `send_message` returns a stream of **`BridgeEvent`**s (text deltas, thinking,
  tool calls, cost, available models, errors, …) that the chat router forwards to
  the renderer over WS. See [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md) for the full
  enum, the transport per family, and the WS message catalog.
- **`BridgeContext`** carries the per-message `base_url_override`,
  `extra_headers`, and `model_override` (used by the routing layer — see
  [`ROUTING.md`](ROUTING.md) — and the model picker).
- HTTP providers are wrapped in the **agentic runner** (`AgenticBridgeRunner`) so
  they get a real tool-use loop, except Ollama and Ollama Cloud, which stay
  single-shot.

---

## 5. The renderer's view

`src/lib/providers-api.ts` fetches the catalog (`/providers/catalog`), the HTTP
health snapshot, and the agent scan; `src/lib/picker-groups.ts::buildPickerGroups`
turns connected tiles + discovered models into the model-picker rails. The chip a
user sees and the dispatch `tool` are reconciled by `resolveModelChip` /
`resolveDispatchTool`. The full model-sourcing story is in
[`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md).

---

## 6. Adding a new provider

1. **Append a `ProviderSpec` to `CATALOG`** (`catalog.rs`) — id, kind, auth,
   `default_models` (or empty), and for a CLI agent its `bin` + `auth_indicators`
   + install/login hints.
2. **HTTP provider** (`kind: Api`): usually nothing else — the OpenAI-compat
   bridge + agentic runner handle it. Add a key-input tile (automatic from the
   spec) and, if it has a `/models` endpoint, wire live discovery in
   `routers/providers.rs::discover_provider_models`.
3. **CLI agent** (`kind: Cli`): add a bridge in `crates/fleetify-backend/src/bridges/`
   and a `match` arm in `routers/chat.rs`. If it speaks ACP, reuse
   `bridges/acp.rs::AcpClient` (mirror `opencode.rs`/`hermes.rs`); otherwise
   implement the transport (subprocess/PTY/HTTP). Add a `ScanProbe` arm if it
   installs off-PATH.
4. **Onboarding parity**: add the id to the hardcoded `PROVIDERS` list in
   `src/components/onboarding/onboarding-chat.tsx` (a mount-time drift guard
   `console.warn`s if the catalog gains an id the onboarding list lacks), and add
   a `ProviderLogo` case in `src/components/ui/provider-logo.tsx`.
5. **Picker bucket**: list CLI ids in `src/components/chat/unified-model-picker.tsx`
   (`CLI_IDS`) so the rail divider buckets it correctly.

---

## Key files

| Concern | File |
|---|---|
| Catalog / specs | `crates/fleetify-backend/src/providers/catalog.rs` |
| Key cache | `crates/fleetify-backend/src/providers/keys.rs` |
| Lookups (`find_provider`, `list_cli_agents`, …) | `crates/fleetify-backend/src/providers/helpers.rs` |
| Scan + model discovery endpoints | `crates/fleetify-backend/src/routers/providers.rs` |
| Key reload (internal) | `crates/fleetify-backend/src/routers/internal.rs` |
| Bridge enum + events | `crates/fleetify-backend/src/bridges/mod.rs` |
| Dispatch | `crates/fleetify-backend/src/routers/chat.rs` |
| Renderer catalog/picker | `src/lib/providers-api.ts`, `src/lib/picker-groups.ts` |
