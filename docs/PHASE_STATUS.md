# Phase Status

Faithful Rust + Tauri rebuild of Fleetify. Phase boundaries follow
`docs/superpowers/specs/2026-05-19-fleetify-rust-tauri-rebuild-design.md`.

## Phase 0 — Scaffold ✅

Cargo workspace (`crates/fleet-core`, `crates/fleet-backend`, `src-tauri`),
Tauri v2 config (`tauri.conf.json`, capabilities ACL, `withGlobalTauri`),
release profile (`lto = "thin"` + `strip = "symbols"`), bundle metadata
(publisher / copyright / category / per-OS hints), icons in place.
`cargo tauri build` is configuration-complete.

## Phase 1 — Runnable core ✅

| Subsystem | Status |
|---|---|
| OIDC sign-in (PKCE + RFC 8707 resource indicator) | ✅ |
| Tauri shell `window.fleetify.*` (5 auth commands) | ✅ |
| Embedded `axum` on `127.0.0.1:8765` (background task) | ✅ |
| sqlx migrations (10 tables, FK cascades, composite indexes) | ✅ |
| `/api/sessions` CRUD + ownership scoping | ✅ |
| `/api/messages` CRUD | ✅ |
| `/api/groups` CRUD | ✅ |
| `/events/status` SSE | ✅ |
| `/ws/sessions` multiplexed chat WebSocket | ✅ |

End-to-end: sign in → create session → send message → see assistant
stream.

## Phase 2 — Bridges + git pipeline ✅ ~95%

| Bridge | Status | Notes |
|---|---|---|
| **ClaudeBridge** (stream-json + `--mcp-config`) | ✅ | Full event translation + cost wiring + MCP registry splice |
| **OpenAIBridge** (SSE Responses API) | ✅ | Mocked-server test |
| **GeminiBridge** (ACP) | ✅ | Real cold-start + session_update streaming |
| **CodexBridge** (V2 JSON-RPC) | ✅ | Spawn + handshake + thread/start + turn streaming + unified-diff parse |
| **Fleet MCP servers** | ✅ | `fleet-memory-mcp` + `fleet-dispatch-mcp` + `fleet-reveng-mcp` stdio binaries |

**Other Phase 2 deliverables:**

- ✅ `workspace` router: file CRUD, search, real `git status` + `git diff` (working/branch/auto)
- ✅ AI git surface: `generateCommitMessage`, `generatePRSummary`, `reviewDiff`, `diagnoseFailure`, `applyRecovery`, `applyPreflightFix`, `diffSummary`
- ✅ GitHub link OAuth fallback (per-user keychain-scoped tokens)
- ✅ HEAD watcher (`notify-debouncer-mini` → renderer branch strip)
- ✅ Installers (`installProvider`, `installOllama`, `checkGithubAuth`)
- ✅ ACP client + Codex JSON-RPC client (foundations)

## Phase 3 — Orchestration ✅

| Service | Status |
|---|---|
| `activity_logger` (kind classifier + tool summariser + DB write + telemetry) | ✅ |
| `meta_cost` (Haiku spend tracking under `<model>/meta-<kind>`) | ✅ |
| `haiku_breaker` (3-strike circuit breaker, 60s cooldown) | ✅ |
| `haiku_client` (`claude --print` one-shot + JSON extractor) | ✅ |
| `fleet_brain` (continue/ask/done classification) | ✅ |
| `prompt_enhancer` (Wand button rewriter) | ✅ |
| `task_enricher` (@mention dispatch task rewriter) | ✅ |
| `auto_planner` (Haiku-driven multi-agent routing) | ✅ |
| `session_summarizer` (end-of-session distillation → session_memory) | ✅ |
| `compactor` (app-owned /compact with snapshot+delete+cumulative summary) | ✅ |
| `recall_hook` (trigger-driven memory injection into bridge turns) | ✅ |

Wired into the chat handler:
- `[fleet:compaction]` marker → `compactor::compact_session`
- end-of-turn idle → `session_summarizer::schedule_distill`
- pre-bridge → `recall_hook::maybe_build_recall_context`
- tool_end → `activity_logger::record_tool_event`
- Cost event → `telemetry::emit_cost`

## Phase 4 — Cloud integration ✅

| Subsystem | Status |
|---|---|
| **Telemetry pipeline** | |
| &nbsp;&nbsp;`device_id` (UUID + hostname + platform) | ✅ |
| &nbsp;&nbsp;`outbox` (sqlx SQLite WAL queue) | ✅ |
| &nbsp;&nbsp;6 `emit_*` functions (session_start/stop/cost/status/activity/heartbeat) | ✅ |
| &nbsp;&nbsp;`heartbeat` loop (60s) | ✅ |
| &nbsp;&nbsp;`ws_client` (WSS to `fleetify.dev` with replay + dedup) | ✅ |
| &nbsp;&nbsp;Tauri shell startup with BearerSource | ✅ |
| **Plugins** | |
| &nbsp;&nbsp;`PluginManifest` types + parser (name regex, semver, providers, legacy-dir reject, `derive_provides`) | ✅ |
| &nbsp;&nbsp;`installer::install_from_git` (clone + validate + place) | ✅ |
| &nbsp;&nbsp;`/api/plugins` list (scans `~/.fleetify/plugins/`) | ✅ |
| &nbsp;&nbsp;`/api/plugins/install` / `/uninstall` | ✅ |
| &nbsp;&nbsp;Materializers (write into `~/.claude/`, `~/.gemini/`, `~/.codex/`) | ✅ |
| **Marketplace** | |
| &nbsp;&nbsp;Source CRUD (list/add/delete/patch) | ✅ |
| &nbsp;&nbsp;Source refresh (clone or `git pull --ff-only` into cache) | ✅ |
| &nbsp;&nbsp;Catalog walk (`marketplace.json` listings + single-plugin repos) | ✅ |
| &nbsp;&nbsp;Plugin detail endpoint | ✅ |
| **MCP** | |
| &nbsp;&nbsp;`mcp_registry` (~/.fleetify/mcp.json CRUD) | ✅ |
| &nbsp;&nbsp;`mcp_secrets` (per-server token store) | ✅ |
| &nbsp;&nbsp;Probe (start servers + `list_tools`) | ✅ |
| &nbsp;&nbsp;OAuth start/callback (PKCE) | ✅ |
| **Workflows** | |
| &nbsp;&nbsp;In-memory run registry + `substitute()` | ✅ |
| &nbsp;&nbsp;Router list / run / get_run with per-user scoping | ✅ |
| &nbsp;&nbsp;Step execution loop (depends on SdkBridge) | ⏳ |

## Phase 5 — Hardening 🟡 ~60%

| Item | Status |
|---|---|
| `[profile.release]` (LTO + strip) | ✅ |
| `tauri.conf.json` bundle metadata (per-OS) | ✅ |
| Icons in `src-tauri/icons/` | ✅ |
| `docs/RUNNING.md` (dev / test / build / deploy) | ✅ |
| `docs/PHASE_STATUS.md` (this file) | ✅ |
| Per-OS smoke installer testing | ⏳ |
| Port `backend/tests/*` → Rust integration tests | ⏳ |
| Wire-conformance suite vs. the original Python | ⏳ |

## Test inventory

Backend (`cargo test -p fleet-backend --lib`): **124 tests**
covering bridges (ACP, Codex client, OpenAI mock SSE), services
(every helper has at least one test), routers (workspace search,
plugin manifest parser, mcp prober error envelopes, mcp auth
PKCE URL composition).

Tauri shell (`cargo test -p fleetify-app --lib`): **22 tests** covering
auth helpers, config persistence, git tokenizer / shell-meta detector,
AI-git CLI dispatcher, scaffolded plugin write, fs read-dir ordering.

Workspace doctests: **2** (auto-generated by `///` examples).

Total: **148 tests**, all stable across multiple runs.

## Workspace crates

- `crates/fleet-core` — shared types (library).
- `crates/fleet-backend` — embedded `axum` server (library).
- `crates/memory-mcp` — `fleet-memory-mcp` stdio MCP binary
  (remember + recall).
- `crates/dispatch-mcp` — `fleet-dispatch-mcp` stdio MCP binary
  (dispatch_to_agent).
- `crates/reveng-mcp` — `fleet-reveng-mcp` stdio MCP binary
  (fetch_url + save_asset).
- `src-tauri` — `fleetify-app` Tauri v2 binary (embeds
  `fleet-backend` library at runtime).
