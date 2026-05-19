import { create } from "zustand";
import {
  listServers, addServer, updateServer, deleteServer,
  probeServer, probeAll,
  type MCPConfig, type MCPServerRow, type MCPProbe,
} from "@/lib/mcp-api";

interface MCPState {
  servers: MCPServerRow[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;

  fetchAll: () => Promise<void>;
  refresh: () => Promise<void>;
  add: (name: string, config: MCPConfig) => Promise<void>;
  update: (name: string, config: MCPConfig) => Promise<void>;
  remove: (name: string) => Promise<void>;
  probe: (name: string) => Promise<void>;
}

function sortByName(rows: MCPServerRow[]): MCPServerRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export const useMCPStore = create<MCPState>((set) => ({
  servers: [],
  loading: false,
  refreshing: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null });
    try {
      const rows = await listServers();
      set({ servers: sortByName(rows), loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  refresh: async () => {
    set({ refreshing: true });
    try {
      const probes = await probeAll();
      set(state => ({
        refreshing: false,
        servers: state.servers.map(s =>
          probes[s.name] ? { ...s, status: probes[s.name] as MCPProbe } : s,
        ),
      }));
    } catch (e) {
      set({ refreshing: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  add: async (name, config) => {
    const row = await addServer(name, config);
    set(state => ({ servers: sortByName([...state.servers, row]) }));
  },

  update: async (name, config) => {
    const row = await updateServer(name, config);
    set(state => ({
      servers: sortByName(state.servers.map(s => s.name === name ? row : s)),
    }));
  },

  remove: async (name) => {
    await deleteServer(name);
    set(state => ({ servers: state.servers.filter(s => s.name !== name) }));
  },

  probe: async (name) => {
    set(state => ({
      servers: state.servers.map(s => s.name === name
        ? { ...s, status: { ...s.status, status: "checking" } }
        : s),
    }));
    try {
      const probe = await probeServer(name);
      set(state => ({
        servers: state.servers.map(s => s.name === name ? { ...s, status: probe } : s),
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set(state => ({
        servers: state.servers.map(s => s.name === name
          ? { ...s, status: { ...s.status, status: "failed", error: msg } }
          : s),
        error: msg,
      }));
    }
  },
}));
