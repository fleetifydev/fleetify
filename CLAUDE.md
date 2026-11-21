# Fleetify — Working notes for Claude Code

Concise context for any coding-agent session in this repo. The project overview lives in `README.md`, and `docs/ARCHITECTURE.md` maps the code; this file is for *how to work*, not *what the code does*. The contributor rules (setup, gates, DCO sign-off, review) are in `CONTRIBUTING.md`: read it too.

---

## Workflow: a branch per feature

**Every feature lands on its own branch.** No work happens directly on `main`. Creating the branch in the main checkout is fine:

```bash
# 1. From an up-to-date main, create the feature branch (name: type/scope-short-summary)
git switch -c feat/your-feature main

# 2. Work. Commit with a sign-off (git commit -s). Push.
git push -u origin feat/your-feature

# 3. Open a draft PR — `gh pr create --base main --draft`
```

**Worktrees are optional.** A git worktree gives a feature its own checkout, so parallel features don't fight for `target/`, `node_modules`, or the working tree, and `npm run dev:tauri:wt` (below) gives each worktree its own app instance. Each worktree has its own checkout but shares `.git` with the main repo:

```bash
# Add a worktree for the branch under .claude/worktrees/ (.claude/ is gitignored)
git branch feat/your-feature main
git worktree add .claude/worktrees/your-feature feat/your-feature
cd .claude/worktrees/your-feature   # or use EnterWorktree if you have the tool

# When the PR merges, remove it:
git worktree remove .claude/worktrees/your-feature
git branch -d feat/your-feature
```

**Branch naming:** match the conventional-commit prefix the PR uses.

| PR title prefix | Branch prefix | Example |
|---|---|---|
| `feat(scope):` | `feat/` | `feat/sidecar-discovery` |
| `fix(scope):` | `fix/` | `fix/outbox-flake` |
| `ci:` | `ci/` | `ci/stage-1-foundations` |
| `docs:` | `docs/` | `docs/release-runbook` |
| `chore:` / `refactor:` / `test:` | matching prefix | `test/branch-strip-mocks` |

CI enforces conventional-commit PR titles with `amannn/action-semantic-pull-request` (`.github/workflows/pr-title.yml`); editing a PR's title reruns the check.

---

## Running the app

Two boot modes; pick based on what you're doing.

```bash
# Worktree-isolated instance — auto-detects you're in a linked worktree,
# hashes the worktree name to a deterministic slot (1-99), picks unique
# VITE_PORT / FLEETIFY_BACKEND_PORT / FLEETIFY_HOME so you can run it
# alongside another instance from a sibling worktree. No-auth by default.
# The main checkout gets slot 0: default ports, but its own FLEETIFY_HOME.
npm run dev:tauri:wt

# Single instance, default ports, talks to your real ~/.fleetify session,
# with real sign-in against an identity provider on http://localhost:3001
# (FLEETIFY_ISSUER). Without one running, sign-in fails: use dev:tauri:wt.
npm run dev:tauri
```

`dev:tauri:wt` env layout (computed at runtime by `scripts/dev-tauri-wt.mjs`):

```
slot                  = sha256(worktree-name) % 99 + 1   (0 in the main checkout)
VITE_PORT             = 3000 + slot
FLEETIFY_BACKEND_PORT = 8765 + slot
FLEETIFY_HOME         = ~/.fleetify-wt-<slot, 2-digit>
FLEETIFY_NOAUTH       = 1     (override: FLEETIFY_NOAUTH=0 npm run dev:tauri:wt)
```

Override the slot explicitly when needed: `npm run dev:tauri:wt -- 17`.

---

## Testing

### Unit + integration (gates that run in CI)

The steps of `.github/workflows/ci.yml`, in its order; CONTRIBUTING.md's "The gates" explains them for contributors:

```bash
npm run check:sidecars                                  # sidecar drift guard           (HARD gate)
npm run build:sidecars                                  # stage the MCP sidecars        (HARD gate; clippy + tests need them)
cargo fmt --all -- --check                              # format check                  (HARD gate)
cargo clippy --workspace --all-targets -- -D warnings   # compile + lint, deny-warnings (HARD gate)
cargo test --workspace --no-fail-fast                   # rust unit + integration       (advisory)
npm run lint                                            # eslint                        (HARD gate)
npx tsc -b tsconfig.build.json --noEmit                 # type-check                    (HARD gate)
npm test                                                # vitest (renderer)             (advisory)
python3 -c "import yaml"                                # PyYAML for the script tests   (HARD gate)
node --test "scripts/ci/*.test.mjs" "scripts/release/*.test.mjs"   # script tests (HARD gate)
actionlint                                              # workflow lint (+ shellcheck)  (HARD gate)
```

Run all of these locally **before pushing**. CI runs the same set on every PR,
plus `cargo audit` and `npm audit --omit=dev`, both advisory. The Rust steps run
on Windows in CI, and clippy runs on Linux and macOS as well, so code behind one
OS's `cfg`, such as `cfg(windows)`, is compiled and linted even when your machine
skips it.

A PR that changes what a release build reads (the paths in
`.github/workflows/release-dry-run.yml`) also runs the release dry run, advisory:
it builds, assembles and smoke-tests the bundles on every platform.

The script tests read YAML with Python 3 and PyYAML (`python3-yaml` on Debian and
Ubuntu, `pip install pyyaml` elsewhere). Without PyYAML those checks skip on your
machine; CI checks for it first, so they can't skip there.

**"Advisory" means `continue-on-error: true` in CI — a red test does not block
a merge.** That is a deliberate choice, not an invitation: failures accumulate
silently, so treat a red test as red. Check whether it is red on `main` too
before assuming your branch caused it, and do not leave a new one behind.

**Node 22.** CI pins it and `engines` / `.nvmrc` declare it. Newer majors are
not merely untested — Node 25 exposes a `localStorage` global whose `clear` is
`undefined`, which shadows happy-dom inside vitest and turns the renderer suite
into ~140 phantom failures that have nothing to do with the code.

### E2E / smoke testing

Always use `npm run dev:tauri:wt` (not `npm run dev:tauri`) so the test instance doesn't collide with whatever you have running for normal dev. Then drive the real app window with a browser- or desktop-automation tool for UI walkthroughs:

```
1. From the checkout being tested, run:    npm run dev:tauri:wt
2. The boot banner prints the slot + ports.
3. The Tauri window opens against the slot's VITE_PORT.
4. Drive that window with the automation tool. A plain browser tab on
   VITE_PORT is no substitute: it doesn't get past sign-in, because the UI
   needs the Tauri bridge.
   - Drive the golden-path scenario the PR claims to fix
   - Capture screenshots for the PR description
5. Tear down: Ctrl-C in the terminal kills the Tauri process; the
   worktree's FLEETIFY_HOME is preserved across re-runs (deterministic slot).
```

**On Linux,** what works: run the real window under Xvfb (inside `dbus-run-session` with a temporary `HOME`, so it touches neither your display nor your data), drive it with `xdotool`, and take screenshots of the virtual display. Keep `RUSTUP_HOME` and `CARGO_HOME` pointing at the real `~/.rustup` and `~/.cargo`: under a temporary `HOME`, rustup otherwise looks for its toolchains there and finds none. For setup the UI would make slow, such as creating sessions, call the backend's API on `127.0.0.1:<FLEETIFY_BACKEND_PORT>` directly. That needs a plain no-auth run, not `FLEETIFY_REQUIRE_API_TOKEN=1`: the per-run API token is reachable only through the webview's IPC, so a script can't get it.

For a webview-driven smoke run, start it as `FLEETIFY_REQUIRE_API_TOKEN=1 npm run dev:tauri:wt`: the run is no-auth by default, which also turns off the per-run API token check, and this keeps the check on (see `docs/RUNNING.md`).

**Don't fake an E2E pass.** Type-checking + unit tests verify *code correctness*; only running the actual app verifies *feature correctness*. If you can't drive the UI (no display, no automation tool available), say so explicitly in the PR rather than claiming a green smoke test.

### Tests that change behavior

When you fix a bug, add the regression test first (TDD). When you change a contract (component props, IPC schema), update the tests that exercise that contract in the same commit — don't let mock drift accumulate.

---

## Workspace layout (quick reference; `docs/ARCHITECTURE.md` has the full map)

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
scripts/                   # build-sidecars.mjs, dev-tauri-wt.mjs, wipe.mjs, ci/ + release/ checks
docs/                      # ARCHITECTURE.md, RUNNING.md, INSTALL.md, ANALYTICS.md, etc.
```

---

## Gotchas

- **`~/.fleetify/` is shared between instances unless you use `FLEETIFY_HOME`.** That includes the sessions DB, `fleet.db` (a no-auth run without `FLEETIFY_HOME` uses `fleet-noauth.db` there). `dev:tauri:wt` sets it per-slot; `dev:tauri` doesn't. Two `dev:tauri` instances writing to the same `fleet.db` or `telemetry-outbox.sqlite` *will* corrupt each other.

- **Backend hard-codes `127.0.0.1:8765` only if `FLEETIFY_BACKEND_PORT` is unset.** Same for the Vite proxy targets. Don't add a new hardcoded port — read the env.

- **Windows line endings.** Git's `core.autocrlf` flips LF→CRLF on checkout on Windows. `git status` may show files as modified that you didn't touch. Don't try to "fix" them; the warning is just git surfacing the normalization. Don't commit `\r\n` files explicitly.

- **`git add -A` will stage worktree gitlinks as submodules.** `.claude/` is in `.gitignore` precisely to block this, but `git add -A` from a parent directory can still get tricky. Prefer `git add -u` (tracked-only) or explicit file paths.

- **MCP sidecar binaries are resolved relative to the running exe.** Each worktree has its own `target/`, so its own copy of `fleet-memory-mcp` / `fleet-dispatch-mcp` / `fleet-reveng-mcp` / `fleet-browser-mcp`. No conflict between instances.

- **Tauri identifier is shared across instances** (`com.fleetify.app`). Webview profile dir (cookies, localStorage) is therefore shared too. Auth tokens live in OS keyring, not the webview, so this is mostly harmless — but expect localStorage state (theme, last-opened panel) to leak across worktrees.

- **Don't run `cargo fmt --all` and another dev command in parallel** — fmt rewrites files, the other command may read stale content.

---

## Commit etiquette — release-please contract

**The PR title is the changelog entry.** From the first public release (v0.2.0) on, [release-please](https://github.com/googleapis/release-please) parses every merge to `main` to derive the next semver bump and write `CHANGELOG.md`. The squashed commit subject is what release-please reads, and that subject is whatever the PR title was at merge time. **The PR title is the only thing that matters — individual commit subjects on the feature branch are advisory.**

### Prefix → version-bump + changelog effect

| Prefix | Version bump (pre-1.0) | Changelog section |
|---|---|---|
| `feat:` / `feat(scope):` | **minor** (0.2.0 → 0.3.0) | Features |
| `fix:` / `fix(scope):` | **patch** (0.2.0 → 0.2.1) | Bug Fixes |
| `perf:` | **patch** | Performance Improvements |
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

**Before 1.0:** release-please runs with `bump-minor-pre-major: true` and `bump-patch-for-minor-pre-major: false`. So `feat:` bumps the minor, `fix:` bumps the patch, and a breaking change bumps the **minor**, not the major. From 1.0 on, a breaking change bumps the major. The first public release is 0.2.0.

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

### Body + sign-off

- Body: explain *why*, not *what*. The diff shows what.
- One logical change per commit on a feature branch. The PR can squash them, but reviewers read individual commits.
- Every commit needs a DCO sign-off: commit with `git commit -s`. A check fails a pull request that has a commit without one. For AI-assisted work, see CONTRIBUTING.md → "AI-assisted contributions".

---

## What NOT to do

- **Don't push directly to `main`.** Even for trivial-looking changes. Use a feature branch + PR.
- **Don't `--force-push` to `main`** under any circumstance.
- **Don't `cargo fmt --all` mid-PR** without committing it as its own `style: cargo fmt` commit. Mixed fmt + logic commits are unreviewable.
- **Don't add new hardcoded ports / paths.** Read from env with a sensible default. The worktree-isolation work was a 13-file refactor specifically because of this; let's not repeat it.
- **Don't disable CI gates to make a PR green.** Fix the underlying issue, or split the fix into a separate prerequisite PR.
- **Don't commit `.claude/` contents.** It's in `.gitignore`; it's local working state (worktrees, agent settings), not a shipped artifact.

## Telemetry & analytics

Fleetify ships two independent telemetry channels. Dashboard sync is on by
default and can be turned off in Settings → General → Privacy; product
analytics is off until the user turns it on. `docs/ANALYTICS.md` lists what
each one sends.

| Channel | Vendor | Default | Toggle | Outbox |
|---|---|---|---|---|
| Dashboard sync | Fleetify cloud (`fleetify.dev`, WebSocket) | **ON** | Settings → General → Privacy → "Dashboard sync" | `~/.fleetify/telemetry-outbox.sqlite` |
| Product analytics | PostHog Cloud (EU, Frankfurt, HTTP `/batch`) | **OFF** | Settings → General → Privacy → "Product analytics" | `~/.fleetify/posthog-outbox.sqlite` |

### PostHog integration

- **Code:** backend module at `crates/fleetify-backend/src/services/telemetry/posthog/`; frontend wrapper at `src/lib/posthog.ts`.
- **Fan-out:** the existing `services/telemetry/emitters.rs::enqueue_payload` writes to both the Fleetify cloud outbox AND the PostHog outbox (the latter via `posthog::enqueue_if_enabled`, gated on a runtime `AtomicBool`).
- **distinct_id:** the persisted `device_id` from `device.json` is reused on both sides. Frontend `posthog.identify(user_id)` runs at sign-in, at each launch while signed in, and at opt-in, and only while product analytics is on; it merges the anonymous person into the authenticated one via `$anon_distinct_id`, with the id only (`before_send` strips `$set` / `$set_once`).
- **Env keys:** `POSTHOG_API_KEY` / `POSTHOG_HOST` (Rust: runtime `std::env::var`, else the value compiled in with `option_env!`) and `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (Vite, `import.meta.env`, inlined at build time). CI release builds compile all four in from the repository variables, so they carry the public, write-only `phc_` project key (the backend build fails on any other kind of key); product analytics still stays off until the user turns it on. A local build carries a key only if its environment (or, for the renderer, `.env`) sets one while it builds. No key → backend `init` short-circuits and the renderer wrapper no-ops. Both hosts default to `https://eu.i.posthog.com`.
- **Runtime gate:** `telemetry_set_posthog_enabled` Tauri command persists the flag in `fleet.config.json::telemetry.posthog_enabled` AND flips the backend's `ENABLED` atomic live. Live opt-out stops new sends within ~10 s; the renderer's `optOut()` opts posthog-js out at once and drops every request it would still make, queued events and retries included.

### Local dev

Single source of truth is a `.env` file in the workspace root (gitignored — `.env.example` is the committed template). In debug builds, `dotenvy::dotenv()` runs at the top of `serve` so the Rust backend picks up the keys via `std::env::var`; release builds never read `.env`. Vite reads the same `.env` natively for the renderer.

```
# .env (gitignored)
POSTHOG_API_KEY=phc_yourtestprojectkey
VITE_POSTHOG_KEY=phc_yourtestprojectkey
POSTHOG_HOST=https://eu.i.posthog.com
VITE_POSTHOG_HOST=https://eu.i.posthog.com
```

Then just run `npm run dev:tauri:wt` — no shell env juggling, no `cargo clean` needed because the backend reads the keys at runtime first (a value compiled in with `option_env!` is only the fallback). Shell-set env vars still win over `.env`. Release builds never load `.env`. CI release builds carry the key and host compiled in from the repository variables (`option_env!` in the backend, Vite's inlining in the renderer), and a `POSTHOG_API_KEY` / `POSTHOG_HOST` set in the environment Fleetify starts in wins over the backend's compiled-in pair. Either way, nothing is sent until the user turns product analytics on.

### Full event list

`docs/ANALYTICS.md` lists every event we emit, every property we drop, and the exact opt-out steps. Keep it in sync with the mapper (`crates/fleetify-backend/src/services/telemetry/posthog/mapper.rs`) and the `capture(...)` callers in `src/`.
