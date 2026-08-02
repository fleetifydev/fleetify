/**
 * Fleet headline counts.
 *
 * Active and idle are defined as exact complements here, in one place, so the
 * strip can never show three numbers that don't add up. Splitting the two
 * derivations across call sites is how "Agents 12 / Active 5 / Idle 4"
 * happens.
 *
 * Idle here means "not currently working" — it is deliberately NOT the 24h
 * staleness notion that drives the "Archive idle" action in index.tsx. That
 * one answers "is this session safe to archive"; this one answers "how much of
 * the fleet is doing nothing right now". Conflating them would make the strip
 * report a number that doesn't complement Active, and would quietly change
 * what the archive button sweeps up.
 */

/** Statuses that mean the agent is doing work right now. */
const ACTIVE_STATUSES = new Set(["running", "starting"]);

interface HasStatus {
  status?: string;
}

export function countActive(sessions: readonly HasStatus[]): number {
  return sessions.filter(s => !!s.status && ACTIVE_STATUSES.has(s.status)).length;
}

export function countIdle(sessions: readonly HasStatus[]): number {
  return sessions.length - countActive(sessions);
}
