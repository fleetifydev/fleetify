# Permissions

How Fleetify exposes each provider's **native permission surface** — the modes shown in the
composer/toolbar permission picker, the optional sandbox axis, and the per-tool allow/deny
matrix — plus exactly which provider offers which.

Everything here is driven by the single lookup in
[`crates/fleetify-backend/src/providers/capabilities.rs`](../crates/fleetify-backend/src/providers/capabilities.rs)
(`permission_capability`, `tool_matrix`, `config_timing`), served to the renderer over the
`providers_list_catalog` IPC as `ProviderTile.capabilities`, and consumed by each bridge at
spawn/turn time. See [`EFFORTS.md`](EFFORTS.md) for the sibling effort system and
[`PROVIDERS.md`](PROVIDERS.md) for the provider list.

> **Each provider exposes its OWN native modes**, verbatim. Copilot shows `ask`/`autopilot`,
> Codex shows approval *tiers*, OpenCode shows `build`/`plan` — not one Claude-style list for
> everyone. A provider's stored `permission_mode` is one of *its* ids; bridges also still
> accept the legacy Fleet-canonical ids for backward compatibility.

---

## Permission families

A provider's permission surface is one of three shapes:

| Family | Shape | Used by |
|---|---|---|
| **Modes** | a single mode enum, optionally with an independent **sandbox** toggle | Claude, Cursor, Copilot, OpenCode, Kimi, Grok Build, Hermes, Antigravity, the HTTP providers |
| **ApprovalSandbox** | two orthogonal axes — *approval policy* × *sandbox tier* (a true cross-product) | Codex only |
| **None** | no tool-authorization concept | Perplexity |

Two overlays sit on top of the family:

- **Sandbox axis** — an OS-sandbox control independent of the mode. Antigravity
  carries an `off`/`on` toggle; Codex's sandbox is one of its two axes (below).
- **Tool matrix** — a per-tool allow/ask/deny override for the agents that support one
  (OpenCode, Cursor, Copilot, Kimi). Edited via the composer's **Tools** button → persisted to
  `session.tool_overrides`.

---

## Per-provider permission modes

### CLI agents

| Agent (`id`) | Family | Modes (`id` → label) | Sandbox axis |
|---|---|---|---|
| Claude Code (`claude-code`) | Modes | `default` → Ask permissions · `acceptEdits` → Accept edits · `plan` → Plan mode · `bypassPermissions` → Bypass permissions | — |
| Codex CLI (`codex-cli`) | ApprovalSandbox | **approval:** `untrusted` · `on-request` · `never` | **sandbox:** `read-only` · `workspace-write` · `danger-full-access` |
| GitHub Copilot CLI (`github-copilot`) | Modes | `ask` → Ask permissions · `plan` → Plan mode · `autopilot` → Autopilot | — |
| OpenCode (`opencode`) | Modes | `build` → Build · `plan` → Plan | — |
| Cursor CLI (`cursor-cli`) | Modes | `agent` → Agent · `plan` → Plan · `ask` → Ask (read-only) | — |
| Kimi Code CLI (`kimi-code`) | Modes | `ask` → Ask permissions · `plan` → Plan mode · `yolo` → YOLO (bypass) | — |
| Grok Build (`grok-build`) | Modes | `default` → Ask permissions · `acceptEdits` → Accept edits · `plan` → Plan mode · `bypassPermissions` → Bypass permissions | — |
| Hermes Agent (`hermes-agent`) | Modes | `default` → Ask permissions · `acceptEdits` → Accept edits · `bypassPermissions` → Bypass permissions | — |
| Antigravity CLI (`antigravity-cli`) | Modes + sandbox | `request-review` → Request review · `proceed-in-sandbox` → Proceed in sandbox · `always-proceed` → Always proceed (YOLO) | `off` / `on` |
| Antigravity SDK (`antigravity-sdk`) | Modes + sandbox | same as `antigravity-cli` | `off` / `on` |

### Cloud HTTP APIs

| Provider(s) (`id`) | Family | Modes |
|---|---|---|
| Perplexity (`perplexity`) | **None** | — (no tool-authorization concept — picker hidden) |
| OpenAI, Anthropic, DeepSeek, Grok, NVIDIA NIM, Kimi API, Gemini API, OpenRouter, Cloudflare Workers AI | Modes (Fleet agentic-runner tiers) | `default` → Ask permissions · `acceptEdits` → Accept edits · `bypassPermissions` → Bypass permissions |
| Ollama (`ollama`), Ollama Cloud (`ollama-cloud`) | Modes (the same three tiers, from the lookup's default branch) | no effect: these turns run as single-shot chat, without tools |

> The tiers apply to chat turns. In a chat turn, HTTP providers run through Fleetify's own
> agentic runner, which maps the three tiers to its autonomy levels: `default` → reads auto /
> writes & shell ask · `acceptEdits` → reads+writes auto / shell ask · `bypassPermissions` →
> everything auto. Any other stored value runs as `default`. Ollama and Ollama Cloud skip the
> runner (`routers/chat.rs`): their turns go out single-shot, with no tools to authorize. A task
> dispatched to an HTTP-provider session goes out single-shot too, through the same bridge as
> Ollama's turns, so the tiers don't apply to it either.

---

## Per-tool matrix

Only these agents expose a per-tool override surface. The tool names are each agent's **real
vocabulary** (they differ per agent); a decision overrides the mode for that tool.

| Agent (`id`) | Tools | Decisions | Glob patterns |
|---|---|---|---|
| OpenCode (`opencode`) | `read` · `edit` · `bash` · `glob` · `grep` · `webfetch` · `websearch` | allow / **ask** / deny | yes |
| Cursor CLI (`cursor-cli`) | `Read` · `Write` · `Shell` · `WebFetch` · `Mcp` | allow / deny | yes |
| GitHub Copilot CLI (`github-copilot`) | `shell` · `write` · `read` | allow / deny¹ | yes |
| Kimi Code CLI (`kimi-code`) | `mcp_tool` | allow / deny | yes |
| *(all others)* | — | — | — |

¹ Copilot has no hard `--deny-tool`; a `deny` override simply withholds the `--allow-tool`
flag (the tool then follows Copilot's default ask/deny). `allow`/`deny` for OpenCode/Cursor/Kimi
short-circuit the ACP permission prompt at runtime; tool-name matching is lowercased and
best-effort against the ACP tool name the agent emits.

---

## When a change applies

`config_timing(provider_id)` decides whether changing a permission re-spawns the agent or
applies mid-session:

| Permission applies | Effort applies | Providers |
|---|---|---|
| **Live** (ACP `set_config_option`) | **Live** | OpenCode, Cursor, Grok Build, Hermes |
| **Spawn** (next message) | **Live** | GitHub Copilot |
| **Spawn** | **Spawn** | everyone else (Claude, Codex, Kimi, Antigravity, all HTTP) |

---

## Storage & dispatch (brief)

- The chosen mode persists to `session.permission_mode`; the sandbox tier to
  `session.sandbox`; the per-tool matrix to `session.tool_overrides` (a JSON string).
- At dispatch each bridge maps `permission_mode` to its CLI flag / ACP session-mode / approval
  policy, accepting **both** the provider-native id and the legacy Fleet-canonical id.
- "Auto mode" is intentionally **not** a permission mode — it is the routing sentinel
  (`tool == "auto"`), unrelated to tool authorization.

---

*Keep this file in sync with `permission_capability`, `tool_matrix`, and `config_timing` in
`crates/fleetify-backend/src/providers/capabilities.rs`.*
