/**
 * Renderer-side wrapper around the routers:* IPC commands.
 *
 * Mirrors lib/github-link-api.ts. No-op fallbacks return deterministic
 * shapes so callers branching on `r.ok` continue to work without an
 * Electron bridge present (e.g. running the renderer in a plain browser
 * for tests / Storybook).
 */

export type RouterMode = "managed" | "self_hosted";

export interface RouterTile {
  id: string;
  display_name: string;
  capabilities: ("decision" | "proxy")[];
  /** Credential modes the router accepts. Empty when no credentials are
   *  needed (`builtin`, `none-proxy`). `managed` = router has a default
   *  hosted endpoint and the user just supplies an API key. `self_hosted`
   *  = the user must also supply the base URL of their own deployment. */
  modes: RouterMode[];
  connected: boolean;
  active_for_decision: boolean;
  active_for_proxy: boolean;
  /** Non-secret metadata saved at connect time. Currently carries the
   *  user-supplied `base_url` for self-hosted routers so the Edit form
   *  can be pre-populated without a separate IPC round-trip. */
  metadata?: Record<string, unknown> | null;
}

export type RoutersKeyPreviewResult =
  | { ok: true; preview: string | null }
  | { ok: false; code: "NO_USER" | "KEYCHAIN"; error?: string };

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
  getKeyPreview: (id: string) => Promise<RoutersKeyPreviewResult>;
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
      getKeyPreview: async () => ({ ok: true, preview: null }),
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
  getKeyPreview: (id: string) => api().getKeyPreview(id),
};
