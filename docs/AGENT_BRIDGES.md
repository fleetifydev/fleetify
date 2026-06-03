# Agent Bridges & the WebSocket Protocol

How a chat turn flows from the renderer, through a **bridge** (the adapter for one
provider/transport), back to the UI as a stream of events.

> Related: [`PROVIDER_ARCHITECTURE.md`](PROVIDER_ARCHITECTURE.md) (how a bridge is
> *selected*), [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md), [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md).

---

## 1. The bridge abstraction

A **bridge** owns the transport to one provider and exposes a uniform contract:

```rust
async fn send_message(&self, msg: &str, ctx: BridgeContext) -> Result<mpsc::Receiver<BridgeEvent>>;
async fn abort(&self);
```

`send_message` returns a **stream of `BridgeEvent`s**; the chat router forwards
each one to the renderer over WebSocket. Every concrete bridge is a variant of
`AnyBridge` (`crates/fleetify-backend/src/bridges/mod.rs`):

| Variant | Provider(s) | Transport family |
|---|---|---|
| `Claude` | claude | subprocess `claude --output-format stream-json` |
| `Gemini` | gemini | **ACP** (`gemini --acp`) |
| `Codex` | codex | `codex app-server` (JSON-RPC over stdio) |
| `OpenCode` | opencode | **ACP** (`opencode acp`) |
| `Cursor` | cursor | **ACP** (`cursor-agent acp`) + `cursor/*` extensions |
| `Hermes` | hermes | **ACP** (`hermes acp`) |
| `GitHubCopilot` | github-copilot | **ACP** (`copilot --acp`) |
| `Antigravity` | agy | PTY `agy -p` (headless one-shot) |
| `AntigravitySdk` | antigravity-sdk | Python sidecar (NDJSON over stdout) |
| `OpenAICompat` | ollama | HTTP `/chat/completions` SSE (single-shot) |
| `Agentic` | openai / deepseek / grok / nvidia-nim / kimi-api / gemini-api / openrouter / cloudflare-workers-ai | HTTP-compat wrapped in a tool-use loop |
| `Perplexity` | perplexity | HTTP SSE + citation/search parsing |
| `Kimi` | kimi | HTTP-compat |
| `OpenAI` | — | retired (test-only) |

`BridgeContext { base_url_override, extra_headers, model_override }` carries
per-message overrides from the routing layer and the model picker.

---

## 2. `BridgeEvent` → WebSocket

Bridges emit `BridgeEvent`s; `BridgeEvent::to_json()` (`bridges/mod.rs`) serializes
each to the WS message the renderer consumes. The chat router injects `session_id`
and writes it to the socket.

| `BridgeEvent` | WS `type` | Notes |
|---|---|---|
| `Status` | `status` | `running` / `done` (`done` ends the stream) |
| `Init` | `init` | session id, model, tools_count |
| `MessageDelta` | `message_delta` | streamed assistant text |
| `Thinking` | `thinking` | reasoning chunk |
| `ToolStart` / `ToolUpdate` / `ToolEnd` | `tool_start` / `tool_update` / `tool_end` | tool-use lifecycle |
| `Cost` | `cost` | `usage`, `cost_usd`, `model` |
| `AvailableModels` | `available_models_update` | `{ models:[{id,label}], current_model }` — see [`MODEL_DISCOVERY.md`](MODEL_DISCOVERY.md) |
| `SlashCommands` | `slash_commands_update` | agent's available `/commands` |
| `PermissionRequest` | `permission_request` | tool approval (CLI-MCP path) |
| `Citation` / `SearchResult` | `citation` / `search_result` | Perplexity |
| `CompactBoundary` | `compact_boundary` | context-compaction marker |
| `AuthRequired` | `auth_required` | intercepted by the router to open the OS browser |
| `Error` | `error` | surfaced to the user (now includes ACP `error.data.details`) |

---

## 3. The WebSocket protocol

One multiplexed socket (`src/services/ws-manager.ts`) carries all sessions.

**Outbound (renderer → backend):**

| `type` | Shape |
|---|---|
| `send` | `{ session_id, message, images? }` |
| `enhance_prompt` | `send` with `[fleet:enhance-prompt]` prefix |
| `permission_response` | `{ session_id, id, approved, always, tool_name }` |
| `model_switch` | `{ session_id, model }` |
| `config_switch` | `{ session_id, config_id, value }` (effort/mode for ACP agents) |
| `auth_code` | `{ session_id, code }` |
| `abort` | `{ session_id }` |
| `cursor_question_response` / `cursor_plan_response` | Cursor extension replies |
| `subscribe` / `unsubscribe` | `{ session_ids }` multiplex management |

**Inbound (backend → renderer):** the `BridgeEvent` set above, plus the
**dispatch** family for Fleet's agent-to-agent protocol (`dispatch_ack`,
`dispatch_incoming`, `dispatch_stream`, `dispatch_progress`, `dispatch_result`),
the **subagent** family (`subagent_start/progress/end`), and Cursor's
`cursor_ask_question` / `cursor_create_plan`. Full union: `src/types/chat.ts`.

The renderer buffers `message_delta`/`thinking` on `requestAnimationFrame` (vsync,
hard-capped per buffer) and finalizes the message on `status: done`.

---

## 4. Transport families

### ACP (`bridges/acp.rs` — shared `AcpClient`)

Gemini, OpenCode, Cursor, GitHub Copilot, and **Hermes** all speak the
[Agent Client Protocol](https://agentclientprotocol.com): JSON-RPC 2.0 over
line-delimited stdio. `AcpClient` is transport-agnostic:

- `attach(reader, writer)` starts a read loop that routes responses to pending
  calls and notifications (`session/update`) / inbound requests
  (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`) to
  handlers.
- Typical flow: `initialize` → `session/new` (or `session/load` to resume) →
  `session/prompt`; model switching via `session/set_model` /
  `session/set_config_option`; cancel via `session/cancel`.
- `session/new` returns the agent's offered model list (`models.availableModels`),
  which the bridge re-emits as `AvailableModels`.
- Errors carry an `error.data.details` field that the client now surfaces (so
  "Internal error" becomes the agent's actionable message).

Cursor adds blocking extension requests (`cursor/ask_question`,
`cursor/create_plan`) handled via the generic-request mechanism.

### Other transports

- **Claude** (`bridges/claude.rs`) — spawns `claude --output-format stream-json`;
  parses each NDJSON event into `BridgeEvent`s. Resume via `--resume <id>`
  (swapped to `--continue` if the id was orphaned). Permission via the
  `fleet-permission-mcp` `--permission-prompt-tool`.
- **Codex** (`bridges/codex.rs` + `codex_client.rs`) — `codex app-server`, a
  JSON-RPC 2.0 stdio server.
- **HTTP-compat** (`bridges/openai_compat.rs`) — POST `/chat/completions` with SSE
  streaming; per-provider base URL/headers/models from the catalog. Perplexity
  extends it to emit `citation`/`search_result`.
- **Agentic runner** (`bridges/agentic_runner.rs`) — wraps an HTTP-compat provider
  in a real tool-use loop (`drive_agentic_loop`), translating `TurnEvent`s to
  `BridgeEvent`s and gating tool use through an interactive permission prompt.
  This is why HTTP API providers can use tools, not just chat.
- **Antigravity CLI** (`bridges/antigravity.rs`) — drives `agy -p` over a PTY
  (`portable_pty`), one-shot per turn; resumes via `--conversation <uuid>`.
- **Antigravity SDK** (`bridges/antigravity_sdk.rs`) — spawns a Python sidecar
  that emits NDJSON events; one process per turn; model set via
  `LocalAgentConfig(model=…)`.

---

## 5. Permissions

Dangerous tool calls route back to the renderer for approval; on timeout/error
the default is **deny**.

- **Claude** — the CLI calls `fleet-permission-mcp`, which POSTs
  `/api/internal/permission_prompt`; the backend's `PermissionSession`
  (`bridges/permission.rs`) awaits the user's click (a `oneshot`) and replies.
- **ACP bridges** — `session/request_permission` is answered by the bridge's
  permission handler (matched by option `kind`: `allow_once` / `reject_once` /
  …).
- **Agentic runner** — an in-loop `InteractiveGate` awaits
  `/api/chat/permission_response` (5-minute timeout).

Bypass modes (`bypassPermissions` / `dontAsk`) auto-allow; staff sessions skip
the dialog (they only call read-only tools).

---

## 6. Session resume

The previous ACP/Claude session id is persisted as `session.claude_session_id`
(populated from the prior turn's `Init`). On the next turn the bridge resumes:
Claude `--resume`, ACP `session/load` (falling back to `session/new`), Antigravity
`--conversation`.

---

## Key files

| Concern | File |
|---|---|
| Bridge enum + events + serialization | `crates/fleetify-backend/src/bridges/mod.rs` |
| Shared ACP transport | `crates/fleetify-backend/src/bridges/acp.rs` |
| Per-provider bridges | `crates/fleetify-backend/src/bridges/*.rs` |
| Permission gate | `crates/fleetify-backend/src/bridges/permission.rs` |
| Dispatch + WS forwarding | `crates/fleetify-backend/src/routers/chat.rs` |
| WS client (renderer) | `src/services/ws-manager.ts` |
| WS message types | `src/types/chat.ts` |
