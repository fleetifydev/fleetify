/**
 * Shared provider-config state for the renderer. Backed by a module-level
 * Zustand store so every consumer (Settings → Models tile grid,
 * Settings → Agents tile grid, chat composer's model picker, New Agent
 * dialog's provider dropdown) sees the *same* tiles and re-renders the
 * instant any of them mutates.
 *
 * Why a store instead of per-hook `useState`:
 *   - One source of truth across tabs. Settings → Models flipping a
 *     provider from "disconnected" to "connected" updates the chat
 *     picker on the next tick — no manual prop drilling, no event bus.
 *   - Mirrors the use-router-config.ts pattern already used elsewhere
 *     in the renderer; no new dependency.
 *
 * The first hook call (anywhere) triggers a single backend fetch via
 * `providers.listCatalog()`; subsequent calls just subscribe to the
 * existing store.
 */
import { useEffect } from "react";
import { create } from "zustand";
import {
  providers,
  type ProviderTile,
  type ProvidersTestResult,
} from "@/lib/providers-api";

export interface ProvidersConfigState {
  tiles: ProviderTile[];
  loading: boolean;
  refresh: () => Promise<void>;
  setKey: (id: string, key: string) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;
  setEnabledModels: (id: string, models: string[]) => Promise<void>;
  setOllamaBaseUrl: (baseUrl: string) => Promise<void>;
  /** Test does NOT mutate the store — caller renders the result inline
   *  in the Settings tile (status pill). */
  testConnection: (id: string, key: string) => Promise<ProvidersTestResult>;
}

interface InternalState extends ProvidersConfigState {
  /** Set to true the first time any consumer mounts so concurrent first
   *  renders don't issue duplicate `providers.listCatalog()` requests. */
  fetchStarted: boolean;
}

const useStore = create<InternalState>((set, get) => ({
  tiles: [],
  loading: true,
  fetchStarted: false,
  refresh: async () => {
    const r = await providers.listCatalog();
    // Defensive: a transient IPC failure (electron unavailable, backend
    // restarting during dev hot-reload, ...) returns ok=false + tiles: [].
    // Clobbering the store with [] in that case erases a previously-good
    // load and makes the picker render a blank rail until the next
    // refresh. Only replace tiles when the call actually succeeded.
    if (r.ok) {
      set({ tiles: r.tiles, loading: false });
    } else {
      set({ loading: false });
    }
  },
  setKey: async (id: string, key: string) => {
    await providers.setKey(id, key);
    await get().refresh();
  },
  deleteKey: async (id: string) => {
    await providers.deleteKey(id);
    await get().refresh();
  },
  setEnabledModels: async (id: string, models: string[]) => {
    await providers.setEnabledModels(id, models);
    await get().refresh();
  },
  setOllamaBaseUrl: async (baseUrl: string) => {
    await providers.setOllamaBaseUrl(baseUrl);
    await get().refresh();
  },
  testConnection: (id: string, key: string) => providers.testConnection(id, key),
}));

export function useProvidersConfig(): ProvidersConfigState {
  const tiles = useStore((s) => s.tiles);
  const loading = useStore((s) => s.loading);
  const refresh = useStore((s) => s.refresh);
  const setKey = useStore((s) => s.setKey);
  const deleteKey = useStore((s) => s.deleteKey);
  const setEnabledModels = useStore((s) => s.setEnabledModels);
  const setOllamaBaseUrl = useStore((s) => s.setOllamaBaseUrl);
  const testConnection = useStore((s) => s.testConnection);

  useEffect(() => {
    if (useStore.getState().fetchStarted) return;
    useStore.setState({ fetchStarted: true });
    void useStore.getState().refresh();

    // Cross-tab refresh: any successful providers_* mutation in main
    // emits "providers-config-changed" so the store picks up edits made
    // from a different React tree (e.g. New Agent dialog vs. Settings).
    const unsub = providers.onChanged(() => {
      void useStore.getState().refresh();
    });
    return () => unsub();
  }, []);

  return {
    tiles,
    loading,
    refresh,
    setKey,
    deleteKey,
    setEnabledModels,
    setOllamaBaseUrl,
    testConnection,
  };
}
