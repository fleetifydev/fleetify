/** "Has this session left the setup phase?" — a durable latch.
 *
 *  Three surfaces need that answer: the auto-intro (fire a bootstrap prompt at a
 *  brand-new session), the SessionToolbar (the pre-deploy folder / branch /
 *  worktree setup row), and the BranchStrip (the post-deploy PR surface). All
 *  three used to infer it from the in-memory message list — "does this session
 *  have a real message yet?".
 *
 *  That list is wipeable. Clearing the chat made an established session look
 *  brand new, and all three misfired at once: the setup row came back on a
 *  session that already had a worktree, the branch strip vanished, and — worst
 *  — the auto-intro re-armed, so returning to the session started the agent on
 *  a prompt nobody typed.
 *
 *  So the latch is set once, from either direction: a real message appeared, or
 *  the user deliberately emptied the chat. Both mean "past setup". It never
 *  un-sets; there is no path from an established session back to a fresh one.
 *
 *  localStorage rather than a session column: it is a client-side UX latch that
 *  must survive a remount and a reload, and it must not need a migration.
 *  Sessions that were established before this shipped still read as established
 *  through the message list, so nothing needs backfilling.
 *
 *  Bounded so months of use can't grow it without limit. Evicting the oldest is
 *  safe: a session old enough to fall off has real messages again, which is
 *  itself the signal. */
const KEY = "fleet:sessions-established";
/** Keep the most recent N — well above any plausible number of live sessions. */
const MAX = 500;

/** Read-through cache so the render path never touches localStorage per call. */
let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    // Unavailable / corrupt storage degrades to "nothing latched", which at
    // worst restores the old behaviour — it never throws into a render.
    cache = new Set();
  }
  return cache;
}

export function isSessionEstablished(sessionId: string | null | undefined): boolean {
  return !!sessionId && load().has(sessionId);
}

/** Latch this session as past setup. Idempotent. */
export function markSessionEstablished(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const set = load();
  if (set.has(sessionId)) return;
  set.add(sessionId);
  try {
    // Newest first so the size cap evicts the least recently latched.
    const next = [sessionId, ...[...set].filter((id) => id !== sessionId)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    cache = new Set(next);
  } catch {
    /* best-effort: the in-memory cache still holds for this app run */
  }
}

/** Test seam — drops the cached read so a test can control localStorage. */
export function __resetSessionEstablishedCache(): void {
  cache = null;
}
