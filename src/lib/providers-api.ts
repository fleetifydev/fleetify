/**
 * Renderer-side wrapper around the providers:* IPC commands.
 *
 * Mirrors lib/routers-api.ts. No-op fallbacks return deterministic shapes
 * so callers branching on `r.ok` continue to work without an Electron /
 * Tauri bridge present (Storybook, Vitest in jsdom mode, plain-browser
 * dev preview).
 */

// ─── Static catalog (backend `ProviderSpec`) ────────────────────────────

export type ProviderKind = "api" | "local_http" | "cli";

export type AuthSpec =
  | { kind: "bearer"; env_hint?: string | null }
  | { kind: "api_key"; header: string; env_hint?: string | null }
  | { kind: "none" };

export interface ModelSpec {
  id: string;
  label: string;
  context_window?: string | null;
  note?: string | null;
}

export interface ProviderExtras {
  citations?: boolean;
  search_results?: boolean;
  dynamic_models?: boolean;
  supports_streaming?: boolean;
}

export type AuthIndicator =
  | { kind: "home_dir"; path: string }
  | { kind: "env_var"; name: string };

export interface ProviderSpec {
  id: string;
  display_name: string;
  kind: ProviderKind;
  default_base_url: string;
  auth: AuthSpec;
  default_models: ModelSpec[];
  extras: ProviderExtras;
  bin: string;
  auth_indicators: AuthIndicator[];
  install_hint: string;
  login_hint: string;
}

// ─── Per-tile state ─────────────────────────────────────────────────────

export interface ProviderTile {
  spec: ProviderSpec;
  /** User has marked this provider as "connected" in config — gates
   *  whether the chat composer's picker offers its models. */
  connected: boolean;
  /** Keychain has an entry for this provider under the signed-in user.
   *  Renderer treats this as a hint (e.g. show a masked preview link) —
   *  the source of truth for "should we dispatch?" is `connected`. */
  has_key: boolean;
  /** Subset of `spec.default_models[*].id` the user wants in the picker.
   *  Empty array ⇒ all defaults enabled (matches backend behaviour). */
  enabled_models: string[];
}

export type ProvidersListResult =
  | { ok: true; tiles: ProviderTile[] }
  | { ok: false; error: string; tiles: ProviderTile[] };

export type ProvidersSetKeyResult =
  | { ok: true }
  | { ok: false; code: "NO_USER" | "KEYCHAIN" | "CONFIG" | "UNKNOWN_PROVIDER"; error: string };

export type ProvidersDeleteResult = { ok: boolean };

export type ProvidersKeyPreviewResult =
  | { ok: true; preview: string | null }
  | { ok: false; code: "NO_USER" | "KEYCHAIN" | "UNKNOWN_PROVIDER"; error?: string };

export type ProvidersTestResult =
  | { ok: true; latency_ms: number; model_count: number | null }
  | {
      ok: false;
      code: "AUTH" | "NETWORK" | "TIMEOUT" | "NOT_FOUND" | "UNKNOWN_PROVIDER" | "USE_PROBE";
      error?: string;
      latency_ms?: number;
    };

export interface OllamaModelEntry {
  name: string;
  size?: number;
  modified_at?: string;
  digest?: string;
  details?: Record<string, unknown>;
}

export type ProvidersOllamaProbeResult =
  | { ok: true; running: true; base_url: string; models: OllamaModelEntry[] }
  | {
      ok: false;
      running: boolean;
      base_url: string;
      code: "NETWORK" | "TIMEOUT" | "PARSE";
      error?: string;
    };

export type ProvidersMutationResult = { ok: boolean; error?: string };

interface ProvidersAPI {
  listCatalog: () => Promise<ProvidersListResult>;
  setKey: (id: string, key: string) => Promise<ProvidersSetKeyResult>;
  getKeyPreview: (id: string) => Promise<ProvidersKeyPreviewResult>;
  deleteKey: (id: string) => Promise<ProvidersDeleteResult>;
  testConnection: (id: string, key: string) => Promise<ProvidersTestResult>;
  ollamaProbe: (baseUrl?: string | null) => Promise<ProvidersOllamaProbeResult>;
  setEnabledModels: (id: string, models: string[]) => Promise<ProvidersMutationResult>;
  setOllamaBaseUrl: (baseUrl: string) => Promise<ProvidersMutationResult>;
  onChanged?: (cb: (payload: unknown) => void) => () => void;
}

function api(): ProvidersAPI {
  const w = (typeof window !== "undefined" ? window : {}) as {
    electronAPI?: { providers?: ProvidersAPI };
  };
  return (
    w.electronAPI?.providers ?? {
      listCatalog: async () => ({
        ok: false,
        error: "electron unavailable",
        tiles: [],
      }),
      setKey: async () => ({
        ok: false,
        code: "KEYCHAIN",
        error: "electron unavailable",
      }),
      getKeyPreview: async () => ({ ok: true, preview: null }),
      deleteKey: async () => ({ ok: false }),
      testConnection: async () => ({
        ok: false,
        code: "NETWORK",
        error: "electron unavailable",
      }),
      ollamaProbe: async () => ({
        ok: false,
        running: false,
        base_url: "",
        code: "NETWORK",
        error: "electron unavailable",
      }),
      setEnabledModels: async () => ({ ok: false, error: "electron unavailable" }),
      setOllamaBaseUrl: async () => ({ ok: false, error: "electron unavailable" }),
    }
  );
}

export const providers = {
  listCatalog: () => api().listCatalog(),
  setKey: (id: string, key: string) => api().setKey(id, key),
  getKeyPreview: (id: string) => api().getKeyPreview(id),
  deleteKey: (id: string) => api().deleteKey(id),
  testConnection: (id: string, key: string) => api().testConnection(id, key),
  ollamaProbe: (baseUrl?: string | null) => api().ollamaProbe(baseUrl ?? null),
  setEnabledModels: (id: string, models: string[]) => api().setEnabledModels(id, models),
  setOllamaBaseUrl: (baseUrl: string) => api().setOllamaBaseUrl(baseUrl),
  onChanged: (cb: (payload: unknown) => void) => {
    const fn = api().onChanged;
    return fn ? fn(cb) : () => {};
  },
};
