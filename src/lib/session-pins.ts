import { useLayoutEffect } from "react";

/** Sessions held on screen by a surface other than chat-view.
 *
 *  The inactive-session sweep (session-eviction.ts) counts a transcript as on
 *  screen only when a chat view shows it. Other surfaces read transcripts too,
 *  and nothing reloads one for them once the sweep has emptied it: the
 *  Workflows run detail fetches its run's transcript once, and the dashboard
 *  widgets read only what is already in memory. A pin keeps the sweep off a
 *  session while such a surface shows it.
 *
 *  Reference-counted, because two surfaces can show the same session and one
 *  of them closing must not release the other's hold. */
const pins = new Map<string, number>();

/** Pin a session until the returned function is called. That function
 *  releases this one pin, once: calling it again does nothing, so a doubled
 *  cleanup cannot release another holder's pin. */
export function pinSession(id: string): () => void {
  pins.set(id, (pins.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (pins.get(id) ?? 0) - 1;
    if (left > 0) pins.set(id, left);
    else pins.delete(id);
  };
}

/** Every session at least one holder has pinned. */
export function pinnedSessionIds(): string[] {
  return [...pins.keys()];
}

/** Pin `id` while the calling component is mounted. The pin follows the id,
 *  and there is none while the id is null or undefined.
 *
 *  A layout effect, not a passive one, because it runs inside the commit, so
 *  the pin exists before any sweep can see the new screen. A passive effect
 *  can be flushed a task later, and the sweep timer can fire in that gap and
 *  empty a transcript the surface will not fetch again. */
export function usePinnedSession(id: string | null | undefined): void {
  useLayoutEffect(() => (id ? pinSession(id) : undefined), [id]);
}

/** {@link usePinnedSession} for a component that reads a list of sessions.
 *  Keyed on the set of ids rather than the array, so a re-render with a fresh
 *  array of the same sessions neither releases nor re-takes a pin. */
export function usePinnedSessions(ids: readonly string[]): void {
  const key = JSON.stringify([...new Set(ids)].sort());
  useLayoutEffect(() => {
    const releases = (JSON.parse(key) as string[]).map((id) => pinSession(id));
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
}
