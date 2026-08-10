/**
 * Pure drag-and-drop planning for the left-sidebar session list.
 *
 * Rules (see the "Left Sidebar - Session Drag / Put" task):
 *  - a session may only be dragged among the sessions of its OWN workspace
 *    group — cross-workspace drops are rejected, dragging never re-homes a
 *    session to another workspace;
 *  - dropping an unpinned session onto a pinned same-workspace session pins
 *    it (the Pin section shows it under the same workspace header);
 *  - dropping a pinned session onto an unpinned same-workspace session
 *    unpins it and returns it to the workspace group.
 *
 * The component owns persistence; this module only computes what a drop
 * means so the rules stay unit-testable away from React and the store.
 */

export interface DndSession {
  id: string;
  /** Workspace group key (folder name for agents). */
  group: string;
  pinned: boolean;
}

export type DropPlan =
  /** Invalid pairing (self-drop or unknown ids) — ignore silently. */
  | { kind: "noop" }
  /** Cross-workspace drop — disallowed by design. */
  | { kind: "reject" }
  /** Same group, same pin state — plain reorder. `ids` is the new full order. */
  | { kind: "reorder"; ids: string[] }
  /** Unpinned dragged onto pinned — pin `id`, then apply `ids` order. */
  | { kind: "pin"; id: string; ids: string[] }
  /** Pinned dragged onto unpinned — unpin `id`, then apply `ids` order. */
  | { kind: "unpin"; id: string; ids: string[] };

export function planSessionDrop(
  sessions: readonly DndSession[],
  dragId: string,
  targetId: string,
): DropPlan {
  if (dragId === targetId) return { kind: "noop" };
  const source = sessions.find((s) => s.id === dragId);
  const target = sessions.find((s) => s.id === targetId);
  if (!source || !target) return { kind: "noop" };
  if (source.group !== target.group) return { kind: "reject" };

  const ids = sessions.map((s) => s.id);
  const next = [...ids];
  next.splice(ids.indexOf(dragId), 1);
  next.splice(next.indexOf(targetId), 0, dragId);

  if (source.pinned === target.pinned) return { kind: "reorder", ids: next };
  return source.pinned
    ? { kind: "unpin", id: dragId, ids: next }
    : { kind: "pin", id: dragId, ids: next };
}

/** Whether `targetId` is a legal drop target for `dragId` (for hover cues). */
export function canDropOn(
  sessions: readonly DndSession[],
  dragId: string,
  targetId: string,
): boolean {
  const kind = planSessionDrop(sessions, dragId, targetId).kind;
  return kind === "reorder" || kind === "pin" || kind === "unpin";
}
