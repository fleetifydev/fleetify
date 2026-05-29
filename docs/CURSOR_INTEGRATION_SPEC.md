# Cursor CLI — Provider Integration Spec

Status: **Implemented** (Phase 1 core + Phase 2 extension UI) on
`feat/cursor-cli-acp`. Code-correctness gates green (`cargo test` +
`clippy -D warnings` + `fmt`; `tsc` + `eslint` 0 errors + `vitest` 271 passed).
E2E still pending a quota'd Cursor account (the probe account returns "Upgrade
your plan"); see §10/§11. Originated from a docs review (`cursor.com/docs/cli/overview`, `/acp`,
`/reference/parameters`, `/reference/authentication`, `/reference/configuration`),
an architecture review of Fleetify's provider system, and a **live
`cursor-agent acp` protocol probe** (Cursor Agent `2026.05.28-a70ca7c`,
Windows native install). See §11 for the shipped-vs-deferred breakdown.

## 1. Goal

Add **Cursor** as a new CLI agent provider (`ProviderKind::Cli`), so it
appears in Settings → Agents next to Claude Code / Codex / Gemini / Kimi /
OpenCode / GitHub Copilot, and can drive chat sessions — at **full OpenCode
parity** (streaming, cancel, permission dialog, MCP-over-ACP, session resume,
**live runtime-switchable models** sourced from Cursor's own session config),
plus **first-class UI for Cursor's blocking ACP extension methods**
(`cursor/ask_question` multiple-choice, `cursor/create_plan` plan approval).

## 2. Decision: integrate over ACP

Cursor's CLI (`cursor-agent`) exposes three programmatic surfaces:

| Surface | Command | Transport | Verdict |
| --- | --- | --- | --- |
| **ACP server** | `cursor-agent acp` | JSON-RPC 2.0 / nd-JSON over stdio | **Chosen.** |
| Non-interactive print | `cursor-agent -p --output-format stream-json` | one subprocess **per turn**, bespoke JSON | Rejected — bespoke parser, no live permission protocol. |
| SDK (TS/Python) | n/a | wraps the same engine | Rejected — extra runtime; ACP is the native integration path. |

**Why ACP:** Fleetify already ships a transport-agnostic ACP client
(`crates/fleetify-backend/src/bridges/acp.rs`) and three reference bridges
(`gemini.rs`, `opencode.rs`, `github_copilot.rs`). The live probe (§3) proved
Cursor's ACP surface is **near-identical to OpenCode's** — same rich
`session/new` body (`models` + `configOptions` + `modes`), same
`agent_message_chunk` shape, `loadSession`, and `available_commands_update`.
So the bridge is a near-verbatim copy of `OpenCodeBridge`; the existing
`translate_session_update` / `translate_acp_tool_call` / `pick_permission_option`
helpers map Cursor's events onto `BridgeEvent`s with minimal change, and the
existing permission dialog + MCP plumbing + model picker are reused as-is.

## 3. Protocol contract (empirically verified)

Captured from a live `cursor-agent acp` handshake against an authenticated
account (logged in via `cursor-agent login`), Windows, cwd = a scratch temp dir.

### Handshake

```
→ initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:false}, clientInfo:{name,version}}
← {protocolVersion:1,
   agentCapabilities:{loadSession:true,
                      mcpCapabilities:{http:true, sse:true},
                      promptCapabilities:{audio:false, embeddedContext:false, image:true},
                      sessionCapabilities:{list:{}}},
   authMethods:[{id:"cursor_login", name:"Cursor Login",
                 description:"Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."}]}
```

`protocolVersion: 1` matches Fleetify's hard-coded `acp.rs` value. ✅

### Session setup

```
→ session/new {cwd, mcpServers:[]}
← {sessionId:"bd5d1bc9-83de-4697-b691-745d68acec8a",          // UUID, resumable (loadSession:true)
   modes:{currentModeId:"agent",
          availableModes:[{id:"agent"},{id:"plan"},{id:"ask"}]},
   models:{currentModelId:"composer-2.5[fast=true]",
           availableModels:[{modelId:"default[]", name:"Auto"},
                            {modelId:"composer-2.5[fast=true]", name:"composer-2.5"},
                            {modelId:"claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]", name:"claude-opus-4-8"},
                            …27 total]},
   configOptions:[ {id:"mode",  category:"mode",  type:"select", currentValue:"agent", options:[agent|plan|ask]},
                   {id:"model", category:"model", type:"select", currentValue:"composer-2.5[fast=true]", options:[…27…]} ]}
```

**No `authenticate` call was made and `session/new` + `session/prompt` still
worked.** Cursor loads creds out-of-band from `cursor-agent login` (or
`CURSOR_API_KEY`); the advertised `cursor_login` auth method is skippable when
already logged in — exactly OpenCode's no-auth path.

**Model id format is opaque:** `name[k=v,...]` (e.g. `default[]` = Auto,
`claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]`). The
`name` field is the clean display label. Pass the `modelId`/`value` verbatim to
`set_config_option`; never parse the bracket params.

### Model / mode selection

The `configOptions` block is the **same shape OpenCode uses** for
`session/set_config_option {sessionId, configId, value}`. So model + mode are
applied identically to the OpenCode bridge (verify the live call during impl —
high confidence given the identical advertised shape; does not require quota).

### Prompt turn

```
→ session/prompt {sessionId, prompt:[{type:"text", text:"…"}]}
← session/update available_commands_update {availableCommands:[{name:"copy-request-id"},{name:"multi-model-review"}, …]}
← session/update agent_message_chunk       {content:{type:"text", text:"…"}}
← (response) {stopReason:"end_turn"}
```

Streaming `agent_message_chunk` shape is **identical to OpenCode** →
`translate_session_update` works nearly verbatim. (The probe account is out of
quota — the agent replied *"Upgrade your plan to continue"* — so a full
multi-event turn with `tool_call`/`usage_update` was not captured; those follow
the ACP spec + OpenCode's shapes. Real `usage`/cost capture is deferred until
quota is available.)

### Cursor extension methods (Cursor-specific, from docs `/cli/acp`)

Beyond standard ACP, Cursor sends extension methods over the same channel:

| Method | Type | Direction | Client must |
| --- | --- | --- | --- |
| `cursor/ask_question` | **Blocking request** | agent→client | return `{outcome:{outcome:"answered", answers:[{questionId, selectedOptionIds:[]}]}}` / `{outcome:"skipped"}` / `{outcome:"cancelled"}` |
| `cursor/create_plan` | **Blocking request** | agent→client | return `{outcome:{outcome:"accepted", planUri?}}` / `{outcome:"rejected", reason?}` / `{outcome:"cancelled"}` |
| `cursor/update_todos` | Notification | agent→client | (optional) display todos |
| `cursor/task` | Notification | agent→client | (optional) display subagent task |
| `cursor/generate_image` | Notification | agent→client | (optional) display image |

`cursor/ask_question` request: `{toolCallId, title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}`.
`cursor/create_plan` request: `{toolCallId, name?, overview?, plan(markdown), todos:[{id,content,status}], isProject?, phases?:[{name,todos}]}`.

**Critical:** if the client does not respond to the two blocking requests, the
agent stalls. Fleetify's shared `AcpClient` today answers only
`session/request_permission` + `fs/*` and returns `-32601` for anything else
→ it must be extended to dispatch arbitrary inbound methods (§5.1).

## 4. Event mapping → BridgeEvent

| Cursor `session/update` / inbound | Handled by `opencode.rs`? | BridgeEvent / action |
| --- | --- | --- |
| `agent_message_chunk` | ✅ | `MessageDelta` |
| `agent_thought_chunk` | ✅ | `Thinking` |
| `tool_call` / `tool_call_update` | ✅ (`translate_acp_tool_call`) | `ToolStart` / `ToolUpdate` / `ToolEnd` |
| `usage_update` + prompt `usage` | ✅ | `Cost` (verify Cursor's field names when quota allows) |
| `available_commands_update` | ✅ | `SlashCommands` |
| `current_mode_update` / `config_option_update` | ✅/partial | model/mode UI refresh |
| `session/request_permission` | ✅ | permission dialog round-trip |
| **`cursor/ask_question`** (inbound request) | ❌ **new** | `AskQuestion` → UI card → response |
| **`cursor/create_plan`** (inbound request) | ❌ **new** | `CreatePlan` → UI card → response |
| `cursor/update_todos` / `task` / `generate_image` | ❌ | log/ignore in v1 (optional UI later) |

## 5. Implementation plan (file-by-file)

### Backend (Rust)

**5.1 `bridges/acp.rs`** — extend the shared client with generic inbound
dispatch (additive, backward-compatible; benefits all ACP bridges):
- `Handlers` gains `generic: HashMap<String, RequestHandler>` and
  `generic_notify: HashMap<String, NotificationHandler>`.
- new `pub async fn on_request(&self, method: &str, h: RequestHandler)` and
  `on_notification(&self, method: &str, h: NotificationHandler)`.
- `handle_inbound_request`: after the known `session/request_permission` +
  `fs/*` arms, look up `generic[method]`; only fall to `-32601` if absent.
- `handle_inbound_notification`: after `session/update`, look up `generic_notify[method]`.
- +1 unit test (generic request handler invoked + result written back).

**5.2 `bridges/cursor.rs`** *(new)* — fork `opencode.rs`. Differences:
- spawn `cursor-agent acp` via a `resolve_cursor_bin()` helper (§6): try
  `which::which("cursor-agent")` → `which::which("agent")` → Windows
  `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` → Unix `~/.local/bin/{cursor-agent,agent}`.
  `current_dir(cwd)` with `strip_verbatim_prefix` (Windows `\\?\` guard).
- **skip `authenticate()`** (verified; creds load out-of-band). If `session/new`
  returns an auth error, emit `BridgeEvent::AuthRequired { provider:"cursor", … }`.
- after `session/new`: apply model via `session/set_config_option {configId:"model"}`
  (reuse `select_model_to_apply` + `parse_session_models`), then mode via
  `{configId:"mode"}` mapped from `permission_mode` (plan→`plan`, ask/read-only→`ask`,
  else `agent`).
- reuse `AcpClient`, `on_permission_request`, `on_fs_read`, `on_fs_write`,
  `translate_session_update`, `translate_acp_tool_call`, `pick_permission_option`,
  `models_to_json`, `ensure_stdio_env`, `tokens_*`, `cost_*` (copy into cursor.rs).
- register generic handlers for `cursor/ask_question` + `cursor/create_plan`
  (§5.4) and `on_notification` no-ops for `cursor/update_todos|task|generate_image`.
- MCP: `build_merged_map` → `to_acp_servers`; backfill `ensure_stdio_env` only if
  Cursor rejects env-less stdio entries (`-32602`) — verify live.
- `resume_session_id` → `session/load` (loadSession:true), fall back to `session/new`.

**5.3 `bridges/mod.rs`**
- `pub mod cursor;` (~`:19`); `pub mod interactive;` (~`:20`, §5.4).
- `Cursor(Arc<cursor::CursorBridge>)` variant in `AnyBridge` (~`:96`).
- arms in `send_message` (~`:117`) + `abort` (~`:133`) (required); `claude_session_id`
  (~`:150`, ACP sid for resume); `set_model` + `set_config` (~`:164`/`:178`, live model —
  copy the OpenCode arms, `cursor::models_to_json`).
- two new `BridgeEvent` variants + `to_json` (§5.4):
  `AskQuestion{ call_id, title, questions }` → `{type:"cursor_ask_question", id, title, questions}`;
  `CreatePlan{ call_id, name, overview, plan, todos, phases }` → `{type:"cursor_create_plan", id, …}`.

**5.4 `bridges/interactive.rs`** *(new)* — `InteractiveRequestSession`, a sibling
of `PermissionSession` but resolving with an arbitrary `serde_json::Value`
(not just `bool`):
- `pending: Mutex<HashMap<String, oneshot::Sender<Value>>>`.
- `make_ask_handler(send_payload)` / `make_plan_handler(send_payload)` → return
  `RequestHandler`s the bridge registers via `on_request`. Each parks a oneshot,
  ships the WS event (`cursor_ask_question` / `cursor_create_plan`), awaits the
  user's reply, maps it to the ACP `outcome` result.
- `resolve(req_id, Value)` (from the WS arms) + `fail_all_pending` (disconnect →
  `cancelled`).

**5.5 `providers/catalog.rs`**
- new `AuthIndicator::JsonFieldPresent { path, field }` variant (satisfied when
  the JSON file has `field` set to a non-null value) + its evaluation in
  `routers/providers.rs` (where `AuthIndicator` is checked in `scan_all_agents`).
- `CURSOR_CLI_INDICATORS = &[ JsonFieldPresent { path:".cursor/cli-config.json", field:"authInfo" }, EnvVar { name:"CURSOR_API_KEY" } ]`.
- `ProviderSpec` near the OpenCode entry (~`:1162`):
  ```rust
  ProviderSpec {
      id: "cursor",
      display_name: "Cursor CLI",
      kind: ProviderKind::Cli,
      default_base_url: "",
      auth: AuthSpec::None,
      default_models: &[],                 // live from the ACP session
      extras: ProviderExtras::DEFAULT,
      bin: "cursor-agent",
      auth_indicators: CURSOR_CLI_INDICATORS,
      install_hint: "",
      install_hints: Some(InstallHints {
          windows: "irm 'https://cursor.com/install?win32=true' | iex",
          macos:   "curl https://cursor.com/install -fsS | bash",
          linux:   "curl https://cursor.com/install -fsS | bash",
      }),
      login_hint: "cursor-agent login",
  }
  ```
- bump `catalog_has_expected_split` `assert_eq!(cli, 8 …)` → `9` (~`:1287`) + comment.

**5.6 `routers/chat.rs`**
- `"cursor" => { … CursorBridge::new(…); b.resume_session_id = session.claude_session_id.clone(); with_permission_handler(…); AnyBridge::Cursor(Arc::new(b)) }` at **both** dispatch sites: live chat (~`:1081`, mirror the OpenCode block incl. the permission-handler gate) and dispatched-task (~`:2284`).
- two WS arms next to `permission_response` (~`:335`): `cursor_question_response` and
  `cursor_plan_response` → `InteractiveRequestSession::resolve`. On disconnect call
  `fail_all_pending` (alongside the existing `PermissionSession::fail_all_pending`).

**5.7 `routers/providers.rs`**
- `ScanProbe::CursorCli` variant: `which(cursor-agent|agent)` OR install-dir check
  (Windows `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd`, Unix `~/.local/bin/{cursor-agent,agent}`)
  — **required because the Windows installer does NOT put the binary on PATH** (verified).
- `scan_probe_for("cursor") => ScanProbe::CursorCli`.
- add `("cursor", ScanProbe::CursorCli) => {}` to the exhaustive
  `scan_probe_for_id_returns_bin_only_for_legacy_clis` test (~`:854`) — it panics on
  unmapped ids (the single most likely missed step).

### Frontend (TS/React)

Catalog-driven, so the Settings tile + agent card + composer picker render
automatically (using the already-present `CursorLogo`). Required edits:

**5.8 `src/types/session.ts`** — add `| "cursor"` to the `AgentTool` union.

**5.9 `src/components/chat/session-toolbar.tsx`** — live-model agent, so broaden
the three hardcoded `"opencode"` gates (~`:367`/`:668`/`:675`) and the
`dynamicCliModels` builder key (~`:366`) to include `"cursor"` (so model/mode
switches call `switchModel`/`switchConfig`, not just PATCH the session).

**5.10 `src/lib/picker-groups.ts`** — add `cursor: "Cursor CLI"` to
`CLI_FALLBACK_LABELS` (blank-rail fallback; models arrive live so `CLI_MODELS`
is optional). Update the explicit-id expectations in `picker-groups.test.ts`.

**5.11 Cursor extension UI** — `src/services/ws-manager.ts` + `src/stores/chat-store.ts`
+ `src/types/chat.ts`: store `cursor_ask_question` / `cursor_create_plan` events
per session + add `sendQuestionResponse` / `sendPlanResponse`. Two new renderer
cards modeled on the existing permission dialog + plan-mode cards: a
**multiple-choice question card** (honors `allowMultiple`) and a **plan-approval
card** (markdown + todos/phases + Accept/Reject).

**5.12 `src/components/ui/__tests__/provider-logo.test.tsx`** — add a Cursor
icon assertion. (Do NOT touch `provider-logo.tsx` — `CursorLogo` + `case "cursor"`
+ `providerName.cursor` already exist; re-adding is a TS/lint error.)

## 6. Auth & binary detection

- **Auth indicator (verified):** `~/.cursor/cli-config.json` gains an `authInfo`
  object (email/userId/authId) **only while logged in** — it is removed on
  `cursor-agent logout`. The file itself persists when logged out, so plain
  `HomeDir` existence is a false positive → use `JsonFieldPresent { field:"authInfo" }`.
  Plus `EnvVar { CURSOR_API_KEY }` for headless/CI. `login_hint:"cursor-agent login"`.
- **Binary (verified, Windows):** installed at
  `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` (Node-based: `cursor-agent-svc.js`
  + bundled `node.exe`), also `agent.cmd`. **NOT on PATH** after install, so the
  default `BinOnly { bin }` probe fails → `ScanProbe::CursorCli` (§5.7). The bridge's
  `resolve_cursor_bin()` mirrors the same resolution order.

## 7. Model selection design

ACP gives live model state per session — no catalog duplication (identical to
OpenCode):

```
session/new ─→ configOptions[model].options  (+ models.availableModels)   ── the list (27 models)
session/set_config_option {configId:"model", value} ──────────────────────── the switch
session/update config_option_update ──────────────────────────────────────── agent-side change
```

- Cold start: apply `session.model_name` (if set + present in `availableModels`)
  via `set_config_option`; else keep Cursor's `currentModelId`.
- Live switch: `BridgeEvent::AvailableModels` after `Init` → renderer composer
  dropdown → `model_switch` WS command → `AnyBridge::set_model` →
  `set_config_option`. (All inherited from the OpenCode template.)
- `default_models: &[]` in the catalog; the picker keys off the live list.

## 8. Mode mapping

Cursor modes `agent`/`plan`/`ask` (advertised in `session/new.modes` +
`configOptions[mode]`). Map Fleetify `permission_mode`:
`plan` → `plan`; ask/read-only → `ask`; `default`/`acceptEdits`/`bypassPermissions`
→ `agent` (default). Apply via `set_config_option {configId:"mode"}` at cold
start (mirrors `permission_mode_to_session_mode`).

## 9. Open questions / risks

- **`session/set_config_option` live call** — advertised in the same shape as
  OpenCode; verify the actual model/mode switch round-trip during impl (does not
  require quota).
- **stdio MCP `env`** — Cursor advertises `mcpCapabilities:{http,sse}` plus the
  stdio baseline; verify whether env-less stdio entries are rejected (`-32602`,
  like OpenCode) → backfill via `ensure_stdio_env` if so.
- **usage/cost shape** — not captured (account out of quota). Confirm field names
  for the `Cost` mapping on a quota'd account; fall back to OpenCode's helper shapes.
- **`cursor/ask_question` / `cursor/create_plan` live payloads** — schemas from
  docs; trigger them with a planning prompt to confirm exact field casing when quota allows.
- **Account quota** — the probe account returns *"Upgrade your plan to continue"*;
  end-to-end model generation needs a plan with available usage. The integration
  itself is unaffected; this will be called out in the PR if still unresolved.
- **Windows `cursor-agent.cmd` spawn** — `which`/`Command` must resolve a `.cmd`
  (PATHEXT). The bridge resolves an absolute path to the `.cmd` so this is moot.

## 10. Test plan

- **Unit (Rust):** copied pure helpers (`parse_session_models`,
  `translate_acp_tool_call`, `pick_permission_option`, `tokens_*`, `cost_*`,
  `models_to_json`, `ensure_stdio_env`); `resolve_cursor_bin` order;
  `JsonFieldPresent` evaluation (present/absent/null); `InteractiveRequestSession`
  round-trip + `fail_all_pending`; catalog count test (9); `scan_probe_for`
  `CursorCli` test arm; `acp.rs` generic-handler duplex test.
- **Frontend:** `provider-logo.test.tsx` (cursor), `picker-groups.test.ts`.
- **Gates (CLAUDE.md):** `cargo fmt --check`, `cargo clippy --workspace -D warnings`,
  `cargo test --workspace`, `npm run lint`, `npm test`, `tsc -b`, sidecar drift guard.
- **E2E (`npm run dev:tauri:wt` + agent-browser):** Settings → Agents "Cursor CLI"
  tile detected (binary off-PATH) + "Logged in" pill (gone after logout); start a
  Cursor session; live model picker (27 models) + switch; permission dialog;
  `cursor/create_plan` + `cursor/ask_question` cards; session resume; cancel.
  *(Real model turns require quota — noted in the PR if blocked.)*

## 11. Phasing — shipped vs deferred

**Phase 1 (core) — SHIPPED:** `bridges/cursor.rs` over ACP; `acp.rs` generic
handlers; catalog entry + `JsonFieldPresent` indicator; `CursorCli` scan probe;
dispatch at both sites; `AnyBridge` variant + arms; auth-skip; selected/default
model + mode via `set_config_option`; streaming + `Cost` + `SlashCommands`;
permission dialog; MCP-over-ACP; session resume; live model switching. Logo
already present.

**Phase 2 (Cursor extension UI) — SHIPPED:** `InteractiveRequestSession`; the
`cursor/ask_question` + `cursor/create_plan` blocking methods are answered via
the shared `AcpClient` generic `on_request` hook and routed to the renderer
through `build_cursor_question_handler` / `build_cursor_plan_handler` + the
`cursor_*_response` WS arms; renderer `CursorQuestionCard` (multiple-choice,
single/`allowMultiple`) + `CursorPlanCard` (markdown plan + todos/phases +
Accept/Reject). (Routed via the permission-style WS round-trip rather than new
`BridgeEvent` variants — simpler, consistent with the existing permission flow.)

**Deferred:** `cursor/update_todos|task|generate_image` rich UI (handled via
`on_notification` as no-ops in v1); intelligent-routing `AgentKind::Cursor`;
image inputs; Max Mode / sandbox toggles.

**E2E status:** NOT yet run via `dev:tauri:wt`. The probe account is out of
quota ("Upgrade your plan to continue"), so a real model turn — and thus the
streaming / live-card walkthrough — could not be exercised end to end. All
protocol/plumbing paths are verified by the handshake probe + unit tests; the PR
states this honestly (per CLAUDE.md — no faked E2E pass).

## Appendix — branch

Implementation lands on `feat/cursor-cli-acp` in its own worktree
(`.claude/worktrees/cursor-cli-acp`) per the repo workflow; PR title
`feat(providers): add Cursor CLI agent over ACP`.
