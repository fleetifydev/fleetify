/**
 * How long a session has actually been worked on.
 *
 * Deliberately NOT wall-clock span. A session opened Monday and touched again
 * Friday would report "4 days", which says nothing about effort. Instead we
 * sum the gaps between consecutive activity events and drop any gap longer
 * than IDLE_GAP_MS — those are the user being away, not the agent working.
 *
 * Source is the activity ledger the detail pane already loads, so this costs
 * no extra request.
 */

/** A gap longer than this is the user being away, not work in progress. */
export const IDLE_GAP_MS = 15 * 60_000;

interface HasTs {
  ts: string;
}

/**
 * @returns active milliseconds, or **null** when the duration is unknowable —
 *          no events, or only one. Null and zero are different answers: null
 *          means "no data", zero means "data, but nothing counted". Rendering
 *          an unknown duration as "0m" would be a lie.
 */
export function activeWorkingMs(activity: readonly HasTs[]): number | null {
  const times = activity
    .map(a => Date.parse(a.ts))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;

  let total = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap <= IDLE_GAP_MS) total += gap;
  }
  return total;
}

/** Compact duration for a stat line: "—", "<1m", "9m", "2h 7m", "3h". */
export function formatWorkingTime(ms: number | null): string {
  if (ms === null) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
