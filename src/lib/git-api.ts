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
type PRStatusResult  = { ok: true; pr: PRStatus | null } | { ok: false; error: string };
type CreatePRResult =
  | { ok: true; prNumber: number | null; prUrl: string; existed?: boolean; repoCreated?: boolean; repoUrl?: string }
  | { ok: false; code?: string; error: string };
type MergeResult     = { ok: true } | { ok: false; error: string };
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
  createPR(folder: string, opts: { title: string; body?: string; base?: string; draft?: boolean; featureBranch?: string; tool?: string }): Promise<CreatePRResult>;
  getPRStatus(folder: string, prNumber?: number | null): Promise<PRStatusResult>;
  mergePR(folder: string, prNumber: number | null, method: "squash" | "merge" | "rebase"): Promise<MergeResult>;
  openPR(folder: string): Promise<{ ok: boolean; error?: string }>;
  syncMain(folder: string, baseBranch?: string): Promise<SyncMainResult>;
  carveNextRound(folder: string, branch: string, baseBranch?: string): Promise<CarveNextRoundResult>;
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
  createPR:       (folder: string, opts: { title: string; body?: string; base?: string; draft?: boolean; featureBranch?: string; tool?: string }) => api().createPR(folder, opts),
  prStatus:       (folder: string, prNumber?: number | null) => api().getPRStatus(folder, prNumber),
  mergePR:        (folder: string, prNumber: number | null, method: "squash" | "merge" | "rebase" = "squash") =>
                    api().mergePR(folder, prNumber, method),
  openPR:         (folder: string) => api().openPR(folder),
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
