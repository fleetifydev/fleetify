# Changelog

All notable rebuild milestones. Faithful Rust + Tauri port of
[Fleetify](https://fleetify.dev).

## [Unreleased] — Phase 0–5 coverage complete

Spec: `docs/superpowers/specs/2026-05-19-fleetify-rust-tauri-rebuild-design.md`

### Phase 0 — Scaffold

- Cargo workspace (`crates/fleetify-core`, `crates/fleetify-backend`,
  `src-tauri`).
- Tauri v2 config (`tauri.conf.json`, capabilities ACL,
  `withGlobalTauri: true`).
- `[profile.release]` with `lto = "thin"` + `strip = "symbols"` +
  `panic = "abort"` for ~20% smaller installers.

### Phase 1 — Runnable core

- OIDC sign-in via PKCE + RFC 8707 resource indicator
  (`shell::auth`).
- 5-command `window.fleetify` IPC surface (sign in / sign out /
  userinfo / get-access-token / get-state).
- Embedded axum on `127.0.0.1:8765` from the Tauri `setup` hook (no
  child process — `fleetify_backend::serve(addr, dist).await` runs on a
  tokio task).
- sqlx 10-table schema with FK cascades.
- `/api/sessions`, `/api/messages`, `/api/groups` CRUD; `/events/status`
  SSE; `/ws/sessions` multiplexed chat WebSocket.

### Phase 2 — Bridges + git

- **ClaudeBridge**: stream-json + `--mcp-config` splice from
  `mcp_registry` + `mcp_secrets`.
- **OpenAIBridge**: SSE Responses API + mocked-server end-to-end
  test.
- **GeminiBridge**: ACP cold-start + session_update streaming +
  permission/fs handlers (project-scoped).
- **CodexBridge**: V2 JSON-RPC (UUID ids) + thread/start + turn
  streaming + unified-diff parse + approval handler.
- **3 stdio MCP server binaries**: `fleet-memory-mcp` (remember +
  recall), `fleet-dispatch-mcp` (dispatch_to_agent with per-session
  rate-limit + self-dispatch refusal), `fleet-reveng-mcp` (fetch_url
  + save_asset + find_endpoints + discover_assets). Auto-registered
  in `~/.fleetify/mcp_servers.json` on first backend boot.
- Workspace router: file CRUD + `git status` + `git diff`
  (working/branch/auto) + `@`-mention search.
- AI git surface: `generateCommitMessage`, `generatePRSummary`,
  `reviewDiff`, `diagnoseFailure`, `applyRecovery` (whitelisted
  verbs + tokenizer), `applyPreflightFix`, `diffSummary`.
- GitHub link OAuth fallback (per-user keychain-scoped tokens).
- HEAD watcher (`notify-debouncer-mini` → renderer branch strip).
- Installers (`installProvider`, `installOllama`,
  `checkGithubAuth`).

### Phase 3 — Orchestration

All 11 services ported + wired into the chat handler:

- `activity_logger` (tool classifier + summariser + DB write +
  telemetry emit).
- `meta_cost` + `haiku_breaker` + `haiku_client` (one-shot Haiku
  caller + JSON extractor + circuit breaker).
- `fleet_brain` (continue/ask/done classification).
- `prompt_enhancer` (`/api/prompt/enhance` Wand button).
- `task_enricher` (@-mention dispatch task rewrites).
- `auto_planner` (Haiku-driven multi-agent routing).
- `session_summarizer` (end-of-session distillation →
  session_memory).
- `compactor` (app-owned `/compact` with snapshot + delete +
  cumulative summary).
- `recall_hook` (trigger-driven `[RECALL CONTEXT]` injection into
  bridge turns).

Chat handler wiring:
- `[fleet:compaction]` marker → `compactor::compact_session`.
- end-of-turn idle → `session_summarizer::schedule_distill`.
- pre-bridge → `recall_hook::maybe_build_recall_context`.
- `tool_end` event → `activity_logger::record_tool_event`.
- `Cost` event → `telemetry::emit_cost`.

### Phase 4 — Cloud

- **Telemetry pipeline** end-to-end:
   * `device_id` (`<HOME>/.fleetify/device.json`).
   * `outbox` (sqlx WAL queue at
     `<HOME>/.fleetify/telemetry-outbox.sqlite`).
   * 6 emitters (`session_start` / `session_stop` / `cost` /
     `status_change` / `activity` / `heartbeat`).
   * Heartbeat loop (60 s, started from backend serve hook).
   * WS client to `wss://fleetify.dev/api/realtime/connect` with
     exponential backoff (1 s → 30 s), bearer source callback
     supplied by the Tauri shell.
- **Plugins**:
   * Manifest parser (regex name + semver + provider whitelist +
     legacy-dir reject + auto-derived `provides`).
   * Installer: git clone + manifest validate + canonical place at
     `<HOME>/.fleetify/plugins/<name>/`.
   * Materializers: per-provider skills + commands + prompts +
     hooks written into `~/.{claude,gemini,codex}/` with
     `<plugin>__<name>` prefix.
   * Uninstall walks the materialized prefix and removes
     `~/.{claude,gemini,codex}/{skills,commands,prompts}/<plugin>__*`
     before removing the install dir.
- **Marketplace**: source CRUD (list/add/delete/patch) + refresh
  (clone or `git pull --ff-only` into
  `<HOME>/.fleetify/marketplace-cache/`) + catalog walk
  (`marketplace.json` listings + single-plugin repos) + plugin
  detail endpoint.
- **MCP**: registry CRUD, per-server secrets store, real stdio
  probe (initialize → `tools/list`), OAuth (PKCE start + callback
  via shared loopback redirect URI).
- **Workflows**: in-memory run registry + `substitute()` for
  `{{step:N:output}}` / `{{argname}}`; step execution loop with
  `agent` (one-shot Haiku) and `tool` (V1 echo) kinds.

### Phase 5 — Hardening

- `docs/RUNNING.md` (dev / test / build / deploy).
- `docs/PHASE_STATUS.md` (this matrix).
- `README.md` top-level overview.
- CI: `.github/workflows/ci.yml` runs the workspace test suite +
  clippy + release-build on every push / PR across Ubuntu / macOS
  / Windows.
- Release: `.github/workflows/release.yml` produces per-OS DMG /
  MSI / DEB installers on `v*` tag push.
- Integration tests: 8 active (auth_jwt × 3, healthz,
  schema_parity, sessions_api, static_dir, ws_protocol, phase4_apis).

### Test inventory

| Surface | Tests |
|---|---|
| `fleetify-backend` lib | 125 |
| `fleetify-backend` integration | 8 (+1 ignored) |
| `fleetify-core` lib | 2 |
| `fleetify-app` lib | 22 |
| Doctests | 2 |
| **Total** | **159 active + 1 ignored** |

### What remains

- Per-OS smoke installer testing (fires automatically when a
  `v*` tag triggers `release.yml`).
- Optional Codex sub-agent (`spawnAgent` collab thread) tracking
  for renderer's parent_task_id tagging.
