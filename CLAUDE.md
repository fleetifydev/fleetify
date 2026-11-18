# Fleetify — Working notes for Claude Code

Concise context for any Claude Code session in this repo. Project overview lives in `README.md` and `docs/PHASE_STATUS.md`; this file is for *how to work*, not *what the code does*.

---

## Workflow: branch + worktree per feature

**Every feature lands on its own branch in its own git worktree.** No work happens directly on `main`. The `dev:tauri:wt` helper (see below) is built around this.

Flow for a new feature:

```bash
# 1. From main, create the feature branch (name: type/scope-short-summary)
git branch feat/your-feature main

# 2. Add a worktree for it under .claude/worktrees/
git worktree add .claude/worktrees/your-feature feat/your-feature

# 3. Enter the worktree (or use EnterWorktree if you have the tool)
cd .claude/worktrees/your-feature

# 4. Work. Commit. Push.
git push -u origin feat/your-feature

# 5. Open a draft PR — `gh pr create --base main --draft`
```

When the PR merges, the worktree can be removed:

```bash
git worktree remove .claude/worktrees/your-feature
git branch -d feat/your-feature
```

**Why worktrees:** parallel features don't fight for `target/`, `node_modules`, or the working tree. Each worktree has its own checkout but shares `.git` with the main repo.

**Branch naming:** match the conventional-commit prefix the PR uses.

| PR title prefix | Branch prefix | Example |
|---|---|---|
| `feat(scope):` | `feat/` | `feat/sidecar-discovery` |
| `fix(scope):` | `fix/` | `fix/outbox-flake` |
| `ci:` | `ci/` | `ci/stage-1-foundations` |
| `docs:` | `docs/` | `docs/release-runbook` |
| `chore:` / `refactor:` / `test:` | matching prefix | `test/branch-strip-mocks` |

The CI workflow (when it lands — see PR #2) enforces conventional-commit PR titles via `amannn/action-semantic-pull-request`.

---

## Running the app

Two boot modes; pick based on what you're doing.

```bash
# Single instance, default ports, talks to your real ~/.fleetify session.
npm run dev:tauri

# Worktree-isolated instance — auto-detects you're in a linked worktree,
# hashes the worktree name to a deterministic slot (1-99), picks unique
# VITE_PORT / FLEETIFY_BACKEND_PORT / FLEETIFY_HOME so you can run it
# alongside another instance from a sibling worktree. No-auth by default.
npm run dev:tauri:wt
```

`dev:tauri:wt` env layout (computed at runtime by `scripts/dev-tauri-wt.mjs`):

```
slot                  = sha256(worktree-name) % 99 + 1   (0 on main)
VITE_PORT             = 3000 + slot
FLEETIFY_BACKEND_PORT = 8765 + slot
FLEETIFY_HOME         = ~/.fleetify-wt-<slot, 2-digit>
FLEETIFY_NOAUTH       = 1     (override: FLEETIFY_NOAUTH=0 npm run dev:tauri:wt)
```

Override the slot explicitly when needed: `npm run dev:tauri:wt -- 17`.

---

## Testing

### Unit + integration (gates that run in CI)

```bash
cargo fmt --all -- --check                           # format check      (HARD gate)
cargo clippy --workspace --all-targets -- -D warnings # lint, deny-warnings (HARD gate)
cargo test --workspace                               # rust unit + integration (advisory)
npm run lint                                         # eslint            (HARD gate)
npx tsc -b tsconfig.build.json --noEmit              # type-check        (HARD gate)
npm test                                             # vitest (renderer) (advisory)
npm run check:sidecars                               # sidecar drift guard (HARD gate)
```

Run all of these locally **before pushing**. CI runs the same set on every PR
(`.github/workflows/ci.yml`).

**"Advisory" means `continue-on-error: true` in CI — a red test does not block
a merge.** That is a deliberate choice, not an invitation: failures accumulate
silently, so treat a red test as red. Check whether it is red on `main` too
before assuming your branch caused it, and do not leave a new one behind.

**Node 22.** CI pins it and `engines` / `.nvmrc` declare it. Newer majors are
not merely untested — Node 25 exposes a `localStorage` global whose `clear` is
`undefined`, which shadows happy-dom inside vitest and turns the renderer suite
into ~140 phantom failures that have nothing to do with the code.

### E2E / smoke testing

Always use `npm run dev:tauri:wt` (not `npm run dev:tauri`) so the test instance doesn't collide with whatever you have running for normal dev. Then drive it with the **agent-browser skill** for UI walkthroughs:

```
1. From the worktree being tested, run:    npm run dev:tauri:wt
2. The boot banner prints the slot + ports.
3. The Tauri window opens against the slot's VITE_PORT.
4. Use the agent-browser skill to:
   - Attach to the rendered webview (or http://localhost:<VITE_PORT>)
   - Drive the golden-path scenario the PR claims to fix
   - Capture screenshots for the PR description
5. Tear down: Ctrl-C in the terminal kills the Tauri process; the
   worktree's FLEETIFY_HOME is preserved across re-runs (deterministic slot).
```

**Don't fake an E2E pass.** Type-checking + unit tests verify *code correctness*; only running the actual app verifies *feature correctness*. If you can't drive the UI (no display, no agent-browser available), say so explicitly in the PR rather than claiming a green smoke test.

### Tests that change behavior

When you fix a bug, add the regression test first (TDD). When you change a contract (component props, IPC schema), update the tests that exercise that contract in the same commit — don't let mock drift accumulate.

---

## Workspace layout (quick reference, full table in README)

```
crates/
├── fleetify-core/         # shared types (Session, Message, BridgeEvent), I/O-free
│                          # also: user_home() + fleetify_home() helpers
├── fleetify-backend/      # embedded axum server (library, no main.rs)
├── memory-mcp/            # stdio MCP: remember + recall
├── dispatch-mcp/          # stdio MCP: dispatch_to_agent
├── reveng-mcp/            # stdio MCP: fetch_url + save_asset + …
├── browser-mcp/           # stdio MCP: headless Chromium browsing (lazy launch)
└── fleet-wipe/            # uninstall / reset helper

src-tauri/                 # Tauri v2 shell, embeds fleetify-backend in setup()
src/                       # React + Vite renderer
scripts/                   # build-sidecars.mjs, dev-tauri-wt.mjs, wipe.mjs
docs/                      # RUNNING.md, PHASE_STATUS.md, ANALYTICS.md, etc.
```

---

## Gotchas

- **`~/.fleetify/` is shared between instances unless you use `FLEETIFY_HOME`.** `dev:tauri:wt` sets it per-slot; `dev:tauri` doesn't. Two `dev:tauri` instances writing to the same `telemetry-outbox.sqlite` *will* corrupt each other.

- **Backend hard-codes `127.0.0.1:8765` only if `FLEETIFY_BACKEND_PORT` is unset.** Same for the Vite proxy targets. Don't add a new hardcoded port — read the env.

- **Windows line endings.** Git's `core.autocrlf` flips LF→CRLF on checkout on Windows. `git status` may show files as modified that you didn't touch. Don't try to "fix" them; the warning is just git surfacing the normalization. Don't commit `\r\n` files explicitly.

- **`git add -A` will stage worktree gitlinks as submodules.** `.claude/` is in `.gitignore` precisely to block this, but `git add -A` from a parent directory can still get tricky. Prefer `git add -u` (tracked-only) or explicit file paths.

- **MCP sidecar binaries are resolved relative to the running exe.** Each worktree has its own `target/`, so its own copy of `fleet-memory-mcp` / `fleet-dispatch-mcp` / `fleet-reveng-mcp`. No conflict between instances.

- **Tauri identifier is shared across instances** (`com.fleetify.app`). Webview profile dir (cookies, localStorage) is therefore shared too. Auth tokens live in OS keyring, not the webview, so this is mostly harmless — but expect localStorage state (theme, last-opened panel) to leak across worktrees.

- **Don't run `cargo fmt --all` and another dev command in parallel** — fmt rewrites files, the other command may read stale content.

---

## Commit etiquette — release-please contract

**The PR title is the changelog entry.** Once release-please ships (see `docs/superpowers/specs/2026-05-22-github-workflows-design.md` §5), every merge to `main` is parsed by [release-please](https://github.com/googleapis/release-please) to derive the next semver bump and write `CHANGELOG.md`. The squashed commit subject is what release-please reads, and that subject is whatever the PR title was at merge time. **The PR title is the only thing that matters — individual commit subjects on the feature branch are advisory.**

### Prefix → version-bump + changelog effect

| Prefix | Version bump (pre-1.0) | Changelog section |
|---|---|---|
| `feat:` / `feat(scope):` | **minor** (0.1.x → 0.2.0) | Features |
| `fix:` / `fix(scope):` | **minor** pre-1.0 (`bump-minor-pre-major`) / **patch** post-1.0 | Bug Fixes |
| `perf:` | **patch** | Performance |
| `deps:` | **patch** | Dependencies |
| `revert:` | **patch** | Reverts |
| `feat!:` / footer `BREAKING CHANGE:` | **minor** pre-1.0 / **major** post-1.0 | Features (with `!`) |
| `docs:` | none | hidden |
| `chore:` | none | hidden |
| `refactor:` | none | hidden |
| `test:` | none | hidden |
| `ci:` | none | hidden |
| `build:` | none | hidden |
| `style:` | none | hidden (release-please doesn't define it; `amannn/action-semantic-pull-request` accepts it) |

**Pre-1.0 footgun:** we're at 0.1.x today, so `bump-minor-pre-major: true` + `bump-patch-for-minor-pre-major: true` are both ON. That means **`fix:` bumps the minor while pre-1.0**, not the patch — surprising if you're used to the post-1.0 semantics. Stops mattering once we cut 1.0.

### How to pick the right prefix

- Did this change ship a user-visible capability that wasn't there before? → `feat:`
- Did this change correct user-visible broken behaviour? → `fix:`
- Did this change improve speed / memory / latency with no behaviour delta? → `perf:`
- Did this change bump a dependency or generated lockfile? → `deps:`
- Did this change roll back a prior commit? → `revert:`
- Did this change touch only tests / CI / docs / formatting / internal cleanup / build scripts? → pick the corresponding hidden prefix (`test:` / `ci:` / `docs:` / `style:` / `chore:` / `refactor:` / `build:`). **These do not trigger a release.**

When unsure between `feat:` and `chore:`, ask: *"would I want this line to show up in the public changelog?"* If yes, `feat:` (or `fix:`); if no, a hidden prefix.

### Breaking changes

Use the `!` marker AND a `BREAKING CHANGE:` footer when you ship one:

```
feat(api)!: drop /v1/sessions in favour of /v2/sessions

<body explaining the migration>

BREAKING CHANGE: /v1/sessions has been removed. Callers must migrate
to /v2/sessions which returns a paginated envelope instead of a
bare array.
```

Pre-1.0 this still triggers only a minor bump (we're 0.x — semver lets us break things). Post-1.0 it forces a major bump.

### Body + co-author

- Body: explain *why*, not *what*. The diff shows what.
- One logical change per commit on a feature branch. The PR can squash them, but reviewers read individual commits.
- Co-author footer for AI-assisted commits:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

## What NOT to do

- **Don't push directly to `main`.** Even for trivial-looking changes. Use a feature branch + PR.
- **Don't `--force-push` to `main`** under any circumstance.
- **Don't `cargo fmt --all` mid-PR** without committing it as its own `style: cargo fmt` commit. Mixed fmt + logic commits are unreviewable.
- **Don't add new hardcoded ports / paths.** Read from env with a sensible default. The worktree-isolation work was a 13-file refactor specifically because of this; let's not repeat it.
- **Don't disable CI gates to make a PR green.** Fix the underlying issue, or split the fix into a separate prerequisite PR.
- **Don't commit `docs/superpowers/` or `.claude/` contents.** Both are in `.gitignore`; they're local working state, not shipped artifacts.

## Telemetry & analytics

Fleetify ships two independent telemetry channels. Dashboard sync is on by
default and can be turned off in Settings → Privacy; product analytics is
off until the user turns it on. `docs/ANALYTICS.md` lists what each one
sends.

| Channel | Vendor | Default | Toggle | Outbox |
|---|---|---|---|---|
| Dashboard sync | Fleetify cloud (`fleetify.dev`, WebSocket) | **ON** | Settings → Privacy → "Dashboard sync" | `~/.fleetify/telemetry-outbox.sqlite` |
| Product analytics | PostHog Cloud (EU, Frankfurt, HTTP `/batch`) | **OFF** | Settings → Privacy → "Product analytics" | `~/.fleetify/posthog-outbox.sqlite` |

### PostHog integration

- **Code:** backend module at `crates/fleetify-backend/src/services/telemetry/posthog/`; frontend wrapper at `src/lib/posthog.ts`.
- **Fan-out:** the existing `services/telemetry/emitters.rs::enqueue_payload` writes to both the Fleetify cloud outbox AND the PostHog outbox (the latter via `posthog::enqueue_if_enabled`, gated on a runtime `AtomicBool`).
- **distinct_id:** the persisted `device_id` from `device.json` is reused on both sides. Frontend `posthog.identify(user_id)` runs at sign-in, at each launch while signed in, and at opt-in, and only while product analytics is on; it merges the anonymous person into the authenticated one via `$anon_distinct_id`, with the id only (`before_send` strips `$set` / `$set_once`).
- **Env keys:** `POSTHOG_API_KEY` (Rust, runtime `std::env::var`) and `VITE_POSTHOG_KEY` (Vite, `import.meta.env`). Unset → backend `init` short-circuits and the renderer wrapper no-ops. `POSTHOG_HOST` / `VITE_POSTHOG_HOST` default to `https://eu.i.posthog.com`.
- **Runtime gate:** `telemetry_set_posthog_enabled` Tauri command persists the flag in `fleet.config.json::telemetry.posthog_enabled` AND flips the backend's `ENABLED` atomic live. Live opt-out stops new sends within ~10 s; the renderer's `optOut()` opts posthog-js out at once and drops every request it would still make, queued events and retries included.

### Local dev

Single source of truth is a `.env` file in the workspace root (gitignored — `.env.example` is the committed template). `dotenvy::dotenv()` runs at the top of `serve` so the Rust backend picks up the keys via `std::env::var`; Vite reads the same `.env` natively for the renderer.

```
# .env (gitignored)
POSTHOG_API_KEY=phc_yourtestprojectkey
VITE_POSTHOG_KEY=phc_yourtestprojectkey
POSTHOG_HOST=https://eu.i.posthog.com
VITE_POSTHOG_HOST=https://eu.i.posthog.com
```

Then just run `npm run dev:tauri:wt` — no shell env juggling, no `cargo clean` needed because the keys are read at runtime now (was `option_env!` baked-at-compile, dropped in favour of runtime resolution). Shell-set env vars still win over `.env` so CI / production injection paths are unchanged.

### Full event list

`docs/ANALYTICS.md` lists every event we emit, every property we drop, and the exact opt-out steps. Keep it in sync with the mapper (`crates/fleetify-backend/src/services/telemetry/posthog/mapper.rs`) and the `capture(...)` callers in `src/`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
