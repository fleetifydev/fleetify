# Providers

Fleetify's chat composer + Settings → Models page is driven by a single
static catalog in `crates/fleetify-backend/src/providers/catalog.rs`.
Adding a new provider is a one-file append; the renderer, IPC layer,
chat dispatch, and Settings tile all pick it up automatically.

## Supported providers

### Cloud HTTP

| Provider | Catalog id | Base URL | Get a key |
| --- | --- | --- | --- |
| OpenAI | `openai` | `https://api.openai.com/v1` | <https://platform.openai.com/api-keys> |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | <https://platform.deepseek.com/api_keys> |
| Grok (xAI) | `grok` | `https://api.x.ai/v1` | <https://console.x.ai/> |
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com` | <https://build.nvidia.com/> (free tier with daily request cap) |
| Kimi (Moonshot) | `kimi-api` | `https://api.moonshot.ai/v1` | <https://platform.moonshot.ai/> |
| Gemini API | `gemini-api` | `https://generativelanguage.googleapis.com/v1beta/openai` | <https://aistudio.google.com/apikey> |
| Perplexity | `perplexity` | `https://api.perplexity.ai` | <https://www.perplexity.ai/settings/api> |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | <https://openrouter.ai/keys> |

OpenRouter is an OpenAI-compatible aggregator: its full catalog (hundreds of
models) is discovered live from `GET /api/v1/models` (proxied by the backend at
`GET /providers/openrouter/models`, TTL-cached) and surfaced in the composer's
model picker with a search box — the static catalog ships only a small curated
fallback list, so OpenRouter is exempt from the doc-pinned `no_stale_model_ids`
check that fixed-catalog providers must satisfy.

### Local

| Provider | Catalog id | Default URL | Notes |
| --- | --- | --- | --- |
| Ollama | `ollama` | `http://localhost:11434` | Auto-detects models via `/api/tags`. Settings → Models lets you point at a LAN URL like `http://192.168.1.50:11434` to drive a remote rig. |

## How keys are stored

The user's API key is written to the OS keychain under
`Fleetify-Provider-<id>` (account = the user's OIDC `sub`). The
`fleet.config.json` file on disk only carries non-secret state:

```json
{
  "providers": {
    "connected": { "openai": true, "perplexity": true },
    "enabled_models": { "openai": ["o3", "gpt-4o"] },
    "ollama_base_url": "http://192.168.1.50:11434",
    "enabled_agents": ["claude", "codex"]
  }
}
```

The legacy `cfg.apiKeys` JSON block from older installs is migrated
silently into the keychain at boot. The block is only stripped when
every key writes succeed — partial failures (e.g. Linux without
secret-service) leave the JSON intact for next-boot retry.

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

The cache is process-wide (`providers::keys::PROVIDER_KEYS`) so a key
change in Settings is visible to the very next chat turn — no restart.

## Perplexity citations

Perplexity's Sonar models emit `citations` + `search_results` arrays
alongside the streamed text. The `PerplexityBridge` parses them out as
`BridgeEvent::Citation` / `BridgeEvent::SearchResult` events; the
renderer buffers them in `ws-manager.ts` and pushes a single
`CitationBlock` onto `contentSoFar` right before the message is
finalized. Output: a `<CitationCard>` footer with favicon + title +
hostname + snippet for each source.

## Test Connection

Settings → Models' Test button calls `providers_test_connection`, which
hits `<base>/models` with the draft key (4s timeout). Result codes:

| Code | Meaning |
| --- | --- |
| `AUTH` | 401/403 — key wrong or revoked. |
| `NETWORK` | Couldn't reach the host or 5xx response. |
| `TIMEOUT` | Took longer than 4 seconds. |
| `NOT_FOUND` | 404 at `<base>/models` (Perplexity has no models endpoint — its connectivity ping is deferred to a future 1-token completion fallback). |

Test is optional — Save without testing if you want to commit a key
that the test currently can't probe.
