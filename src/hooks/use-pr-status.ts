/**
 * Polls PR status for a single session's worktree folder. Returns the
 * latest PR or null. Polls on mount + every 30 seconds — the sidebar
 * has many of these in flight at once, so the cadence is half the rate
 * of the BranchStrip's per-session poll.
 *
 * Hook deliberately swallows errors (gh missing, no remote, etc.) and
 * keeps returning null — the badge just doesn't render. The point is
 * "show PR state when we know it", not "surface every git failure".
 */
import { useEffect, useState } from "react";
import { git, type PRStatus } from "@/lib/git-api";

export function usePRStatus(folder: string | null | undefined): PRStatus | null {
  const [pr, setPr] = useState<PRStatus | null>(null);

  useEffect(() => {
    if (!folder) { setPr(null); return; }
    let cancelled = false;
    const load = () => {
      git.prStatus(folder).then(r => {
        if (cancelled) return;
        setPr(r.ok ? (r.pr ?? null) : null);
      }).catch(() => { if (!cancelled) setPr(null); });
    };
    load();
    // Pause while the window is hidden — the sidebar runs one of these per
    // session, so a backgrounded app would otherwise keep firing N `gh pr`
    // subprocesses + GitHub API calls every 30s for data nobody is looking
    // at. Resumes on the next tick after the window is visible again.
    const iv = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [folder]);

  return pr;
}
