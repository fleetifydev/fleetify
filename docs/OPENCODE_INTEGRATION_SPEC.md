# OpenCode CLI — Provider Integration Spec

Status: **Implemented** (Phase 1 + live model switching) on
`feat/opencode-provider`. Originated from a docs review
(`opencode.ai/docs/cli`, `/docs/acp`), an architecture review of Fleetify's
provider system, and a **live `opencode acp` protocol probe** (OpenCode
`1.15.11`, Windows). See §10 for the shipped-vs-deferred breakdown.

## 1. Goal

Add **OpenCode** as a new CLI agent provider (`ProviderKind::Cli`), so it
appears in Settings → Agents next to Claude Code / Codex / Gemini / Kimi,
and can drive chat sessions — with **user-selectable, runtime-switchable
models sourced from OpenCode's own session config**.

## 2. Decision: integrate over ACP

OpenCode exposes three programmatic surfaces:

| Surface | Command | Transport | Verdict |
| --- | --- | --- | --- |
| **ACP server** | `opencode acp` | JSON-RPC 2.0 / nd-JSON over stdio | **Chosen.** |
| Non-interactive run | `opencode run --format json` | one subprocess **per turn**, JSON to stdout | Rejected — no live permission protocol; new parser. |
| Headless HTTP | `opencode serve` / `web` | bespoke HTTP + SSE | Rejected — long-lived server + port mgmt + new client. |

**Why ACP:** Fleetify already ships a transport-agnostic ACP client
(`crates/fleetify-backend/src/bridges/acp.rs`, *"reusable for any future ACP
agent"*) and a working reference bridge that drives `gemini --acp`
(`bridges/gemini.rs`). OpenCode speaks the **same** Agent Client Protocol, so
the bulk of the bridge is a copy of `GeminiBridge`, and the existing
`translate_session_update` / `translate_acp_tool_call` helpers already map
OpenCode's `session/update` events onto `BridgeEvent`s. It also reuses the
existing permission dialog, MCP plumbing, and Process Viewer.

## 3. Protocol contract (empirically verified)

Captured from a live `opencode acp` handshake + prompt turn against a free
`opencode/*` model with **zero credentials**.

### Handshake

```
→ initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile,writeTextFile}}}
← {protocolVersion:1,
   agentCapabilities:{loadSession:true,
                      mcpCapabilities:{http:true, sse:true},        // NB: no stdio
                      promptCapabilities:{embeddedContext:true, image:true},
                      sessionCapabilities:{close,fork,list,resume}},
   authMethods:[{id:"opencode-login", name:"Login with opencode",
                 description:"Run `opencode auth login` in the terminal"}],
   agentInfo:{name:"OpenCode", version:"1.15.11"}}
```

`protocolVersion: 1` matches Fleetify's hard-coded `acp.rs` value. ✅

### Session setup

```
→ session/new {cwd, mcpServers:[]}
← {sessionId:"ses_…",
   configOptions:[ {id:"model", category:"model", type:"select",
                    currentValue:"opencode/big-pickle",
                    options:[{value:"opencode/big-pickle", name:"OpenCode Zen/Big Pickle"}, …]},
                   {id:"mode", category:"mode", type:"select",
                    currentValue:"build", options:[{value:"build"},{value:"plan"}]} ],
   models:{currentModelId:"opencode/big-pickle",
           availableModels:[{modelId:"opencode/big-pickle", name:"…"}, …]}}
```

**No `authenticate` call was made and `session/new` + `session/prompt` still
worked.** OpenCode loads provider creds out-of-band from
`~/.local/share/opencode/auth.json`; free `opencode/*` models need none.

### Model selection (the key requirement)

```
→ session/set_config_option {sessionId, configId:"model", value:"opencode/deepseek-v4-flash-free"}
← {configOptions:[ {id:"model", …, currentValue:"opencode/deepseek-v4-flash-free", options:[…]},
                   {id:"mode", …},
                   {id:"effort", …} ]}                              // dependent option appeared
```

Runtime model switching **is supported** (unlike the Gemini bridge, which
documents model override as a Day-1 limitation). The response always returns
the *complete* config state, and switching a model can reveal dependent
options (here, an `effort` / reasoning-level selector).

### Prompt turn

```
→ session/prompt {sessionId, prompt:[{type:"text", text:"…"}]}
← session/update agent_thought_chunk   {content:{type:text,text:"…"}}      → Thinking
← session/update agent_message_chunk   {content:{type:text,text:"…"}}      → MessageDelta
← session/update usage_update          {used:12695, size:200000, cost:{amount:0, currency:"USD"}}
← session/update available_commands_update {availableCommands:[{name:"init"}, …]}
← (response) {stopReason:"end_turn",
              usage:{totalTokens:12713, inputTokens:12695, outputTokens:3, thoughtTokens:15}, _meta:{}}
```

Also defined by the ACP spec (not all seen in this minimal turn):
`tool_call`, `tool_call_update` (status `pending`→`in_progress`→`completed`/`failed`),
`plan`, `current_mode_update`, `config_option_update`; inbound
`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`;
`session/cancel` notification.

## 4. Event mapping → BridgeEvent

| OpenCode `session/update` | Already handled by `gemini.rs`? | BridgeEvent |
| --- | --- | --- |
| `agent_message_chunk` | ✅ | `MessageDelta` |
| `agent_thought_chunk` | ✅ | `Thinking` |
| `tool_call` | ✅ (`translate_acp_tool_call`) | `ToolStart` |
| `tool_call_update` | ✅ | `ToolUpdate` / `ToolEnd` |
| `usage_update` | ❌ **different shape** | `Cost` (new mapping) |
| `available_commands_update` | ❌ (ignored `_=>{}`) | — (optional: surface slash commands later) |
| `config_option_update` | ❌ | model/effort UI refresh (Phase 2) |
| `plan`, `current_mode_update` | ❌ (ignored) | — (optional) |

The prompt-response `usage` (`totalTokens/inputTokens/outputTokens/thoughtTokens`)
plus `usage_update.cost.amount` give a ready cost figure — prefer OpenCode's
own `cost.amount` over recomputing via `services::pricing`.

## 5. Implementation plan (file-by-file)

### Backend (Rust)

1. **`crates/fleetify-backend/src/bridges/opencode.rs`** *(new)* — fork
   `gemini.rs`. Differences:
   - spawn `opencode acp` (resolve via `which::which("opencode")`), pipe
     stdin/stdout/stderr, `current_dir(cwd)` with `strip_verbatim_prefix`
     (same Windows `\\?\` guard as Gemini).
   - **skip `authenticate()`** entirely (free models work; paid creds load
     from `auth.json`).
   - after `session/new`, if a model is selected call
     `session/set_config_option {configId:"model", value}`; optionally
     `{configId:"effort", value}` when the session carries an effort level.
   - reuse `AcpClient`, `on_permission_request`, `on_fs_read`,
     `on_fs_write`, and most of `translate_session_update`; add a
     `usage_update` arm + fold the prompt-response `usage`.
   - map `permission_mode` → config: `plan` → set mode `plan`; default →
     mode `build` + live permission handler.
2. **`bridges/mod.rs`** — `pub mod opencode;` (`:6`); add
   `OpenCode(Arc<opencode::OpenCodeBridge>)` to `AnyBridge` (`:51`) + arms in
   `send_message` (`:96`) and `abort` (`:109`).
3. **`providers/catalog.rs`** — add `OPENCODE_INDICATORS` near `:736`
   (see §6 re: auth signal) and a `ProviderSpec` near `:1039`:
   ```rust
   ProviderSpec {
       id: "opencode",
       display_name: "OpenCode",
       kind: ProviderKind::Cli,
       default_base_url: "",
       auth: AuthSpec::None,
       default_models: &[],            // models come from the live ACP session
       extras: ProviderExtras::DEFAULT,
       bin: "opencode",
       auth_indicators: OPENCODE_INDICATORS,
       install_hint: "npm install -g opencode-ai",   // verify exact package name
       install_hints: None,
       login_hint: "opencode auth login",
   }
   ```
4. **`routers/chat.rs`** — add `"opencode" => …` arms at **both** dispatch
   sites: live chat (`:916`-area, mirror the Gemini block incl. the
   `permission_mode == "default"` handler gate) and dispatched-task
   (`:2079`-area).
5. **`routers/providers.rs`** — no probe change (`BinOnly { bin: "opencode" }`
   is the default); update the `scan_probe_for` unit test (`:823`) to include
   `("opencode", BinOnly { bin: "opencode" })`.

### Frontend (TS/React)

Catalog-driven, so the Settings tile, agent card, and config hooks render
automatically. Only:

6. **`src/components/ui/provider-logo.tsx`** — add an `"opencode"` icon case.
7. **Model picker (Phase 2):** today CLI agents carry `default_models: &[]`
   and the picker keys off the catalog. To expose OpenCode's *live* model
   list + switching, surface `configOptions`/`models` from the bridge to the
   renderer (see §7). Phase 1 can ship with OpenCode's configured default
   model and no in-app switcher.

## 6. Auth detection caveat

`auth.json` exists only after `opencode auth login`, **but free `opencode/*`
models run with zero credentials.** So `AuthIndicator::HomeDir { path:
".local/share/opencode/auth.json" }` correctly reports "logged in to a paid
provider" but will show "Login required" for a user happily using free
models. Options:
- (a) accept it — the pill is advisory; the agent still works. Pair with a
  `login_hint` that says login is only needed for paid providers.
- (b) treat "binary present" as sufficient for OpenCode (custom probe), since
  free models always work.

Recommendation: **(a)** for Phase 1; revisit copy in the AgentCard.

## 7. Model selection design (satisfies "pick & switch among OpenCode models")

ACP gives us live model state per session — no catalog duplication:

```
session/new ─→ configOptions[model].options  (+ models.availableModels)   ── the list
session/set_config_option {configId:"model", value} ──────────────────────── the switch
session/update config_option_update ──────────────────────────────────────── agent-side change
```

- **Phase 1:** bridge reads the selected model from `session.model_name`
  (if set and present in `availableModels`) and applies it via
  `set_config_option` right after `session/new`. Falls back to OpenCode's
  default (`currentModelId`) otherwise.
- **Phase 2:** add a `BridgeEvent` (or reuse `Init` metadata) carrying
  `availableModels` + `currentModelId` so the renderer can render a live
  OpenCode model dropdown in the composer and POST a switch that calls
  `set_config_option` mid-session. The `effort` config option wires into
  Fleetify's existing effort column the same way.

## 8. Open questions / risks

- **MCP transport.** OpenCode advertises `mcpCapabilities: {http, sse}` —
  **no stdio.** Fleetify's built-in MCPs (`fleet_memory`, `fleet_dispatch`,
  `fleet_reveng`) are stdio. Verify whether `to_acp_servers()` output is
  accepted; if not, Phase 1 ships with `mcpServers: []` (same as Gemini's
  Phase-2 cut) and stdio→ACP MCP bridging is deferred.
- **`install_hint` package name** — confirm `opencode-ai` vs `opencode` on
  npm (and that the bun/curl installer path is acceptable; current dev box
  has it under `~/.bun/bin/opencode`).
- **`session/new` latency** — observed an occasional multi-second hang on
  `session/new` (model/network refresh). Keep `INIT_TIMEOUT_SECS` generous;
  consider `OPENCODE_DISABLE_MODELS_FETCH` only if it proves flaky (it
  shrinks the model list, so not for prod).
- **Windows data dir** — confirmed `~\.local\share\opencode\` is used on
  Windows (XDG-style), so `HomeDir` indicator resolves under `USERPROFILE`.
- **`.claude/` auto-read** — OpenCode reads `~/.claude/CLAUDE.md` + skills by
  default (`OPENCODE_DISABLE_CLAUDE_CODE*` to disable). Harmless; note it.

## 9. Test plan

- **Unit (Rust):** mirror `gemini.rs` tests — `approval_mode` mapping,
  `usage_update` → Cost mapping, `set_config_option` payload shape; plus the
  `acp.rs` duplex smoke test pattern for the OpenCode handshake. Update the
  `scan_probe_for` test.
- **Gates:** `cargo fmt --check`, `cargo clippy --workspace -D warnings`,
  `cargo test --workspace`, `npm run lint`, `npm test`, `tsc -b`.
- **E2E (per CLAUDE.md):** `npm run dev:tauri:wt`, drive an OpenCode turn via
  agent-browser — confirm streaming text, thinking, a tool call card,
  permission dialog, and a model switch. This is the only way to validate the
  auth-skip + model-switch behaviour end to end.

## 10. Phasing — shipped vs deferred

**Shipped (Phase 1):** `bridges/opencode.rs` over ACP; catalog entry +
auth indicator; dispatch at both sites; `AnyBridge` variant; logo (already
present); auth-skip; selected/default model + mode + effort applied via
`set_config_option` at cold start; `usage_update`→`Cost`; empty MCP list;
permission dialog wired (option picked by `kind`). Unit-tested helpers;
backend `cargo test` + `clippy -D warnings` green.

**Shipped (Phase 2 — live model switching):** `BridgeEvent::AvailableModels`
pushes OpenCode's runtime model list + current model to the renderer right
after `Init`; `AnyBridge::set_model` → `session/set_config_option`; WS
`model_switch` command; renderer stores the per-session catalog
(`chat-store.dynamicModels`), `buildPickerGroups` renders the live list, and
the toolbar PATCHes `model_name` + sends `model_switch`. `tsc` + `eslint`
(0 errors) + `vitest` green.

**Shipped (Phase 2 — remaining items):**
- **MCP-over-ACP** — the merged MCP map attaches over ACP **stdio** (the
  mandatory baseline transport; OpenCode's `mcpCapabilities:{http,sse}` only
  advertises the *extra* transports it also supports). `to_acp_servers` emits
  the right shape; `ensure_stdio_env` backfills the `env` field OpenCode
  requires on stdio entries — verified that omitting it returns `-32602`. **No
  http/sse shim needed** (the earlier assumption was wrong).
- **Session resume** — `Init` stamps the ACP session id into
  `session.claude_session_id`; both dispatch sites pass it back as
  `resume_session_id`, and cold start calls `session/load` (falling back to
  `session/new` on failure).
- **Live effort switch** — generic `OpenCodeBridge::set_config` +
  `AnyBridge::set_config` + a `config_switch` WS command; the toolbar applies
  effort to the running session via `wsManager.switchConfig`.
- **Slash commands** — `BridgeEvent::SlashCommands` carries OpenCode's
  `available_commands_update` to the renderer; ws-manager stores them
  (`chat-store.dynamicCommands`) and the composer merges them into its slash
  menu.

**Still deferred:** image inputs.

**E2E not yet run.** Per CLAUDE.md, code-correctness gates pass (backend
`cargo test` + `clippy -D warnings`; renderer `tsc` + `eslint` 0 errors +
`vitest`) but feature correctness still needs a `npm run dev:tauri:wt`
walkthrough driving an OpenCode turn + model/effort switch + a slash command.

## Appendix — branch

Implementation lands on `feat/opencode-provider` in its own worktree
(`.claude/worktrees/opencode-provider`) per the repo workflow; PR title
`feat(providers): add OpenCode CLI agent over ACP`.
