# Library

User-authored content — **prompts, skills, subagents, hooks, rules, and agent
templates** you write yourself — stored under `~/.fleetify/library/` and
**materialized into every selected CLI agent's native config** so the agent
picks it up with no extra wiring. The Library is the hand-authored sibling of the
[Marketplace](MARKETPLACE.md): same per-provider materializers, but one item at
a time instead of a packaged plugin.

> Related: [`MARKETPLACE.md`](MARKETPLACE.md) (packaged plugins + the provider
> registry), [`PROVIDERS.md`](PROVIDERS.md), [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md).

---

## 1. What the Library is

A flat collection of **items**, each one a single authored artifact. Items are
NOT plugins: no manifest, no git repo, no versioning — you type a body, pick the
agents it targets, and it lands on disk. Source of truth is the backend store
(`~/.fleetify/library/`); the renderer mirrors it in a Zustand store
(`src/stores/library-store.ts`) that re-fetches after every mutation.

The Library page (`src/components/library-page.tsx`) shows eight sections, but
only six are **authorable** here; the other two are surfaced for navigation and
delegate elsewhere:

| Section | Authorable? | Backing |
|---|---|---|
| Prompts | ✅ | `LibraryKind::Prompt` |
| Skills | ✅ | `LibraryKind::Skill` |
| Subagents | ✅ | `LibraryKind::Subagent` |
| Hooks | ✅ | `LibraryKind::Hook` |
| Rules | ✅ | `LibraryKind::Rule` |
| Templates | ✅ | `LibraryKind::Template` |
| Workflows | ❌ read-only | plugin-contributed only |
| MCP | ❌ | redirects to Settings → MCP ([`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)) |

> **Commands are not a Library kind.** Slash-commands were removed as a
> first-class authorable type (and as a marketplace category). Plugins may still
> *ship* commands — those still install — but you can't author a standalone
> command item. See §12.

## 2. The six authorable kinds

`LibraryKind` (`crates/fleetify-backend/src/services/library/types.rs`, mirrored
in `src/lib/library-api.ts`):

| Kind | Payload (authored body) | Provider-scoped? | Materializes to |
|---|---|---|---|
| `prompt` | `prompt.md` (plain text) | no (every agent) | `~/.fleetify/prompts/<slug>.md` |
| `skill` | `skill/SKILL.md` (+ assets) | yes (≥1) | each provider's `<home>/skills/<slug>/` **and** the shared `~/.agents/skills/<slug>/` |
| `subagent` | `subagent.md` (frontmatter + system prompt) | yes (≥1) | each provider's `<home>/agents/<slug>.<ext>` (Codex → `.toml`) |
| `hook` | `hook.json` (`{event, matcher, command}`) | yes (≥1) | merged into each provider's hook config |
| `rule` | `rule.md` (plain text) | yes (≥1) | merged into each provider's global rule file (Cursor → `.mdc`) |
| `template` | `system_prompt.md` | no | nothing on disk — read by the runtime-templates endpoint (NewAgentDialog) |

"Provider-scoped" (`LibraryKind::is_provider_scoped`) means the create form
shows the provider multi-select and the backend **400s** an empty list.

## 3. On-disk store layout

`services/library/store.rs` — each item is a directory keyed by a UUID:

```
~/.fleetify/library/items/<uuid>/
├── meta.json          # the LibraryItem record (kind, slug, providers,
│                      #   materialized[], hook_merge[], rule_merge[], timestamps)
└── <payload>          # skill/SKILL.md | prompt.md | subagent.md | hook.json |
                       #   rule.md | system_prompt.md
```

`~/.fleetify` is the **FLEETIFY_HOME-aware** root (`fleetify_core::fleetify_home()`),
so a `dev:tauri:wt` slot with its own `$FLEETIFY_HOME` gets an isolated store.
`meta.json` records every path the item wrote (`materialized: [{provider, path}]`)
plus hook-merge and rule-merge reversal records, so **delete is a precise
reverse** — never a guess (§11).

## 4. Authoring flow & validation

Create/edit happens in `src/components/library/create-item-dialog.tsx`:

1. **Name → slug.** The slug auto-derives from the name via `slugify()` until you
   hand-edit it. Rule (`SLUG_RE` / backend `is_valid_slug`): `^[a-z0-9][a-z0-9-]*$`
   — lowercase, digits, hyphens; no leading hyphen, no underscores (OpenCode and
   Cursor reject those).
2. **Description.** Optional for most kinds; **required (≤1024 chars) for skills
   and subagents** because it's injected into the materialized frontmatter and the
   consumer needs it (the Agent-Skills standard mandates it for skills; a provider
   reads a subagent's `description` to decide *when to delegate* — §5, §6).
3. **Providers.** A multi-select dropdown gated to the kind's allowed set
   (`PROVIDERS_FOR_KIND` in `library-api.ts`). Hidden for provider-agnostic kinds.
4. **Body.** SKILL.md / agent markdown / hook JSON / prompt / rule / system-prompt
   text, or **Import from file**.

Backend create (`routers/library.rs::create_item`) enforces, in order: valid slug
(400) → ≥1 provider for provider-scoped kinds (400) → slug not already taken for
that kind (409). On success it writes the payload, materializes, and persists the
record.

## 5. Skills — the cross-agent open standard

Skills are an [open standard](https://agentskills.io) shared across all nine
agents: a `<name>/SKILL.md` folder with YAML frontmatter. The two **universal
required** fields are `name` (= the directory name; ≤64; lowercase-hyphen) and
`description` (≤1024). Other agents *ignore* unknown frontmatter, so the format
is inherently portable — Fleetify's job is to write a spec-valid SKILL.md into
each location an agent reads.

**What the materializer writes** (`services/plugins/materializers.rs`):

- Copies the authored `skill/` dir (SKILL.md + any `scripts/`, `references/`,
  `assets/`) into the target.
- **Rewrites `name`** to equal the slug (the dir id) and **injects `description`**
  from the item when the SKILL.md frontmatter lacks one (an author-written
  description is preserved; the value is collapsed to a one-line ≤1024 scalar).
  This is the `set_frontmatter_name_desc` / `rewrite_skill_frontmatter` path.

**Where it writes** — every selected provider's own skills dir **plus** the shared
`~/.agents/skills/` interop dir (`providers.rs::skills_dir` /
`agents_skills_dir`; the shared write is `materialize_skill_shared`, recorded
under the synthetic provider id `"agents"`):

| Provider id | USER skills dir |
|---|---|
| `claude-code` | `~/.claude/skills/` |
| `codex` | `~/.codex/skills/` *(written, but Codex reads the shared dir — see below)* |
| `gemini` | `~/.gemini/skills/` |
| `kimi` | `~/.kimi/skills/` |
| `opencode` | `~/.config/opencode/skills/` |
| `github-copilot` | `~/.copilot/skills/` |
| `cursor` | `~/.cursor/skills/` |
| `hermes` | `~/.hermes/skills/` (`%LOCALAPPDATA%\hermes\skills` on Windows) |
| `agy` (Antigravity) | `~/.gemini/antigravity-cli/skills/` |
| *(shared)* | `~/.agents/skills/` — read by Codex (its **only** USER scope), Gemini, Copilot, Cursor and Kimi |

> **Why the shared dir matters.** **Codex's USER skill scope is `~/.agents/skills`,
> not `~/.codex/skills`** — it never reads the latter. Writing the shared copy is
> how a Codex-selected skill is actually discovered, and it maximizes cross-tool
> reach for the others too. This is why every skill lands in `~/.agents/skills`
> regardless of which providers were ticked.

## 6. Subagents

A **subagent** is a named delegate agent — a markdown file with `name` /
`description` frontmatter and a system-prompt body — that the host agent can hand
a focused sub-task to. The authored body is `subagent.md`; the `description` is
what a provider reads to decide *when* to delegate, so it's **required** (§4).

**What the materializer writes** (`materialize_subagent_item`): for each selected
provider, a `<slug>.<ext>` file in that provider's `agents/` dir, with `name`
rewritten to the slug and `description` injected (same helper as skills). The file
format is per-provider:

| Provider id | Sub-agent file |
|---|---|
| `claude-code` | `~/.claude/agents/<slug>.md` |
| `codex` | `~/.codex/agents/<slug>.toml` — converted to TOML (`name` / `description` / `developer_instructions`) |
| `gemini` | `~/.gemini/agents/<slug>.md` |
| `opencode` | `~/.config/opencode/agents/<slug>.md` |
| `github-copilot` | `~/.copilot/agents/<slug>.agent.md` (Copilot's compound extension) |
| `cursor` | `~/.cursor/agents/<slug>.md` |
| `agy` (Antigravity) | `~/.gemini/antigravity-cli/agents/<slug>.md` |

> **Kimi and Hermes have no on-disk per-agent file**, so they're absent from
> `PROVIDERS_FOR_KIND.subagent`. **Codex is the one non-copy path**: its agents are
> TOML, so the markdown frontmatter + body are transcoded rather than copied
> verbatim (`write_codex_agent`). The `.md`/`.agent.md` providers all share the
> plain-copy + frontmatter-rewrite path (`providers.rs::agents_dir`).

## 7. Hooks

A hook item is authored as `{ "event": "...", "matcher": "...", "command": "..." }`
and **merged** into each selected provider's live hook config rather than copied
as a standalone file — so it co-exists with the user's existing hooks and
**un-merges** cleanly on delete. The merge strategies live in
`services/plugins/hook_merge.rs`:

- **Claude Code** → `~/.claude/settings.json` (`hooks` object)
- **Kimi** → `~/.kimi/config.toml` (`[[hooks]]`)
- **Cursor / agy** → `hooks.json`

Each merge writes a `HookMergeRecord` onto the item (`meta.json::hook_merge`) that
delete replays in reverse. Allowed providers for the hook kind are listed in
`PROVIDERS_FOR_KIND.hook`.

## 8. Rules

A **rule** is always-on, free-text guidance ("never use emoji", "prefer tabs")
that a provider reads from its instruction file. There are two scopes:

### 8.1 Library rules — user-global

A Library `rule` item fans out to every selected provider's **user-global** rule
file as a slug-fenced marked block, so it coexists with the user's own
instructions and un-merges precisely on delete (`services/plugins/rule_merge.rs`).
The block looks like:

```
<!-- fleetify:rule:<slug> START -->
…your rule text…
<!-- fleetify:rule:<slug> END -->
```

| Provider id | Global rule file |
|---|---|
| `claude-code` | `~/.claude/CLAUDE.md` |
| `gemini` | `~/.gemini/GEMINI.md` |
| `codex` / `kimi` / `opencode` / `agy` | `<home>/AGENTS.md` (the dominant cross-tool standard) |
| `github-copilot` | `~/.copilot/copilot-instructions.md` |
| `cursor` | `~/.cursor/rules/<slug>.mdc` — **standalone file**, not a merge (Cursor's per-rule format with `description` + `alwaysApply: true` frontmatter) |

Each merge writes a `RuleMergeRecord` onto the item (`meta.json::rule_merge`);
delete strips exactly that block (Cursor's `.mdc` is removed as a standalone
path). Cursor is the outlier — its [rules](https://cursor.com/docs/rules) are
`.mdc` files, so it's materialized by the writer, not the merger.

### 8.2 Session rules — per-session

A session can also carry its own rules, edited from the **Rules chip** in the
session toolbar (`src/components/chat/session-rules-chip.tsx`). These are written
into the session's **working-directory** rule file (the worktree checkout when
present, else `project_path`) for the session's provider, so the CLI reads them
automatically on its next spawn — exactly the file the provider already looks for,
no system-prompt injection.

- Persisted on the session row (`sessions.session_rules`, migration
  `0008_session_rules.sql`).
- Endpoint: `GET` / `PUT /api/sessions/{id}/rules`
  (`routers/sessions.rs::get_session_rules` / `set_session_rules`).
- The block is keyed `fleetify:rule:session-<id>` so it coexists with the user's
  own project rule file **and** any sibling session sharing the same in-place
  project directory. Cursor sessions get a project `.cursor/rules/session-<id>.mdc`.
- Clearing the text strips the block. The DB row is the source of truth; the next
  spawn re-applies.

## 9. Prompts & Templates

- **Prompts** are provider-agnostic: one shared `~/.fleetify/prompts/<slug>.md`
  available to every agent (recorded under the synthetic provider `"fleetify"`).
- **Templates** are app-level agent presets. The authored `system_prompt.md` is
  stored but **not** written to any provider — it's surfaced by the runtime
  templates endpoint and shown in the New-Agent dialog. (`materialize_item` is a
  no-op for `Template`.)

## 10. HTTP API

`/api/library/*` (`crates/fleetify-backend/src/routers/library.rs`), wrapped by
`src/lib/library-api.ts`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/library/items?kind=<kind>` | List items (user + plugin-contributed). `kind` optional. |
| `POST` | `/library/items` | Create. 400 invalid-slug / no-providers; 409 slug-taken. |
| `GET` | `/library/items/{id}` | Fetch one. |
| `PUT` | `/library/items/{id}` | Edit (kind + slug immutable; re-materializes from scratch). |
| `DELETE` | `/library/items/{id}` | Delete + reverse all materialized artifacts. |

Session rules live on the **sessions** router (they're per-session, not Library
items): `GET` / `PUT /api/sessions/{id}/rules` (§8.2), wrapped by
`getSessionRules` / `setSessionRules` in `src/lib/api.ts`.

List rows carry `source` (`"user"` or the plugin name) and `editable` — the
renderer hides edit/delete on plugin-contributed (read-only) rows.

## 11. Materialization, edit & cleanup

`services/library/materialize.rs` is the orchestrator:

- **Create** writes the payload, dispatches per `kind` to the shared
  `services::plugins::materializers` / `rule_merge` writers, and persists the
  returned `materialized[]` + `hook_merge[]` + `rule_merge[]` onto the item.
- **Edit** (`PUT`) **un-materializes first, then re-materializes from scratch** —
  this is how a *dropped* provider's artifacts get cleaned up. The body is
  rewritten only when a non-empty one is supplied, so a providers-only edit keeps
  the existing payload.
- **Delete** calls `unmaterialize_item`: every recorded path is removed, every
  hook-merge record is replayed in reverse, and every rule-merge block is stripped,
  then the item dir is deleted.

Because cleanup is driven by recorded paths/records (not re-derived), it stays
correct even if the provider registry later changes.

## 12. Plugin-contributed items (read-only)

The list endpoint also enumerates items a plugin install contributes, so the
Library shows them alongside your own — but read-only (`editable: false`).
`services/library/enumerate.rs::plugin_items` scans installed plugins under
`~/.fleetify/plugins/` for **skills** (`.<provider>/skills/<name>/SKILL.md`,
deduped across providers), **subagents** (`.<provider>/agents/<name>.{md,agent.md,toml}`,
deduped by agent name) and **templates** (`templates/*.json`). It does **not**
enumerate prompts/hooks/rules.

> Plugin command *installation* is unaffected: `services/plugins/materializers.rs::materialize`
> still writes a plugin's `.<provider>/commands/` via `commands_dir` — only the
> Library command *authoring* surface and the marketplace commands *category* were
> removed.

## 13. Frontend

- **`src/components/library-page.tsx`** — the page shell: the section nav
  (`NAV`), `SECTION_KIND` / `KIND_SECTION` maps, and `countForSection` (which
  mirrors the marketplace's component-count rules). Plugin skills/subagents/
  templates are enumerated as items, so their declares are skipped from the
  section totals to avoid double-counting (`ENUMERATED`).
- **`src/components/library/create-item-dialog.tsx`** — the create/edit modal
  (name→slug, description, the provider multi-select, body + import-from-file).
  `descriptionRequired(kind)` gates the mandatory-description kinds (skill,
  subagent).
- **`src/components/chat/session-rules-chip.tsx`** — the per-session Rules chip in
  the session toolbar (load-on-open, save-on-demand; §8.2). Only mounted for a
  committed session.
- **`src/stores/library-store.ts`** — Zustand store; `refresh` / `create` /
  `update` / `remove` all re-fetch after mutating so the UI never shows stale
  state. `create`/`update` re-throw so the dialog can surface 400/409 inline.
- **`src/lib/library-api.ts`** — types (`LibraryKind`, `LibraryItem`,
  `CreateLibraryItem`), `PROVIDERS_FOR_KIND`, `SLUG_RE` / `slugify`, and the
  HTTP client (`LibraryHttpError` carries `.status` so the dialog branches on
  400 vs 409).

## 14. Invariants & gotchas

- **Slug uniqueness is per-kind.** Two different kinds may share a slug; two
  prompts may not.
- **`kind` and `slug` are immutable after create** — edits change
  name/description/providers/body only.
- **A skill's (and subagent's) frontmatter `name` is always rewritten to the
  slug.** OpenCode and Cursor require `name` == the containing directory.
  Author-set `name` is ignored.
- **Rules never delete the user's rule file.** Un-merge strips only the
  slug-fenced block, leaving any surrounding content (and an empty file) in place.
- **Session rules write into your project directory.** A non-worktree session
  merges its block into `<project_path>/CLAUDE.md` (etc.); the marker is
  session-keyed so concurrent sessions in the same dir don't clobber each other.
- **Provider ids are canonical** (`claude-code`, `agy`, …) — the same set the
  catalog and marketplace use. A skill/subagent/rule written for an unknown id
  silently no-ops.
- **Everything is FLEETIFY_HOME-scoped.** Two instances with different
  `$FLEETIFY_HOME` have independent libraries; the default `~/.fleetify` is
  shared.
