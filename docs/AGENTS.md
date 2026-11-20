# Agents (CLI)

Fleetify ships **ten CLI agents** — local subprocesses that run against your
machine. They're discovered via `providers::list_cli_agents()` and surface in
Settings → Agents as cards driven by `/api/agents/scan`.

> See [`PROVIDER_ARCHITECTURE.md`](PROVIDER_ARCHITECTURE.md) for how agents plug
> into the system, [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md) for the transport per
> agent, and [`PROVIDERS.md`](PROVIDERS.md) for the full provider list.

## The ten agents

| Agent | Catalog id | Binary | Transport | Install / Login |
|---|---|---|---|---|
| Claude Code | `claude-code` | `claude` | subprocess `--output-format stream-json` | `npm i -g @anthropic-ai/claude-code` · `claude login` |
| Codex CLI | `codex-cli` | `codex` | `codex app-server` (JSON-RPC/stdio) | `npm i -g @openai/codex` · `codex login` |
| Kimi Code CLI | `kimi-code` | `kimi` | ACP (`kimi acp`) | `npm i -g @moonshot-ai/kimi-code` · `kimi login` |
| OpenCode | `opencode` | `opencode` | ACP (`opencode acp`) | `npm i -g opencode-ai` · `opencode auth login` |
| Cursor CLI | `cursor-cli` | `cursor-agent` | ACP (`cursor-agent acp`) + `cursor/*` extensions | shell installer · `cursor-agent login` |
| GitHub Copilot CLI | `github-copilot` | `copilot` | ACP (`copilot --acp`) | `npm i -g @github/copilot` · `copilot login` |
| Grok Build | `grok-build` | `grok` | ACP (`grok agent stdio`) | shell installer · `grok login` |
| Hermes Agent | `hermes-agent` | `hermes` | ACP (`hermes acp`), multi-provider | `pip install "hermes-agent[acp]"` · `hermes model` |
| Antigravity CLI | `antigravity-cli` | `agy` | PTY `agy -p` (print mode) | shell installer · `agy` |
| Antigravity SDK | `antigravity-sdk` | `python3` | Python sidecar (NDJSON) | `pip install` · set `GEMINI_API_KEY` |

ACP agents share `bridges/acp.rs`'s `AcpClient` (JSON-RPC 2.0 over stdio); the
others use their own transport (see [`AGENT_BRIDGES.md`](AGENT_BRIDGES.md)). An
agent that isn't yet configured (or whose CLI lacks a feature) surfaces a clear
error rather than spawning a broken session — e.g. Hermes returns *"No LLM
provider configured. Run `hermes model`…"* until a provider is set up.

## Detection

Each agent declares its `auth_indicators` in the catalog. The scan endpoint
reports `installed=true` when the binary is found (PATH, or known off-PATH install
dirs for Cursor/Copilot/Hermes/Grok Build — see the `ScanProbe` strategies), and
`authenticated=true` when the first matching indicator fires:

```rust
const CLAUDE_INDICATORS: &[AuthIndicator] = &[
    AuthIndicator::HomeDir { path: ".claude/projects" },
    AuthIndicator::HomeDir { path: ".claude/sessions" },
    AuthIndicator::HomeDir { path: ".claude/history.jsonl" },
    AuthIndicator::EnvVar { name: "ANTHROPIC_API_KEY" },
];
```

OAuth agents (Antigravity CLI) use `JsonExpiry` indicators so an expired
token reads as "not authenticated" without launching the agent. When you run
`<bin> login` and the indicator appears, the Settings tile flips to "Detected" on
the next scan (tile expand or the Refresh button).

**Grok Build is the exception.** It authenticates off the **shared xAI key** you
save for the `grok` API provider — the bridge injects it as `XAI_API_KEY`, so the
scan OR-s a keyring check on top of the catalog's `XAI_API_KEY` env indicator. Set
the key once in Settings → Models and the agent reads as authenticated; `grok
login` (device-OAuth) also works, and the in-chat login-recovery flow runs it for
you when a turn hits *"Authentication required"*.

## Why install commands aren't auto-run

Settings copies install / login commands to the clipboard — it **never** spawns
them for you. Reasons: shell-injection blast radius (we'd be `exec`-ing
user-visible strings), transparency (you see the exact command), and
cross-platform terminal differences (subprocess output doesn't always reach the
GUI).

## Adding a new CLI agent

1. Append a `ProviderSpec` with `kind: ProviderKind::Cli` to `CATALOG`
   (`crates/fleetify-backend/src/providers/catalog.rs`) — `bin`,
   `auth_indicators`, `install_hint`(`s`), `login_hint`.
2. Add a bridge under `crates/fleetify-backend/src/bridges/`. If it speaks ACP,
   reuse `bridges/acp.rs::AcpClient` (mirror `opencode.rs` / `hermes.rs`);
   otherwise implement the transport.
3. Add an `AnyBridge` variant + a dispatch arm in `routers/chat.rs`.
4. Add a `ScanProbe` arm in `routers/providers.rs` if the agent installs off-PATH.
5. Onboarding parity: add the id to the hardcoded list in
   `src/components/onboarding/onboarding-chat.tsx` and a `ProviderLogo` case in
   `src/components/ui/provider-logo.tsx`.
