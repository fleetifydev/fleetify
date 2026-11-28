/**
 * The CLI agent scan (`GET /api/agents/scan`): which agents are installed and
 * signed in. One store for every surface that shows it — Settings → Agents,
 * the in-chat sign-in card — so they agree and share one request.
 *
 * Signing in or out happens outside Fleetify too (a terminal, another app),
 * so the scan refreshes when the window regains focus; the backend serves a
 * cached scan for up to 30 s and rescans after that, so focus refreshes are
 * cheap. A finished sign-in forces a rescan (`refresh(true)`).
 *
 * A refresh never blanks what's on screen: `status` stays "ready" while a new
 * scan loads (`refreshing`), and a failed refresh keeps the last good scan.
 */
import { create } from "zustand";
import { backendFetch } from "@/lib/api";
import type { AgentScanEntry } from "@/lib/providers-api";

export type AgentScan = Record<string, AgentScanEntry>;

interface AgentScanState {
  scan: AgentScan;
  /** "loading" only before the first scan lands; "error" only when no scan
   *  ever landed (a failed refresh keeps the last good one). */
  status: "idle" | "loading" | "ready" | "error";
  refreshing: boolean;
  /** Load the scan. `force` makes the backend rescan instead of serving
   *  its cache (Refresh, a finished install or sign-in). Concurrent calls
   *  share one request; a forced call waits for an in-flight plain one and
   *  then rescans. */
  refresh: (force?: boolean) => Promise<AgentScan>;
}

let inFlight: { force: boolean; promise: Promise<AgentScan> } | null = null;

async function fetchScan(force: boolean): Promise<AgentScan> {
  const r = await backendFetch(`/api/agents/scan${force ? "?refresh=1" : ""}`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`agent scan failed: HTTP ${r.status}`);
  return (await r.json()) as AgentScan;
}

export const useAgentScanStore = create<AgentScanState>((set, get) => ({
  scan: {},
  status: "idle",
  refreshing: false,

  refresh: async (force = false) => {
    if (inFlight && (inFlight.force || !force)) return inFlight.promise;
    const previous = inFlight?.promise;
    const run = (async () => {
      if (previous) await previous.catch(() => undefined);
      const hadScan = get().status === "ready";
      set(hadScan ? { refreshing: true } : { status: "loading", refreshing: true });
      try {
        const scan = await fetchScan(force);
        set({ scan, status: "ready", refreshing: false });
        return scan;
      } catch {
        set((s) => ({ status: s.status === "ready" ? "ready" : "error", refreshing: false }));
        return get().scan;
      }
    })();
    const entry = { force, promise: run };
    inFlight = entry;
    try {
      return await run;
    } finally {
      if (inFlight === entry) inFlight = null;
    }
  },
}));

/** Refresh the scan whenever the window regains focus (a sign-in finished in
 *  a terminal or the browser). Returns the unsubscribe. */
export function refreshAgentScanOnFocus(): () => void {
  if (typeof window === "undefined") return () => {};
  const onFocus = () => {
    if (useAgentScanStore.getState().status !== "idle") {
      void useAgentScanStore.getState().refresh(false);
    }
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}

/** Test seam: drop the cached scan and any in-flight request. */
export function resetAgentScanStoreForTests(): void {
  inFlight = null;
  useAgentScanStore.setState({ scan: {}, status: "idle", refreshing: false });
}
