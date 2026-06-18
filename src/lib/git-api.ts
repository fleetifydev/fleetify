/**
 * Renderer-side wrapper around the Electron git/PR IPC bridge.
 *
 * All of these resolve to a `{ ok: boolean, ...payload }` shape so callers
 * can branch with `if (r.ok) ...` instead of catching exceptions. When
 * Electron isn't available (e.g. running the renderer in a plain browser
 * for tests / Storybook) every method returns `{ ok: false, error: msg }`.
 */

type GhCliInfo = { ok: boolean; version: string | null; authed: boolean; ghLogin?: string | null };
type CommitResult = { ok: true; sha: string | null } | { ok: false; error: string };
type PushResult   = { ok: true; branch: string } | { ok: false; error: string; branch?: string };
type PullResult   = { ok: true } | { ok: false; error: string; inConflict?: boolean };
type DiffSummary  = { ok: true; files: string; log: string; stat: string } | { ok: false; error: string };
type PRSummary    = { ok: true; title: string; body: string } | { ok: false; error: string };
type CommitMessage = { ok: true; message: string } | { ok: false; error: string };
type ReviewResult  = { ok: true; review: string; cli?: string } | { ok: false; error: string };

export type RecoveryAction = "pull-rebase" | "force-with-lease" | "set-upstream" | "custom-command" | "manual";
export type RecoveryRisk   = "low" | "medium" | "high";

export type PreflightAction = "nest-ignore" | "abort-rebase" | "manual";
export type PreflightIssue = {
  id: string;
  type: "nested-no-commits" | "mid-rebase";
  severity: "blocking" | "warning";
  description: string;
  data: { path?: string };
  action: PreflightAction;
  command: string;
  risk: RecoveryRisk;
};
type PreflightResult =
  | { ok: true; issues: PreflightIssue[] }
  | { ok: false; error: string };
type ApplyPreflightFixResult = { ok: true; output: string } | { ok: false; error: string };
type DiagnosisResult =
  | {
      ok: true;
      summary: string;
      action: RecoveryAction;
      rationale: string;
      command: string | null;
      risk: RecoveryRisk;
      cli?: string;
    }
  | { ok: false; error: string };
type ApplyRecoveryResult = { ok: true; output: string } | { ok: false; error: string };

export type PRStatus = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  checks: { passing: number; failing: number; pending: number; total: number };
  commentsCount: number;
};
type PRStatusResult  = { ok: true; pr: PRStatus | null } | { ok: false; code?: string; error: string };
type CreatePRResult =
  | { ok: true; prNumber: number | null; prUrl: string; existed?: boolean; repoCreated?: boolean; repoUrl?: string }
  | { ok: false; code?: string; error: string };
type MergeResult     = { ok: true } | { ok: false; code?: string; error: string };
type SyncMainResult  = { ok: true; base: string; prevBranch: string | null } | { ok: false; error: string };
type CarveNextRoundResult = { ok: true; branch: string; base: string } | { ok: false; error: string };

interface GitAPI {
  hasGhCli(): Promise<GhCliInfo>;
  gitCommit(folder: string, message: string): Promise<CommitResult>;
  gitPush(folder: string): Promise<PushResult>;
  gitPullLatest(folder: string, baseBranch?: string): Promise<PullResult>;
  gitDiffSummary(folder: string, baseBranch?: string): Promise<DiffSummary>;
  generatePRSummary(folder: string, baseBranch?: string, tool?: string): Promise<PRSummary>;
  generateCommitMessage(folder: string, tool?: string, isInitial?: boolean): Promise<CommitMessage>;
  reviewDiff(folder: string, baseBranch?: string, tool?: string): Promise<ReviewResult>;
  diagnoseFailure(folder: string, errorMessage: string, tool?: string, context?: string, baseBranch?: string): Promise<DiagnosisResult>;
  applyRecovery(folder: string, action: RecoveryAction, baseBranch?: string, command?: string): Promise<ApplyRecoveryResult>;
  preflightCheck(folder: string): Promise<PreflightResult>;
  applyPreflightFix(folder: string, action: PreflightAction, data?: PreflightIssue["data"]): Promise<ApplyPreflightFixResult>;
  createPR(folder: string, opts: { title: string; body?: string; base?: string; draft?: boolean; featureBranch?: string; tool?: string; method?: "gh" | "cli" | "oauth" | "link" }): Promise<CreatePRResult>;
  getPRStatus(folder: string, prNumber?: number | null, authMethod?: string, authStored?: string): Promise<PRStatusResult>;
  /** Bulk PR snapshot for the branch picker — one `gh pr list` call
   *  drives the per-branch PR badges instead of N `gh pr view`s. */
  listPRs?(folder: string, limit?: number, authMethod?: string, authStored?: string): Promise<{
    ok: boolean;
    prs?: Array<{
      number: number;
      state: string;
      headRefName: string;
      isDraft?: boolean;
      mergeable?: string;
    }>;
    error?: string;
  }>;
  mergePR(folder: string, prNumber: number | null, method: "squash" | "merge" | "rebase", authMethod?: string, authStored?: string): Promise<MergeResult>;
  /** `git push origin --delete <branch>` (gh-routed or REST), idempotent —
   *  used to clean up a session's merged feature branch on next round.
   *  Auth-routed the same way as the PR IPCs (see git_host::resolve_auth_method). */
  deleteRemoteBranch?(folder: string, branch: string, authMethod?: string, authStored?: string): Promise<{ ok: boolean; error?: string }>;
  /** `gh pr ready <number>` — converts a draft PR to "ready for
   *  review". Used by the Merge button so one click un-drafts +
   *  squash-merges in sequence. */
  markPRReady?(folder: string, prNumber: number, authMethod?: string, authStored?: string): Promise<{ ok: boolean; error?: string }>;
  /** Open the PR in the browser. With `prNumber` the exact /pull/<n>
   *  page opens; without it the backend tries to resolve the current
   *  branch's PR via gh before falling back to the repo's /pulls list. */
  openPR(folder: string, prNumber?: number): Promise<{ ok: boolean; error?: string }>;
  syncMain(folder: string, baseBranch?: string): Promise<SyncMainResult>;
  carveNextRound(folder: string, branch: string, baseBranch?: string): Promise<CarveNextRoundResult>;
  setBaseBranch?(folder: string, branch: string): Promise<{ ok: boolean; base?: string; error?: string }>;
}

/** The user's chosen GitHub auth method, persisted by onboarding / the
 *  auth-choice dialog under localStorage["fleet:github-auth-method"].
 *  "skip"/absent → undefined (let the backend probe). Forwarded to the PR
 *  IPCs so list/status/ready/merge use the SAME backend (OAuth-REST or gh)
 *  the user signed in with — see git_host::resolve_auth_method. */
function storedAuthMethod(): "oauth" | "cli" | undefined {
  try {
    const v = localStorage.getItem("fleet:github-auth-method");
    return v === "oauth" || v === "cli" ? v : undefined;
  } catch {
    return undefined;
  }
}

const FAIL = (error: string) => ({ ok: false as const, error });

function api(): GitAPI {
  const w = (typeof window !== "undefined" ? window : {}) as unknown as { electronAPI?: GitAPI };
  return w.electronAPI ?? {
    hasGhCli:      async () => ({ ok: false, version: null, authed: false, ghLogin: null }),
    gitCommit:     async () => FAIL("electron unavailable"),
    gitPush:       async () => FAIL("electron unavailable"),
    gitPullLatest: async () => FAIL("electron unavailable"),
    gitDiffSummary: async () => FAIL("electron unavailable"),
    generatePRSummary: async () => FAIL("electron unavailable"),
    generateCommitMessage: async () => FAIL("electron unavailable"),
    reviewDiff:    async () => FAIL("electron unavailable"),
    diagnoseFailure: async () => FAIL("electron unavailable"),
    applyRecovery: async () => FAIL("electron unavailable"),
    preflightCheck: async () => FAIL("electron unavailable"),
    applyPreflightFix: async () => FAIL("electron unavailable"),
    createPR:      async () => FAIL("electron unavailable"),
    getPRStatus:   async () => ({ ok: true, pr: null }),
    mergePR:       async () => FAIL("electron unavailable"),
    openPR:        async () => ({ ok: false, error: "electron unavailable" }),
    syncMain:      async () => FAIL("electron unavailable"),
    carveNextRound: async () => FAIL("electron unavailable"),
    deleteRemoteBranch: async () => FAIL("electron unavailable"),
  };
}

export const git = {
  hasGhCli:       () => api().hasGhCli(),
  commit:         (folder: string, message: string) => api().gitCommit(folder, message),
  push:           (folder: string) => api().gitPush(folder),
  pullLatest:     (folder: string, baseBranch?: string) => api().gitPullLatest(folder, baseBranch),
  diffSummary:    (folder: string, baseBranch?: string) => api().gitDiffSummary(folder, baseBranch),
  /** Uses the active session's CLI provider (claude/codex/gemini) to
   *  draft a PR title + body from the diff. Pass the agent's `tool`
   *  string so we route to the right binary. */
  generatePRSummary: (folder: string, baseBranch?: string, tool?: string) =>
                       api().generatePRSummary(folder, baseBranch, tool),
  /** Draft a one-line commit message for the working tree's pending
   *  changes via the session's CLI. `isInitial` flips the prompt to
   *  the "first commit on a fresh repo" variant. */
  generateCommitMessage: (folder: string, tool?: string, isInitial?: boolean) =>
                           api().generateCommitMessage(folder, tool, isInitial),
  /** Run a one-shot agent review pass over the diff. Returns
   *  markdown the renderer displays in the Review dialog. Mirrors
   *  Conductor's Review action. */
  reviewDiff:     (folder: string, baseBranch?: string, tool?: string) =>
                    api().reviewDiff(folder, baseBranch, tool),
  /** Ask the session agent to diagnose a failed git/gh command.
   *  Returns a structured diagnosis with a recovery action drawn
   *  from a whitelisted set — never a free-form command. */
  diagnoseFailure: (folder: string, errorMessage: string, tool?: string, context?: string, baseBranch?: string) =>
                     api().diagnoseFailure(folder, errorMessage, tool, context, baseBranch),
  /** Execute one of the whitelisted recovery actions returned by
   *  diagnoseFailure. The action verb maps to a fixed command in
   *  the main process; agent-provided `command` strings are
   *  ignored. */
  applyRecovery:  (folder: string, action: RecoveryAction, baseBranch?: string, command?: string) =>
                    api().applyRecovery(folder, action, baseBranch, command),
  /** Detect structural state that would block the Create PR happy
   *  path (nested git repos, mid-rebase, detached HEAD with diff,
   *  tracked build-output dirs). Returns a list of issues; the
   *  PreflightDialog presents each with a one-click Fix button. */
  preflightCheck: (folder: string) => api().preflightCheck(folder),
  /** Apply a single whitelisted preflight fix. */
  applyPreflightFix: (folder: string, action: PreflightAction, data?: PreflightIssue["data"]) =>
                       api().applyPreflightFix(folder, action, data),
  createPR:       (folder: string, opts: { title: string; body?: string; base?: string; draft?: boolean; featureBranch?: string; tool?: string; method?: "gh" | "cli" | "oauth" | "link" }) => api().createPR(folder, opts),
  prStatus:       (folder: string, prNumber?: number | null) => api().getPRStatus(folder, prNumber, undefined, storedAuthMethod()),
  prList:         (folder: string, limit?: number) =>
                    api().listPRs?.(folder, limit, undefined, storedAuthMethod()) ?? Promise.resolve({ ok: false, error: "electron unavailable" }),
  mergePR:        (folder: string, prNumber: number | null, method: "squash" | "merge" | "rebase" = "squash") =>
                    api().mergePR(folder, prNumber, method, undefined, storedAuthMethod()),
  markPRReady:    (folder: string, prNumber: number) =>
                    api().markPRReady?.(folder, prNumber, undefined, storedAuthMethod())
                    ?? Promise.resolve({ ok: false, error: "electron unavailable" }),
  openPR:         (folder: string, prNumber?: number) => api().openPR(folder, prNumber),
  /** Post-merge cleanup: switch the source repo to `baseBranch`
   *  (default "main") and pull --ff-only. Runs on the SOURCE repo,
   *  not the agent's worktree — caller passes the source path. */
  syncMain:       (folder: string, baseBranch?: string) => api().syncMain(folder, baseBranch),
  /** Post-merge "next round": from inside the agent's working dir
   *  (worktree or source), fetch origin/<base> and force-recreate
   *  the session's feature branch on top so the next chunk of work
   *  starts from a fresh, up-to-date branch. */
  carveNextRound: (folder: string, branch: string, baseBranch?: string) =>
                    api().carveNextRound(folder, branch, baseBranch),
  /** Delete a remote branch, auth-routed (gh vs REST) and idempotent —
   *  used to clean up a session's merged branch on next round. */
  deleteRemoteBranch: (folder: string, branch: string) =>
                        api().deleteRemoteBranch?.(folder, branch, undefined, storedAuthMethod())
                        ?? Promise.resolve({ ok: false, error: "electron unavailable" }),
  /** "Create new main branch" — pins `branch` as this clone's logical
   *  base via `git config fleetify.baseBranch`, carving it from the
   *  current base when it doesn't already exist. Nondestructive: does
   *  not push, rename, or change the remote default. */
  setBaseBranch:  (folder: string, branch: string) =>
                    api().setBaseBranch?.(folder, branch)
                    ?? Promise.resolve({ ok: false, error: "electron unavailable" }),
};

/**
 * Default branch-name → PR title heuristic, so the dialog isn't empty.
 * "claude/wonderful-grothendieck-f03a45" → "wonderful grothendieck f03a45"
 * Caller can replace with anything fancier (AI-generated etc.).
 */
export function defaultPRTitle(branch: string): string {
  return branch
    .replace(/^[^/]+\//, "")          // strip "claude/" prefix
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 72);
}

/** Default body from a diff summary — file list + commit log. */
export function defaultPRBody(summary: { files: string; log: string; stat: string }): string {
  const out: string[] = [];
  if (summary.log) {
    out.push("## Commits");
    out.push("");
    out.push(summary.log.split("\n").map(l => `- ${l}`).join("\n"));
    out.push("");
  }
  if (summary.files) {
    const files = summary.files.split("\n").filter(Boolean);
    if (files.length > 0) {
      out.push("## Files changed");
      out.push("");
      out.push(files.slice(0, 50).map(f => `- \`${f}\``).join("\n"));
      if (files.length > 50) out.push(`- …and ${files.length - 50} more`);
      out.push("");
    }
  }
  if (summary.stat) {
    out.push(`_${summary.stat.trim()}_`);
  }
  return out.join("\n");
}
