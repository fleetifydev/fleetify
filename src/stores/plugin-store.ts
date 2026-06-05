// Zustand store for plugin foundation. Single source of truth for installs,
// sources, and the in-flight catalog query result.
import { create } from "zustand";
import * as api from "@/lib/plugin-api";
import { useMCPStore } from "@/stores/mcp-store";
import type {
  CatalogPlugin, MarketplaceSource, PluginInstall, ScopeType,
} from "@/types/plugin";

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
