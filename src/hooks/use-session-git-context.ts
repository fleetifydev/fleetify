import { useEffect, useState } from "react";

/** Working branch + a LIVE uncommitted diff stat for a session's folder. */
export interface SessionGitContext {
  branch: string | null;
  plus: number;
  minus: number;
}

/** Poll cadence while the card is open. The backing call (`getWorkingDiff`) is
 *  two git subprocesses, so a tight interval stays responsive without piling
 *  up — and an in-flight guard skips a tick that would overlap a slow call. */
const POLL_MS = 500;

interface RawDiff { branch?: string | null; plus?: number; minus?: number }

function fetchWorkingDiff(folder: string): Promise<SessionGitContext | null> {
  const w = window as unknown as {
    electronAPI?: { getWorkingDiff?: (f: string) => Promise<RawDiff | null> };
  };
  const fn = w.electronAPI?.getWorkingDiff;
  if (!fn) return Promise.resolve(null);
  return fn(folder)
    .then(c => (c ? { branch: c.branch ?? null, plus: c.plus ?? 0, minus: c.minus ?? 0 } : null))
    .catch(() => null);
}

/** Live working branch + uncommitted diff for a session's folder. While
 *  `enabled` (the card is open) it polls every POLL_MS so the diff updates
 *  as the agent edits files. Returns null until the first load (or when the
 *  shell bridge is unavailable). */
export function useSessionGitContext(folder: string | null | undefined, enabled: boolean): SessionGitContext | null {
  const [ctx, setCtx] = useState<SessionGitContext | null>(null);

  useEffect(() => {
    if (!enabled || !folder) { setCtx(null); return; }
    let cancelled = false;
    let inFlight = false;

    const load = () => {
      if (inFlight) return;
      inFlight = true;
      void fetchWorkingDiff(folder).then(data => {
        inFlight = false;
        if (!cancelled && data) setCtx(data);
      });
    };

    load();
    const iv = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [folder, enabled]);

  return ctx;
}
