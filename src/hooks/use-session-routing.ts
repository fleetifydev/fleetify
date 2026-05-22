/**
 * Fetches the routing pin for a session so the chat header can render
 * a "Auto-routed → claude-sonnet-4-6" chip with the rationale visible
 * on hover. Hits `GET /api/sessions/:id/routing` (added in Task 28).
 *
 * Returns `null` while the request is in flight OR when the session
 * hasn't been pinned yet (fresh session before the first turn lands).
 * Callers conditionally render the chip on truthy state, so the empty
 * pre-turn surface stays clean. A 401/404/network error also resolves
 * to `null` — the chip is purely informational, never blocks a turn.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export interface SessionRoutingInfo {
  agent: string;
  model: string;
  /** `"pinned"` when the user manually picked the agent; otherwise the
   *  decision router id (`builtin` | `notdiamond` | `weave` | …). */
  source: string;
  rationale: string;
}

export function useSessionRouting(
  sessionId: string | null,
): SessionRoutingInfo | null {
  const [info, setInfo] = useState<SessionRoutingInfo | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/sessions/${sessionId}/routing`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean; routing?: SessionRoutingInfo | null } | null) => {
        if (cancelled) return;
        if (j && j.ok) setInfo(j.routing ?? null);
        else setInfo(null);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return info;
}
