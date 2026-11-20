# Marketplace & Plugins

How a Fleetify plugin is structured, how it installs, and how its components
**materialize into every CLI agent's native config** so one install reaches
Claude Code, Codex, Kimi, OpenCode, GitHub Copilot, Cursor,
Hermes, and Antigravity.

> Related: [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md), [`PROVIDERS.md`](PROVIDERS.md).

---

## 1. What a plugin is

A plugin is a git repo (or a subdir of a marketplace repo) with a manifest
plus per-provider component directories:

```
my-plugin/
├── .fleetify-plugin/plugin.json   # REQUIRED manifest
├── mcp.json                       # optional — MCP servers (shared, all agents)
├── templates/                     # optional — Fleet-internal agent templates
├── workflows/                     # optional — Fleet workflows
├── .fleetify/prompts/             # optional — Fleetify-native prompts
└── .<provider>/                   # per-agent components, in the agent's vendor folder (§2)
    ├── skills/<name>/SKILL.md      #   Agent-Skills (universal format)
    ├── commands/<name>.md          #   slash commands (claude/opencode)
    ├── prompts/<name>.md           #   codex only
    ├── agents/<name>.md            #   sub-agents (claude/opencode/agy/cursor/copilot)
    └── hooks/…                     #   provider-native hook files
```

Root-level `skills/` / `commands/` / `prompts/` / `hooks/` are **rejected** at
parse time — components must live under `.<provider>/` so the materializer
never half-applies a plugin.

## 2. The manifest (`.fleetify-plugin/plugin.json`)

```jsonc
{
  "name": "diff-summarizer",            // kebab-case, ^[a-z0-9][a-z0-9-]*$
  "version": "0.1.0",                   // semver
  "providers": ["claude-code", "kimi-code", …],   // ⊆ KNOWN_PROVIDERS (below)
  "tags": ["productivity"],
  "requires_secrets": [{ "key": "GITHUB_TOKEN", "label": "…", "url": "…" }],
  "declares": {
    "mcp_servers": 0, "templates": 0, "workflows": 0, "prompts": 0,
    "providers": {                      // a MAP keyed by provider id …
      "claude-code": { "skills": 1, "commands": 0, "hooks": 0 },
      "kimi-code":   { "skills": 1, "commands": 0, "hooks": 0 }
    }
  }
}
```

- **`providers`** lists the agents the plugin targets. **`KNOWN_PROVIDERS`** =
  `claude-code, codex-cli, kimi-code, opencode, github-copilot, cursor-cli,
  hermes-agent, antigravity-cli, grok-build, antigravity-sdk` (the last is
  MCP-only — no on-disk home).
- The **component folders** use the vendor's own name, which differs from the
  id for the suffixed ones (`providers::component_basename`): `.claude/` for
  `claude-code`, `.codex/` for `codex-cli`, `.kimi/` for `kimi-code`, `.cursor/`
  for `cursor-cli`, `.hermes/` for `hermes-agent`, `.agy/` for `antigravity-cli`
  and `.grok/` for `grok-build`; the others match their id.
- **`declares.providers`** is a **map** (`provider id → {skills, commands,
  hooks}`), not a fixed struct — new agents are additive.
- **`provides`** (`["mcp","skills",…]`, the marketplace filter chips) is
  auto-derived from `declares` by the backend; authors may omit it.
- The ids are the app's **canonical** ones — Antigravity CLI is **`antigravity-cli`**. A
  manifest that names an id outside `KNOWN_PROVIDERS` fails validation, and the
  plugin doesn't install.

## 3. The provider registry — where each agent reads its components

`services/plugins/providers.rs` is the single source of truth. Homes are **not**
naive `~/.{id}`:

| id | home | skills | command/prompt | sub-agents | hooks |
|---|---|---|---|---|---|
| `claude-code` | `~/.claude` | `skills/` | `commands/*.md` | `agents/*.md` | `settings.json` (merge†) |
| `codex-cli` | `~/.codex` | `skills/` | `prompts/*.md` | — | — |
| `kimi-code` | `~/.kimi` | `skills/` | — | — | `config.toml` (TOML merge†) |
| `opencode` | `~/.config/opencode` | `skills/` | `commands/*.md` | `agents/*.md` | `plugins/*.ts` (copy) |
| `github-copilot` | `~/.copilot` | `skills/` | — | `agents/*.agent.md` | `hooks/*.json` (copy) |
| `cursor-cli` | `~/.cursor` | `skills/` | — | `agents/*.md` | `hooks.json` (merge†) |
| `hermes-agent` | `~/.hermes`‡ | `skills/` | — | — | `hooks/<n>/` (copy dir) |
| `antigravity-cli` | `~/.gemini/antigravity-cli` | `skills/` | — | `agents/*.md` | `hooks.json` (merge†) |
| `grok-build` | `~/.grok` | `skills/` | — | — | — (not supported yet) |
| `antigravity-sdk` | — | — | — | — | — (MCP only) |

‡ Hermes uses `%LOCALAPPDATA%\hermes` on Windows. † merge = next step (§7).

## 4. Materialization

On install, for each provider in `providers[]`, `materializers::materialize`
copies the plugin's components into that agent's home (`installer.rs` loops the
providers; uninstall reverses by prefix-walk).

- **Skills** (universal). Each `.<provider>/skills/<name>/SKILL.md` → the
  agent's `skills/<plugin>-<name>/`. Two correctness rules:
  - **Namespacing** is `<plugin>-<name>` (single hyphen, lowercase) — OpenCode
    and Cursor reject underscores **and** require the SKILL.md frontmatter
    `name` to equal the directory, so the materializer **rewrites the
    frontmatter `name`** to match the dir.
  - **Canonical fan-out**: a plugin shipping a single `.claude/skills/…`
    reaches *every* agent — if a provider's own `.<provider>/skills/` is
    absent, the materializer reads the first dir the plugin did ship (skills
    are byte-identical across agents). No 9× duplication required.
- **Commands / prompts**: `.<provider>/commands/*.md` → `commands/` (Claude /
  OpenCode) or `prompts/` (Codex), namespaced.
- **Sub-agents**: `.<provider>/agents/*.md` → the agent's `agents/` dir; GitHub
  Copilot gets the `.agent.md` extension, others plain `.md`.
- **Hooks** (copy strategies): `.<provider>/hooks/…` → Copilot `~/.copilot/hooks/*.json`,
  OpenCode `~/.config/opencode/plugins/*.ts`, Hermes `~/.hermes/hooks/<n>/`.
- **MCP** (`mcp_materialize`): the plugin's `mcp.json` servers are added to the
  **shared** `~/.fleetify/mcp_servers.json` registry. The per-bridge emitters
  (`mcp_dispatch`) then fan them out to every MCP-capable agent at spawn —
  **one write covers all providers**. `${secret:KEY}` placeholders are resolved
  from the install-time secret map (a missing key stays literal, never blanked).

## 5. Install / uninstall

```
POST /api/plugins/install  { repo_url }
  └─ git clone → parse+validate manifest → place at ~/.fleetify/plugins/<name>/
     → materialize(provider) for each provider → MCP → registry
POST /api/plugins/{id}/uninstall
  └─ for each provider: remove artifacts under the agent home matching the
     `<plugin>-` prefix (skills/commands/prompts/agents/hooks/plugins)
     → drop the plugin's MCP servers from the registry → rm the install dir
```

State (master enable + per-scope user/project/agent toggles) lives in
`~/.fleetify/plugin_state.json`.

## 6. The marketplace repo

A marketplace is a repo with a root `marketplace.json` indexing plugin subdirs
(each with its own `.fleetify-plugin/plugin.json`). `marketplace.json` inlines
each plugin's manifest for fast listing. The official repo is
`fleetifydev/marketplace`. Provider-id conventions:

- **MCP plugins** (github, slack, postgres, …) → `providers` = the agents that
  mount MCP servers ([`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) §4 lists how each
  does); per-provider `declares` empty.
- **Skill / template plugins** (diff-summarizer, code-reviewer, …) → `providers`
  = every CLI agent the plugin supports.

## 7. Roadmap — hook merge strategies

Four agents register hooks by **merging into a user's live config** rather than
a standalone file: Claude (`settings.json`), Kimi (`config.toml`), Cursor and
agy (`hooks.json`). `providers::hook_strategy` already classifies these as
`MergeJson` / `MergeToml`. Library hook items already merge into them, with a
recorded, reversible merge (`services/plugins/hook_merge.rs`, see
[`LIBRARY.md`](LIBRARY.md) §7), but the plugin materializer still skips them.
Wiring plugin installs into the merger is the next step — it needs: backup the
target → inject **namespaced** entries → parse-fail-skip (never corrupt) →
idempotent un-merge on uninstall. It's deferred (not faked) because merging into
a hand-edited config is the one genuinely risky operation here, and **no
marketplace plugin ships hooks yet**, so it's forward infrastructure with no
consumer to break.

Also pending: threading the install-dialog **secret map** through to
`mcp_materialize` so `${secret:KEY}` resolves at install (the resolver +
placeholder-passthrough are already built + tested).
