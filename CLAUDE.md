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
cargo fmt --all -- --check                           # format check
cargo clippy --workspace --all-targets -- -D warnings # lint, deny-warnings
cargo test --workspace                               # rust unit + integration
npm run lint                                         # eslint
npm test                                             # vitest (renderer)
npx tsc -b tsconfig.build.json --noEmit              # type-check
node scripts/release/discover-sidecars.mjs \
  --format=tauri-externalbin --check                 # sidecar drift guard
```

Run all of these locally **before pushing**. CI runs the same set on every PR (see PR #2's `ci.yml`).

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
└── reveng-mcp/            # stdio MCP: fetch_url + save_asset + …

src-tauri/                 # Tauri v2 shell, embeds fleetify-backend in setup()
src/                       # React + Vite renderer
scripts/                   # release helpers + dev-tauri-wt.mjs
docs/                      # RELEASE.md, RUNNING.md, PHASE_STATUS.md, etc.
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

## Commit etiquette

- Conventional-commit titles (`feat(scope):`, `fix(scope):`, `ci:`, `docs:`, `chore:`, `test:`, `refactor:`, `perf:`, `deps:`, `revert:`, `build:`). PR title becomes the changelog entry once release-please lands.
- Body: explain *why*, not *what*. The diff shows what.
- One logical change per commit. If a refactor lands alongside a feature, split them.
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
