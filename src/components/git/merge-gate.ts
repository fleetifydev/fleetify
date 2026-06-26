/**
 * resolveMergeGate — the single source of truth for whether the BranchStrip's
 * Merge button is clickable, and why.
 *
 * It trusts GitHub's computed `mergeStateStatus` (branch-protection-aware:
 * required checks, required reviews, up-to-date rules all fold into it) instead
 * of re-deriving merge-readiness from our own check counts. This is what makes
 * the button HONEST: on a protected branch with required checks still pending,
 * GitHub reports BLOCKED and the button is genuinely un-clickable — rather than
 * appearing actionable and then failing when `gh pr merge` is rejected.
 *
 * When `mergeStateStatus` is absent (older backend) or UNKNOWN (GitHub still
 * computing right after a push), it falls back to the legacy heuristic so a
 * transient state never dead-locks the button.
 */
import type { PRStatus } from "@/lib/git-api";

export type MergeGateKind =
  | "loading"
  | "clean"
  | "blocked"
  | "behind"
  | "conflicting"
  | "draft"
  | "unknown";

export type MergeGate = {
  kind: MergeGateKind;
  /** Whether the primary Merge action is enabled. */
  canMerge: boolean;
  /** Human tooltip explaining the state / why merge is blocked. */
  reason: string;
};

/** Why a not-yet-mergeable PR is held up, phrased from the check counts. */
function blockedReason(det: PRStatus): string {
  const { failing, pending } = det.checks;
  if (failing > 0) return `${failing} check${failing > 1 ? "s" : ""} failing`;
  if (pending > 0) return `Waiting on ${pending} check${pending > 1 ? "s" : ""} to pass`;
  return "Blocked by branch protection — review required";
}

export function resolveMergeGate(det: PRStatus | null): MergeGate {
  if (!det) return { kind: "loading", canMerge: false, reason: "Loading PR status…" };

  const mss = (det.mergeStateStatus ?? "").toUpperCase();
  const failing = det.checks.failing > 0;
  const base = det.baseRefName || "base";
  const mergeReason = `Squash + merge #${det.number} into ${base}`;

  // Conflicts (GitHub DIRTY, or our own CONFLICTING flag) → resolve path.
  if (det.mergeable === "CONFLICTING" || mss === "DIRTY") {
    return {
      kind: "conflicting",
      canMerge: false,
      reason: "Has merge conflicts — resolve on GitHub or rebase locally",
    };
  }

  // Branch-protection-aware blocks — trust GitHub's computed state.
  if (mss === "BLOCKED") {
    return { kind: "blocked", canMerge: false, reason: blockedReason(det) };
  }
  if (mss === "BEHIND") {
    return { kind: "behind", canMerge: false, reason: `Branch is behind ${base} — update required` };
  }

  // Draft → one-click "mark ready + squash-merge", but never over failing
  // checks (we can't tell required-ness for a draft, so stay conservative).
  if (det.isDraft) {
    if (failing) return { kind: "blocked", canMerge: false, reason: blockedReason(det) };
    return {
      kind: "draft",
      canMerge: true,
      reason: `Mark #${det.number} ready for review and squash + merge into ${base}`,
    };
  }

  // Mergeable per GitHub. UNSTABLE is included on purpose: its failing/pending
  // checks are NOT required, so GitHub allows the merge and we don't invent a
  // stricter rule.
  if (mss === "CLEAN" || mss === "HAS_HOOKS" || mss === "UNSTABLE") {
    return { kind: "clean", canMerge: true, reason: mergeReason };
  }

  // UNKNOWN / field absent → legacy heuristic (don't dead-lock on a transient).
  if (det.mergeable !== "CONFLICTING" && !failing) {
    return { kind: "clean", canMerge: true, reason: mergeReason };
  }
  return { kind: "blocked", canMerge: false, reason: blockedReason(det) };
}
