# Providers

What's wired into Fleetify today, and what each provider is for. Everything here
is driven by the single static catalog in
`crates/fleetify-backend/src/providers/catalog.rs` — see
[`PROVIDER_ARCHITECTURE.md`](PROVIDER_ARCHITECTURE.md) for *how* it all connects,
and [`AGENTS.md`](AGENTS.md) for the CLI-agent details.

The catalog currently ships **21 providers**: **10 CLI agents**, **10 cloud HTTP
APIs**, and **1 local HTTP** (Ollama).

---

## CLI agents (`kind: cli`)

Local subprocess agents that run against your machine. Auth is **out-of-band**
(each agent's own `login`); Fleetify only *detects* the logged-in state and never
holds the credential. Surface in Settings → Agents via `/api/agents/scan`.

| Agent | Catalog id | Binary | What it is | Install / Login |
|---|---|---|---|---|
| Claude Code | `claude-code` | `claude` | Anthropic's agentic CLI; Fleetify's default agent. | `npm i -g @anthropic-ai/claude-code` · `claude login` |
| Codex CLI | `codex-cli` | `codex` | OpenAI's coding agent (ChatGPT/Codex models). | `npm i -g @openai/codex` · `codex login` |
| Kimi Code CLI | `kimi-code` | `kimi` | Moonshot's coding agent. | `npm i -g @moonshot-ai/kimi-code` · `kimi login` |
| OpenCode | `opencode` | `opencode` | Open-source multi-model agent; free `opencode/*` models work with no key. **ACP.** | `npm i -g opencode-ai` · `opencode auth login` |
| Cursor CLI | `cursor-cli` | `cursor-agent` | Cursor's terminal agent. **ACP.** | shell installer · `cursor-agent login` |
| GitHub Copilot CLI | `github-copilot` | `copilot` | GitHub Copilot subscription (GPT-5.x, Claude, Gemini). **ACP.** | `npm i -g @github/copilot` · `copilot login` |
| Grok Build | `grok-build` | `grok` | xAI's Grok Build coding agent; auths with your xAI key (`XAI_API_KEY`, shared with `grok`) or `grok login`. **ACP.** | shell installer · `grok login` |
| Hermes Agent | `hermes-agent` | `hermes` | Nous Research's agent; **fans one agent across every provider you've authenticated** (Copilot, Anthropic, OpenRouter, Nous, …). **ACP.** | `pip install "hermes-agent[acp]"` · `hermes model` |
| Antigravity CLI | `antigravity-cli` | `agy` | Google's Antigravity terminal agent (OAuth, print-mode). | shell installer · `agy` |
| Antigravity SDK | `antigravity-sdk` | `python3` | Python SDK wrapping `google.antigravity`; uses a `GEMINI_API_KEY`. | `pip install` · set `GEMINI_API_KEY` |

> Hermes is unusual: a single agent that dispatches to whatever model provider its
> own `hermes model` config has authenticated. The picker shows a **provider
> dropdown** (Copilot / Anthropic / …) above the models — see
> [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md).

---

## Cloud HTTP APIs (`kind: api`)

OpenAI-compatible endpoints; you supply an API key (stored in the OS keychain).
HTTP providers run through the **agentic tool-use loop** (`AgenticBridgeRunner`)
so they get real tool calls, not just chat — see [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md).

| Provider | Catalog id | Base URL | Get a key |
|---|---|---|---|
| OpenAI | `openai` | `https://api.openai.com/v1` | <https://platform.openai.com/api-keys> |
| Anthropic (Claude API) | `anthropic` | `https://api.anthropic.com/v1` | <https://console.anthropic.com/settings/keys> |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | <https://platform.deepseek.com/api_keys> |
| Grok (xAI) | `grok` | `https://api.x.ai/v1` | <https://console.x.ai/> |
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com` | <https://build.nvidia.com/> (free tier, daily cap) |
| Kimi (Moonshot) | `kimi-api` | `https://api.moonshot.ai/v1` | <https://platform.moonshot.ai/> |
| Gemini API | `gemini-api` | `https://generativelanguage.googleapis.com/v1beta/openai` | <https://aistudio.google.com/apikey> |
| Perplexity | `perplexity` | `https://api.perplexity.ai` | <https://www.perplexity.ai/settings/api> |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | <https://openrouter.ai/keys> |
| Cloudflare Workers AI | `cloudflare-workers-ai` | `https://api.cloudflare.com/.../accounts/{account_id}/ai/v1` | <https://dash.cloudflare.com/profile/api-tokens> (+ account id) |

- **OpenRouter** is an aggregator: its full catalog (hundreds of models) is
  discovered live from `GET /api/v1/models` (proxied at
  `GET /providers/openrouter/models`, TTL-cached) and shown with a search box; the
  static catalog ships only a small curated fallback.
- **Cloudflare Workers AI** uses a base-URL template with `{account_id}`,
  substituted at dispatch from the saved account id.
- **Grok (xAI)** shares its key and model lineup with the **Grok Build** CLI agent
  (above): the `XAI_API_KEY` you save here is the same key the `grok-build` bridge
  injects into its subprocess, and both draw from the same curated Grok lineup
  (discovered live from `GET /v1/models` → remote catalog → baked fallback).

---

## Local HTTP (`kind: local_http`)

| Provider | Catalog id | Default URL | Notes |
|---|---|---|---|
| Ollama | `ollama` | `http://localhost:11434` | No auth. Auto-detects models via `/api/tags`; point Settings → Models at a LAN URL (e.g. `http://192.168.1.50:11434`) to drive a remote rig. |

---

## How keys are stored

API keys live in the **OS keychain** under `Fleetify-Provider-<id>` (account =
the user's OIDC `sub`). `fleet.config.json` carries only non-secret state:

```json
{
  "providers": {
    "connected": { "openai": true, "perplexity": true },
    "enabled_models": { "openai": ["gpt-5.5"] },
    "ollama_base_url": "http://192.168.1.50:11434",
    "enabled_agents": ["claude-code", "codex-cli", "hermes-agent"]
  }
}
```

Legacy `cfg.apiKeys` JSON from older installs is migrated into the keychain at
boot (stripped only when every write succeeds, so a Linux box without
secret-service retries next boot).

## How keys reach the bridge

```
Settings → Models
    └─ providers_set_key IPC
         ├─ writes keychain (Fleetify-Provider-<id>)
         ├─ writes fleet.config.json#providers.connected
         └─ POST /api/internal/providers/reload  ─→  in-process key cache
                                                      ↑
                                                      └─ bridge spawn reads here
```

The cache (`providers::keys::PROVIDER_KEYS`) is process-wide, so a key change in
Settings is visible to the very next chat turn — no restart. A bridge that finds
no cached key falls back to the spec's `auth.env_hint` env var.

## Perplexity citations

Sonar models emit `citations` + `search_results` arrays alongside the streamed
text. `PerplexityBridge` parses them into `BridgeEvent::Citation` /
`BridgeEvent::SearchResult`; the renderer buffers them and renders a
`<CitationCard>` footer (favicon + title + hostname + snippet) per source.

## Test Connection

Settings → Models' Test button calls `providers_test_connection`, hitting
`<base>/models` with the draft key (4s timeout):

| Code | Meaning |
|---|---|
| `AUTH` | 401/403 — key wrong or revoked. |
| `NETWORK` | Couldn't reach the host or 5xx. |
| `TIMEOUT` | Took longer than 4 s. |
| `NOT_FOUND` | 404 at `<base>/models` (Perplexity has no models endpoint). |

Test is optional — you can Save without testing.
