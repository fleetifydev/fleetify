import type { Session } from "@/types/session";

/** The user's most recently touched real agent session (by `last_accessed`),
 *  skipping the staff session, archived rows, and rows without a model. Used to
 *  default a new session's provider/model/effort to the last one used so the
 *  user isn't re-picking the model (and effort) on every new session.
 *
 *  Shared by both new-session surfaces: the draft composer (`openComposer`,
 *  the sidebar "New session" / ⌘N path) and the legacy `NewAgentView` dialog. */
export function lastUsedSession(
  sessions: Session[],
  staffSessionId: string | null | undefined,
): Session | undefined {
  let best: Session | undefined;
  let bestT = -1;
  for (const s of sessions) {
    if (s.id === staffSessionId || s.archived_at || !s.model_name) continue;
    const t = new Date(s.last_accessed ?? s.created_at).getTime();
    if (t > bestT) { bestT = t; best = s; }
  }
  return best;
}
