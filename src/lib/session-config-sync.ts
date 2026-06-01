/**
 * Tracks in-flight session-config PATCHes (model / tool) so a WebSocket
 * message send can wait for the matching HTTP PATCH to commit first.
 *
 * Why this exists — a cross-channel race:
 *   • Picking a model persists over HTTP (`apiUpdateSession` PATCH).
 *   • Sending a message dispatches over WebSocket (`wsManager.send`), which
 *     carries no model — the backend reads the session's stored `model_name`.
 *
 * The WS send can reach the backend and load the session BEFORE the slower
 * HTTP PATCH commits, so the dispatch runs with the *previous* model (and the
 * 5 s session poll briefly reflects the stale row, reverting the picker chip).
 *
 * Registering each model/tool PATCH here and awaiting it before a send closes
 * the race: `apiUpdateSession` resolving means the row is written, so the next
 * send sees the model the user actually picked.
 */

const pending = new Map<string, Promise<unknown>>();

/**
 * Register an in-flight session-config PATCH. The promise is awaited by
 * {@link awaitConfigPatch} before the next send. Rejections are swallowed here
 * (the caller already handles PATCH errors); we only care that it *settled*.
 * The newest registration for a session supersedes any earlier one, and the
 * entry self-clears once settled so later sends don't wait needlessly.
 */
export function registerConfigPatch(sessionId: string, patch: Promise<unknown>): void {
  const tracked: Promise<unknown> = patch
    .catch(() => {})
    .finally(() => {
      // Only clear if we're still the latest pending patch for this session —
      // a newer registerConfigPatch may have replaced us mid-flight.
      if (pending.get(sessionId) === tracked) pending.delete(sessionId);
    });
  pending.set(sessionId, tracked);
}

/**
 * Resolve once any in-flight config PATCH for the session has settled. A no-op
 * (already resolved) when nothing is pending — `await undefined` resolves on
 * the current microtask.
 */
export async function awaitConfigPatch(sessionId: string): Promise<void> {
  await pending.get(sessionId);
}
