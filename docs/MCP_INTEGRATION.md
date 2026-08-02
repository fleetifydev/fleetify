# MCP Integration

Where Fleetify keeps MCP (Model Context Protocol) servers, and how it materializes
them into each provider/agent's native config at spawn time.

> Related: [`PROVIDER_ARCHITECTURE.md`](PROVIDER_ARCHITECTURE.md),
> [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md).

---

## 1. Two sources of MCP servers

Every agent spawn sees a **merged** set of MCP servers built from two sources:

1. **The user registry** — MCP servers the user added, persisted in
   `~/.fleetify/mcp_servers.json` (`services/mcp_registry.rs`). Managed from the
   Settings → MCP page via `/api/mcp/*` (`routers/mcp.rs`). Schema:

   ```json
   { "mcpServers": { "<name>": { "type": "stdio|http|sse", "command|url": …, "args": …, "headers|env": … } } }
   ```

2. **The fleet built-in MCPs** — stdio sidecar binaries Fleetify ships, spliced
   in **per spawn** (not stored in the user registry). They are gated by session
   type / agent template (see §3).

The user registry holds **only** user entries; a one-shot migration
(`purge_legacy_builtin_seeds`) strips any `"builtin": true` rows older builds
auto-seeded there.

---

## 2. The built-in MCP sidecars

Four stdio JSON-RPC 2.0 MCP servers, each a workspace crate emitting a
`fleet-*-mcp` binary:

| Crate | Binary | Tools | Purpose |
|---|---|---|---|
| `crates/memory-mcp` | `fleet-memory-mcp` | `remember(title, content, kind?)`, `recall(query?, limit?)` | Project-scoped long-term memory that survives across sessions. Talks back to the backend at `/api/sessions/{id}/memory`. |
| `crates/dispatch-mcp` | `fleet-dispatch-mcp` | `dispatch_to_agent(agent, task)` | Agent-to-agent task routing without returning to the user. Rate-limited (5 / 60 s / session); self-dispatch refused. POSTs `/api/internal/dispatch`. |
| `crates/reveng-mcp` | `fleet-reveng-mcp` | `fetch_url`, `discover_assets`, `find_endpoints`, `save_asset` | Reverse-engineering toolkit (scrape + asset/endpoint discovery). Pure-local; writes under `<project>/.fleetify/reveng-assets/`. |
| _(in-process, no binary)_ | HTTP `/api/internal/mcp/permission/{sid}` | `permission_prompt(tool_name, input)` | Claude-CLI permission gate (`--permission-prompt-tool`), served **in-process over HTTP** by the backend — not a sidecar binary. Claude connects with the session id in the URL + an `Authorization: Bearer <internal-secret>`. Wired only by the Claude bridge. |

**Sidecars connect upward to the backend.** They receive their wiring via env
vars set by the bridge at spawn:

- `FLEETIFY_SESSION_ID` — scopes memory / rate-limits dispatch / looks up the permission session.
- `FLEETIFY_BACKEND_URL` — defaults to `http://127.0.0.1:8765`.
- `FLEETIFY_INTERNAL_SECRET` — loopback shared secret (dispatch + permission), sent as `X-Fleet-Internal`.
- `FLEETIFY_PROJECT_PATH` — reveng only, root for `save_asset`.

Exposed to the model as `mcp__<server>__<tool>`, e.g.
`mcp__fleet_memory__remember`, `mcp__fleet_dispatch__dispatch_to_agent`.

---

## 3. `mcp_dispatch.rs` — the materializer

`crates/fleetify-backend/src/services/mcp_dispatch.rs` is the **single source of
truth for "what MCPs does this spawn see, and in what shape."**

### Build the canonical map

```rust
build_merged_map(session_id, is_staff, agent_template) -> BTreeMap<String, Value>
```

1. Pulls every user-registry entry.
2. Appends the gated built-ins from `builtin_names_for`:
   - `fleet_memory` — **always**.
   - `fleet_dispatch` — **non-staff only** (staff dispatch via a text protocol).
   - `fleet_reveng` — only when `agent_template == "reverse_engineering"`.
   - `fleet_permission` — *not* here; the Claude bridge mounts it separately, as an in-process HTTP MCP (no sidecar).
3. `builtin_mcp_config` resolves each built-in: the stdio sidecars
   (memory/dispatch/reveng) → `{ type: "stdio", command, args, env, builtin: true }`;
   `fleet_permission` → `{ type: "http", url, headers, builtin: true }` pointing at
   the backend's own in-process MCP endpoint.
4. `splice_oauth` injects stored OAuth Bearer tokens into http/sse `headers`
   (from `services/mcp_secrets.rs`) and the `FLEETIFY_*` env trio into the
   `fleet_*` stdio entries.

Per-server isolation: a single malformed user entry can't drop the whole map.

### Emit into each agent's native format

The merged map is **transport-agnostic**; each bridge serializes it through a
format-specific emitter:

| Emitter | Output shape | Consumed by |
|---|---|---|
| `to_acp_servers(map)` | ACP `mcpServers` **array**; `headers`/`env` dicts → `[{name,value}]`; strips the internal `builtin` marker | Gemini, GitHub Copilot, OpenCode, Cursor, Hermes, **Kimi** (all ACP bridges) |
| `to_codex_cli_args(map)` | flat `-c mcp_servers.<n>.<key>=<toml>` CLI args | Codex (`codex app-server`) |
| `to_antigravity_cli_json(map)` | `{ "mcpServers": { … } }`; `url` → `serverUrl` for remote | Antigravity CLI (`agy`), written to a config file |
| `to_sdk_mcp_servers(map)` | transport-tagged list; **omits `env` for stdio** (delivered out-of-band) | Antigravity SDK (Python) |
| (Claude builds JSON directly) | `{ "mcpServers": { <name>: <config> } }` | Claude CLI (`--mcp-config`) |

> **ACP `env` quirk:** ACP requires every stdio entry to carry an `env` field.
> `ensure_stdio_env` (in each ACP bridge) backfills `env: []` on stdio entries
> that lack one — OpenCode/Hermes reject a missing `env` with `-32602 Invalid
> params`.

---

## 4. How each bridge mounts MCP

| Bridge | Mechanism |
|---|---|
| **Claude** (`bridges/claude.rs`) | `build_merged_map` → JSON → `claude -p --mcp-config <path>`. Adds `fleet_permission` (in-process HTTP MCP served by the backend) + `--permission-prompt-tool` whenever a permission handler is set (every non-staff session). |
| **ACP** — Gemini / GitHub Copilot / OpenCode / Cursor / Hermes / **Kimi** | `build_merged_map` → `to_acp_servers` → `ensure_stdio_env` → sent in the ACP `session/new` request's `mcpServers`. |
| **Codex** (`bridges/codex.rs`) | `build_merged_map` → `to_codex_cli_args` → `-c mcp_servers.…` flags on `codex app-server`. |
| **Antigravity CLI** (`bridges/antigravity.rs`) | `build_merged_map` → `to_antigravity_cli_json` → writes `~/.gemini/config/mcp_config.json`; cleans up its own keys after the turn (preserves user entries). |
| **Antigravity SDK** (`bridges/antigravity_sdk.rs`) | `build_merged_map` → `to_sdk_mcp_servers` → Python SDK `mcp_servers` list. |
| **Grok Build** (`bridges/grok_cli.rs`) | `build_merged_map` → `to_acp_servers` → `grok_acceptable_mcp` → sent in the ACP `session/new` `mcpServers`. **http/sse only** — Grok's ACP rejects stdio entries (`-32602`), so `grok_acceptable_mcp` drops any server carrying a `command`; `ensure_stdio_env` is intentionally NOT called (Grok also rejects stdio `env`). |
| **HTTP-only** — OpenAI/DeepSeek/**Grok (REST API)**/… , Perplexity, Kimi-API, Ollama | No MCP path (REST chat only). The `grok-build` *CLI agent* is separate — see the Grok Build row above. |

Hermes specifically mounts the merged map over ACP and relies on
`ensure_stdio_env` for the `fleet_*` stdio entries — see
[`PROVIDER_ARCHITECTURE.md`](PROVIDER_ARCHITECTURE.md) and `bridges/hermes.rs`.

**Kimi (Moonshot) Code CLI** (`bridges/kimi.rs`) mounts MCP the same ACP way —
the merged map rides in the `session/new` `mcpServers` array. Two Kimi-specific
notes: the bridge spawns plain **`kimi acp`** with *no* model/approval flags (the
ACP `acp` subcommand exposes none — model comes from Kimi's own config, tool
permissions route through ACP `session/request_permission`), and Kimi
authenticates **out-of-band** — run `kimi` once and send `/login` before a
session works; the bridge only calls ACP `authenticate` when `initialize`
advertises an `authMethods` entry, otherwise it goes straight to `session/new`,
and a "not logged in" error surfaces verbatim. **Do not confuse it with
"Kimi-API"** in the HTTP-only row above — that is Moonshot's OpenAI-compatible
REST endpoint (`bridges/openai_compat.rs`), a different provider with no MCP path.

---

## 5. Resolving the sidecar binaries

`mcp_registry::resolve_builtin_path(basename)` resolves a `fleet-*-mcp` binary at
runtime, in order:

1. **Beside the running executable** — `current_exe()`'s dir (the Tauri bundle
   layout, where `fleetify-app(.exe)` and the `fleet-*-mcp(.exe)` ship together).
2. **`which::which(basename)`** — PATH (honors `PATHEXT` on Windows).
3. **Bare basename** — last-resort fallback (errors at spawn if not on PATH).

Because each worktree builds its own `target/`, every dev instance resolves its
own copy of the sidecars — no cross-instance conflict. The release sidecar set is
asserted by `npm run check:sidecars` (the drift guard CI runs), which compares
`SIDECARS` in `scripts/build-sidecars.mjs` against `bundle.externalBin` in
`src-tauri/tauri.conf.json`.

---

## 6. Secrets for remote (OAuth) MCP servers

`services/mcp_secrets.rs` holds per-server OAuth tokens
(`access_token`/`refresh_token`/`expires_at`/`extra`). `build_merged_map` calls
`mcp_secrets::get(name)` and `splice_oauth` injects `Authorization: Bearer <token>`
into that server's `headers`. The OAuth (PKCE) flow + signout live behind
`/api/mcp/servers/{name}/auth/*`.

---

## 7. HTTP surface (`routers/mcp.rs`)

```
GET    /api/mcp/servers              list user registry
POST   /api/mcp/servers              add
PUT    /api/mcp/servers/{name}       update
DELETE /api/mcp/servers/{name}       remove
POST   /api/mcp/servers/{name}/probe probe one
POST   /api/mcp/probe-all            probe all
GET    /api/mcp/config-path          path to ~/.fleetify/mcp_servers.json
POST   /api/mcp/open-config          open it in the editor
POST   /api/mcp/servers/{name}/auth/start    OAuth start (PKCE)
GET    /api/mcp/auth/callback                OAuth callback
POST   /api/mcp/servers/{name}/auth/signout  clear stored secret
```

---

## Key files

| Concern | File |
|---|---|
| Materializer + format emitters | `crates/fleetify-backend/src/services/mcp_dispatch.rs` |
| User registry (`~/.fleetify/mcp_servers.json`) | `crates/fleetify-backend/src/services/mcp_registry.rs` |
| OAuth token store | `crates/fleetify-backend/src/services/mcp_secrets.rs` |
| HTTP endpoints | `crates/fleetify-backend/src/routers/mcp.rs` |
| Built-in sidecars | `crates/{memory,dispatch,reveng,browser}-mcp/` |
| Per-bridge mounting | `crates/fleetify-backend/src/bridges/{claude,gemini,codex,antigravity,antigravity_sdk,opencode,cursor,hermes,github_copilot,kimi}.rs` |
| Sidecar drift guard | `npm run check:sidecars` (`scripts/build-sidecars.mjs --check`) |
