# Library

User-authored content — **prompts, skills, hooks, and agent templates** you
write yourself — stored under `~/.fleetify/library/` and **materialized into
every selected CLI agent's native config** so the agent picks it up with no
extra wiring. The Library is the hand-authored sibling of the
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

The Library page (`src/components/library-page.tsx`) shows six sections, but
only four are **authorable** here; the other two are surfaced for navigation and
delegate elsewhere:

| Section | Authorable? | Backing |
|---|---|---|
| Prompts | ✅ | `LibraryKind::Prompt` |
| Skills | ✅ | `LibraryKind::Skill` |
| Hooks | ✅ | `LibraryKind::Hook` |
| Templates | ✅ | `LibraryKind::Template` |
| Workflows | ❌ read-only | plugin-contributed only |
| MCP | ❌ | redirects to Settings → MCP ([`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)) |

> **Commands are not a Library kind.** Slash-commands were removed as a
> first-class authorable type (and as a marketplace category). Plugins may still
> *ship* commands — those still install — but you can't author a standalone
> command item. See §10.

## 2. The four authorable kinds

`LibraryKind` (`crates/fleetify-backend/src/services/library/types.rs`, mirrored
in `src/lib/library-api.ts`):

| Kind | Payload (authored body) | Provider-scoped? | Materializes to |
|---|---|---|---|
| `prompt` | `prompt.md` (plain text) | no (every agent) | `~/.fleetify/prompts/<slug>.md` |
| `skill` | `skill/SKILL.md` (+ assets) | yes (≥1) | each provider's `<home>/skills/<slug>/` **and** the shared `~/.agents/skills/<slug>/` |
| `hook` | `hook.json` (`{event, matcher, command}`) | yes (≥1) | merged into each provider's hook config |
| `template` | `system_prompt.md` | no | nothing on disk — read by the runtime-templates endpoint (NewAgentDialog) |

"Provider-scoped" (`LibraryKind::is_provider_scoped`) means the create form
shows the provider multi-select and the backend **400s** an empty list.

## 3. On-disk store layout

`services/library/store.rs` — each item is a directory keyed by a UUID:

```
~/.fleetify/library/items/<uuid>/
├── meta.json          # the LibraryItem record (kind, slug, providers,
│                      #   materialized[], hook_merge[], timestamps)
└── <payload>          # skill/SKILL.md | prompt.md | hook.json | system_prompt.md
```

`~/.fleetify` is the **FLEETIFY_HOME-aware** root (`fleetify_core::fleetify_home()`),
so a `dev:tauri:wt` slot with its own `$FLEETIFY_HOME` gets an isolated store.
`meta.json` records every path the item wrote (`materialized: [{provider, path}]`)
plus hook-merge reversal records, so **delete is a precise reverse** — never a
guess (§9).

## 4. Authoring flow & validation

Create/edit happens in `src/components/library/create-item-dialog.tsx`:

1. **Name → slug.** The slug auto-derives from the name via `slugify()` until you
   hand-edit it. Rule (`SLUG_RE` / backend `is_valid_slug`): `^[a-z0-9][a-z0-9-]*$`
   — lowercase, digits, hyphens; no leading hyphen, no underscores (OpenCode and
   Cursor reject those).
2. **Description.** Optional for most kinds; **required (≤1024 chars) for skills**
   because it's injected into `SKILL.md` and the Agent-Skills standard mandates it
   (§5).
3. **Providers.** A multi-select dropdown gated to the kind's allowed set
   (`PROVIDERS_FOR_KIND` in `library-api.ts`). Hidden for provider-agnostic kinds.
4. **Body.** SKILL.md / hook JSON / prompt / system-prompt text, or **Import from
   file**.

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

## 6. Hooks

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

## 7. Prompts & Templates

- **Prompts** are provider-agnostic: one shared `~/.fleetify/prompts/<slug>.md`
  available to every agent (recorded under the synthetic provider `"fleetify"`).
- **Templates** are app-level agent presets. The authored `system_prompt.md` is
  stored but **not** written to any provider — it's surfaced by the runtime
  templates endpoint and shown in the New-Agent dialog. (`materialize_item` is a
  no-op for `Template`.)

## 8. HTTP API

`/api/library/*` (`crates/fleetify-backend/src/routers/library.rs`), wrapped by
`src/lib/library-api.ts`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/library/items?kind=<kind>` | List items (user + plugin-contributed). `kind` optional. |
| `POST` | `/library/items` | Create. 400 invalid-slug / no-providers; 409 slug-taken. |
| `GET` | `/library/items/{id}` | Fetch one. |
| `PUT` | `/library/items/{id}` | Edit (kind + slug immutable; re-materializes from scratch). |
| `DELETE` | `/library/items/{id}` | Delete + reverse all materialized artifacts. |

List rows carry `source` (`"user"` or the plugin name) and `editable` — the
renderer hides edit/delete on plugin-contributed (read-only) rows.

## 9. Materialization, edit & cleanup

`services/library/materialize.rs` is the orchestrator:

- **Create** writes the payload, dispatches per `kind` to the shared
  `services::plugins::materializers` writers, and persists the returned
  `materialized[]` + `hook_merge[]` onto the item.
- **Edit** (`PUT`) **un-materializes first, then re-materializes from scratch** —
  this is how a *dropped* provider's artifacts get cleaned up. The body is
  rewritten only when a non-empty one is supplied, so a providers-only edit keeps
  the existing payload.
- **Delete** calls `unmaterialize_item`: every recorded path is removed and every
  hook-merge record is replayed in reverse, then the item dir is deleted.

Because cleanup is driven by recorded paths (not re-derived), it stays correct
even if the provider registry later changes.

## 10. Plugin-contributed items (read-only)

The list endpoint also enumerates items a plugin install contributes, so the
Library shows them alongside your own — but read-only (`editable: false`).
`services/library/enumerate.rs::plugin_items` scans installed plugins under
`~/.fleetify/plugins/` for **skills** (`.<provider>/skills/<name>/SKILL.md`,
deduped across providers) and **templates** (`templates/*.json`). It does **not**
enumerate prompts/hooks, and no longer enumerates commands.

> Plugin command *installation* is unaffected: `services/plugins/materializers.rs::materialize`
> still writes a plugin's `.<provider>/commands/` via `commands_dir` — only the
> Library command *authoring* surface and the marketplace commands *category* were
> removed.

## 11. Frontend

- **`src/components/library-page.tsx`** — the page shell: the section nav
  (`NAV`), `SECTION_KIND` / `KIND_SECTION` maps, and `countForSection` (which
  mirrors the marketplace's component-count rules). Plugin skills/templates are
  enumerated as items, so their declares are skipped from the section totals to
  avoid double-counting.
- **`src/components/library/create-item-dialog.tsx`** — the create/edit modal
  (name→slug, description, the provider multi-select, body + import-from-file).
- **`src/stores/library-store.ts`** — Zustand store; `refresh` / `create` /
  `update` / `remove` all re-fetch after mutating so the UI never shows stale
  state. `create`/`update` re-throw so the dialog can surface 400/409 inline.
- **`src/lib/library-api.ts`** — types (`LibraryKind`, `LibraryItem`,
  `CreateLibraryItem`), `PROVIDERS_FOR_KIND`, `SLUG_RE` / `slugify`, and the
  HTTP client (`LibraryHttpError` carries `.status` so the dialog branches on
  400 vs 409).

## 12. Invariants & gotchas

- **Slug uniqueness is per-kind.** Two different kinds may share a slug; two
  prompts may not.
- **`kind` and `slug` are immutable after create** — edits change
  name/description/providers/body only.
- **A skill's frontmatter `name` is always rewritten to the slug.** OpenCode and
  Cursor require `name` == the containing directory. Author-set `name` is ignored.
- **Provider ids are canonical** (`claude-code`, `agy`, …) — the same set the
  catalog and marketplace use. A skill written for an unknown id silently no-ops.
- **Everything is FLEETIFY_HOME-scoped.** Two instances with different
  `$FLEETIFY_HOME` have independent libraries; the default `~/.fleetify` is
  shared.
