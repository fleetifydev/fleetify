# Fleetify (Rust + Tauri)

Faithful Rust + Tauri rebuild of [Fleetify](https://fleetify.dev). One
Tauri v2 process; the embedded `axum` backend on `127.0.0.1:8765`
serves the React UI + REST API + WebSocket chat from the same origin.

## At a glance

- **6 workspace crates**, **95+ commits**.
- All bridges real (Claude / OpenAI / Gemini / Codex) with cost
  computation, telemetry sync, activity ledger, recall-on-trigger,
  end-of-session distillation, app-owned `/compact`.
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
| `crates/fleetify-backend` | library | embedded `axum` server (`fleetify_backend::serve(addr, dist_dir)`) |
| `crates/memory-mcp` | binary `fleet-memory-mcp` | stdio MCP: `remember` + `recall` |
| `crates/dispatch-mcp` | binary `fleet-dispatch-mcp` | stdio MCP: `dispatch_to_agent` |
| `crates/reveng-mcp` | binary `fleet-reveng-mcp` | stdio MCP: `fetch_url` + `save_asset` |
| `src-tauri` | binary `fleetify-app` | Tauri v2 shell (embeds `fleetify-backend`) |

## Architecture in 60 seconds

`fleetify-backend` is library-only — no `main.rs`. The Tauri shell calls
`fleetify_backend::serve(addr, static_dir).await` from its `setup` hook;
the server runs as a tokio task in the same process. Sign-in lives in
the Tauri shell (`shell::auth`); the bearer is exposed to the backend
via `127.0.0.1:8770` (loopback bearer-bridge) so the React UI can use
the cookie-less OIDC flow without leaking the token across IPC. The 3
MCP-server binaries connect upward to `127.0.0.1:8765/api/sessions/...`
when the user's session invokes their tools.

## License

MIT (per `Cargo.toml` workspace.package.license).
