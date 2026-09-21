import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";

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
 *  one, because chat-view only re-fetches when the session id changes. */
export function sweepInactiveSessions(): void {
  useChatStore.getState().evictInactive(visibleSessionIds(useAppStore.getState()));
}
