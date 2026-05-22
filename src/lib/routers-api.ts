/**
 * Renderer-side wrapper around the routers:* IPC commands.
 *
 * Mirrors lib/github-link-api.ts. No-op fallbacks return deterministic
 * shapes so callers branching on `r.ok` continue to work without an
 * Electron bridge present (e.g. running the renderer in a plain browser
 * for tests / Storybook).
 */

export interface RouterTile {
  id: string;
  display_name: string;
  capabilities: ("decision" | "proxy")[];
  connected: boolean;
  active_for_decision: boolean;
  active_for_proxy: boolean;
}

export type RoutersListResult =
  | { ok: true; tiles: RouterTile[]; enabled: boolean }
  | { ok: false; error: string; tiles: RouterTile[]; enabled: boolean };

export type RoutersConnectResult =
  | { ok: true }
  | { ok: false; code: "NO_USER" | "KEYCHAIN" | "CONFIG"; error: string };

export type RoutersTestResult =
  | { ok: true; always_available?: boolean; has_secret?: boolean }
  | { ok: false; code: "NO_USER" | "NO_SECRET" | "KEYCHAIN"; error?: string };

interface RoutersAPI {
  list: () => Promise<RoutersListResult>;
  connect: (
    id: string,
    secret: string,
    metadata: Record<string, unknown>,
  ) => Promise<RoutersConnectResult>;
  disconnect: (id: string) => Promise<{ ok: boolean }>;
  setActive: (
    category: "decision" | "proxy",
    id: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  setMasterToggle: (
    enabled: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
  testRouter: (id: string) => Promise<RoutersTestResult>;
}

function api(): RoutersAPI {
  const w = (typeof window !== "undefined" ? window : {}) as {
    electronAPI?: { routers?: RoutersAPI };
  };
  return (
    w.electronAPI?.routers ?? {
      list: async () => ({
        ok: false,
        error: "electron unavailable",
        tiles: [],
        enabled: false,
      }),
      connect: async () => ({
        ok: false,
        code: "KEYCHAIN",
        error: "electron unavailable",
      }),
      disconnect: async () => ({ ok: false }),
      setActive: async () => ({ ok: false, error: "electron unavailable" }),
      setMasterToggle: async () => ({
        ok: false,
        error: "electron unavailable",
      }),
      testRouter: async () => ({
        ok: false,
        code: "KEYCHAIN",
        error: "electron unavailable",
      }),
    }
  );
}

export const routers = {
  list: () => api().list(),
  connect: (
    id: string,
    secret: string,
    metadata: Record<string, unknown>,
  ) => api().connect(id, secret, metadata),
  disconnect: (id: string) => api().disconnect(id),
  setActive: (category: "decision" | "proxy", id: string) =>
    api().setActive(category, id),
  setMasterToggle: (enabled: boolean) => api().setMasterToggle(enabled),
  testRouter: (id: string) => api().testRouter(id),
};
