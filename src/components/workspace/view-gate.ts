/**
 * Which workspace views are worth offering, given the session state.
 *
 * Before a real agent session exists — the composer is open but nothing has
 * been created yet — every pane except Browser reads session-scoped state
 * (diff, files, tasks, memories, process) or a session cwd (terminal, preview).
 * Offering them produces seven ways to open an empty pane, so the picker hides
 * them until there is a session to fill them.
 *
 * "Real" excludes the staff session for the same reason
 * right-panel-wrapper.tsx uses that distinction to choose between the
 * workspace and the Fleet hub — keep the two predicates in sync.
 */
import type { WorkspaceView } from "@/stores/app-store";

export function hasRealSession(
  activeSessionId: string | null,
  staffSessionId: string | null,
): boolean {
  return !!activeSessionId && activeSessionId !== staffSessionId;
}

export function isViewSelectable(
  view: WorkspaceView,
  activeSessionId: string | null,
  staffSessionId: string | null,
): boolean {
  return hasRealSession(activeSessionId, staffSessionId) || view === "browser";
}
