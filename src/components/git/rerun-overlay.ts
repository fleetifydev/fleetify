import type { ChecksSummary } from "@/components/git/pr-checks-indicator";
import type { CheckRun } from "@/lib/git-api";

export type ChecksWithRuns = ChecksSummary & { runs?: CheckRun[] };

/**
 * Optimistically flip the named failing checks to `pending`, so the chip / ring
 * / popover read "waiting" the instant a re-run is triggered — before the next
 * status poll reflects GitHub's new state. Pure + idempotent: returns a new
 * object only when something changed; checks not named in `rerunning`, and
 * checks that aren't currently `failing`, are left untouched.
 */
export function applyRerunOverlay(
  checks: ChecksWithRuns,
  rerunning: ReadonlySet<string>,
): ChecksWithRuns {
  if (rerunning.size === 0 || !checks.runs?.length) return checks;
  let moved = 0;
  const runs = checks.runs.map((r) => {
    if (r.bucket === "failing" && rerunning.has(r.name)) {
      moved++;
      return { ...r, bucket: "pending" as const, conclusion: null, status: "QUEUED" };
    }
    return r;
  });
  if (moved === 0) return checks;
  return {
    ...checks,
    failing: Math.max(0, checks.failing - moved),
    pending: checks.pending + moved,
    runs,
  };
}
