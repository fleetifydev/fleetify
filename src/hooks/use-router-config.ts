/**
 * Shared router-config state for the renderer. Backed by a module-level
 * Zustand store so every consumer (Settings card grid, Fleet Hub routing
 * chip, status bar under the composer, new-agent dialog) sees the *same*
 * tiles + master-toggle and re-renders the instant any of them mutates.
 *
 * Why a store instead of per-hook `useState`:
 *   - The old implementation kept state inside each `useRouterConfig` call,
 *     so a Settings "Connect & activate" only refreshed the Settings copy
 *     of state — the chat-input chip kept showing stale values until the
 *     user navigated away and back. With the store, the chip refreshes on
 *     the same tick the Settings card does.
 *   - Mirrors the `app-store` / `mcp-store` pattern already used elsewhere
 *     in the renderer; no new dependency.
 *
 * The first hook call (anywhere) triggers a single backend fetch via
 * `routers.list()`; subsequent calls just subscribe to the existing store.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { routers, type RouterTile } from "@/lib/routers-api";

export interface RouterConfigState {
  tiles: RouterTile[];
  masterEnabled: boolean;
  loading: boolean;
  setMasterEnabled: (v: boolean) => Promise<void>;
  setActive: (category: "decision" | "proxy", id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

interface InternalState extends RouterConfigState {
  /** Set to true the first time any consumer mounts so concurrent first
   *  renders don't issue duplicate `routers.list()` requests. */
  fetchStarted: boolean;
}

const useStore = create<InternalState>((set, get) => ({
  tiles: [],
  masterEnabled: false,
  loading: true,
  fetchStarted: false,
  refresh: async () => {
    const r = await routers.list();
    set({ tiles: r.tiles, masterEnabled: r.enabled, loading: false });
  },
  setMasterEnabled: async (v: boolean) => {
    await routers.setMasterToggle(v);
    set({ masterEnabled: v });
  },
  setActive: async (category: "decision" | "proxy", id: string) => {
    await routers.setActive(category, id);
    await get().refresh();
  },
}));

export function useRouterConfig(): RouterConfigState {
  const tiles = useStore((s) => s.tiles);
  const masterEnabled = useStore((s) => s.masterEnabled);
  const loading = useStore((s) => s.loading);
  const setMasterEnabled = useStore((s) => s.setMasterEnabled);
  const setActive = useStore((s) => s.setActive);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    if (useStore.getState().fetchStarted) return;
    useStore.setState({ fetchStarted: true });
    void useStore.getState().refresh();
  }, []);

  return { tiles, masterEnabled, loading, setMasterEnabled, setActive, refresh };
}
