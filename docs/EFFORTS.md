# Reasoning effort

How Fleetify exposes each model's **native reasoning-effort lever** in the composer's
model picker (the **Effort** column), and exactly which providers/models expose which
levels.

Everything here is driven by the single lookup in
[`crates/fleetify-backend/src/providers/capabilities.rs`](../crates/fleetify-backend/src/providers/capabilities.rs)
(`effort_capability(provider_id, model_id)`), served to the renderer over the
`providers_list_catalog` IPC as `ProviderTile.capabilities.model_efforts`, and — for the
CLI agents whose models are frontend-static — mirrored in `src/lib/picker-groups.ts`
(`CLI_MODELS`). See [`PERMISSIONS.md`](PERMISSIONS.md) for the sibling permission system
and [`PROVIDERS.md`](PROVIDERS.md) for the provider list.

> **Effort is per *model*, not per provider.** Opus 4.8 and Sonnet 4.6 do not expose the
> same levels; the picker reads each model's own descriptor.

---

## Effort mechanism families

Each model's effort surface is one of five shapes. The composer renders the matching
control (only the first two render a level picker in v1):

| Family | Shape | UI | Used by |
|---|---|---|---|
| **Levels** | a discrete set, a subset of `minimal · low · medium · high · xhigh · max` (plus `none` for Grok) | button list | Claude, Codex, OpenAI, Grok, Perplexity (deep-research), Copilot |
| **ThinkingLevel** | Gemini-3 style `low · high` | button list | Gemini 3.x |
| **Budget** | a token thinking-budget (`min..max`, `-1` = dynamic, optionally disable) | slider *(deferred — not rendered in v1)* | Gemini 2.5 |
| **Toggle** | a thinking on/off switch | switch *(deferred — not rendered in v1)* | Kimi (thinking), DeepSeek (reasoner/V3.2) |
| **None** | intrinsic / non-reasoning — no control | hidden | everything else |

---

## Per-provider · per-model effort

### CLI agents

| Agent (`id`) | Model(s) | Family | Levels / detail | Default |
|---|---|---|---|---|
| Claude Code (`claude-code`) | Opus 4.8, Opus 4.7 | Levels | `low · medium · high · xhigh · max` | `high` |
| | Opus 4.6, Sonnet 4.6 | Levels | `low · medium · high · max` | `high` |
| | Opus 4.5 | Levels | `low · medium · high` | `high` |
| | Haiku 4.5 | None | — | — |
| Codex CLI (`codex-cli`) | all (GPT-5.x-codex) | Levels | `low · medium · high · xhigh` | `medium` |
| Gemini CLI (`gemini-cli`) | 3.x (3.1 Pro, 3 Flash) | ThinkingLevel | `low · high` | `high` |
| | 2.5 Flash | Budget | `0 – 24576` tokens, dynamic, can disable | dynamic (`-1`) |
| | 2.5 Pro | Budget | `128 – 32768` tokens, dynamic | dynamic (`-1`) |
| | other (incl. 3.x Lite) | None | — | — |
| GitHub Copilot CLI (`github-copilot`) | all | Levels | `low · medium · high · xhigh` | `medium` |
| Kimi Code CLI (`kimi-code`) | `*-thinking` | Toggle | on / off | on |
| | other | None | — | — |
| OpenCode (`opencode`) | all | None¹ | — | — |
| Cursor CLI (`cursor-cli`) | all | None¹ | — | — |
| Hermes Agent (`hermes-agent`) | all | None | — | — |
| Antigravity CLI (`antigravity-cli`) | all | None² | — | — |
| Antigravity SDK (`antigravity-sdk`) | all | None² | — | — |

¹ OpenCode / Cursor expose effort *live* over ACP, but their catalogued models carry no
effort lever today, so the column stays hidden.
² Antigravity bakes the effort into the **model id** (`gemini-3.5-flash-medium`, …) — it's
chosen by picking the model, not a separate lever.

### Cloud HTTP APIs

| Provider (`id`) | Model(s) | Family | Levels / detail | Default |
|---|---|---|---|---|
| OpenAI (`openai`) | GPT-5.x | Levels | `minimal · low · medium · high` | `medium` |
| | o1 / o3 / o4 | Levels | `low · medium · high` | `medium` |
| | GPT-4.1 / non-reasoning | None | — | — |
| Grok · xAI (`grok`) | Grok 4.3 | Levels | `none · low · medium · high` | `low` |
| | Grok 3-mini | Levels | `low · high` | `low` |
| | Grok 4 / 3 / code-fast | None (reasoning-always) | — | — |
| Gemini API (`gemini-api`) | 3.x | ThinkingLevel | `low · high` | `high` |
| | 2.5 Flash / Pro | Budget | see Gemini CLI above | dynamic |
| Kimi API (`kimi-api`) | `*-thinking` | Toggle | on / off | on |
| DeepSeek (`deepseek`) | reasoner, V3.2 | Toggle | on / off | on |
| Perplexity (`perplexity`) | `*deep-research*` | Levels | `low · medium · high` | `medium` |
| | Sonar / other | None | — | — |
| Anthropic API (`anthropic`) | — | **None** ³ | — | — |
| NVIDIA NIM, OpenRouter, Cloudflare Workers AI, Ollama | — | None | — | — |

³ **Anthropic's OpenAI-compat endpoint ignores `effort`.** Claude reasoning effort is
**CLI-only** (the `claude --effort` flag); over the HTTP API there is no effort lever, so
this is `None` by design — distinct from Claude Code (`claude-code`) above.

---

## Vocabulary & the `xhigh` ↔ `extra_high` mapping

- The full ladder is `minimal · low · medium · high · xhigh · max` (plus Grok's `none`).
  `minimal` is OpenAI gpt-5 only; `max` is Claude Opus 4.x only.
- The **session** stores effort in the legacy vocabulary `low · medium · high · extra_high · max`.
  The picker maps the capability id `xhigh` ⇆ the session id `extra_high` on read/write, and
  each bridge maps it onward to its CLI/API spelling. So picking "Extra high" on Opus persists
  `extra_high` and reaches `claude --effort xhigh`.
- Over-specifying is safe: Claude Code auto-falls-back when a model lacks a level (e.g.
  `xhigh` → `high` on Sonnet).

---

## When a change applies + what consumes it

`config_timing(provider_id)` decides whether changing effort re-spawns the agent or applies
mid-session:

| Apply | Providers |
|---|---|
| **Live** (mid-session, ACP `set_config_option`) | OpenCode, Cursor, Hermes, **GitHub Copilot** (effort) |
| **Spawn** (takes effect on the next message) | everyone else |

Where the chosen effort is actually sent:

| Provider | Mechanism | Wired |
|---|---|---|
| Claude Code | `claude --effort <level>` (skips Haiku) | ✅ |
| Codex CLI | `-c model_reasoning_effort=<level>` | ✅ |
| GitHub Copilot | `--effort=<level>` | ✅ |
| OpenAI / Grok / Perplexity (HTTP) | `reasoning_effort` in the request — **gated to `Levels` models** so non-reasoning models never 400 | ✅ |
| Cursor / OpenCode | ACP `set_config_option(effort)` (no catalogued effort models today) | ✅ (live) |
| Gemini CLI / Kimi CLI | thinking is **model-selected** (the model id is the thinking variant); Budget/Toggle controls are a follow-up | ⏳ |
| Hermes | no effort lever | n/a |

---

*Keep this file in sync with `effort_capability` in
`crates/fleetify-backend/src/providers/capabilities.rs` and the `CLI_MODELS` table in
`src/lib/picker-groups.ts`.*
