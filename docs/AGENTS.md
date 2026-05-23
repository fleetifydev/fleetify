# Agents (CLI)

Fleetify ships four CLI agents that run as subprocesses against your
local environment. They're discovered via `providers::list_cli_agents()`
and surface in Settings → Agents as cards driven by the
`/api/agents/scan` endpoint.

## The four agents

| Agent | Catalog id | Binary | Install | Login |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `npm install -g @anthropic-ai/claude-code` | `claude login` |
| Codex CLI | `codex` | `codex` | `npm install -g @openai/codex` | `codex login` |
| Gemini CLI | `gemini` | `gemini` | `npm install -g @google/gemini-cli` | `gemini` (first run prompts browser auth) |
| Kimi Code CLI | `kimi` | `kimi` | `npm install -g @moonshot-ai/kimi-code` | `kimi login` |

> **Note:** Kimi's bridge is wired (registry, Settings tile, chat
> dispatch) but the actual ACP protocol implementation is deferred
> until Moonshot publishes a stable spec. Selecting Kimi in chat today
> returns a clear "not yet implemented" error rather than spawning a
> broken session.

## Detection

Each agent declares its `auth_indicators` in the catalog. The scan
endpoint reports `installed=true` when the binary is on `PATH`, and
`authenticated=true` when the first matching indicator fires.

```rust
const CLAUDE_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir { path: ".claude/projects" },
    AuthIndicator::HomeDir { path: ".claude/sessions" },
    AuthIndicator::HomeDir { path: ".claude/history.jsonl" },
    AuthIndicator::HomeDir { path: ".config/anthropic/credentials.json" },
    AuthIndicator::EnvVar { name: "ANTHROPIC_API_KEY" },
];
```

When you run `<bin> login` in a terminal and the indicator file
appears, the Settings tile flips from "Login required" → "Detected"
within a Settings refresh cycle (auto-rescanned on tile expand or
manual Refresh button click).

## Why install commands aren't auto-run

Settings copies the install / login commands to the clipboard — it
NEVER spawns them on your behalf. Reasons:

1. **Shell-injection blast radius.** Auto-running an install hint from
   our config means we're effectively `exec`-ing user-visible strings.
   Even if the catalog is `'static`, the principle's worth keeping
   clean.
2. **Transparency.** You see the exact command before it runs.
3. **Cross-platform.** Each OS opens terminals differently and the
   subprocess output doesn't always make it back to the GUI — it's
   easier to let the user own that terminal.

## Adding a new CLI agent

1. Append a `ProviderSpec` with `kind: ProviderKind::Cli` to `CATALOG`
   in `crates/fleetify-backend/src/providers/catalog.rs` — populate
   `bin`, `auth_indicators`, `install_hint`, `login_hint`.
2. Add a bridge module under `crates/fleetify-backend/src/bridges/`
   that implements `send_message` + `abort`.
3. Add an `AnyBridge` variant + dispatch arm in
   `crates/fleetify-backend/src/routers/chat.rs`.
4. Settings → Agents picks up the new tile automatically; no renderer
   change needed unless the bridge surfaces novel events.
