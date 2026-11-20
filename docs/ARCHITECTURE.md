# Fleetify Architecture

A map of how Fleetify fits together, and an index into the deeper docs.

Fleetify is a **single Tauri v2 process**: an embedded `axum` backend on
`127.0.0.1:8765` serves the React UI, the REST API, and the WebSocket chat from
the same origin. It's a multi-agent "cockpit" — run many AI coding agents
(Claude Code, Codex, OpenCode, Hermes, …) side by side, each in its own session,
plus cloud HTTP model providers (OpenAI, OpenRouter, …).

---

## Process & crates

```
┌───────────────────────────── Tauri v2 process ─────────────────────────────┐
│  src-tauri (fleetify-app)                                                   │
│   ├─ shell::auth          OIDC sign-in; holds the access token              │
│   │                       (the renderer asks for it over IPC)               │
│   └─ setup() ─ calls ──▶  fleetify_backend::serve(127.0.0.1:8765, opts)     │
│                              │  (library, no main.rs — runs as a tokio task)│
│                              ├─ React UI (release: embedded files + CSP)     │
│                              ├─ REST API (/api/...)                          │
│                              └─ WebSocket chat (/ws/...)                     │
│                                                                             │
│  Spawns, on demand: CLI agents (claude/hermes/…) + the fleet-*-mcp sidecars │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Crate | Kind | Purpose |
|---|---|---|
| `crates/fleetify-core` | library | shared types (`Session`, `Message`, `BridgeEvent`), `~/.fleetify` path helpers |
| `crates/fleetify-backend` | library | the embedded `axum` server — routers, bridges, services |
| `crates/memory-mcp` | bin `fleet-memory-mcp` | stdio MCP: `remember` + `recall` |
| `crates/dispatch-mcp` | bin `fleet-dispatch-mcp` | stdio MCP: `dispatch_to_agent` |
| `crates/reveng-mcp` | bin `fleet-reveng-mcp` | stdio MCP: `fetch_url` + `discover_assets` + … |
| `crates/browser-mcp` | bin `fleet-browser-mcp` | stdio MCP: `navigate` + `read_page` + `click` + … on the backend's shared headless browser (Chromium starts on first use) |
| `crates/fleet-wipe` | bin `fleet-wipe` | development helper: removes Fleetify's entries from the OS credential store (`npm run wipe` calls it on Linux); not bundled |
| `src-tauri` | bin `fleetify-app` | Tauri shell; embeds the backend (incl. the in-process permission MCP, served over HTTP — no sidecar) |

The installers ship the four `fleet-*-mcp` sidecars next to `fleetify-app`
(`bundle.externalBin` in `src-tauri/tauri.conf.json`).

`src/` is the React + Vite renderer. State lives in Zustand stores
(`src/stores/*`); the WebSocket client is `src/services/ws-manager.ts`.

---

## A chat turn, end to end

```
React renderer  ──WS {send}──▶  chat router  ──match session.tool──▶  AnyBridge
   ▲                               (routers/chat.rs)                    │
   │                                                                    │ send_message()
   │                                                                    ▼
   │                                          transport (ACP / stdio / PTY / HTTP)
   │                                                                    │
   └──WS {message_delta, tool_*, cost, …}◀── BridgeEvent stream ◀───────┘
```

1. The renderer sends `{ type: "send", session_id, message }` over the multiplexed
   WebSocket.
2. The **chat router** selects a **bridge** from the session's `tool` (provider
   id) and calls `send_message`.
3. The **bridge** drives the provider over its transport and yields a stream of
   `BridgeEvent`s.
4. Each event is serialized to a WS message and streamed back; the renderer
   accumulates them into the chat message.

Providers, models, MCP servers, and routing are all layered on top of this spine.

---

## On-disk layout (`~/.fleetify/`)

`device.json`, `telemetry-outbox.sqlite`, `posthog-outbox.sqlite`,
`mcp_servers.json` (user MCP registry), `plugins/`, `marketplace-cache/`,
`library/`, `models-cache/`. The folder is `$FLEETIFY_HOME` when that is set.
The sessions database, `fleet.db`, is always in this folder, never in the
working directory. A no-auth run (`FLEETIFY_NOAUTH=1`) that doesn't set
`FLEETIFY_HOME` uses `fleet-noauth.db` here instead, which keeps the stub
user's sessions out of the signed-in user's database
([RUNNING.md](RUNNING.md#environment) has the rule). Provider
API keys are **not** here: they live in the OS keychain. MCP servers' OAuth
tokens and plugins' secret values do live here, in `mcp_secrets.json` and
`plugin_secrets.json`.
[INSTALL.md](INSTALL.md#remove-your-data) lists every place an installed
Fleetify keeps data, this folder included.

---

## Documentation map

### Architecture (how it works)
- **[PROVIDER_ARCHITECTURE.md](PROVIDER_ARCHITECTURE.md)** — the provider catalog,
  the three provider kinds, auth/key storage, the agent scan, and how a message
  is dispatched to a bridge.
- **[AGENT_BRIDGES.md](AGENT_BRIDGES.md)** — the bridge abstraction, the
  `AnyBridge`/`BridgeEvent` enums, every transport family (ACP, stream-json,
  app-server, HTTP-SSE, PTY, Python sidecar, the agentic tool loop), and the full
  WebSocket protocol.
- **[MCP_INTEGRATION.md](MCP_INTEGRATION.md)** — where MCP servers are kept (user
  registry + built-in sidecars) and how they're materialized into each agent's
  native config (`mcp_dispatch` + the per-format emitters).
- **[MODEL_DISCOVERY.md](MODEL_DISCOVERY.md)** — how the model list is sourced
  (catalog / live CLI probe / `/models`), the dual toolbar+composer feed, and the
  unified picker (including Hermes' per-provider dropdown).
- **[REMOTE_MODEL_CATALOG.md](REMOTE_MODEL_CATALOG.md)** — the published model
  catalog the app fetches at runtime, so new models ship without an app release.
- **[ROUTING.md](ROUTING.md)** — the "Auto" model-routing engine.
- **[ANALYTICS.md](ANALYTICS.md)** — the two telemetry channels (Fleetify cloud +
  PostHog) and every event/property.

### Reference (what's wired in)
- **[PROVIDERS.md](PROVIDERS.md)** — the current 22 providers and what each is for.
- **[AGENTS.md](AGENTS.md)** — the 10 CLI agents (binary, transport, install/login).

### Integration specs
- **[OPENCODE_INTEGRATION_SPEC.md](OPENCODE_INTEGRATION_SPEC.md)**,
  **[CURSOR_INTEGRATION_SPEC.md](CURSOR_INTEGRATION_SPEC.md)** — design notes
  written when each ACP integration was added.

### Operations
- **[RUNNING.md](RUNNING.md)** — running from source: dev loop, tests, release
  builds, configuration.
- **[INSTALL.md](INSTALL.md)** — installing a release, verifying a download, and
  uninstalling.
