import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { pinnedSessionIds } from "@/lib/session-pins";

type VisibilityState = {
  activeSessionId: string | null;
  staffSessionId: string | null;
  splitPaneIds?: string[] | null;
};

/** The sessions whose transcript is on screen right now.
 *
 *  Must agree with chat-view, which renders `activeSessionId || staffSessionId`:
 *  on the Fleet hub there is no active agent, and the conversation the user is
 *  looking at is the STAFF session. Leaving it out handed the hub's transcript
 *  to the sweep below. */
export function visibleSessionIds(app: VisibilityState): string[] {
  const main = app.activeSessionId || app.staffSessionId;
  return [...new Set([main, ...(app.splitPaneIds ?? [])])]
    .filter((x): x is string => Boolean(x));
}

/** Renderer-memory sweep: drop the re-fetchable transcript of every session
 *  that is neither visible nor streaming. Lossless for a hidden session
 *  (chat-view re-fetches from SQLite when it is opened) — but NOT for a visible
 *  one, because chat-view only re-fetches when the session id changes.
 *
 *  "Visible" also covers the pinned sessions (session-pins.ts): the ones a
 *  surface outside chat-view has on screen, such as a Workflows run detail.
 *  Nothing reloads a transcript for those surfaces, so emptying it would blank
 *  them. */
export function sweepInactiveSessions(): void {
  useChatStore.getState().evictInactive([
    ...visibleSessionIds(useAppStore.getState()),
    ...pinnedSessionIds(),
  ]);
}
