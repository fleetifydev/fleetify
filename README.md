# Fleetify (Rust + Tauri)

Faithful Rust + Tauri rebuild of [Fleetify](https://fleetify.dev). One
Tauri v2 process; the embedded `axum` backend on `127.0.0.1:8765`
serves the React UI + REST API + WebSocket chat from the same origin.

## At a glance

- **6 workspace crates**, **95+ commits**.
- All bridges real (Claude / OpenAI / Gemini / Codex + the 7 OpenAI-
  compat HTTP providers + Perplexity) with cost computation,
  telemetry sync, activity ledger, recall-on-trigger, end-of-session
  distillation, app-owned `/compact`.
- **4 CLI agents** (Claude, OpenAI Codex, Gemini, Kimi) and **8 HTTP
  providers** (OpenAI, DeepSeek, Grok / xAI, NVIDIA NIM, Kimi /
  Moonshot, Gemini API, Perplexity Sonar with citations, Ollama
  local + LAN-remote) — all driven by the static registry in
  `crates/fleetify-backend/src/providers/catalog.rs`. Keys live in
  the OS keychain; Settings → Models / Agents render from the
  registry; see [`docs/PROVIDERS.md`](docs/PROVIDERS.md) +
  [`docs/AGENTS.md`](docs/AGENTS.md).
- 3 stdio MCP server binaries shipped (`fleet-memory-mcp`,
  `fleet-dispatch-mcp`, `fleet-reveng-mcp`) auto-registered on first
  launch and spliced into Claude sessions via `--mcp-config`.
- Plugin installer + materializers (Claude / Gemini / Codex) live;
  marketplace source CRUD + catalog walk live; MCP probe + OAuth
  (PKCE) live.
- Workflow engine with step execution (agent kind = one-shot Haiku;
  tool kind = V1 echo) live.
- `~/.fleetify/`-rooted layout: `device.json`,
  `telemetry-outbox.sqlite`, `fleet.db`, `plugins/`,
  `marketplace-cache/`, `mcp_servers.json`.

See [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) for the full
phase-by-phase coverage matrix and [`docs/RUNNING.md`](docs/RUNNING.md)
for dev / test / build / deploy.

## Quick start

```bash
# Develop
cargo tauri dev

# Test
cargo test --workspace

# Build per-OS installers
cargo tauri build
```

## Workspace crates

| Crate | Kind | Purpose |
|---|---|---|
| `crates/fleetify-core` | library | shared types (Session, Message, BridgeEvent, …) |
| `crates/fleetify-backend` | library | embedded `axum` server (`fleetify_backend::serve(addr, ServeOptions)`) |
| `crates/memory-mcp` | binary `fleet-memory-mcp` | stdio MCP: `remember` + `recall` |
| `crates/dispatch-mcp` | binary `fleet-dispatch-mcp` | stdio MCP: `dispatch_to_agent` |
| `crates/reveng-mcp` | binary `fleet-reveng-mcp` | stdio MCP: `fetch_url` + `save_asset` |
| `crates/browser-mcp` | binary `fleet-browser-mcp` | stdio MCP: browser tools, forwarded to the backend's shared browser |
| `src-tauri` | binary `fleetify-app` | Tauri v2 shell (embeds `fleetify-backend`) |

## Architecture in 60 seconds

`fleetify-backend` is library-only — no `main.rs`. The Tauri shell calls
`fleetify_backend::serve(addr, ServeOptions).await` from its `setup` hook;
the server runs as a tokio task in the same process. A release build
serves the UI from files embedded in the binary, on the same origin and
under a Content-Security-Policy; a debug build loads it from the Vite dev
server. Sign-in lives in the Tauri shell (`shell::auth`), which holds the
access token. The React UI asks for it over IPC (`auth_get_access_token`);
the telemetry client gets it in-process from `shell::auth`. Of the four
MCP sidecars, `fleet-dispatch-mcp` and `fleet-browser-mcp` call the
backend's `/api/internal/*` routes with the internal secret, and
`fleet-reveng-mcp` doesn't call the backend. `fleet-memory-mcp` calls
`/api/sessions/{id}/memory` and expects a bearer token in
`FLEETIFY_BEARER`, which the app doesn't set: that route is a known issue.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
