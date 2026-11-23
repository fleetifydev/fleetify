# Fleetify git/PR/CI E2E — findings

## F1 — `origin` leaks into the working-branch picker; picking it detaches HEAD
- **Where:** `src-tauri/src/shell/git.rs::list_branches` + `src/components/git/branch-picker-menu.tsx` (rows useMemo)
- **Repro:** any repo that has `refs/remotes/origin/HEAD` (every `git clone`, or after `git fetch`/`git remote set-head`). Open the working-branch pill.
- **Cause:** `git for-each-ref --format=%(refname:short) refs/remotes` shortens `refs/remotes/origin/HEAD` to bare `origin`. The renderer only skips `trimmed === "HEAD"`, so `origin` survives as a row.
- **Effect:** clicking it runs `git checkout origin` -> succeeds into **detached HEAD** in the session worktree. Strip then shows a stale branch label and drops Review / Create PR entirely.
- **Secondary:** `r.replace(/^origin\//, "")` hardcodes the remote name, so a second remote (`upstream/foo`) is offered verbatim -> `git checkout upstream/foo` -> detached HEAD too.

## F2 — orphaned permission card survives the end of the turn and disables the composer
- **Repro:** agent asks for a PowerShell permission (`git diff -- src/app.js`), the tool call times out CLI-side, the agent finishes the turn via another tool and prints its final answer.
- **Observed:** the PERMISSION card (Deny / Allow / Always allow) is still rendered after the turn ends; composer placeholder stays "Approve or deny above to continue…" and both the textbox and Send are disabled. Only a manual Deny unblocks it.
- **Expected:** a turn that has completed should clear any still-pending permission request (or at least re-enable the composer).

## F3 — PR dialog "Generate with AI" always times out on a branch with no commits yet
- **Where:** `src-tauri/src/shell/ai_git.rs::generate_pr_summary`
- **Repro:** fresh worktree round, agent edits files but does not commit, open Create PR dialog -> "Generate with AI" (title or description). Inline error: "claude timed out". Reproduced twice.
- **Cause:** the prompt context is built ONLY from the commit range (`{base}...HEAD` / `{base}..HEAD`). With no commits the model receives `(no commits)` / `(no files)` / empty diff, so Claude Code goes and explores the repo itself to answer. Measured directly: identical prompt with a real diff = **5.7 s**; the empty-context prompt = **36.5 s** > the 25 s timeout.
- **Why auto-Create-PR is unaffected:** `create_pr_via_gh` runs `git add -A` + auto-commit BEFORE calling `generate_pr_summary`, so its range is never empty. The dialog calls it pre-commit.
- **Fix:** include the working-tree diff (staged + unstaged) when the commit range is empty — `review_diff` already does this (`git diff --unified=3` at ai_git.rs:373).

## F4 — a mergeable FOREIGN PR hides Create PR / Review for the whole session  [INTENDED BEHAVIOUR — needs a product call, NOT fixed]
- **Where:** `src/components/git/branch-strip.tsx:1382` (`selectedMergeable` -> `createBlocked`, and `showReview`)
- **Repro:** off-worktree session in a repo that has any open, mergeable PR from another branch. The repo-wide poll auto-selects that PR (`openPrsList[0]` fallback). Make a real edit in the session.
- **Observed:** strip shows `#3 · Open | main | fleet/<planned> | Open · #3 · Merge`. **Create PR and Review are gone**, even though the session has uncommitted work of its own. `PrSwitcherChip` has no "none"/deselect row (`onSelect: (n: number)`), so there is no way to get them back.
- **Cause:** `selectedMergeable = !!effSelectedRepoPr && resolveMergeGate(selectedPr).canMerge` blocks the create slot regardless of whether the selected PR belongs to the working branch.
- **Status:** this is SPECIFIED, not an oversight — `branch-strip.test.tsx` ("Issue 1") explicitly pins "hides Create PR + Review once the selected (foreign) PR is mergeable". I wrote the fix (gate `selectedMergeable` on `effSelectedIsBranchPr`), saw it break that test, and **reverted it**: reversing a deliberate product decision is the user's call, not mine.
- **Why it is still worth raising:** in any repo that has one open mergeable PR, every session in that repo loses Create PR + Review permanently, including one holding real uncommitted work. Possible fix if wanted: gate `selectedMergeable` on `effSelectedIsBranchPr`.

## F5 — the PR dialog commits + pushes to the DEFAULT BRANCH (no feature-branch carve)
- **Where:** `src/components/git/pr-dialog.tsx:173`
- **Repro:** off-worktree session whose HEAD is the default branch (the normal shape — the `fleet/…` branch is only *planned* until the first PR). Make an edit -> "More create options" -> "Create with custom title…" (or "Create draft PR") -> Create.
- **Observed:** dialog header reads `main → main`. Backend trace: `git add -A` -> `auto-commit` -> `FAIL · push HEAD · ! [rejected] HEAD -> main`. The commit landed **on main**, and the push targeted **main**. The planned `fleet/fleetify-e2e-lab-7d12910e` branch was never created.
- **Cause:** the split-button path computes `const featureBranch = isBootstrap ? plannedBranch! : undefined` (`branch-strip.tsx:1719`) and forwards it (`:1866`). The dialog calls `git.createPR(folder, { title, body, base, draft })` with **no `featureBranch`**, so `create_pr_via_gh` has nothing to carve and commits onto the current branch.
- **Severity:** high — only the stale-remote push rejection stopped this from silently landing agent work on `main`. With an up-to-date origin the push succeeds and `gh pr create --head main --base main` is what fails.
- **Fix:** pass the same `featureBranch` the split button computes into `PRDialog`, and forward it in the `createPR` call.

## F6 — `.fleetify-worktrees/` is not gitignored in a pre-existing repo, so `git add -A` commits it as a gitlink
- **Where:** `src-tauri/src/shell/git.rs::create_pr_via_gh` (`write_gitignore_if_missing` is only called inside the `if !owns_repo` git-init branch)
- **Repro:** existing git repo with no `.gitignore` (or one lacking the entry) -> create a worktree session -> Create PR from any session in that repo.
- **Observed:** trace line `ok · git add -A (pre-push) · warning: adding embedded git repository: .fleetify-worktrees/5f5db2e0-…-r3`, and the resulting commit contains `.fleetify-worktrees/<uuid>` as a **gitlink**: `git show --stat` -> `.fleetify-worktrees/5f5db2e0-…-r3 | 1 +`.
- **Effect:** Fleetify's internal worktree dir is committed into the user's repo/PR as an embedded repository. Clones get a broken empty directory. The repo also permanently shows `?? .fleetify-worktrees/` in `git status`.
- **Fix:** ensure the `.fleetify-worktrees/` ignore entry on every session create / pre-push, not just on `git init` (append to an existing `.gitignore`, or add to `.git/info/exclude` so the user's tracked `.gitignore` is left alone).

## F7 — Review dialog times out on a trivial diff (35 s budget vs ~39 s real cost)
- **Where:** `src-tauri/src/shell/ai_git.rs::review_diff` (`Duration::from_secs(35)`)
- **Repro:** worktree session, 4-line uncommitted diff, click Review. Dialog renders "claude timed out / Retry / Re-run / Close".
- **Measured on this machine:** same prompt via `claude --print` = **39.4 s** (the CLI also went and read `package.json`/`index.js` on its own); with `--tools ""` = **30.5 s**. The 400-word review is simply a long generation, so 35 s is a coin flip.
- **Fix:** raise the AI budgets to something a CLI agent can actually meet (review 35 -> 90 s, PR summary 25 -> 60 s, commit message 20 -> 45 s) and pass `--tools ""` on these one-shot summarisation calls so the CLI answers from the supplied diff instead of exploring the repo (also stops a "review" from touching files).

## Not covered (environment limits, not defects)
- **Re-run failed check**: needs a real GitHub Actions check run. This account queues **0** Actions runs on private repos (`actions/permissions` = enabled, workflow registered + active, `actions/runs` total_count = 0), so only commit statuses were available, and commit statuses are correctly not re-runnable (`canRerun` requires `r.rerunnable`).
- **Branch-protection-gated merge (BLOCKED)**: `PUT /branches/main/protection` returns 403 "Upgrade to GitHub Pro or make this repository public". Not exercised.
- **Strip tier 1 / tier 2 gating** (no `git` on PATH / GitHub not connected): would require removing git from PATH or logging the user's `gh` CLI out. Not exercised.
