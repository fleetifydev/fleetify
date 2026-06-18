// Zustand store for plugin foundation. Single source of truth for installs,
// sources, and the in-flight catalog query result.
import { create } from "zustand";
import * as api from "@/lib/plugin-api";
import { useMCPStore } from "@/stores/mcp-store";
import { computeUpdateInfo, isSafeUpdate, type UpdateInfo } from "@/lib/plugin-update";
import type {
  CatalogPlugin, MarketplaceSource, PluginInstall, ScopeType,
} from "@/types/plugin";

// Module-level in-flight guard for autoUpdateSweep. The sweep can be triggered
// from two places near-simultaneously (the once-per-launch sweep in App.tsx and
// the sweep on MarketplacePage mount). Two overlapping sweeps could call
// applyUpdate(id) for the SAME plugin concurrently, racing two backend
// `update_from_git` calls on the same install dir (a destructive remove_dir_all
// + swap). This is transient coordination, not rendered UI, so it lives in a
// module-scoped flag rather than store state.
let sweepInFlight = false;

interface State {
  installs: PluginInstall[];
  sources: MarketplaceSource[];
  catalog: CatalogPlugin[];
  loadingInstalls: boolean;
  loadingSources: boolean;
  loadingCatalog: boolean;
  error: string | null;

  refreshAll: () => Promise<void>;
  refreshInstalls: () => Promise<void>;
  refreshSources: () => Promise<void>;
  refreshCatalog: (params?: { q?: string; tag?: string; source?: string; featured?: boolean; refresh?: boolean }) => Promise<void>;

  install: (body: api.InstallRequest) => Promise<{ install_id: string; plugin_name: string; version: string }>;
  uninstall: (id: string) => Promise<void>;
  uninstallScope: (id: string, scope_type: ScopeType, scope_id: string | null) => Promise<void>;
  setAutoUpdate: (id: string, value: boolean) => Promise<void>;
  applyUpdate: (id: string) => Promise<void>;
  autoUpdateSweep: () => Promise<void>;
  setMasterEnabled: (id: string, enabled: boolean) => Promise<void>;
  setScope: (id: string, scope_type: ScopeType, scope_id: string | null, enabled: boolean) => Promise<void>;
  addSource: (repo_url: string, name?: string, description?: string) => Promise<void>;
  deleteSource: (id: string) => Promise<void>;
  setSourceEnabled: (id: string, enabled: boolean) => Promise<void>;
  refreshSource: (id: string) => Promise<void>;
}

export const usePluginStore = create<State>((set, get) => ({
  installs: [],
  sources: [],
  catalog: [],
  loadingInstalls: false,
  loadingSources: false,
  loadingCatalog: false,
  error: null,

  refreshAll: async () => {
    await Promise.all([get().refreshInstalls(), get().refreshSources()]);
  },

  refreshInstalls: async () => {
    set({ loadingInstalls: true, error: null });
    try {
      const installs = await api.fetchInstalls();
      set({ installs, loadingInstalls: false });
    } catch (e: any) {
      set({ error: String(e?.message || e), loadingInstalls: false });
    }
  },

  refreshSources: async () => {
    set({ loadingSources: true, error: null });
    try {
      const sources = await api.fetchSources();
      set({ sources, loadingSources: false });
    } catch (e: any) {
      set({ error: String(e?.message || e), loadingSources: false });
    }
  },

  refreshCatalog: async (params) => {
    set({ loadingCatalog: true, error: null });
    try {
      const catalog = await api.listCatalog(params || {});
      set({ catalog, loadingCatalog: false });
    } catch (e: any) {
      set({ error: String(e?.message || e), loadingCatalog: false });
    }
  },

  install: async (body) => {
    const result = await api.installPlugin(body);
    await get().refreshInstalls();
    // A freshly installed plugin may contribute MCP servers. Refresh the MCP
    // list and probe so they show real status immediately, without the user
    // having to open Settings → Tools & MCPs and click Test connection.
    const mcp = useMCPStore.getState();
    await mcp.fetchAll();
    void mcp.refresh();
    return result;
  },

  uninstall: async (id) => {
    await api.uninstallPlugin(id);
    await get().refreshInstalls();
  },

  uninstallScope: async (id, scope_type, scope_id) => {
    await api.uninstallScope(id, scope_type, scope_id);
    await get().refreshInstalls();
  },

  setAutoUpdate: async (id, value) => {
    await api.setAutoUpdate(id, value);
    await get().refreshInstalls();
  },

  applyUpdate: async (id) => {
    await api.applyUpdate(id);
    await get().refreshInstalls();
    // An update re-materializes the plugin's components, including any MCP
    // servers — same as a fresh install. Refresh + probe the MCP list so
    // changed servers show live status without a trip through Settings.
    const mcp = useMCPStore.getState();
    await mcp.fetchAll();
    void mcp.refresh();
  },

  autoUpdateSweep: async () => {
    if (sweepInFlight) return; // a sweep is already running — skip this one
    sweepInFlight = true;
    try {
      const { installs, catalog } = get();
      const byName = new Map(catalog.map(c => [c.manifest.name, c]));
      const safe = installs.filter(i => {
        if (!i.auto_update) return false;
        const c = byName.get(i.plugin_name);
        if (!c) return false;
        return isSafeUpdate(computeUpdateInfo(i, c));
      });
      for (const i of safe) {
        try { await api.applyUpdate(i.id); }
        catch (e) { console.warn(`auto-update failed for ${i.id}`, e); }
      }
      if (safe.length) {
        await get().refreshInstalls();
        // Mirror applyUpdate's MCP refresh once after the batch — any updated
        // plugin may have changed its MCP servers.
        const mcp = useMCPStore.getState();
        await mcp.fetchAll();
        void mcp.refresh();
      }
    } finally {
      sweepInFlight = false; // reset even on throw so a sweep can't wedge permanently
    }
  },

  setMasterEnabled: async (id, enabled) => {
    await api.setMasterEnabled(id, enabled);
    await get().refreshInstalls();
  },

  setScope: async (id, scope_type, scope_id, enabled) => {
    await api.setScope(id, scope_type, scope_id, enabled);
    await get().refreshInstalls();
  },

  addSource: async (repo_url, name, description) => {
    await api.addSource(repo_url, name, description);
    await get().refreshSources();
    await get().refreshCatalog();
  },

  deleteSource: async (id) => {
    await api.deleteSource(id);
    await get().refreshSources();
    await get().refreshCatalog();
  },

  setSourceEnabled: async (id, enabled) => {
    await api.setSourceEnabled(id, enabled);
    await get().refreshSources();
    await get().refreshCatalog();
  },

  refreshSource: async (id) => {
    await api.refreshSource(id);
    await get().refreshCatalog();
  },
}));

/** Build a per-install map of available updates by matching each install's
 *  `plugin_name` against a catalog entry's `manifest.name`. Only installs with
 *  an actual update available are included (keyed by install `id`). Pure — pass
 *  `installs` + `catalog` straight from the store so the UI can derive badges
 *  without coupling to fetch order. */
export function updatesFor(
  installs: PluginInstall[], catalog: CatalogPlugin[],
): Map<string, UpdateInfo> {
  const byName = new Map(catalog.map(c => [c.manifest.name, c]));
  const out = new Map<string, UpdateInfo>();
  for (const i of installs) {
    const c = byName.get(i.plugin_name);
    if (!c) continue;
    const info = computeUpdateInfo(i, c);
    if (info.updateAvailable) out.set(i.id, info);
  }
  return out;
}
