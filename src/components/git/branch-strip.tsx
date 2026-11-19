/**
 * BranchStrip — the Claude-Code-style git context strip that sits
 * above the chat composer. Extracted verbatim from chat-input.tsx
 * (it had grown to ~1400 lines inside an already 5k-line file).
 *
 * Exports:
 *   BranchStrip        — the strip component
 *   computeBranchName  — renderer-side mirror of the backend's
 *                        compute_branch_name (consumed by ChatInput)
 */
import { useState, useRef, useCallback, useEffect } from "react";
import {
  ChevronDown, Check,
  GitBranch, GitPullRequest, ArrowLeft,
  X, Loader2, Copy, GitMerge, ExternalLink,
  CircleSlash, RefreshCw, FolderGit2,
} from "lucide-react";
import { truncateMid, folderName } from "@/lib/utils";
import { openExternalUrl } from "@/lib/links";
import { PRDialog } from "@/components/git/pr-dialog";
import { ReviewDialog } from "@/components/git/review-dialog";
import { AuthChoicePopover } from "@/components/git/auth-choice-popover";
import { BranchPickerMenu } from "@/components/git/branch-picker-menu";
import { RecoveryDialog } from "@/components/git/recovery-dialog";
import { PreflightDialog } from "@/components/git/preflight-dialog";
import { resolveMergeGate } from "@/components/git/merge-gate";
import { PrChecksIndicator } from "@/components/git/pr-checks-indicator";
import { PrChecksPopover } from "@/components/git/pr-checks-popover";
import { applyRerunOverlay } from "@/components/git/rerun-overlay";
import type { PreflightIssue } from "@/lib/git-api";
import { git, type PRStatus, type CheckRun, defaultPRTitle, defaultPRBody } from "@/lib/git-api";
import { github } from "@/lib/github-link-api";
import { glog } from "@/lib/git-log";
import { useAppStore, COMPOSER_CHAT_KEY } from "@/stores/app-store";
import { pushChatError, useChatStore, selectSession } from "@/stores/chat-store";
import { sessionNextRoundWorktree } from "@/lib/api";
import { useRepoPrs, useOpenPrs, usePrStore, type RepoPr } from "@/stores/pr-store";
import { PrSwitcherChip, prIconColor } from "@/components/git/pr-switcher-chip";
/* ── BranchStrip ──
   The Claude-Code-style git context strip that sits ABOVE the chat
   textarea. Layout (left → right):

     [pr icon] base ← branch                         [+X −Y]  [Create PR]

   Visible only when:
     1) we have a project folder (renderer can ask main for git data)
     2) git returned a branch (i.e. the folder is a real repo)
     3) the current branch is NOT the base branch (no point showing
        "main ← main" with zero diff — it's noise)

   Diff stats poll on a slow cadence + on focus so the user sees fresh
   numbers without us hammering git every keystroke. Create PR opens
   `<remote>/pull/new/<branch>` via shell.openExternal — works for both
   GitHub and most GitLab setups.
*/
type GitContext = {
  branch: string | null;
  baseBranch: string | null;
  plus: number;
  minus: number;
  /** Commits the local base branch is BEHIND its remote (origin/<base>), and
   *  only when a pure fast-forward is possible — the backend reports 0 when the
   *  base is diverged or up to date. Drives the standalone "Sync <base>" action.
   *  Optional so partial/legacy context payloads default to "not behind". */
  baseBehind?: number;
  remoteHttpsUrl: string | null;
};

/** Branch names that conventionally serve as the integration branch
 *  when `baseBranch` is unknown. Used to detect "on default branch"
 *  in the no-remote case where we can't resolve the upstream HEAD. */
const KNOWN_DEFAULTS = new Set(["main", "master"]);

/** While a conflict-resolution turn is in flight we poll the PR faster
 *  than the normal 15s status cadence so the squash-merge fires promptly
 *  once the agent's push clears the conflict. Short-lived (only during an
 *  active, user-initiated resolve). */
const RESOLVE_POLL_MS = 2000;
/** Optimistic-pending grace after a re-run is triggered: past this we trust the
 *  server's reported state even if a re-run check still reads "failing" (e.g. it
 *  re-failed fast), so a silently-failed re-run can't pin "Pending" forever. */
const RERUN_GRACE_MS = 30_000;
/** Give up waiting after this long (agent couldn't resolve / push failed)
 *  so the UI never spins forever; we surface a ChatError and stop. */
const RESOLVE_TIMEOUT_MS = 5 * 60 * 1000;

/** Claude-Code-idiomatic conflict-resolution prompt. The closing line
 *  tells the agent NOT to run `gh pr merge` — the app owns the final
 *  squash-merge (auth-correct), avoiding a double-merge. */
function buildResolvePrompt(base: string, prNumber: number): string {
  return [
    `The current branch has merge conflicts with \`${base}\` that are blocking PR #${prNumber}.`,
    ``,
    `Please resolve them directly in this repository:`,
    `1. \`git fetch origin\``,
    `2. Merge the base in: \`git merge origin/${base}\` (use a rebase if that's cleaner for this history).`,
    `3. Resolve every conflict, preserving the intent of both sides — don't discard either branch's changes. If two changes are genuinely incompatible, prefer the safer/more-complete one and say so.`,
    `4. Stage the resolved files and commit (e.g. "Merge ${base} and resolve conflicts").`,
    `5. \`git push\`.`,
    ``,
    `Once the push lands, PR #${prNumber} becomes mergeable and Fleetify will complete the squash-merge. Don't change unrelated code.`,
  ].join("\n");
}

/* ── Copyable branch label ──
   Inline pill that shows a branch name. The body click BUBBLES to the
   enclosing PillTrigger (which opens the branch menu) — the pill itself
   does NOT copy. A copy button slides in on hover and copies the full
   name on its own click, calling stopPropagation so it never also opens
   the menu. (Per user request: click name → menu; click copy icon → copy.) */
function BranchPill({ text, tone, dim }: {
  /** Full branch name. The pill MIDDLE-truncates for display when the
   *  name exceeds 32 chars, but `text` is what lands in the clipboard
   *  — copying a `fleet/long-feature-branch-name-deadbeef` gave us a
   *  truncated `fleet/long-fe…ef` instead of the original because
   *  callers used to pass the already-truncated string. Internalising
   *  the truncation keeps display and copy in lockstep. */
  text: string;
  tone: "low" | "med";
  dim?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    // Copy ONLY — stop the event so it never reaches the enclosing
    // PillTrigger (which would also open the branch menu).
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [text]);
  const display = truncateMid(text, 32);
  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={text}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "1px 6px",
        borderRadius: 5,
        fontFamily: "var(--font-mono)", fontSize: 12,
        fontWeight: 500, letterSpacing: -0.15,
        // Compact reference: --c-med for base, --c-high for current
        // branch keeps contrast legible at the smaller 12px scale
        // without making the strip feel oversized.
        color: tone === "low" ? "var(--c-med)" : "var(--c-high)",
        background: hovered ? "rgba(var(--fg-rgb), 0.08)" : "transparent",
        transition: "background 0.12s",
        maxWidth: 320,
        overflow: "hidden", whiteSpace: "nowrap",
        opacity: dim ? 0.55 : 1,
        border: dim ? "1px dashed rgba(var(--fg-rgb), 0.20)" : "none",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {display}
      </span>
      {(hovered || copied) && (
        <span
          role="button"
          tabIndex={0}
          onClick={onCopy}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") onCopy(e); }}
          onMouseDown={e => e.preventDefault()}
          title={copied ? "Copied" : `Copy ${text}`}
          style={{
            display: "inline-flex", alignItems: "center", flexShrink: 0,
            cursor: "pointer", borderRadius: 3, padding: 1,
          }}
        >
          {copied
            ? <Check size={10} strokeWidth={2.2} style={{ color: "var(--c-high)" }} />
            : <Copy size={10} strokeWidth={1.85} style={{ color: "var(--c-low)" }} />}
        </span>
      )}
    </span>
  );
}

/* ── No-git state pill ──
   Fallback when we don't have a planned branch name to show yet (no
   sessionId, or sessionId hasn't reached BranchStrip). Once the
   session id is wired through, the strip renders "main ← fleet/…" as
   a dimmed planned label instead so the user sees what bootstrap
   will produce. */
function NoGitPill() {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "1px 8px",
      fontSize: 12, fontWeight: 500,
      background: "rgba(var(--fg-rgb), 0.04)",
      border: "1px dashed rgba(var(--fg-rgb), 0.20)",
      color: "var(--c-dim)",
      borderRadius: 5,
      fontFamily: "var(--font-mono)",
    }}>
      <CircleSlash size={11} strokeWidth={1.75} />
      No git
    </span>
  );
}

/* ── PillTrigger ──
   Click-only wrapper around a BranchPill so the base + working pills
   in BranchStrip can open their respective BranchPickerMenu modes
   independently. Keeps the per-pill hover feedback subtle (just a soft
   surface lift), separate from any outer container hover. */
function PillTrigger({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={e => { e.stopPropagation(); onClick(); }}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.04)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 5,
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      {children}
    </span>
  );
}

/* ── computeBranchName ──
   Renderer-side mirror of backend/app/services/worktree.py's
   `compute_branch_name`. Used by the BranchStrip to render the
   "planned" fleet/<slug>-<id> label BEFORE backend session-start
   has carved it (or when the carve failed silently and the source
   repo is still on main). Keep the slug rules byte-identical to
   the Python helper — drift means the renderer shows one name and
   the backend creates a different one. */
export function computeBranchName(
  label: string | null | undefined,
  sessionId: string,
  /** Optional fallback when `label` is empty or the "New chat"
   *  placeholder — derives the slug from the folder basename instead
   *  of the raw session id. Lets compose-mode strips show
   *  `fleet/<folder>-<id>` immediately when the user picks a folder
   *  without us having to mirror the title into composer state. */
  projectPath?: string | null,
): string {
  const labelTrimmed = label?.trim();
  const usableLabel = labelTrimmed && labelTrimmed !== "New chat"
    ? labelTrimmed
    : null;
  const fallback = projectPath ? folderName(projectPath) : "";
  const raw = usableLabel || fallback || sessionId;
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
  const slug = cleaned.slice(0, 48) || "session";
  return `fleet/${slug}-${sessionId.slice(0, 8)}`;
}

/** Inputs to {@link resolveStripSelection} — the already-computed repo-wide
 *  selection (`effectiveSelectedNumber` / `selectedIsBranchPr` /
 *  `selectedRepoPr`) plus the working-branch PR (`pr` / `branchOpenPr`), the
 *  foreign-PR detail poll, and the `isWorktree` flag. */
export interface StripSelectionInput {
  isWorktree: boolean;
  /** The working branch's PR (any state), or null. */
  pr: PRStatus | null;
  /** `pr` iff it's OPEN and GitHub is connected, else null. */
  branchOpenPr: PRStatus | null;
  /** Repo-wide effective selection number (explicit pick → branch PR →
   *  newest open). The worktree override ignores this entirely. */
  effectiveSelectedNumber: number | null;
  /** Whether the repo-wide selection is the working branch's own PR. */
  selectedIsBranchPr: boolean;
  /** The repo-wide open-PR store entry for the current selection (the chip's
   *  source PR; may be a FOREIGN PR). Sourced from `openPrsList` so it's a
   *  `RepoPr`; a `PRStatus` (the branch PR) is structurally assignable too. */
  selectedRepoPr: RepoPr | null;
  /** The foreign-PR detail-poll result (null in worktree mode — its poll is
   *  short-circuited). */
  foreignPr: PRStatus | null;
}

/** The strip's *effective* selection after the worktree override. */
export interface StripSelection {
  /** Number the merge/open/resolve paths act on. */
  effSelectedNumber: number | null;
  /** Whether the effective selection is the working branch's own PR. */
  effSelectedIsBranchPr: boolean;
  /** Full PRStatus the merge cluster reads (`det`). */
  effSelectedPr: PRStatus | null;
  /** The gate the merge cluster renders on (replaces `selectedRepoPr`).
   *  `RepoPr` off-worktree (the store entry); the branch `PRStatus` in
   *  worktree mode, which is structurally assignable to `RepoPr`. */
  effSelectedRepoPr: RepoPr | null;
  /** Whether the repo-wide PR switcher chip may render. Always false in
   *  worktree mode. */
  showSwitcher: boolean;
}

/**
 * Worktree-mode PR-selection lock (pure, unit-tested without React).
 *
 * Off-worktree the strip targets the repo-wide selection (spec §6): the
 * switcher chip + merge cluster follow whatever PR the user picked, falling
 * back to the working branch's PR then the newest open PR. That fallback can
 * resolve to a FOREIGN PR.
 *
 * In worktree mode one session ↔ one branch ↔ one PR. We ignore the repo-wide
 * selection entirely and bind the strip to THIS branch's own PR (`pr`), so a
 * foreign PR in `openPrsList` can never become the merge/Resolve target, and
 * the repo-wide switcher is hidden. When the branch has no PR yet, the
 * effective selection collapses to "nothing" (never a foreign PR).
 *
 * Off-worktree the return is byte-identical to the inline values it replaces.
 */
export function resolveStripSelection(input: StripSelectionInput): StripSelection {
  const {
    isWorktree, pr, branchOpenPr, effectiveSelectedNumber,
    selectedIsBranchPr, selectedRepoPr, foreignPr,
  } = input;

  if (isWorktree) {
    // Bind to the working branch's own PR; ignore the repo-wide selection.
    // `effSelectedRepoPr` is the merge-cluster gate and MUST stay OPEN-only
    // (mirroring the off-worktree `selectedRepoPr`, sourced from openPrsList) —
    // so a CLOSED/MERGED branch PR still falls through to the Sync-main /
    // Closed states instead of rendering a dead Open·#N + Merge pair.
    // `branchOpenPr` is `pr` iff it's OPEN, so it is exactly that gate.
    const effSelectedRepoPr = branchOpenPr;
    return {
      // The hidden switcher would read this; the `pr?.number` fallback keeps it
      // non-null for a CLOSED/MERGED own PR without affecting the cluster.
      effSelectedNumber: branchOpenPr?.number ?? pr?.number ?? null,
      effSelectedIsBranchPr: true,
      // `det`/onMerge target — the branch's own PR, never the foreign poll.
      effSelectedPr: pr,
      effSelectedRepoPr,
      showSwitcher: false,
    };
  }

  // Off-worktree: preserve the existing repo-wide behaviour exactly.
  return {
    effSelectedNumber: effectiveSelectedNumber,
    effSelectedIsBranchPr: selectedIsBranchPr,
    effSelectedPr: selectedIsBranchPr ? pr : foreignPr,
    effSelectedRepoPr: selectedRepoPr,
    showSwitcher: effectiveSelectedNumber != null,
  };
}

/** Inputs to {@link shouldAutoNextRound} — a snapshot of the PR poll's state
 *  at the moment it computes `incoming`, plus the worktree/idle gates. */
export interface AutoNextRoundInput {
  /** Worktree-mode sessions only. Off-worktree keeps the Sync-main path. */
  isWorktree: boolean;
  /** The PR state observed on the PREVIOUS poll tick (`prevPrStateRef`). */
  prevState: string | null;
  /** The PR state this tick (`incoming.state`). */
  incomingState: string | null;
  /** This tick's PR head ref — must equal `ctxBranch` for it to be OUR PR. */
  incomingHeadRef: string | null;
  /** The session's current working branch (`ctx.branch`). */
  ctxBranch: string | null;
  /** A sync/carve (app-merge or a prior external) is already in flight. */
  syncing: boolean;
  /** An app-merge's own-branch carve is already running (`justMergedRef`). */
  justMerged: boolean;
  /** The session is mid-turn — the idle gate blocks auto-advance. */
  isStreaming: boolean;
}

/**
 * Decide whether the PR poll should auto-advance a worktree session to a fresh
 * round on a LIVE external merge (pure; unit-tested without React).
 *
 * Fires only when ALL hold:
 *   - worktree mode (off-worktree uses Sync-main, unchanged);
 *   - we observed the flip THIS session — `prevState === "OPEN"` and
 *     `incomingState === "MERGED"`. Boot-into-merged (no prior OPEN) is
 *     deliberately excluded: there's no flip to detect, so the manual
 *     "Start next round" button owns that case;
 *   - the merged PR is OUR working branch (`incomingHeadRef === ctxBranch`,
 *     both non-null) — a foreign PR merging never advances this session;
 *   - we're not already carving (`!syncing`, `!justMerged` — the latter means
 *     onMerge's own-branch path already triggered the carve directly);
 *   - the session is idle (`!isStreaming`).
 */
export function shouldAutoNextRound(input: AutoNextRoundInput): boolean {
  const {
    isWorktree, prevState, incomingState, incomingHeadRef, ctxBranch,
    syncing, justMerged, isStreaming,
  } = input;
  return (
    isWorktree &&
    prevState === "OPEN" &&
    incomingState === "MERGED" &&
    incomingHeadRef != null &&
    incomingHeadRef === ctxBranch &&
    !syncing &&
    !justMerged &&
    !isStreaming
  );
}

/** Whether the Create-PR/Review slot should be empty-diff-blocked. Worktree
 *  sessions live on a dedicated fleet/… branch that exists to become a PR, so
 *  they show Create PR/Review optimistically even before the first committed
 *  diff — parity with the off-worktree bootstrap path on the default branch.
 *  (The backend surfaces NO_COMMITS gracefully if there is truly nothing to
 *  commit, exactly as the bootstrap path already relies on.) */
export function isEmptyDiffBlocked(opts: {
  isBootstrapShape: boolean;
  isWorktree: boolean;
  plus: number;
  minus: number;
}): boolean {
  if (opts.isBootstrapShape || opts.isWorktree) return false;
  return opts.plus + opts.minus === 0;
}

/** PR affordances (Create PR, Review, auto-PR, PR status) require BOTH a git
 *  context AND a Fleetify GitHub connection. Without git → nothing; with git
 *  but no GitHub connection → only branches (no PR UI); with both → full. */
export function prAffordancesEnabled(githubConnected: boolean, noGit: boolean): boolean {
  return githubConnected && !noGit;
}

/** GitHub is "connected" for the strip when it isn't explicitly disabled and
 *  EITHER the Fleetify OAuth/Settings link is set OR the gh CLI is authed
 *  locally. Recognizing gh-CLI auth avoids forcing a redundant second
 *  connection — the backend already falls back to gh for PR ops. */
export function resolveGithubConnected(opts: { disabled: boolean; flagConnected: boolean; ghCliAuthed: boolean }): boolean {
  return !opts.disabled && (opts.flagConnected || opts.ghCliAuthed);
}

/** PR-op result codes that mean the GitHub auth is genuinely no longer valid
 *  (logged out / token expired), as opposed to a transient failure. The
 *  backend returns one of these after invalidating its own auth cache; the
 *  strip reacts by RESETTING its GitHub connection state. */
const AUTH_FAILURE_CODES = ["AUTH_FAILED", "NO_AUTH", "AUTH_EXPIRED"] as const;
/** Whether a PR-op failure code means the GitHub auth is no longer valid
 *  (logged out / expired), as opposed to a transient network error. */
export function isAuthFailureCode(code: string | undefined | null): boolean {
  return !!code && (AUTH_FAILURE_CODES as readonly string[]).includes(code);
}

export function BranchStrip({ projectPath, sourcePath, tool, controlCenter, sessionId, sessionTitle, plannedBranch, isWorktree = false, onResolveConflicts, permissionMode }: {
  projectPath?: string | null;
  /** True when the resolved projectPath is a git worktree under
   *  `<source-repo>/.fleetify-worktrees/<session-id>/`. Drives the
   *  small "Worktree" indicator pill — communicates to the user that
   *  their file ops live in an isolated checkout, not the source
   *  repo's working tree. */
  isWorktree?: boolean;
  /** Always the SOURCE repo — even when `projectPath` points to a
   *  worktree (worktree-on sessions). Post-merge "Sync main" acts on
   *  this path so the user's main repo catches up with the merged
   *  remote, independent of the worktree's lifecycle. Falls back to
   *  `projectPath` for worktree-off sessions where the two are the
   *  same. */
  sourcePath?: string | null;
  tool?: string | null;
  /** When true (Fleet/staff view), the strip is suppressed entirely —
   *  PR/branch context only makes sense when an agent session is
   *  active and bound to a worktree. The early return MUST come after
   *  hooks (below) to satisfy the rules of hooks; we use it as the
   *  first render-condition gate. */
  controlCenter?: boolean;
  /** The session this strip is bound to. Required for the worktree
   *  next-round flow: `sessionNextRoundWorktree(sessionId, base)` asks the
   *  backend to carve a fresh pristine worktree on a new `-r<N>` branch and
   *  repoint THIS session. Absent on the compose-mode / control-center
   *  surfaces (no session yet), where the next-round paths are no-ops. */
  sessionId?: string | null;
  /** Session title — used as the auto-generated PR title when we
   *  open a draft PR on the user's behalf. Falls back to the branch
   *  name when absent. */
  sessionTitle?: string | null;
  /** The fleet/<slug>-<id> branch this session SHOULD live on. Driven
   *  by `computeBranchName(sessionTitle, sessionId)` in the caller —
   *  available even when the folder hasn't been git-init'd yet, so
   *  the strip can render "main ← fleet/…" as a dimmed placeholder
   *  and the Create PR dispatcher knows which branch to carve. */
  plannedBranch?: string | null;
  /** Hand a conflict-resolution task to the CURRENT session's agent.
   *  Wired by ChatInput to its own `onSend`, so the prompt enters the
   *  live session as a visible turn (the agent resolves in its
   *  worktree). Absent on surfaces with no agent (control-center). */
  onResolveConflicts?: (prompt: string) => void;
  /** Session permission mode. Only consulted to block the resolve flow
   *  in "plan" mode (which forbids the file edits resolution needs). */
  permissionMode?: string | null;
}) {
  const [ctx, setCtx]       = useState<GitContext | null>(null);
  const [pr, setPr]         = useState<PRStatus | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  // Mid-flow GitHub auth picker — shown when the user clicks Create PR
  // without having picked a method during onboarding (or after they
  // explicitly Skipped). The promise resolver is captured so the
  // surrounding await in `executeCreatePR` can suspend on it.
  const [authChoiceOpen, setAuthChoiceOpen] = useState(false);
  const authChoiceResolverRef = useRef<((m: "oauth" | "cli" | null) => void) | null>(null);
  // Branch-switcher popover. Anchored to the BranchStrip pills. Two
  // distinct modes — "base" pops from the base/main pill (list current
  // base + "Create new main branch"), "working" pops from the working
  // pill (list every other branch + "Create new branch"). null = closed.
  // Refresh ctx + pr on every successful checkout so the strip's PR
  // badge / Merge button stays in sync.
  const [branchMenuMode, setBranchMenuMode] = useState<"base" | "working" | null>(null);
  const [draftDialog, setDraftDialog] = useState(false);
  // Review dialog state — Conductor-style. Open via the small ScanEye
  // button beside Create PR; the dialog runs the session agent over
  // the current diff and shows the markdown review.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Sad-path recovery dialog state. Holds the raw error from the
  // failed Create PR call so the RecoveryDialog can hand it to the
  // session agent for a diagnosis + whitelisted recovery action.
  // Cleared via Close / Retry / successful re-attempt.
  const [recovery, setRecovery] = useState<{ error: string } | null>(null);
  // Pre-flight dialog state. Holds the issues that the deterministic
  // scan found (nested-no-commits, mid-rebase). When set, the
  // PreflightDialog opens and `executeCreatePR` is gated behind the
  // user clicking Continue. The agent isn't involved at this layer
  // — these are cases with a single obvious fix.
  const [preflight, setPreflight] = useState<{ issues: PreflightIssue[] } | null>(null);
  // Folders for which we've already auto-fired a draft PR. Per-
  // folder (worktree path) so every session's worktree gets its
  // own one-shot, with retry-on-failure handled inline.
  const autoPrFiredRef = useRef<Set<string>>(new Set());
  // True while the background auto-PR effect is mid-dispatch (its
  // `git.createPR` is in flight). Drives the BranchStrip's "Checking…"
  // placeholder so we never flash Create PR during the 1-3s window
  // when an existing PR exists but the optimistic setPr hasn't fired
  // yet. Cleared in the .then/.catch/.finally branches below.
  const [autoPrInFlight, setAutoPrInFlight] = useState(false);
  // True once prStatus has resolved at least once for the current
  // folder. Without this, the auto-PR effect can't tell "no PR
  // exists" apart from "PR status hasn't loaded yet" — both look
  // like pr === null. Firing too early races a real existing PR
  // and gh pr create errors out with "a PR for this branch already
  // exists", which is then silently swallowed.
  const [prStatusLoaded, setPrStatusLoaded] = useState(false);
  const [merging, setMerging] = useState(false);
  // Set while a conflict-resolution turn is in flight for `prNumber`.
  const [resolving, setResolving] = useState<{ prNumber: number } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // True between the in-app merge click and the moment we observe
  // `pr.state` flip to MERGED via prStatus poll. Gates the auto-
  // cleanup useEffect below — without this we'd also auto-sync when
  // someone merged via the GitHub web UI or when the app boots into
  // an already-merged session, both of which would surprise the user.
  const justMergedRef = useRef(false);
  // True after a successful sync+carve (auto or manual). Tells the
  // prStatus load() callback to IGNORE the stale MERGED PR that
  // `gh pr view` keeps returning for the just-recreated branch
  // (GitHub still associates the branch name with the merged PR's
  // headRefName). Cleared when an OPEN PR for the same branch
  // surfaces (round 2 has started) or when the user clicks Create
  // PR. Without this gate the strip oscillates forever between
  // null and MERGED, the Sync main button keeps reappearing, and
  // re-clicking it just re-runs the cleanup with no visible change.
  const postMergeCleanedRef = useRef(false);
  // The PR state observed on the PREVIOUS poll tick. Drives the live
  // external-merge detector in the poll: we only auto-advance a worktree
  // session when we WATCH the flip from OPEN → MERGED this session. Seeded
  // null so a boot-into-merged session (first poll already MERGED) is NOT a
  // detected flip — that case is owned by the manual "Start next round"
  // button instead. (postMergeCleanedRef swallows the MERGED tick on the
  // very next poll, so the flip must be caught right where `incoming` is
  // computed, before setPr.)
  const prevPrStateRef = useRef<string | null>(null);
  // Timestamp (ms) of the last working-branch PR-status poll. Throttles the
  // focus/visibility re-poll below so rapid alt-tabbing can't hammer `gh` —
  // a foreground event within 3s of the previous poll is ignored.
  const lastPrPollAtRef = useRef(0);
  // Timestamp (ms) of the last gh-CLI auth probe (`git.hasGhCli`). gh auth
  // state changes rarely, so the foreground re-probe is throttled to 30s — a
  // foreground event within that window is ignored. The mount probe is always
  // immediate. Mirrors `lastPrPollAtRef`'s 3s pattern with a wider window.
  const lastGhProbeAtRef = useRef(0);
  // Timestamp (ms) of the last base-branch fetch (`git fetch origin <base>`).
  // The base-behind indicator (ctx.baseBehind) is computed fetch-free, so we
  // refresh origin/<base> on focus to keep it honest — throttled to 30s like
  // the gh probe so rapid alt-tabbing can't hammer the network.
  const lastBaseFetchAtRef = useRef(0);
  // Live ref to doWorktreeNextRound (declared far below the controlCenter
  // early-return and re-created each render). The PR poll + auto-cleanup
  // effects are HOISTED above that declaration to keep the hook count stable,
  // so they call the latest runner through this ref instead of closing over a
  // TDZ const. `.current` is set right after doWorktreeNextRound is declared.
  // Mirrors the onMergeRef pattern already used for the resolve-watcher.
  const doWorktreeNextRoundRef = useRef<(base: string) => void>(() => {});
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);
  // Auto-create flow state — true while we're drafting + submitting
  // a PR straight from the BranchStrip's Create PR button (no
  // dialog). The button label flips to "Creating…" and the click
  // is no-op'd until the in-flight call completes.
  const [autoCreating, setAutoCreating] = useState(false);

  // Reactive idle gate. The next-round auto-advance (and the manual button)
  // must not fire mid-turn — carving a fresh worktree under a streaming agent
  // would yank its cwd out from under an in-flight tool call. We read the
  // ACTIVE session's stream flag (matching how the rest of this file resolves
  // the session for pushChatError) via a hook selector so the gate is
  // reactive: when the turn ends the strip re-renders and the button enables.
  // `selectSession` returns a stable frozen EMPTY_SESSION when the id isn't in
  // the store, so this is hooks-order-safe (always one selector call).
  const activeSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
  const isStreaming = useChatStore(selectSession(sessionId ?? activeSid)).isStreaming;

  // Whether a locally-authed `gh` CLI is available. Probed asynchronously
  // (below) via git.hasGhCli() so a user who ran `gh auth login` counts as
  // connected WITHOUT a separate Fleetify Settings link — the backend already
  // falls back to gh for PR ops. Seeded false so the strip stays branches-only
  // until the probe confirms auth.
  const [ghCliAuthed, setGhCliAuthed] = useState(false);
  // Bumped by `resetGithubConnection` to force `githubConnected` (which reads
  // the localStorage auth flag NON-reactively below) to recompute after the
  // flag is cleared. Needed because when the OAuth/Settings flag — not gh CLI —
  // was the live connection, `setGhCliAuthed(false)` is a no-op (already false)
  // and wouldn't re-render; without this nonce the strip would keep showing the
  // stale connected state until the next incidental render.
  const [authFlagNonce, setAuthFlagNonce] = useState(0);

  // GitHub connection state. Connected when NOT explicitly disabled in
  // Settings → Integrations AND either the Fleetify OAuth/Settings link is set
  // (the same localStorage keys the Create-PR pre-flight + AuthChoicePopover
  // write/read) OR the gh CLI is authed locally (`ghCliAuthed`, probed below).
  // When NOT connected the strip shows only branches: no PR data leaks in and
  // Create PR / Review / auto-PR / PR-status polling are all gated off (see
  // prAffordancesEnabled + the effects below). Derived here (above the
  // PR-status poll + auto-PR effects) so those effects can list it in their
  // dependency arrays without a TDZ. Reads localStorage live; `authFlagNonce`
  // is referenced so a reset (which clears the flag) re-runs this derivation.
  const githubConnected = (() => {
    void authFlagNonce;
    let disabled = false;
    let flagConnected = false;
    try {
      disabled = localStorage.getItem("fleet:settings:github-enabled") === "0";
      const m = localStorage.getItem("fleet:github-auth-method");
      flagConnected = m === "oauth" || m === "cli";
    } catch { /* ignore */ }
    return resolveGithubConnected({ disabled, flagConnected, ghCliAuthed });
  })();

  // Probe the local gh CLI's auth state on mount + whenever the app returns to
  // the foreground (the user may have run `gh auth login` in a terminal while
  // away). A successful authed probe flips `ghCliAuthed`, which re-derives
  // `githubConnected` above and surfaces the PR UI without a Fleetify Settings
  // connection. Failures are swallowed — absent/erroring gh just stays false.
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      lastGhProbeAtRef.current = Date.now();
      git.hasGhCli().then(r => { if (!cancelled) setGhCliAuthed(!!(r && r.ok && r.authed)); }).catch(() => {});
    };
    probe();
    // gh auth state changes rarely; throttle the foreground re-probe to 30s so
    // rapid alt-tabbing can't hammer `gh auth status`. The mount probe above is
    // unthrottled.
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastGhProbeAtRef.current < 30000) return;
      probe();
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => { cancelled = true; window.removeEventListener("focus", onForeground); document.removeEventListener("visibilitychange", onForeground); };
  }, []);

  // Disconnect the strip's GitHub state. Called when a PR op returns an
  // auth-failure code (the backend logged us out / the token expired): clears
  // BOTH connection signals — the persisted Settings auth flag AND the probed
  // gh-CLI auth — so `githubConnected` (= !disabled && (flagConnected ||
  // ghCliAuthed)) flips to false. The strip then falls back to branches-only
  // and the PR poll early-returns. Reconnection self-heals: a later
  // `gh auth login` is re-detected by the throttled probe; OAuth users
  // reconnect via Settings. `setGhCliAuthed(false)` covers the case where gh
  // auth (not the OAuth link) was the live connection — without it, the next
  // probe could re-flip ghCliAuthed and undo the reset.
  const resetGithubConnection = useCallback(() => {
    try { localStorage.removeItem("fleet:github-auth-method"); } catch { /* ignore */ }
    setGhCliAuthed(false);
    // Force `githubConnected` to recompute even when gh CLI wasn't the live
    // connection (so setGhCliAuthed(false) above is a no-op) — otherwise the
    // cleared localStorage flag wouldn't be re-read until the next render.
    setAuthFlagNonce(n => n + 1);
  }, []);

  // Close the Create-PR dropdown when clicking outside it.
  useEffect(() => {
    if (!createMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [createMenuOpen]);

  // Diagnostic: log mount + every projectPath change so the user can
  // verify BranchStrip is rendering for their session at all. Common
  // miss is that hideBranchStrip kept it from mounting, in which case
  // no log appears.
  useEffect(() => {
    console.info("[BranchStrip] mounted/updated", { projectPath, controlCenter });
  }, [projectPath, controlCenter]);

  // Folder resolution — agent's project_path, falling back to Electron's
  // PROJECT_ROOT so the strip works on the Fleet control-center view too.
  useEffect(() => {
    let cancelled = false;
    if (projectPath) { setFolder(projectPath); return; }
    const w = window as unknown as { electronAPI?: { getProjectRoot?: () => Promise<string | null> } };
    w.electronAPI?.getProjectRoot?.().then(root => {
      if (!cancelled) setFolder(root ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectPath]);

  // Branch / diff stats. Two-channel refresh:
  //   1. fs.watch on `<gitdir>/HEAD` fires INSTANTLY when the user
  //      runs `git checkout`, `git switch`, branch creation, etc.
  //      Worktree-safe — `rev-parse --absolute-git-dir` resolves
  //      to the per-worktree gitdir.
  //   2. 5s poll as a fallback for things HEAD doesn't capture —
  //      uncommitted diff stats from file edits, the user staging
  //      from another tool, etc.
  useEffect(() => {
    if (!folder) { setCtx(null); return; }
    let cancelled = false;
    const w = window as unknown as { electronAPI?: {
      getGitContext?: (folder: string) => Promise<GitContext>;
      watchHead?: (folder: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      unwatchHead?: (key: string) => Promise<{ ok: boolean }>;
      onHeadChanged?: (cb: (p: { folder: string; key: string }) => void) => () => void;
    } };
    const api = w.electronAPI;
    if (!api?.getGitContext) return;
    const load = () => {
      api.getGitContext!(folder).then(c => {
        if (!cancelled) setCtx(c ?? null);
      }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 5000);

    const watchKey = `branchstrip:${folder}`;
    let offWatcher: (() => void) | null = null;
    if (api.watchHead && api.onHeadChanged) {
      api.watchHead(folder, watchKey).catch(() => {});
      offWatcher = api.onHeadChanged(({ key }) => {
        if (!cancelled && key === watchKey) load();
      });
    }

    return () => {
      cancelled = true;
      clearInterval(iv);
      offWatcher?.();
      api.unwatchHead?.(watchKey).catch(() => {});
    };
  }, [folder]);

  // Base-branch freshness. `ctx.baseBehind` is computed fetch-free in the
  // backend, so a stale `origin/<base>` would under-report how far the local
  // base has drifted (and the "Sync <base>" action would never appear after an
  // external merge / a teammate's push). We refresh origin/<base> with a
  // fetch-only IPC (no checkout) when the base resolves and whenever the app
  // returns to the foreground, then re-pull the git context so baseBehind is
  // accurate the moment the user looks. Throttled (30s) and off-worktree only —
  // worktree sessions surface the next round via "Start next round", not a base
  // sync. Absent `fetchBase` (e.g. the test harness's partial electronAPI) is a
  // no-op.
  useEffect(() => {
    if (!folder || isWorktree) return;
    const base = ctx?.baseBranch;
    if (!base) return;
    const w = window as unknown as { electronAPI?: {
      fetchBase?: (folder: string, base: string) => Promise<{ ok: boolean }>;
      getGitContext?: (folder: string) => Promise<GitContext>;
    } };
    const api = w.electronAPI;
    if (!api?.fetchBase) return;
    let cancelled = false;
    const refresh = () => {
      lastBaseFetchAtRef.current = Date.now();
      api.fetchBase!(folder, base).then(() => {
        if (cancelled) return;
        api.getGitContext?.(folder).then(c => { if (!cancelled) setCtx(c ?? null); }).catch(() => {});
      }).catch(() => {});
    };
    refresh();
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastBaseFetchAtRef.current < 30000) return;
      refresh();
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [folder, ctx?.baseBranch, isWorktree]);

  // PR status poll — every 15s. Slower than git context because gh
  // hits the GitHub API (rate limits) and PR state changes less often
  // than working-tree edits. Skipped when we don't have a feature
  // branch (no PR can exist).
  useEffect(() => {
    setPrStatusLoaded(false);
    // GitHub connection gate (Settings → Integrations). Without it we never
    // poll `gh pr status` — the strip shows only branches, no PR state leaks
    // in even if `gh` is authed independently of Settings. Mirrors the
    // openPrsList / branchOpenPr gating already keyed on githubConnected.
    if (!githubConnected) { setPr(null); return; }
    if (!folder || !ctx?.branch || ctx.branch === ctx.baseBranch) {
      setPr(null);
      return;
    }
    // While the Create PR dispatcher is mid-run, the local branch is
    // in flux: it may have been force-recreated (round 2 carve) but
    // not yet pushed. `gh pr view` against such a branch can transiently
    // return the OLD merged PR (which still references the name), and
    // we'd flash "Sync main" in the action area until the next poll
    // returns the new OPEN PR. Pausing the effect here removes that
    // window entirely; the post-createPR success handler triggers a
    // fresh poll once the new state is settled.
    if (autoCreating) return;
    let cancelled = false;
    const load = () => {
      lastPrPollAtRef.current = Date.now();
      git.prStatus(folder).then(r => {
        if (cancelled) return;
        // Diagnostic so we can see, in DevTools, exactly what each
        // poll's `gh` call returned — the flicker between Create PR
        // and Merge in earlier traces was hard to root-cause without
        // a line per poll.
        const peek = r.ok ? (r.pr ?? null) : null;
        console.info("[pr-status] poll", {
          folder,
          ok: r.ok,
          error: r.ok ? undefined : r.error,
          number: peek?.number ?? null,
          state: peek?.state ?? null,
          isDraft: peek?.isDraft ?? null,
        });
        // gh transient failure (rc != 0): do NOT clear pr. Could be a
        // network blip, rate limit, or default-repo-not-set hiccup —
        // none of which mean the PR went away. The next interval poll
        // retries; keep the strip on whatever state we already had.
        //
        // EXCEPTION: an auth-failure code (AUTH_FAILED / NO_AUTH /
        // AUTH_EXPIRED) means the backend invalidated its auth cache — we're
        // genuinely logged out / expired, not blipping. Reset the strip's
        // GitHub connection so it honestly falls back to branches-only and
        // stops polling a dead auth, instead of showing a connected strip
        // where every op fails. Generic failures stay tolerated (state kept).
        if (!r.ok) {
          if (isAuthFailureCode(r.code)) resetGithubConnection();
          setPrStatusLoaded(true);
          return;
        }
        const incoming = r.pr ?? null;
        // Post-merge cleanup filter. After we've sync+carved this
        // branch, gh keeps returning the merged PR for the recreated
        // branch name. Suppress non-OPEN states so the strip stays
        // in the "ready for next round" shape (Create PR button)
        // instead of bouncing back to Sync main. Clear the flag the
        // moment a real OPEN PR shows up (round 2 surfaced).
        if (postMergeCleanedRef.current && incoming && incoming.state !== "OPEN") {
          setPr(null);
          setPrStatusLoaded(true);
          return;
        }
        if (incoming && incoming.state === "OPEN") {
          postMergeCleanedRef.current = false;
        }
        // Live external-merge detection (worktree only). We compare against
        // the PREVIOUS tick's state and act the instant we WATCH the flip
        // OPEN → MERGED on our own branch. This must run here — before
        // setPr — because the next poll's stale MERGED tick is swallowed by
        // the postMergeCleanedRef filter above, so the flip is only
        // observable once. Boot-into-merged (prevState null) is intentionally
        // skipped; the manual "Start next round" button owns that case.
        const prevState = prevPrStateRef.current;
        prevPrStateRef.current = incoming?.state ?? null;
        if (shouldAutoNextRound({
          isWorktree,
          prevState,
          incomingState: incoming?.state ?? null,
          incomingHeadRef: incoming?.headRefName ?? null,
          ctxBranch: ctx?.branch ?? null,
          syncing,
          justMerged: justMergedRef.current,
          isStreaming,
        })) {
          glog("ui", "next-round.external", { prNumber: incoming?.number });
          doWorktreeNextRoundRef.current(incoming!.baseRefName || ctx?.baseBranch || "main");
        }
        // Off-worktree: a branch PR that's already MERGED — and that we did
        // NOT merge in-app this session (justMergedRef gates that) — is a
        // FINISHED PR. Clinging to it strands the strip on the merged PR's
        // View while an unrelated open PR's Merge bleeds into the same row
        // (the user's "I'm on #116 but it shows #262 + Sync main" bug). Drop
        // it so the repo-wide selection falls through to the newest open PR.
        // The in-app merge path keeps the transient MERGED state (justMergedRef
        // true) so the auto-cleanup + feedback still run; worktree mode keeps
        // boot-into-merged → "Start next round" (handled in the merge slot).
        if (!isWorktree && incoming?.state === "MERGED" && !justMergedRef.current) {
          setPr(null);
          setPrStatusLoaded(true);
          return;
        }
        setPr(incoming);
        setPrStatusLoaded(true);
      }).catch(() => {
        // Network / IPC blip — don't strand the BranchStrip on the
        // "Checking…" placeholder. Mark resolved but DON'T clear pr;
        // a transient failure shouldn't wipe known state.
        if (!cancelled) setPrStatusLoaded(true);
      });
    };
    load();
    const iv = setInterval(load, 10000);
    // Near-real-time external-merge detection: re-poll the instant the app
    // regains focus or becomes visible (e.g. the user merged the PR on GitHub
    // in a browser and tabbed back) instead of waiting up to one interval.
    // Throttled so rapid alt-tabbing can't hammer `gh`.
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastPrPollAtRef.current < 3000) return;
      load();
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      cancelled = true;
      clearInterval(iv);
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [folder, ctx?.branch, ctx?.baseBranch, autoCreating, isWorktree, syncing, isStreaming, githubConnected, resetGithubConnection]);

  // ── Auto-create draft PR ──
  // First time we see actual diff on a feature branch with no PR
  // yet, kick off a draft PR with a sensible auto-title. Mirrors
  // Claude Code's flow: every session has a draft PR open against
  // the base branch from the moment the agent commits.
  //
  // Three guards keep this from misfiring:
  //   1. prStatusLoaded — we MUST know the PR is actually missing,
  //      not just unfetched, before firing. Without this we race
  //      the prStatus call and try to recreate an existing PR,
  //      which gh rejects with "a pull request already exists".
  //   2. autoPrFiredRef — per-folder one-shot, with retry-on-fail.
  //   3. ctx.plus + ctx.minus > 0 — no PR for an empty diff.
  useEffect(() => {
    // GitHub connection gate (Settings → Integrations). Without it the strip
    // shows only branches; auto-creating a PR here would surface PR
    // affordances the user never connected for (and could race a `gh` that's
    // authed independently of Settings). Mirrors showCreatePR/showReview.
    if (!githubConnected) return;
    // Diagnostic: every state change emits a one-liner so the user
    // can see exactly which guard is currently holding the auto-PR
    // back. Open devtools console and look for "[auto-PR] check".
    const reason = !folder ? "no-folder"
      : !ctx?.branch ? "no-branch"
      : !ctx.baseBranch ? "no-base-branch"
      : ctx.branch === ctx.baseBranch ? "on-default-branch"
      : !prStatusLoaded ? "pr-status-unloaded"
      : pr ? "pr-already-exists"
      : autoCreating ? "manual-create-in-flight"
      : (ctx.plus === 0 && ctx.minus === 0) ? "no-diff"
      : autoPrFiredRef.current.has(folder) ? "already-fired"
      : "ready-to-fire";
    console.info("[auto-PR] check", {
      reason,
      folder,
      branch: ctx?.branch,
      base: ctx?.baseBranch,
      plus: ctx?.plus,
      minus: ctx?.minus,
      hasPr: !!pr,
      prStatusLoaded,
      autoCreating,
    });

    if (!folder || !ctx?.branch || !ctx.baseBranch) return;
    if (ctx.branch === ctx.baseBranch) return;
    if (!prStatusLoaded) return;
    if (pr) return;
    // Don't race the manual click. The user's click sets autoCreating
    // before its first API call; without this guard the background
    // draft-PR effect can fire concurrently — both succeed (the second
    // returns existed:true) BUT the AI summary inside `git_create_pr`
    // (~12-25s) keeps the second request alive even after the first
    // landed, so the trace shows duplicate `gh pr create` attempts.
    if (autoCreating) return;
    if (ctx.plus === 0 && ctx.minus === 0) return;
    if (autoPrFiredRef.current.has(folder)) return;

    autoPrFiredRef.current.add(folder);
    setAutoPrInFlight(true);
    const branchSlug = (ctx.branch || "")
      .replace(/^fleet\//, "").replace(/^claude\//, "")
      .replace(/-[a-f0-9]{8}$/, "");
    const title = (sessionTitle || branchSlug || ctx.branch || "Working session").slice(0, 80);
    const body  = `Draft PR auto-opened by Fleet for branch \`${ctx.branch}\`.`;

    console.info("[auto-PR] firing", { folder, branch: ctx.branch, base: ctx.baseBranch, title });
    // Wrap in try/catch so a missing IPC method (e.g. test
    // harness without the full electronAPI surface) doesn't
    // throw synchronously and bubble up as an unhandled effect
    // error before .catch can grab it.
    try {
      git.createPR(folder, { title, body, base: ctx.baseBranch, draft: false })
        .then(r => {
          setAutoPrInFlight(false);
          if (r.ok) {
            console.info("[auto-PR] created", { number: r.prNumber, url: r.prUrl, existed: r.existed });
            // Optimistic Merge UI — flip the strip from "Create PR"
            // to "Open + Merge" synchronously. Without this, the
            // strip stayed on Create PR for the full 800ms +
            // prStatus round-trip window after an `existed:true`
            // response, and the user could click Create PR a second
            // time during that window (which then races into yet
            // another duplicate dispatch).
            if (typeof r.prNumber === "number") {
              const nr = r.prNumber;
              setPr(prev => prev?.number === nr ? prev : {
                number: nr,
                url: r.prUrl ?? "",
                state: "OPEN",
                mergeable: "UNKNOWN",
                isDraft: false,
                baseRefName: ctx.baseBranch ?? "main",
                headRefName: ctx.branch ?? "",
                checks: { passing: 0, failing: 0, pending: 0, total: 0 },
                commentsCount: 0,
              });
              setPrStatusLoaded(true);
              // Seed the repo-wide store too so the switcher chip / merge
              // cluster pick up the auto-opened PR without waiting for the
              // next prList poll.
              usePrStore.getState().upsert({
                number: nr,
                state: "OPEN",
                headRefName: ctx.branch ?? "",
                isDraft: false,
                mergeable: "UNKNOWN",
                title: sessionTitle ?? undefined,
                url: r.prUrl ?? undefined,
              });
            }
            // Refine the optimistic state from gh — checks counts,
            // draft status, etc. Lookup by the specific number to
            // avoid gh's branch-resolution lag for freshly-created
            // PRs.
            setTimeout(() => {
              if (folder) git.prStatus(folder, r.prNumber).then(s => {
                if (s.ok) { setPr(s.pr ?? null); setPrStatusLoaded(true); }
              });
            }, 800);
          } else {
            // Re-arm by default so the NEXT diff event retries. We only
            // hold the ref when the PR almost certainly exists already
            // ("a pull request for branch X already exists") — in that
            // case the prStatus poll will pick it up. Everything else
            // (timeout, network, auth, push rejected, no commits, no
            // remote) was historically sticky and blocked retries
            // forever on transient failures — including the 4s push
            // timeout we just fixed. Clearing the ref is safe because
            // a real existing PR returns r.ok with r.existed=true and
            // takes the success branch above.
            console.warn("[auto-PR] failed", r.error);
            const err = (r.error || "").toLowerCase();
            const stickyExisting = err.includes("already exists") || err.includes("pull request for branch");
            if (!stickyExisting) {
              autoPrFiredRef.current.delete(folder);
            }
          }
        })
        .catch(e => {
          setAutoPrInFlight(false);
          console.warn("[auto-PR] threw", e);
          autoPrFiredRef.current.delete(folder);
        });
    } catch (e) {
      setAutoPrInFlight(false);
      console.warn("[auto-PR] threw (sync)", e);
      autoPrFiredRef.current.delete(folder);
    }
  }, [folder, ctx?.branch, ctx?.baseBranch, ctx?.plus, ctx?.minus, pr, prStatusLoaded, autoCreating, sessionTitle, githubConnected]);

  // Auto-cleanup after merge. When prStatus poll observes the PR
  // flip to MERGED AND we were the ones who triggered the merge
  // (justMergedRef set in onMerge), run the same Sync main + carve
  // next round flow the manual button does. The user no longer has
  // to click Sync main after every merge — the session immediately
  // reaches the "ready for next round" state.
  //
  // Gating: justMergedRef is the safeguard against firing this for
  // MERGED states the user didn't trigger (e.g. someone merged via
  // GitHub web, or the app boots into a session whose PR was merged
  // last week). In those cases the strip still shows Open + Sync
  // main and the user has manual control.
  //
  // HOISTED above the `controlCenter` early return below: React's
  // Rules of Hooks require the hook call count to stay constant
  // across renders for the same component instance. Without this
  // hoist, navigating from the Fleet hub (controlCenter=true → early
  // return BEFORE the hook) to a real session (controlCenter=false →
  // hook fires) shifted the hook count and React tore the tree down
  // with `Rendered more hooks than during the previous render.`
  useEffect(() => {
    if (controlCenter) return;
    if (pr?.state !== "MERGED") return;
    if (!justMergedRef.current) return;
    glog("ui", "auto-cleanup.fire", { prNumber: pr.number, isWorktree });
    // Worktree sessions advance to a fresh round; off-worktree keeps the
    // in-place Sync-main. (onMerge's own-branch path fires the same runner
    // directly; whichever wins, doWorktreeNextRound/doSyncAndCarve clears
    // justMergedRef up front so the loser no-ops on the same MERGED tick.)
    if (isWorktree) doWorktreeNextRoundRef.current(pr.baseRefName || ctx?.baseBranch || "main");
    else void onSyncMain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr?.state, controlCenter]);

  // Poll the repo's open PRs into the shared store — drives the repo-wide
  // Merge box switcher (+ branch-picker badges). No-op until `folder` resolves.
  useRepoPrs(folder);

  // ── Repo-wide PR selection (Merge-box switcher, spec §6) ──
  // Effective selection: explicit pick (while still open) → the working
  // branch's open PR → the newest open PR. The chip + merge cluster
  // target this PR; Create PR stays bound to the working branch.
  // (`githubConnected` is derived near the top of the component so the
  // PR-status poll + auto-PR effects above can gate their deps on it.)
  const openPrsAll = useOpenPrs();
  const openPrsList = githubConnected ? openPrsAll : [];
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  const branchOpenPr = githubConnected && pr && pr.state === "OPEN" ? pr : null;
  const effectiveSelectedNumber =
    selectedPrNumber != null && openPrsList.some(p => p.number === selectedPrNumber)
      ? selectedPrNumber
      : branchOpenPr?.number ?? openPrsList[0]?.number ?? null;
  const selectedRepoPr = effectiveSelectedNumber != null
    ? openPrsList.find(p => p.number === effectiveSelectedNumber) ?? null
    : null;
  // The selected PR is the working branch's own when its number matches
  // the branch PR OR — before the branch poll lands — when the store
  // entry's head ref is the current branch. The latter avoids a transient
  // foreign-poll for our own PR while `pr` is still loading (which would
  // also race the branch poll's prStatus mock in tests).
  const selectedIsBranchPr =
    effectiveSelectedNumber != null && (
      effectiveSelectedNumber === branchOpenPr?.number ||
      (!!ctx?.branch && selectedRepoPr?.headRefName === ctx.branch)
    );

  // Foreign-PR detail poll — checks/mergeable/draft gating for a selected
  // PR that ISN'T the working branch's. Same 15s cadence as the branch
  // poll; `git.prStatus(folder, number)` is already number-addressable.
  // Skipped entirely in worktree mode: the strip is locked to the working
  // branch's own PR there, so there is no foreign selection to detail-poll.
  const [foreignPr, setForeignPr] = useState<PRStatus | null>(null);
  // Whether the CI-checks details popover (anchored on the merge cluster's
  // status ring) is open. Reads the selected PR's `checks.runs` live.
  const [checksOpen, setChecksOpen] = useState(false);
  // Names of checks with a re-run in flight — drives the optimistic
  // failing→pending overlay until the status poll reflects GitHub's new state.
  const [rerunning, setRerunning] = useState<ReadonlySet<string>>(() => new Set());
  const rerunStartedAtRef = useRef<number>(0);
  useEffect(() => {
    // Reset any previously-loaded foreign detail the instant the selection (or
    // context) changes — otherwise switching PRs keeps the PREVIOUS PR's status
    // on screen (e.g. a lingering "Failing") for the whole detail-poll window,
    // because the chip + merge cluster read the stale `foreignPr` until the new
    // `git.prStatus` resolves. Nulling it makes the chip fall back to the store
    // entry's basic state (Open/Draft/Conflict) for the NEW PR until the fresh
    // poll lands and refines it.
    setForeignPr(null);
    if (!folder || isWorktree || effectiveSelectedNumber == null || selectedIsBranchPr) {
      return;
    }
    let cancelled = false;
    const load = () => {
      git.prStatus(folder, effectiveSelectedNumber).then(r => {
        if (!cancelled && r.ok) setForeignPr(r.pr ?? null);
      }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [folder, isWorktree, effectiveSelectedNumber, selectedIsBranchPr]);

  // Live ref to onMerge (defined below the controlCenter early-return and
  // re-created each render) so the resolve-watcher effect can fire the
  // latest one without listing it in deps. `.current` is set right after
  // onMerge is declared.
  const onMergeRef = useRef<() => void>(() => {});

  // While a resolution turn is in flight, poll the PR faster than the
  // normal 15s cadence. The moment the agent's push clears the conflict
  // (mergeable → MERGEABLE) we run the existing squash-merge. A timeout
  // stops us spinning forever if the agent couldn't finish.
  useEffect(() => {
    if (!resolving || !folder) return;
    let cancelled = false;
    const target = resolving.prNumber;
    const check = () => {
      git.prStatus(folder, target).then(r => {
        if (cancelled || !r.ok) return;
        if (r.pr && r.pr.number === target && r.pr.mergeable === "MERGEABLE") {
          setResolving(null);
          void onMergeRef.current();
        }
      }).catch(() => {});
    };
    check();
    const iv = setInterval(check, RESOLVE_POLL_MS);
    const to = setTimeout(() => {
      if (cancelled) return;
      setResolving(null);
      const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(sid, "Conflict resolution didn't complete — check the agent's output above, then click Merge.");
    }, RESOLVE_TIMEOUT_MS);
    return () => { cancelled = true; clearInterval(iv); clearTimeout(to); };
  }, [resolving, folder]);

  // Effective selection (worktree-mode lock applied). Off-worktree this is
  // byte-identical to the prior inline values: { effSelectedIsBranchPr,
  // effSelectedPr, effSelectedRepoPr } ≡ { selectedIsBranchPr,
  // (selectedIsBranchPr ? pr : foreignPr), selectedRepoPr }. In worktree mode
  // they collapse to the working branch's own PR (`pr`) and the switcher is
  // hidden — a foreign PR in openPrsList can never become the merge/Resolve
  // target. (`effSelectedNumber` is part of the helper's contract but the
  // cluster reads `effSelectedRepoPr.number` directly, mirroring the prior
  // `selectedRepoPr.number`, so it isn't destructured here.)
  const {
    effSelectedIsBranchPr, effSelectedPr, effSelectedRepoPr, showSwitcher,
  } = resolveStripSelection({
    isWorktree,
    pr,
    branchOpenPr,
    effectiveSelectedNumber,
    selectedIsBranchPr,
    selectedRepoPr,
    foreignPr,
  });
  const selectedPr: PRStatus | null = effSelectedPr;
  // Optimistic "waiting" view: re-running checks render as pending. Handlers
  // below read the RAW selectedPr to decide what to re-run; the UI reads this.
  const overlaidPr: PRStatus | null = selectedPr
    ? { ...selectedPr, checks: applyRerunOverlay(selectedPr.checks, rerunning) }
    : null;

  // While a re-run is in flight, poll the selected PR fast (2s) and retire each
  // re-running name once the server stops reporting it "failing" (it actually
  // went pending/passing) — or once the grace window elapses (trust the server).
  useEffect(() => {
    if (!folder || rerunning.size === 0) return;
    const target = effectiveSelectedNumber ?? selectedPr?.number ?? null;
    if (target == null) return;
    let cancelled = false;
    const tick = () => {
      git
        .prStatus(folder, target)
        .then((r) => {
          if (cancelled || !r.ok || !r.pr) return;
          if (selectedIsBranchPr) setPr(r.pr);
          else setForeignPr(r.pr);
          const stillFailing = new Set(
            (r.pr.checks.runs ?? []).filter((x) => x.bucket === "failing").map((x) => x.name),
          );
          const graceOver = Date.now() - rerunStartedAtRef.current > RERUN_GRACE_MS;
          setRerunning((prev) => {
            const next = new Set([...prev].filter((name) => stillFailing.has(name) && !graceOver));
            return next.size === prev.size ? prev : next;
          });
        })
        .catch(() => {});
    };
    tick();
    const iv = setInterval(tick, RESOLVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [folder, rerunning, effectiveSelectedNumber, selectedPr?.number, selectedIsBranchPr]);

  if (controlCenter) return null;

  const noGit = !ctx?.branch;
  const onDefaultBranch =
    !noGit && (
      (!!ctx!.baseBranch && ctx!.branch === ctx!.baseBranch) ||
      (!ctx!.baseBranch && KNOWN_DEFAULTS.has(ctx!.branch!))
    );
  // Show Create PR whenever we have something the dispatcher can act
  // on. Three shapes flow through:
  //   - feature branch (existing happy path)
  //   - noGit with plannedBranch → dispatcher bootstraps + carves it
  //   - on default branch with plannedBranch → dispatcher carves
  // Without plannedBranch the bootstrap states can't pick a target
  // branch, so we fall back to hiding the button.
  // Create PR requires an actual git repo: a non-git session folder shows no
  // Create PR at all (carving a repo from nothing is out of scope). With a
  // repo it shows on feature branches, and on the default branch only when a
  // plannedBranch will be carved.
  const showCreatePR = prAffordancesEnabled(githubConnected, noGit) && (!onDefaultBranch || !!plannedBranch);
  // ── Empty-diff gating ──
  // `ctx.plus/minus` already refresh on the 5s git-context poll, so
  // this costs nothing extra. Bootstrap shapes (no git yet, or on the
  // default branch with a planned carve target) must stay clickable —
  // there the diff doesn't exist YET by design and the dispatcher
  // bootstraps it. The ≤5s staleness window is backstopped by the
  // backend's NO_COMMITS error surfacing through the recovery path.
  const isBootstrapShape = (noGit || onDefaultBranch) && !!plannedBranch;
  const emptyDiffBlocked = isEmptyDiffBlocked({
    isBootstrapShape,
    isWorktree,
    plus: ctx?.plus ?? 0,
    minus: ctx?.minus ?? 0,
  });
  // Create-slot gating. When the slot can't act — the working branch
  // already has an open PR (a second create would just race "a PR
  // already exists"), or the diff is empty — Create PR and Review are
  // HIDDEN entirely rather than rendered grayed out (per user request:
  // a dead lead action is noise next to the live merge cluster).
  // autoCreating is excluded so the in-flight "Creating…" feedback
  // stays visible right after the click.
  //
  // Also hidden once the SELECTED PR is actually mergeable: when the Merge
  // button is live, Create PR + Review are just noise next to it — the user's
  // next move is Merge, not opening another PR or re-reviewing. The working
  // branch's own open PR is already covered by `branchOpenPr` above; this folds
  // in the FOREIGN-selection case (the merge cluster targets a repo PR the
  // working branch doesn't own). `resolveMergeGate(null)` reports canMerge:false,
  // so the actions stay through the post-switch detail-poll window until we KNOW
  // the selected PR is mergeable.
  const selectedMergeable = !!effSelectedRepoPr && resolveMergeGate(selectedPr).canMerge;
  const createBlocked = !autoCreating && (!!branchOpenPr || emptyDiffBlocked || selectedMergeable);
  const createDisabled = autoCreating || !!branchOpenPr || emptyDiffBlocked;
  const createTooltip =
    branchOpenPr ? `PR #${branchOpenPr.number} is already open for this branch`
    : emptyDiffBlocked ? "No changes to include in a PR"
    : undefined;
  // Review is available whenever a git repo exists with something
  // the agent can read — noGit folders have no diff yet, so the
  // button stays hidden until bootstrap. (Conductor's parity: their
  // Review action is only useful once there's a workspace state.)
  // Hidden alongside Create PR whenever that slot is blocked.
  const showReview = prAffordancesEnabled(githubConnected, noGit) && !!folder && !createBlocked;

  // noGit may be true here; we render <NoGitPill /> from the unified
  // JSX path below. The legacy non-noGit render uses ctxR.branch /
  // ctxR.baseBranch directly, gated by the `noGit ? <NoGitPill /> : …`
  // ternary so the cast is only consumed when noGit is provably false.
  const ctxR = ctx as GitContext & { branch: string };

  const onRerunCheck = (run: CheckRun) => {
    if (!folder || run.jobId == null) return;
    setRerunning((prev) => new Set(prev).add(run.name));
    rerunStartedAtRef.current = Date.now();
    void git.rerunCheck(folder, run.jobId).then((r) => {
      if (!r.ok) {
        setRerunning((prev) => {
          const n = new Set(prev);
          n.delete(run.name);
          return n;
        });
        const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
        pushChatError(sid, `Re-run failed: ${r.error ?? "unknown error"}`);
      }
    });
  };

  const onRerunFailed = () => {
    if (!folder || !selectedPr) return;
    const failing = (selectedPr.checks.runs ?? []).filter(
      (r) => r.bucket === "failing" && r.rerunnable && r.runId != null,
    );
    if (failing.length === 0) return;
    const names = failing.map((r) => r.name);
    const runIds = Array.from(new Set(failing.map((r) => r.runId as number)));
    setRerunning((prev) => {
      const n = new Set(prev);
      names.forEach((x) => n.add(x));
      return n;
    });
    rerunStartedAtRef.current = Date.now();
    void git.rerunFailedChecks(folder, runIds).then((r) => {
      if (!r.ok) {
        setRerunning((prev) => {
          const n = new Set(prev);
          names.forEach((x) => n.delete(x));
          return n;
        });
        const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
        pushChatError(sid, `Re-run failed: ${r.error ?? "unknown error"}`);
      }
    });
  };

  const onMerge = async () => {
    if (!folder || !selectedPr || selectedPr.state !== "OPEN") return;
    // Capture base + prNumber BEFORE the mergePR call, because by the
    // time the auto-cleanup runs we'll have cleared `pr` and gh may
    // have switched the local checkout to main.
    const mergedPrNumber = selectedPr.number;
    // Identity gate (spec §7): only the working branch's own PR triggers
    // the sync+carve+auto-switch flow. A foreign PR merges in place —
    // syncMain would otherwise check out the base branch inside the
    // user's working dir on worktree-off sessions.
    const ownBranchMerge = selectedPr.headRefName === ctx?.branch;
    const baseBranch = selectedPr.baseRefName || ctx?.baseBranch || "main";
    glog("ui", "merge.start", { prNumber: mergedPrNumber, baseRef: baseBranch, wasDraft: selectedPr.isDraft, ownBranchMerge });
    setMerging(true);
    // Mark so the fallback auto-cleanup useEffect could ALSO fire if
    // the state-flip path beats the direct trigger below. Cleared in
    // doSyncAndCarve so we never double-run. Only set for own-branch
    // merges — a foreign merge must never touch the working branch.
    if (ownBranchMerge) justMergedRef.current = true;
    // Always attempt `gh pr ready` before merge — the local
    // `isDraft` flag can be stale (optimistic setPr defaults it to
    // false even when the actual PR on GitHub is still a draft from an
    // earlier auto-PR run that hardcoded draft:true). The backend's
    // pr_ready treats "already ready" as a silent no-op so running it
    // unconditionally is cheap. Without this, hitting Merge on a
    // stale-draft PR produced "GraphQL: Pull Request is still a draft"
    // from `gh pr merge`.
    const ready = await git.markPRReady(folder, mergedPrNumber);
    if (!ready.ok) {
      setMerging(false);
      justMergedRef.current = false;
      return;
    }
    if (ownBranchMerge) {
      setPr(prev => prev && prev.number === mergedPrNumber ? { ...prev, isDraft: false } : prev);
    }
    const r = await git.mergePR(folder, mergedPrNumber, "squash");
    setMerging(false);
    glog("ui", "merge.result", { ok: r.ok, error: r.ok ? undefined : r.error });
    if (r.ok) {
      // Optimistically drop the merged PR from the repo-wide store; the
      // selection falls back automatically (branch PR → newest open).
      usePrStore.getState().remove(mergedPrNumber);
      // Only clear the selection if it still points at the PR we just
      // merged — if the user picked a DIFFERENT PR in the popover during
      // the merge await, leave their pick intact rather than clobbering it.
      setSelectedPrNumber(prev => prev === mergedPrNumber ? null : prev);
      if (ownBranchMerge) {
        // Drop the OPEN pr immediately and trigger sync+carve DIRECTLY.
        // We don't wait for pr.state to flip to MERGED via prStatus —
        // `gh pr merge --auto --delete-branch` switches the local
        // checkout to main and deletes the feature branch, so by the
        // time our poll runs again the state has skipped from OPEN
        // straight to null (no PR for main). The useEffect waiting on
        // state===MERGED would never fire. Running it directly here is
        // deterministic. Worktree sessions advance to a fresh round (new
        // `-r<N>` worktree + branch); off-worktree keeps the in-place
        // sync+carve of the same branch.
        setPr(null);
        if (isWorktree) void doWorktreeNextRound(baseBranch);
        else void doSyncAndCarve(baseBranch);
      }
    } else {
      // mergePR rejected (checks failing, auth, …) — wasn't really
      // a merge, clear the flag so the useEffect can't fire either.
      // Surface the failure as a red bubble so the user sees it
      // without having to dig through devtools.
      justMergedRef.current = false;
      // If the rejection is an auth failure (logged out / expired), reset the
      // strip's GitHub connection too — same self-healing fallback the PR poll
      // applies, so a dead-auth merge doesn't leave a connected-looking strip.
      if (isAuthFailureCode(r.code)) resetGithubConnection();
      const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(errSid, r.error || "Merge failed");
    }
  };
  // Keep the resolve-watcher's ref pointed at the current onMerge.
  onMergeRef.current = onMerge;

  // "Resolve & merge" on a CONFLICTING PR: hand the conflict to the
  // session's agent (a visible turn in its worktree), then let the
  // watcher effect above auto-complete the squash-merge once the push
  // clears it. The app owns the final merge — the agent only resolves.
  const onResolveAndMerge = () => {
    if (!folder || !selectedPr || !onResolveConflicts) return;
    if (permissionMode === "plan") {
      const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(sid, "Plan mode blocks edits — switch to Accept Edits or Default so the agent can resolve, then click Resolve & merge.");
      return;
    }
    const base = selectedPr.baseRefName || ctx?.baseBranch || "main";
    onResolveConflicts(buildResolvePrompt(base, selectedPr.number));
    setResolving({ prNumber: selectedPr.number });
  };

  // Post-merge cleanup: switch the SOURCE repo to the base branch
  // and pull --ff-only, THEN carve the next-round feature branch in
  // the AGENT's working dir (worktree or source) so the session is
  // immediately ready for the next chunk of work. Two distinct repo
  // ops separated because for worktree-on sessions they touch
  // different paths.
  // Shared body for both onSyncMain (button click, requires `pr`) and
  // the post-merge auto-trigger (onMerge done-ok, where `pr` may
  // already have been cleared and we pass `base` explicitly). Runs
  // source pull-ff-only + worktree branch reset to origin/<base>.
  // ── Worktree next round ──
  // The worktree-mode analogue of doSyncAndCarve. Instead of pulling the base
  // into the user's source checkout and resetting the SAME branch, the server
  // carves a fresh PRISTINE worktree on a new `-r<N>` branch, repoints THIS
  // session at it (the cwd follows on the next turn), and tears down the old
  // worktree + local branch. We then refresh the in-memory session so the
  // strip's worktree path/branch track the new round, and best-effort delete
  // the old REMOTE branch (auth lives in the Tauri shell, so this is a
  // fire-and-forget — failure just leaves a stale remote branch, not a broken
  // session). Mirrors doSyncAndCarve's flag handling: clear justMergedRef up
  // front, set postMergeCleanedRef so the next poll's stale MERGED tick is
  // swallowed, and clear `pr`.
  const doWorktreeNextRound = async (base: string) => {
    if (!sessionId) return;
    justMergedRef.current = false;
    setSyncing(true);
    try {
      const r = await sessionNextRoundWorktree(sessionId, base);
      if (!r.ok || !r.session) {
        const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
        pushChatError(sid, "Couldn't start the next round — see the agent output, then retry.");
        return;
      }
      useAppStore.getState().updateSession(sessionId, {
        worktree_path: r.session.worktree_path,
        worktree_branch: r.session.worktree_branch,
      });
      if (r.removedBranch && sourcePath) {
        void git.deleteRemoteBranch(sourcePath, r.removedBranch);
      }
      postMergeCleanedRef.current = true;
      setPr(null);
    } catch (e) {
      const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(sid, e instanceof Error ? e.message : "Couldn't start the next round — see the agent output, then retry.");
    } finally {
      setSyncing(false);
    }
  };
  // Keep the poll + auto-cleanup effects' ref pointed at the current runner.
  doWorktreeNextRoundRef.current = doWorktreeNextRound;

  const doSyncAndCarve = async (base: string) => {
    const sourceTarget = sourcePath || folder;
    if (!sourceTarget) return;
    glog("ui", "syncMain.start", { folder: sourceTarget, base });
    justMergedRef.current = false;
    setSyncing(true);
    const r = await git.syncMain(sourceTarget, base);
    glog("ui", "syncMain.result", { ok: r.ok, error: r.ok ? undefined : r.error });
    if (!r.ok) {
      setSyncing(false);
      const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(errSid, r.error || `Sync ${base} failed`);
      return;
    }

    // Source is now up-to-date. Try to carve the session's next
    // round in the agent's working dir (worktree for worktree-on,
    // source for worktree-off). Carve failure isn't fatal — Sync
    // already succeeded — but we still surface it so the user knows
    // the next-round branch reset didn't happen.
    if (folder && plannedBranch) {
      glog("ui", "carveNextRound.start", { folder, branch: plannedBranch, base: r.base });
      const c = await git.carveNextRound(folder, plannedBranch, r.base);
      glog("ui", "carveNextRound.result", { ok: c.ok, error: c.ok ? undefined : c.error });
      if (!c.ok) {
        const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
        pushChatError(errSid, c.error || `Carve ${plannedBranch} failed`);
      }
    }
    setSyncing(false);

    // Mark the branch as "post-cleanup". The next prStatus poll
    // would otherwise return the just-merged PR (GitHub keeps the
    // branch ↔ merged-PR association), making the strip render
    // Sync main again. The flag tells load() to drop any non-OPEN
    // PR it gets back until a fresh OPEN PR (round 2) shows up.
    postMergeCleanedRef.current = true;
    setPr(null);
  };

  // Manual Sync main click — only valid when we have a current pr to
  // pull the base branch off of.
  const onSyncMain = async () => {
    if (!pr) return;
    const base = pr.baseRefName || ctx?.baseBranch || "main";
    return doSyncAndCarve(base);
  };

  // Standalone "Sync <base>" click — a PURE fast-forward of the local base
  // branch, shown when `ctx.baseBehind > 0` (the local base has drifted behind
  // origin). Unlike doSyncAndCarve this does NOT carve a next round: it just
  // catches the local base up so the indicator clears. Acts on the SOURCE repo
  // (worktree-off: sourcePath === folder). Reuses `git.syncMain`, whose backend
  // already does fetch + checkout base + pull --ff-only + return to the prior
  // branch — exactly a base catch-up, nothing more.
  const onSyncBaseOnly = async () => {
    const sourceTarget = sourcePath || folder;
    const base = ctx?.baseBranch;
    if (!sourceTarget || !base || syncing) return;
    glog("ui", "syncBase.start", { folder: sourceTarget, base });
    setSyncing(true);
    const r = await git.syncMain(sourceTarget, base);
    glog("ui", "syncBase.result", { ok: r.ok, error: r.ok ? undefined : r.error });
    setSyncing(false);
    if (!r.ok) {
      const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(sid, r.error || `Sync ${base} failed`);
      return;
    }
    // Re-pull the git context so `baseBehind` recomputes and the action hides
    // once the local base has caught up.
    if (folder) {
      const api = (window as unknown as { electronAPI?: {
        getGitContext?: (f: string) => Promise<GitContext>;
      } }).electronAPI;
      api?.getGitContext?.(folder).then(c => setCtx(c ?? null)).catch(() => {});
    }
  };

  // Forward the branch PR's number so the browser lands on the exact
  // /pull/<n> page instead of the repo-wide /pulls list.
  const onOpenPR = () => folder && git.openPR(folder, pr?.number);

  // Open the SELECTED PR on GitHub. For a foreign PR (not the working
  // branch's) we open its own url directly — `git.openPR(folder)`
  // resolves the working branch's PR, which would open the wrong one.
  const onOpenSelected = () => {
    if (effSelectedRepoPr && !effSelectedIsBranchPr && effSelectedRepoPr.url) {
      const w = window as unknown as { electronAPI?: { openExternal?: (url: string) => Promise<unknown> } };
      void w.electronAPI?.openExternal?.(effSelectedRepoPr.url);
      return;
    }
    // Branch-own selection: prefer the selected entry's number — `pr`
    // can lag a poll behind right after creation.
    if (folder) void git.openPR(folder, effSelectedRepoPr?.number ?? pr?.number);
  };

  // ── Create PR pipeline ──
  // Two phases:
  //   submitCreatePR  — entry point. Runs the deterministic pre-flight
  //                     check first. If structural blockers are found
  //                     (nested-no-commits, mid-rebase) opens the
  //                     PreflightDialog and gates the rest behind the
  //                     user clicking Continue.
  //   executeCreatePR — the actual happy path (diff/AI summary +
  //                     git.createPR + success/failure routing). Also
  //                     re-invoked when the user clicks Retry in the
  //                     RecoveryDialog after a sad-path failure.
  // Splitting it lets both the pre-flight gate AND the recovery retry
  // re-enter without simulating a click on the button.
  const executeCreatePR = async () => {
    if (!folder || autoCreating) {
      glog("ui", "executeCreatePR.bail", { reason: !folder ? "no-folder" : "already-creating" });
      return;
    }
    const isBootstrap = noGit || (onDefaultBranch && !!plannedBranch);
    if (isBootstrap && !plannedBranch) {
      glog("ui", "executeCreatePR.bail", { reason: "bootstrap-without-planned-branch" });
      return;
    }
    if (!isBootstrap && (!ctx || !ctx.branch)) {
      glog("ui", "executeCreatePR.bail", { reason: "no-branch" });
      return;
    }
    const branch = isBootstrap ? plannedBranch! : ctx!.branch!;
    const baseBranch = ctx?.baseBranch || "main";
    const featureBranch = isBootstrap ? plannedBranch! : undefined;
    glog("ui", "executeCreatePR.start", { folder, branch, baseBranch, isBootstrap, featureBranch: featureBranch || null, tool: tool || null });
    setAutoCreating(true);
    // Clear any stale PR state from a previous round (especially a
    // just-MERGED one) so the action area doesn't briefly flash
    // "Open + Sync main" while the dispatcher runs. The new PR's
    // status will populate via prStatus poll after createPR succeeds.
    setPr(null);
    // Mark this folder as "auto-PR'd" so the background draft-PR
    // effect doesn't race the manual click. Without this, both the
    // user's createPR and the auto-PR's draft createPR fire
    // concurrently — the second one hits `gh repo create` after the
    // first already created the repo and fails with "Name already
    // exists", producing a confusing failure log even though the
    // user's PR succeeds.
    if (folder) autoPrFiredRef.current.add(folder);
    try {
      // Pre-flight auth. The dispatcher's createPR bounces with NO_AUTH
      // when neither `gh` CLI nor a Fleetify GitHub link is available,
      // and the only recovery the user gets is a "Connect in Settings"
      // toast. Triggering the App OAuth flow inline turns one click on
      // Create PR into "browser tab opens → authorize → PR fires" with
      // no detour through Settings.
      const [ghProbe, linkProbe] = await Promise.all([
        git.hasGhCli(),
        github.getLink(),
      ]);
      if (!ghProbe.authed && !linkProbe.link) {
        // No live auth. Read the user's onboarding choice — if they
        // picked one we honour it silently; if they skipped (or never
        // chose) we open the mid-flow picker.
        const stored = (() => {
          try { return localStorage.getItem("fleet:github-auth-method"); }
          catch { return null; }
        })();
        let chosen: "oauth" | "cli" | null =
          stored === "oauth" || stored === "cli" ? stored : null;
        if (!chosen) {
          glog("ui", "executeCreatePR.auth-choice.open", {});
          chosen = await new Promise<"oauth" | "cli" | null>((resolve) => {
            authChoiceResolverRef.current = resolve;
            setAuthChoiceOpen(true);
          });
          setAuthChoiceOpen(false);
          authChoiceResolverRef.current = null;
          if (!chosen) {
            glog("ui", "executeCreatePR.auth-choice.dismissed", {});
            return;
          }
          glog("ui", "executeCreatePR.auth-choice.picked", { method: chosen });
        }
        if (chosen === "oauth") {
          glog("ui", "executeCreatePR.auto-oauth", {});
          const oauth = await github.beginOAuth();
          if (!oauth.ok) {
            glog("ui", "executeCreatePR.auto-oauth-failed", { code: oauth.code || "", error: oauth.error });
            return;
          }
          glog("ui", "executeCreatePR.auto-oauth-ok", { login: oauth.link.github_login });
        } else {
          // "cli" — the dialog already drove `gh auth login` to
          // completion (it only resolves "cli" once `hasGhCli` reports
          // authed). If we got here via the stored preference path the
          // probe at the top of this branch may have been pre-auth, so
          // re-probe once before proceeding.
          const re = await git.hasGhCli();
          if (!re.authed) {
            glog("ui", "executeCreatePR.cli-not-authed", {});
            // Pop the picker so the user can complete auth or switch
            // to OAuth — same as if no preference was stored.
            const retry = await new Promise<"oauth" | "cli" | null>((resolve) => {
              authChoiceResolverRef.current = resolve;
              setAuthChoiceOpen(true);
            });
            setAuthChoiceOpen(false);
            authChoiceResolverRef.current = null;
            if (!retry) return;
            // Re-enter the OAuth branch if the user switched method
            // mid-flow. Falls through to PR creation otherwise.
            if (retry === "oauth") {
              const oauth = await github.beginOAuth();
              if (!oauth.ok) {
                return;
              }
            }
          }
        }
      }

      let title = sessionTitle || defaultPRTitle(branch);
      let body = "";
      // Renderer-side AI / diff summary only makes sense when there's
      // ALREADY-COMMITTED diff between base and HEAD. Pre-commit
      // states — bootstrap (no commits yet) AND round-2-on-freshly-
      // carved-branch (uncommitted edits, branch == origin/main) —
      // produce empty diff queries here. The agent sees nothing,
      // returns a generic "no changes" body, and that body then
      // BLOCKS the dispatcher's post-commit AI fallback (which gates
      // on `!finalBody`). Leaving body empty in those cases hands
      // off cleanly to the dispatcher, which re-runs AI AFTER the
      // auto-commit captures the real changes.
      const hasCommittedDiff = (ctx?.plus ?? 0) + (ctx?.minus ?? 0) > 0;
      if (!isBootstrap && hasCommittedDiff) {
        try {
          const sum = await git.diffSummary(folder, baseBranch);
          if (sum.ok) {
            body = defaultPRBody(sum);
            glog("ui", "executeCreatePR.diff-summary", { ok: true, bodyLen: body.length });
          } else {
            glog("ui", "executeCreatePR.diff-summary", { ok: false });
          }
        } catch { /* ignore */ }
        try {
          const ai = await git.generatePRSummary(folder, baseBranch, tool ?? undefined);
          if (ai.ok) {
            if (ai.title) title = ai.title;
            if (ai.body)  body  = ai.body;
            glog("ui", "executeCreatePR.ai-summary", { ok: true, title });
          } else {
            glog("ui", "executeCreatePR.ai-summary", { ok: false, error: ai.error });
          }
        } catch { /* ignore */ }
      } else {
        glog("ui", "executeCreatePR.skip-renderer-ai", {
          isBootstrap,
          hasCommittedDiff,
          reason: !hasCommittedDiff ? "no-committed-diff" : "bootstrap",
        });
      }
      // Resolve the auth method the user picked during onboarding (or
      // mid-flow earlier in this call). Empty / unrecognised → undefined,
      // which makes the backend fall back to its legacy gh-first / link
      // order. Honouring the explicit choice means "Use GitHub CLI"
      // never silently routes through OAuth and vice versa, even when
      // both auths happen to be live on the machine.
      const persistedMethod = (() => {
        try { return localStorage.getItem("fleet:github-auth-method"); }
        catch { return null; }
      })();
      const method: "gh" | "oauth" | undefined =
        persistedMethod === "cli" ? "gh"
        : persistedMethod === "oauth" ? "oauth"
        : undefined;
      glog("ui", "executeCreatePR.dispatch", { titleLen: title.length, bodyLen: body.length, featureBranch: featureBranch || null, method: method || null });
      const r = await git.createPR(folder, {
        title: title.slice(0, 80),
        body, base: baseBranch, draft: false,
        ...(featureBranch ? { featureBranch } : {}),
        tool: tool ?? undefined,
        ...(method ? { method } : {}),
      });
      glog("ui", "executeCreatePR.result", { ok: r.ok, code: r.ok ? undefined : r.code, prNumber: r.ok ? r.prNumber : null, existed: r.ok ? !!r.existed : null });
      if (r.ok) {
        // Optimistic Merge UI — flip the strip from "Create PR" to
        // "Open + Merge" the instant the backend returns, instead of
        // waiting for the prStatus round-trip (~200-500ms gh hop).
        // gh's response refines the details a moment later; in the
        // interim the user already sees the right affordance and
        // doesn't get to click Create PR a second time.
        if (typeof r.prNumber === "number") {
          setPr(prev => prev?.number === r.prNumber ? prev : {
            number: r.prNumber as number,
            url: r.prUrl ?? "",
            state: "OPEN",
            mergeable: "UNKNOWN",
            isDraft: false,
            baseRefName: ctx?.baseBranch ?? "main",
            headRefName: ctx?.branch ?? "",
            checks: { passing: 0, failing: 0, pending: 0, total: 0 },
            commentsCount: 0,
          });
          setPrStatusLoaded(true);
          // Optimistically seed the repo-wide store too so the switcher
          // chip + always-visible merge cluster reflect the new PR
          // immediately, instead of waiting up to 7s for the next
          // prList poll. Server reconciles on the next poll.
          usePrStore.getState().upsert({
            number: r.prNumber,
            state: "OPEN",
            headRefName: ctx?.branch ?? "",
            isDraft: false,
            mergeable: "UNKNOWN",
            title: sessionTitle ?? undefined,
            url: r.prUrl ?? undefined,
          });
        }
        // Query gh by the specific prNumber we just got back so the
        // lookup is deterministic — gh's branch-to-PR resolution can
        // briefly miss a freshly-created PR (~1-2s lag), but
        // `gh pr view <number>` is lag-free.
        git.prStatus(folder, r.prNumber).then(s => {
          if (s.ok && s.pr) setPr(s.pr);
        });
        // Clear any in-flight recovery banner — the retry worked.
        setRecovery(null);
      } else {
        const raw = r.error || "";
        const code = r.code;

        // REPO_CREATE_FORBIDDEN — the recovery ("create on github.com
        // first") isn't something the RecoveryDialog's allow-list can
        // express, so we surface a red error bubble in the chat and
        // bail. The user clicks the github.com link from there.
        if (code === "REPO_CREATE_FORBIDDEN") {
          const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
          pushChatError(
            errSid,
            "GitHub denied repository creation. Create the repo on github.com/new first, then retry Create PR.",
          );
          setAutoCreating(false);
          return;
        }

        // All other failures route through the RecoveryDialog — the
        // session agent diagnoses, picks a whitelisted recovery
        // action, and the user explicitly approves Apply. The raw
        // error string is the input to the diagnosis prompt; we no
        // longer regex-translate it here because the agent's
        // contextual diagnosis is more useful than fixed friendly
        // strings.
        glog("ui", "executeCreatePR.recovery-open", { errorPreview: (raw || "").slice(0, 120) });
        setRecovery({ error: raw || "Create PR failed with no error string." });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errSid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
      pushChatError(errSid, msg || "Create PR failed");
    } finally {
      setAutoCreating(false);
    }
  };

  // submitCreatePR is the entry point both the button onClick and the
  // RecoveryDialog's Retry hand off to. It runs the deterministic
  // pre-flight scan first; if any issues are found, opens the
  // PreflightDialog and returns — `executeCreatePR` only runs after
  // the user clicks Continue inside that dialog. When the scan is
  // clean (the common case), we fall straight through to execute so
  // there's no perceptible latency.
  const submitCreatePR = async () => {
    if (!folder || autoCreating) {
      glog("ui", "submitCreatePR.bail", { reason: !folder ? "no-folder" : "already-creating" });
      return;
    }
    // Starting a new round — let prStatus surface fresh state. If
    // the last merge left this flag set (suppressing the stale
    // MERGED PR), clear it so the new round's OPEN PR can appear.
    postMergeCleanedRef.current = false;
    try {
      glog("ui", "submitCreatePR.preflight", { folder });
      const pf = await git.preflightCheck(folder);
      if (pf.ok && pf.issues.length > 0) {
        glog("ui", "submitCreatePR.preflight-issues", { count: pf.issues.length, types: pf.issues.map(i => i.type).join(",") });
        setPreflight({ issues: pf.issues });
        return;
      }
    } catch (e) {
      // Preflight failures shouldn't block Create PR — they're an
      // optimization layer. Log and continue to executeCreatePR;
      // any structural issue will surface in the dispatcher's
      // RecoveryDialog instead.
      glog("ui", "submitCreatePR.preflight-throw", { error: e instanceof Error ? e.message : String(e) });
    }
    await executeCreatePR();
  };

  // Action button — what we render at the right edge depends on PR state.
  // `showCreatePR` covers no-git, feature branches, and main+diff+no-remote
  // (carve-and-bootstrap). When a PR exists we always swap in the
  // PR-state-driven Merge / Open / Merged / Closed affordance.
  //
  // Wait until the first `gh pr view` poll has landed before showing
  // EITHER Create PR or Merge — otherwise the strip flashes Create PR
  // for ~0.5-1.5s on session mount and the user can click it before
  // the existing PR is detected (which then trips the "already exists"
  // path and a confusing FAIL trace). The `prCheckedOnce` gate is
  // scoped to feature branches (noGit + on-default still show Create
  // PR immediately, since they can't have an existing PR yet).
  //
  // Also stay on the placeholder while the auto-PR effect is mid-
  // dispatch (its createPR call detects an existing PR + flips pr
  // optimistically when it returns). Without this gate the strip
  // showed Create PR for ~2-3s between "poll said no PR" and
  // "auto-PR's optimistic setPr fired."
  const prCheckedOnce = !githubConnected || noGit || onDefaultBranch ? true : prStatusLoaded;
  const checkingPr = !prCheckedOnce || (autoPrInFlight && !pr);

  // ── Create slot (left of the merge cluster) ──
  // Create PR is ALWAYS rendered once the branch shape can act on it,
  // but goes disabled while the working branch already has an open PR
  // (spec §6). The merge cluster below targets the SELECTED PR
  // independently.
  let createSlot: React.ReactNode = null;
  if (checkingPr) {
    // Quiet placeholder so the slot stays the same width during the
    // initial poll — no jumpy layout when Merge / Create PR resolves.
    createSlot = (
      <span
        title="Checking PR status…"
        style={{
          // Plain inline breadcrumb text — no pill, no fill. Matches the
          // Review / Create PR links so the loading state reads as part
          // of the same quiet text row instead of popping as a box.
          display: "inline-flex", alignItems: "center", gap: 5,
          color: "var(--c-low)",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} />
        Checking…
      </span>
    );
  } else if ((showCreatePR || branchOpenPr) && !createBlocked) {
    // Split button: main "Create PR" + chevron-down for variants
    // (draft PR / manually create on the GitHub website). Not rendered
    // at all while blocked (open PR exists / empty diff) — see
    // createBlocked above.
    createSlot = (
      <div ref={createMenuRef} style={{ position: "relative", flexShrink: 0 }}>
        <div style={{
          // Plain inline text-link in the flat breadcrumb (matches
          // worktree · Review · Create PR). No pill, no fill — Create PR
          // gets a blue accent so it reads as the lead action.
          display: "inline-flex", alignItems: "center",
          background: "transparent",
          border: "none",
          borderRadius: 0,
        }}>
          {/* Main action — auto-fill + auto-submit. The user
              explicitly asked for "Create PR" to skip the dialog
              entirely: AI drafts the title and body, the call fires,
              and we let the post-create PR-status poll surface the
              new PR badge. The chevron menu still gives access to
              the dialog ("Create with custom title/body") and the
              draft variant for users who want fine-grained control.

              Heuristic+AI two-pass keeps the call honest even when
              the AI summarizer is slow or unavailable: we fall back
              to the diff-summary body and branch-name title that
              the dialog used as its initial seed. */}
          <button
            onClick={submitCreatePR}
            disabled={createDisabled}
            title={createTooltip}
            onMouseDown={e => e.preventDefault()}
            style={{
              padding: 0,
              background: "transparent",
              border: "none", outline: "none",
              // Blue accent text link — the lead action in the breadcrumb.
              color: "rgb(110,162,228)",
              cursor: createDisabled ? "default" : "pointer",
              fontSize: 12, fontWeight: 500,
              fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", gap: 5,
              opacity: createDisabled && !autoCreating ? 0.5 : autoCreating ? 0.7 : 1,
              transition: "color 0.1s",
            }}
            onMouseEnter={e => { if (!createDisabled) e.currentTarget.style.color = "rgb(140,184,236)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "rgb(110,162,228)"; }}
          >
            {autoCreating
              ? <><Loader2 size={10} style={{ animation: "spin 1.2s linear infinite" }} /> Creating…</>
              : "Create PR"}
          </button>

          {/* Dropdown caret — quiet, directly after the link (no divider /
              no pill, just a small chevron the same blue). Disabled in
              lockstep with the main Create PR action: a clickable menu
              next to a dead button read as a bug. */}
          <button
            onClick={createDisabled ? undefined : () => setCreateMenuOpen(o => !o)}
            disabled={createDisabled}
            onMouseDown={e => e.preventDefault()}
            title={createDisabled ? createTooltip : "More create options"}
            style={{
              padding: "0 2px 0 4px",
              background: "transparent",
              border: "none", outline: "none",
              color: "rgb(110,162,228)",
              cursor: createDisabled ? "default" : "pointer",
              opacity: createDisabled && !autoCreating ? 0.5 : autoCreating ? 0.7 : 1,
              display: "inline-flex", alignItems: "center",
            }}
          >
            <ChevronDown size={11} strokeWidth={2.25} style={{
              transform: createMenuOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }} />
          </button>
        </div>

        {/* Dropdown menu — opens below the split button, right-aligned. */}
        {createMenuOpen && (
          <div style={{
            // Opens UPWARD: BranchStrip lives just above a chat
            // input pinned to the bottom of the viewport, so a
            // top-anchored menu got clipped under the textarea (the
            // user saw it half-cut off). bottom: calc(100% + 6px)
            // floats the menu above the trigger with the same 6px
            // gap as the SessionToolbar popovers.
            position: "absolute", bottom: "calc(100% + 6px)", right: 0,
            minWidth: 200,
            // Theme-aware popover surface — was hardcoded #1c1c1c
            // which painted a black popover on the white chrome in
            // light theme.
            background: "var(--popover, #161616)",
            border: "1px solid var(--c-brd, rgba(255,255,255,0.08))",
            borderRadius: 8,
            // Shadow direction flipped to lift the menu OFF the
            // surface beneath (since it now floats up).
            boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
            padding: 4,
            zIndex: 50,
            display: "flex", flexDirection: "column",
            animation: "fleet-popover-up 0.14s ease-out both",
          }}>
            {/* Main action is the auto-fill flow now (handled by
                the split button itself). The menu is the escape
                hatch for users who want fine-grained control over
                title / body / draft flag — opens the full dialog. */}
            <CreateMenuItem
              icon={<GitPullRequest size={12} />}
              label="Create with custom title…"
              disabled={emptyDiffBlocked}
              title={emptyDiffBlocked ? "No changes to include in a PR" : undefined}
              onClick={() => { setCreateMenuOpen(false); setShowDialog(true); }}
            />
            <CreateMenuItem
              icon={<GitPullRequest size={12} />}
              label="Create draft PR"
              disabled={emptyDiffBlocked}
              title={emptyDiffBlocked ? "No changes to include in a PR" : undefined}
              onClick={() => { setCreateMenuOpen(false); setDraftDialog(true); }}
            />
            <CreateMenuItem
              icon={<ExternalLink size={12} />}
              label="Open on GitHub"
              onClick={() => { setCreateMenuOpen(false); if (folder) git.openPR(folder, branchOpenPr?.number); }}
            />
          </div>
        )}

        {/* Auth-method picker — surfaces here (anchored above the
            Create PR button) the instant the dispatcher needs to pick
            between Connect with GitHub and Use GitHub CLI. Replaces
            the legacy modal dialog: clicking anywhere outside dismisses
            without ceremony, and the popover stays open through the gh
            device-code dance so the user sees the code without leaving
            the page. */}
        {authChoiceOpen && (
          <AuthChoicePopover
            onChoose={(method) => {
              try { localStorage.setItem("fleet:github-auth-method", method); } catch { /* private mode */ }
              setAuthChoiceOpen(false);
              authChoiceResolverRef.current?.(method);
              authChoiceResolverRef.current = null;
            }}
            onDismiss={() => {
              setAuthChoiceOpen(false);
              authChoiceResolverRef.current?.(null);
              authChoiceResolverRef.current = null;
            }}
          />
        )}
      </div>
    );
  }

  // ── Merge slot (right of the create slot) ──
  // The merge cluster is ALWAYS visible once there's a PR to act on,
  // and targets the SELECTED PR (spec §6) — which may be the working
  // branch's own PR or a foreign one picked via the switcher chip. The
  // MERGED / CLOSED states stay bound to the working branch's PR.
  let mergeSlot: React.ReactNode = null;
  if (!checkingPr && githubConnected) {
    // The selected-PR cluster (Open · #N + purple Merge), targeting the
    // SELECTED repo-wide PR (spec §6). Extracted into a local so the
    // MERGED transitional state can render it ALONGSIDE the Sync-main
    // pair — otherwise the chip can point at a PR with no merge cluster.
    // null when there's no open PR to select.
    let foreignCluster: React.ReactNode = null;
    if (effSelectedRepoPr) {
      // `det` is the full PRStatus for the selected PR (the working
      // branch's own pr, or the foreign-PR poll). The mergeable / draft /
      // conflicts logic decides whether Merge is enabled. Pending checks
      // DON'T block — gh's `--auto` flag queues the merge and lets GitHub
      // do it once they pass.
      const det = overlaidPr;
      const checksFailing = det ? det.checks.failing > 0 : false;
      // resolveMergeGate folds GitHub's branch-protection-aware mergeStateStatus
      // into the button's enabled state: on a protected branch with required
      // checks pending/failing it returns canMerge=false, so Merge is honestly
      // un-clickable. (No fabricated "(auto)" — `merge_pr` never passed `--auto`,
      // so that click used to just fail against a protected branch.)
      const gate = resolveMergeGate(det);
      const canMerge = gate.canMerge;
      // A CONFLICTING PR (but not a failing-checks one — the agent can't
      // fix red CI from here) becomes an agent-resolve action instead of
      // a dead disabled button, when a session is wired to resolve it.
      const canResolve = !!det && det.mergeable === "CONFLICTING" && !checksFailing
        && !!onResolveConflicts && !!folder;
      const mergeTitle = gate.reason;
      // CI status ring + click-through details popover — only when the PR
      // actually has checks (repos without CI keep the strip clean).
      const checksRing = det && det.checks.total > 0 ? (
        <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <PrChecksIndicator
            checks={det.checks}
            open={checksOpen}
            onClick={() => setChecksOpen(o => !o)}
          />
          {checksOpen ? (
            <PrChecksPopover
              runs={det.checks.runs ?? []}
              summary={det.checks}
              // The PR's checks tab — target of the popover's footer action and
              // the fallback for runs GitHub reported without a link.
              prChecksUrl={det.url ? `${det.url.replace(/\/+$/, "")}/checks` : null}
              onOpenCheck={(url) => {
                openExternalUrl(url);
                setChecksOpen(false);
              }}
              onDismiss={() => setChecksOpen(false)}
              onRerunCheck={onRerunCheck}
              onRerunFailed={onRerunFailed}
            />
          ) : null}
        </span>
      ) : null;
      foreignCluster = (
        <>
          <ActionBtn onClick={onOpenSelected} title={`Open #${effSelectedRepoPr.number} on GitHub`}>
            Open · #{effSelectedRepoPr.number} <ExternalLink size={11} strokeWidth={1.85} />
          </ActionBtn>
          {/* Hairline-dot separator matches the Review · Create PR rhythm so
              View and Merge read as two distinct actions, not one run-on.
              #N is dropped here — the status pill on the left already shows
              it, so repeating it on the right was redundant noise. */}
          <span aria-hidden style={{ opacity: 0.4 }}>·</span>
          {checksRing}
          {canResolve ? (
            <ActionBtn onClick={onResolveAndMerge} primary accent="purple"
              disabled={!!resolving}
              title={`Have the session's agent resolve the conflicts with ${det.baseRefName}, then squash + merge #${det.number}`}>
              {resolving
                ? <>Resolving… <Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /></>
                : <>Resolve &amp; merge <GitMerge size={11} /></>}
            </ActionBtn>
          ) : (
            <ActionBtn onClick={onMerge} primary accent="purple" disabled={!canMerge || merging} title={mergeTitle}>
              {merging
                ? <>Merging… <Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /></>
                : <>Merge <GitMerge size={11} /></>}
            </ActionBtn>
          )}
        </>
      );
    }

    if (pr && pr.state === "MERGED") {
      // The branch PR was MERGED. Off-worktree this is transient: the poll's
      // P1 filter drops a non-self merged branch PR, and an in-app merge clears
      // it via the auto-cleanup — so here we only show "View", plus (worktree
      // only) the manual "Start next round". Catching the local base up to
      // origin is a SEPARATE concern now, handled by the standalone
      // "Sync <base>" action (driven by ctx.baseBehind), not by this PR state.
      // When the repo ALSO has an open PR, its merge cluster renders too so the
      // chip never points at an unactionable PR (spec §6).
      mergeSlot = (
        <>
          <ActionBtn onClick={onOpenPR} title={`Open #${pr.number} on GitHub`}>
            View <ExternalLink size={11} strokeWidth={1.85} />
          </ActionBtn>
          {isWorktree && (
            // Worktree boot-into-merged affordance. When the app opens a
            // session whose PR was already merged (no live OPEN→MERGED flip
            // observed this session, so the poll's auto-advance never fired),
            // this is the manual trigger to carve the next round. Idle-gated:
            // a streaming turn must finish before we repoint the worktree.
            <ActionBtn onClick={() => doWorktreeNextRound(pr.baseRefName || ctx?.baseBranch || "main")}
              primary disabled={syncing || isStreaming}
              title={isStreaming ? "Wait for the current turn to finish" : "Carve a fresh worktree for the next round"}>
              {syncing
                ? <><Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Starting…</>
                : <><Check size={11} /> Start next round</>}
            </ActionBtn>
          )}
          {foreignCluster != null && <span aria-hidden style={{ opacity: 0.4 }}>·</span>}
          {foreignCluster}
        </>
      );
    } else if (pr && pr.state === "CLOSED" && !effSelectedRepoPr) {
      mergeSlot = (
        <ActionBtn onClick={onOpenPR} title={`Closed · #${pr.number}`}>
          <X size={11} /> Closed · #{pr.number}
        </ActionBtn>
      );
    } else if (effSelectedRepoPr) {
      // OPEN, repo-wide — the common case.
      mergeSlot = foreignCluster;
    }
  }

  // ── Standalone "Sync <base>" slot ──
  // Shown when the local base branch has drifted behind origin
  // (ctx.baseBehind > 0), INDEPENDENT of any PR state — the honest replacement
  // for the old post-merge Sync-main button (which keyed off pr.state ===
  // "MERGED"). A pure fast-forward of the local base; worktree sessions use the
  // "Start next round" carve instead, so it's off-worktree only. Uses the
  // DETECTED base name in the label/tooltip — never assumes "main".
  const baseBehind = ctx?.baseBehind ?? 0;
  const showSyncBase = !noGit && !isWorktree && baseBehind > 0 && !!ctx?.baseBranch;
  const syncBaseSlot: React.ReactNode = showSyncBase ? (
    <ActionBtn onClick={onSyncBaseOnly} disabled={syncing}
      title={`${ctx!.baseBranch} is ${baseBehind} commit${baseBehind === 1 ? "" : "s"} behind origin — fast-forward your local ${ctx!.baseBranch}`}>
      {syncing
        ? <><Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Syncing…</>
        : <><RefreshCw size={11} strokeWidth={1.85} /> Sync {ctx!.baseBranch}</>}
    </ActionBtn>
  ) : null;

  return (
    <>
      <div style={{
        // Flat single-line breadcrumb — no pill, no border, no fill. Just a
        // soft context row above the input that reads as the project's git
        // location: branch on the left, action verbs on the right. Sits
        // VERY quietly so the input itself is the focal point.
        // Horizontal padding matches the input card's inner content so the
        // branch glyph lines up with the textarea text and Create PR lines
        // up with the Send button — the breadcrumb reads as the card's top
        // line, not a separate floating row.
        display: "flex", alignItems: "center", gap: 7,
        padding: "0 11px 5px",
        background: "transparent",
        border: "none",
        color: "var(--c-low)",
        fontSize: 12,
      }}>
        {/* Worktree badge — leading context tag. When the session's files live
            in an isolated git worktree (not the source repo's working tree),
            surface a small, calm "WORKTREE" chip so the isolation reads at a
            glance. Off-worktree sessions omit it entirely. Theme-aware tokens
            keep it legible in light + dark without shouting over the actions. */}
        {isWorktree && (
          <span
            title="This session works in an isolated git worktree — its file edits are separate from the source repo's working tree"
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              flexShrink: 0,
              padding: "1px 6px 1px 5px",
              borderRadius: 4,
              fontSize: 9.5, fontWeight: 600, letterSpacing: "0.07em",
              lineHeight: 1.7,
              textTransform: "uppercase",
              color: "var(--c-med)",
              background: "rgba(var(--fg-rgb), 0.05)",
              border: "1px solid rgba(var(--fg-rgb), 0.12)",
            }}
          >
            <FolderGit2 size={10} strokeWidth={1.9} style={{ opacity: 0.85 }} />
            Worktree
          </span>
        )}

        {/* Branch glyph — FAR LEFT; small, transparent chip. Suppressed
            when the labeled PR pill is shown (below): the pill already
            carries a PR icon + the state colour, so a second standalone
            glyph next to it just doubled up. We keep the glyph only when
            there's no pill (no open PR, or the branch PR is MERGED/CLOSED
            and not in the open-PR list) so that state still reads at a
            glance. */}
        {!(openPrsList.length > 0 && effectiveSelectedNumber != null) && (
          <span style={{
            width: 18, height: 18, borderRadius: 5,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "transparent",
            color: githubConnected && (pr?.state === "MERGED" || pr?.state === "CLOSED") ? prIconColor(pr) : "var(--c-low)",
            flexShrink: 0,
          }}>
            {githubConnected && pr?.state === "MERGED" ? <Check size={12} strokeWidth={2.5} />
              : githubConnected && pr?.state === "CLOSED" ? <X size={12} strokeWidth={2.5} />
              : <GitBranch size={12} strokeWidth={1.85} />}
          </span>
        )}

        {/* PR switcher — right of the glyph: selected open PR + status
            dot, popover lists every open PR in the repo (spec §6). Only
            surfaces once the repo-wide poll has open PRs. Hidden entirely in
            worktree mode (`showSwitcher` is false there): one session ↔ one
            branch ↔ one PR, so the repo-wide cross-PR switcher is noise and a
            foreign pick must never become the merge target. */}
        {showSwitcher && openPrsList.length > 0 && effectiveSelectedNumber != null && (
          <PrSwitcherChip
            openPrs={openPrsList}
            selectedNumber={effectiveSelectedNumber}
            selectedStatus={overlaidPr}
            onSelect={setSelectedPrNumber}
            onOpenUrl={(p) => {
              const w = window as unknown as { electronAPI?: { openExternal?: (url: string) => Promise<unknown> } };
              if (p.url) void w.electronAPI?.openExternal?.(p.url);
              else if (folder) void git.openPR(folder, p.number);
            }}
          />
        )}

        {/* Branch label — minimal, no decorative dots or pulses.
            Per-pill click handlers: the base/main pill opens the
            BranchPickerMenu in "base" mode (current base + Create new
            main branch), the working pill opens it in "working" mode
            (every other branch + Create new branch). noGit and pure
            planned-only renders stay informational — no menu until a
            real repo exists. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            flex: 1,
            position: "relative",
            padding: "1px 2px",
            borderRadius: 4,
          }}
        >
          {noGit && plannedBranch ? (
            // Planned label — folder isn't a git repo yet, but the
            // dispatcher will carve `plannedBranch` on Create PR. The
            // dimmed/dashed pills read as "not landed yet" — no menu
            // yet because there's nothing to switch *to*.
            <>
              <BranchPill text="main" tone="low" dim />
              <ArrowLeft size={11} strokeWidth={1.75}
                style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.7 }} />
              <BranchPill text={plannedBranch} tone="med" dim />
            </>
          ) : noGit ? (
            <NoGitPill />
          ) : onDefaultBranch && plannedBranch && plannedBranch !== ctxR.branch ? (
            // We DO have a git repo — agent's on main/master and a feature
            // branch will be carved on Create PR. The current (base) pill opens
            // the base menu. The planned pill stays DIM (it doesn't exist yet)
            // but is still interactive: clicking it opens the working-branch
            // switcher so the user can check out an existing branch or carve a
            // new one now, instead of being stuck on the default branch with a
            // dead label (the "I can't change the working branch on a real repo"
            // case).
            <>
              <PillTrigger onClick={() => setBranchMenuMode("base")}>
                <BranchPill text={ctxR.branch} tone="low" dim />
              </PillTrigger>
              <ArrowLeft size={11} strokeWidth={1.75}
                style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.7 }} />
              <PillTrigger onClick={() => setBranchMenuMode("working")}>
                <BranchPill text={plannedBranch} tone="med" dim />
              </PillTrigger>
            </>
          ) : onDefaultBranch ? (
            <PillTrigger onClick={() => setBranchMenuMode("base")}>
              <BranchPill text={ctxR.branch} tone="low" />
            </PillTrigger>
          ) : (
            <>
              <PillTrigger onClick={() => setBranchMenuMode("base")}>
                <BranchPill
                  text={ctxR.baseBranch ?? "main"}
                  tone="low"
                  dim={!ctxR.baseBranch}
                />
              </PillTrigger>
              <ArrowLeft size={11} strokeWidth={1.75}
                style={{ color: "var(--c-ghost)", flexShrink: 0, opacity: 0.7 }} />
              <PillTrigger onClick={() => setBranchMenuMode("working")}>
                <BranchPill text={ctxR.branch} tone="med" />
              </PillTrigger>
            </>
          )}
          {branchMenuMode && folder && (
            <BranchPickerMenu
              folder={folder}
              mode={branchMenuMode}
              currentBranch={ctxR?.branch ?? null}
              baseBranch={ctxR?.baseBranch ?? null}
              newBranchTopic={
                sessionTitle ||
                ((ctxR?.branch || "").replace(/^fleet\//, "").replace(/-[a-f0-9]{8}$/, "")) ||
                "scratch"
              }
              onPick={() => setBranchMenuMode(null)}
              onCreateNew={() => setBranchMenuMode(null)}
              onBaseChanged={() => {
                setBranchMenuMode(null);
                // Re-pull git context so the detected base reflects
                // the new `fleetify.baseBranch` config. The 5s poll
                // would catch it eventually, but a direct refetch
                // keeps the strip from showing the stale base for up
                // to one tick.
                if (folder) {
                  const api = (window as unknown as { electronAPI?: {
                    getGitContext?: (f: string) => Promise<GitContext>;
                  } }).electronAPI;
                  api?.getGitContext?.(folder)
                    .then(c => setCtx(c ?? null))
                    .catch(() => {});
                }
              }}
              onDismiss={() => setBranchMenuMode(null)}
            />
          )}
        </div>

        {/* Right cluster — inline text breadcrumb (`worktree · Review ·
            Create PR`), separated by hairline dots. No pills, no borders,
            no diff counts — the strip is meant to whisper the project's
            git location, not advertise it. Create PR / Merge / Open get a
            blue accent so the lead action stands out without a button
            chrome. Hidden behind a flex spacer so they sit flush right. */}
        <div style={{ flex: 1 }} />
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          color: "var(--c-low)", fontSize: 12,
        }}>
          {/* "Sync <base>" sits leftmost — a quiet "your base drifted behind
              origin" nudge that must not displace the lead Create PR / Merge
              actions from the prominent right edge (nearest the Send button). */}
          {syncBaseSlot}
          {syncBaseSlot != null && (showReview || createSlot != null || mergeSlot != null) && (
            <span aria-hidden style={{ opacity: 0.4 }}>·</span>
          )}
          {showReview && (
            <>
              <button
                onClick={() => setReviewOpen(true)}
                onMouseDown={e => e.preventDefault()}
                title={`Review with ${tool || "agent"}`}
                aria-label="Review changes"
                style={{
                  background: "transparent", border: "none", outline: "none",
                  padding: 0, fontFamily: "inherit", fontSize: 12,
                  color: "var(--c-low)", cursor: "pointer",
                  transition: "color 0.12s",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "var(--c-high)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--c-low)"; }}
              >
                Review
              </button>
              {(createSlot != null || mergeSlot != null) && <span aria-hidden style={{ opacity: 0.4 }}>·</span>}
            </>
          )}
          {createSlot}
          {createSlot != null && mergeSlot != null && <span aria-hidden style={{ opacity: 0.4 }}>·</span>}
          {mergeSlot}
        </div>
      </div>

      {/* PR creation dialog — controlled by Create PR button or the
          "Create draft PR" menu item. Both go through the same dialog;
          the menu item just pre-ticks the draft checkbox. */}
      {!noGit && (showDialog || draftDialog) && folder && ctxR.baseBranch && (
        <PRDialog
          folder={folder}
          branch={ctxR.branch}
          baseBranch={ctxR.baseBranch}
          tool={tool}
          // Same carve target the split button sends (executeCreatePR). Without
          // it the dialog paths ("Create with custom title…" / "Create draft
          // PR") commit onto the session's CURRENT branch — which, for a
          // bootstrap-shape session, is the user's default branch.
          featureBranch={isBootstrapShape ? plannedBranch! : undefined}
          initialDraft={draftDialog}
          onClose={() => { setShowDialog(false); setDraftDialog(false); }}
          onCreated={() => {
            setTimeout(() => folder && git.prStatus(folder).then(s => s.ok && setPr(s.pr)), 600);
          }}
        />
      )}

      {/* Review dialog — opened by the ScanEye button. Asks the
          session's CLI to inspect the current diff and renders the
          response as Markdown. */}
      {reviewOpen && folder && (
        <ReviewDialog
          folder={folder}
          baseBranch={ctx?.baseBranch || "main"}
          tool={tool}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {/* Recovery dialog — opens when Create PR fails with anything
          other than REPO_CREATE_FORBIDDEN. The session's CLI is asked
          to diagnose the failure and propose a whitelisted recovery
          action (pull-rebase / force-with-lease / set-upstream /
          custom-command / manual). Apply runs the corresponding
          command in the main process; Retry re-fires the same Create
          PR call. The app — NOT the agent — executes git, keeping
          the action set safe. */}
      {recovery && folder && (
        <RecoveryDialog
          folder={folder}
          baseBranch={ctx?.baseBranch || "main"}
          tool={tool}
          errorMessage={recovery.error}
          context="Create PR"
          onClose={() => setRecovery(null)}
          onRetry={submitCreatePR}
        />
      )}

      {/* Pre-flight dialog — opens when the deterministic scan finds
          structural blockers (nested-no-commits, mid-rebase). Each
          issue has exactly one obvious fix, applied via
          applyPreflightFix. Continue resumes the Create PR happy
          path; Cancel aborts. */}
      {preflight && folder && (
        <PreflightDialog
          folder={folder}
          issues={preflight.issues}
          onContinue={() => {
            setPreflight(null);
            // executeCreatePR is fresh on each render — captures
            // the latest state. We're calling it AFTER setPreflight
            // schedules an update, but React batches and the
            // closure here is from this render's snapshot, which is
            // fine because submitCreatePR pulled it from the same
            // scope.
            void executeCreatePR();
          }}
          onCancel={() => setPreflight(null)}
        />
      )}
      {/* The mid-flow auth picker now renders as a popover anchored to
          the Create PR button (see action-area JSX above). The legacy
          full-screen GithubAuthChoiceDialog is kept as a fallback for
          code paths that don't have a Create PR button to anchor on. */}
    </>
  );
}

/** Action button at the right edge of the BranchStrip. Two visual
 *  weights — primary (Create PR / Merge) lifts onto the foreground,
 *  ghost (Open / Merged status) sits on a subtle bg. */
/** Single row inside the Create-PR split-button dropdown.
 *  Icon + label, optional trailing checkmark for the "current" choice. */
function CreateMenuItem({
  icon, label, checked, disabled, title, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      onMouseDown={e => e.preventDefault()}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        width: "100%", padding: "6px 10px",
        background: "transparent", border: "none", outline: "none",
        color: "#e8e8e8",
        fontSize: 12.5, fontWeight: 400,
        cursor: disabled ? "default" : "pointer", textAlign: "left",
        borderRadius: 5, fontFamily: "inherit",
        opacity: disabled ? 0.45 : 1,
        transition: "background 0.1s",
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ display: "flex", color: "#a8a8a8", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {checked && <Check size={12} strokeWidth={2.5} style={{ color: "#c8c8c8", flexShrink: 0 }} />}
    </button>
  );
}

function ActionBtn({
  children, onClick, primary, accent, disabled, title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  /** Primary accent — "blue" (default, Create PR/Sync) or "purple" (Merge). */
  accent?: "blue" | "purple";
  disabled?: boolean;
  title?: string;
}) {
  // Inline text-link in the new "Focused" branch breadcrumb — no pill chrome
  // any more. Primary actions get an accent so the lead verb stands out;
  // secondary actions (Open · #N) stay muted. Merge goes purple via the
  // theme-tuned --pr-merge vars (light needs a deeper violet than dark);
  // everything else (Create PR / Sync) stays blue.
  const LINK = accent === "purple" ? "var(--pr-merge, #c4b5fd)" : "rgb(110,162,228)";
  const LINK_HOVER = accent === "purple" ? "var(--pr-merge-hover, #ddd6fe)" : "rgb(140,184,236)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: "transparent", border: "none", outline: "none",
        padding: 0, fontFamily: "inherit", fontSize: 12,
        fontWeight: primary ? 500 : 400,
        color: primary ? LINK : "var(--c-low)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        display: "inline-flex", alignItems: "center", gap: 5,
        transition: "color 0.12s, opacity 0.12s",
      }}
      onMouseDown={e => e.preventDefault()}
      onMouseEnter={e => {
        if (disabled) return;
        e.currentTarget.style.color = primary ? LINK_HOVER : "var(--c-high)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = primary ? LINK : "var(--c-low)";
      }}
    >
      {children}
    </button>
  );
}
