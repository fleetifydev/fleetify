/**
 * Renderer-side wrapper around the providers:* IPC commands.
 *
 * Mirrors lib/routers-api.ts. No-op fallbacks return deterministic shapes
 * so callers branching on `r.ok` continue to work without an Electron /
 * Tauri bridge present (Storybook, Vitest in jsdom mode, plain-browser
 * dev preview).
 */

import { apiFetch } from "@/lib/api";

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
  /** Optional grouping label inside a single provider tile.
   *  Perplexity uses "Sonar API" / "Agent API"; null/undefined ⇒ flat. */
  group?: string | null;
  /** Optional per-model endpoint override — informational on the
   *  client (backend dispatch resolves this). null/undefined ⇒
   *  fall back to ProviderSpec.default_base_url. */
  endpoint?: string | null;
  /** True when the model exposes a reasoning-effort lever. Drives
   *  whether the UnifiedModelPicker's Effort column is enabled. */
  supports_effort: boolean;
}

// ─── Capability descriptors (mirror providers/capabilities.rs serde) ────
export interface PermMode { id: string; label: string }
export type PermissionCapability =
  | { kind: "modes"; modes: PermMode[]; sandbox: string[] | null }
  | { kind: "approval_sandbox"; approvals: string[]; sandboxes: string[] }
  | { kind: "none" };
export interface ToolMatrixCapability {
  tools: string[];
  decisions: string[];
  supports_glob: boolean;
}
export type EffortCapability =
  | { kind: "levels"; levels: string[]; default: string }
  | { kind: "thinking_level"; levels: string[]; default: string }
  | { kind: "budget"; min: number; max: number; default: number; can_disable: boolean }
  | { kind: "toggle"; default: boolean }
  | { kind: "none" };
export interface ConfigTiming {
  permission: "spawn" | "live";
  effort: "spawn" | "live";
}
export interface ModelEffort { id: string; effort: EffortCapability }
export interface TileCapabilities {
  permission: PermissionCapability;
  tool_matrix: ToolMatrixCapability | null;
  timing: ConfigTiming;
  model_efforts: ModelEffort[];
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

export interface InstallHints {
  windows: string;
  macos: string;
  linux: string;
}

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
  /** Per-OS install command set. Backend resolves to one string for the
   *  user's current OS before sending; this field is reserved for
   *  future renderer features (e.g. "show me the macOS command too"). */
  install_hints?: InstallHints | null;
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
  /** True when this tile is the current Fleet default (top-level
   *  `defaultProvider` in fleet.config.json). At most one tile carries
   *  this flag at a time. */
  is_default: boolean;
  /** Native permission + effort capability (Phase 2). */
  capabilities: TileCapabilities;
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

/** Mirrors crates/fleetify-backend/src/routers/providers.rs HealthSnapshot
 *  serde tag layout. */
export type ProviderHealthSnapshot =
  | { kind: "no_key" }
  | { kind: "ok"; latency_ms: number; model_count: number | null }
  | { kind: "failed"; code: string; message: string | null };

export interface ProvidersHealthResult {
  ok: boolean;
  providers: Record<string, ProviderHealthSnapshot>;
}

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
      // AUTH ⇒ the daemon answered but rejected the request (401/403/407):
      // a secured / proxied rig that needs an API key, distinct from a
      // NETWORK fault where nothing answered.
      code: "NETWORK" | "TIMEOUT" | "PARSE" | "AUTH";
      error?: string;
    };

/** One running model row from Ollama's `/api/ps`. */
export interface OllamaPsEntry {
  name: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
  context_length?: number;
  details?: Record<string, unknown>;
}

/** Streamed `ollama-pull-progress` event payload. `error` rides the
 *  terminal error line; the terminal success arrives as a status update. */
export interface OllamaPullEvent {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
  error?: string;
}

export type ProvidersOllamaPsResult =
  | { ok: true; running: true; base_url: string; models: OllamaPsEntry[] }
  | { ok: false; running: boolean; base_url: string; code: string; error?: string };

export type ProvidersOllamaDeleteResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "NETWORK"; error?: string };

export type ProvidersMutationResult = { ok: boolean; error?: string };

export type CloudflareVerifyResult = {
  valid: boolean;
  error?: string | null;
};

/** One account/login for a provider or CLI agent. */
export interface AccountInfo {
  id: string;
  provider_id: string;
  /** Friendly name — the signed-in email when known, else dir/user label. */
  label: string;
  /** Secondary line: config-dir name, "System", or the user's custom label. */
  detail?: string | null;
  kind: "cli" | "http";
  is_default: boolean;
  /** CLI: indicators fire against the account's home; HTTP: a key is on file. */
  authenticated: boolean;
  /** The synthetic, undeletable "System" account (real HOME / legacy key). */
  system: boolean;
}

export type ProvidersOpenLoginResult =
  | { ok: true; pty_id: string }
  | { ok: false; code?: string; error?: string };

interface ProvidersAPI {
  listCatalog: () => Promise<ProvidersListResult>;
  fetchHealth: () => Promise<ProvidersHealthResult>;
  setKey: (id: string, key: string) => Promise<ProvidersSetKeyResult>;
  getKeyPreview: (id: string) => Promise<ProvidersKeyPreviewResult>;
  deleteKey: (id: string) => Promise<ProvidersDeleteResult>;
  setAccountKey: (id: string, accountId: string, key: string) => Promise<ProvidersSetKeyResult>;
  getAccountKeyPreview: (id: string, accountId: string) => Promise<ProvidersKeyPreviewResult>;
  deleteAccountKey: (id: string, accountId: string) => Promise<ProvidersMutationResult>;
  openAccountLogin: (id: string, accountId: string) => Promise<ProvidersOpenLoginResult>;
  /** Log in to the agent's real HOME (System/default account) — the in-chat
   *  login-recovery flow (e.g. `grok login`). Returns a PTY id to bind to. */
  startAgentLogin: (id: string) => Promise<ProvidersOpenLoginResult>;
  setEnabled: (id: string, enabled: boolean) => Promise<ProvidersMutationResult>;
  setDefault: (id: string, model?: string | null) => Promise<ProvidersMutationResult & { default_model?: string | null }>;
  setConnectedBulk: (
    connected: Record<string, boolean>,
    enabledAgents?: string[] | null,
  ) => Promise<ProvidersMutationResult>;
  testConnection: (id: string, key: string) => Promise<ProvidersTestResult>;
  ollamaProbe: (baseUrl?: string | null) => Promise<ProvidersOllamaProbeResult>;
  ollamaPs: (baseUrl?: string | null) => Promise<ProvidersOllamaPsResult>;
  ollamaPull: (model: string, baseUrl?: string | null) => Promise<{ ok: boolean; error?: string }>;
  ollamaPullCancel: (model: string) => Promise<{ ok: boolean }>;
  ollamaDelete: (model: string, baseUrl?: string | null) => Promise<ProvidersOllamaDeleteResult>;
  setOllamaCloudBaseUrl: (baseUrl: string) => Promise<ProvidersMutationResult>;
  onOllamaPullProgress: (cb: (e: OllamaPullEvent) => void) => () => void;
  setEnabledModels: (id: string, models: string[]) => Promise<ProvidersMutationResult>;
  setOllamaBaseUrl: (baseUrl: string) => Promise<ProvidersMutationResult>;
  setCloudflareAccountId: (accountId: string) => Promise<ProvidersMutationResult>;
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
      fetchHealth: async () => ({ ok: true, providers: {} }),
      setKey: async () => ({
        ok: false,
        code: "KEYCHAIN",
        error: "electron unavailable",
      }),
      getKeyPreview: async () => ({ ok: true, preview: null }),
      deleteKey: async () => ({ ok: false }),
      setAccountKey: async () => ({ ok: false, code: "KEYCHAIN", error: "electron unavailable" }),
      getAccountKeyPreview: async () => ({ ok: true, preview: null }),
      deleteAccountKey: async () => ({ ok: false, error: "electron unavailable" }),
      openAccountLogin: async () => ({ ok: false, error: "electron unavailable" }),
      startAgentLogin: async () => ({ ok: false, error: "electron unavailable" }),
      setEnabled: async () => ({ ok: false, error: "electron unavailable" }),
      setDefault: async (_id: string, _model?: string | null) => ({ ok: false, error: "electron unavailable" }),
      setConnectedBulk: async () => ({ ok: false, error: "electron unavailable" }),
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
      ollamaPs: async () => ({
        ok: false,
        running: false,
        base_url: "",
        code: "NETWORK",
        error: "electron unavailable",
      }),
      ollamaPull: async () => ({ ok: false, error: "electron unavailable" }),
      ollamaPullCancel: async () => ({ ok: false }),
      ollamaDelete: async () => ({ ok: false, code: "NETWORK", error: "electron unavailable" }),
      setOllamaCloudBaseUrl: async () => ({ ok: false, error: "electron unavailable" }),
      onOllamaPullProgress: () => () => {},
      setEnabledModels: async () => ({ ok: false, error: "electron unavailable" }),
      setOllamaBaseUrl: async () => ({ ok: false, error: "electron unavailable" }),
      setCloudflareAccountId: async () => ({ ok: false, error: "electron unavailable" }),
    }
  );
}

export const providers = {
  listCatalog: () => api().listCatalog(),
  /**
   * Reads the backend's prewarmed `HttpHealthCache` via the public
   * `/api/providers/health` endpoint. Not routed through the preload
   * IPC because the cache is non-secret and the backend already exposes
   * an HTTP route — going direct skips the IPC roundtrip and avoids a
   * dedicated Tauri command. Returns the empty-providers shape on any
   * transport failure so callers can detect "cache cold / unreachable"
   * via `Object.keys(result.providers).length === 0`.
   */
  fetchHealth: async (): Promise<ProvidersHealthResult> => {
    try {
      const res = await apiFetch("/api/providers/health");
      if (!res.ok) return { ok: false, providers: {} };
      const body = (await res.json()) as ProvidersHealthResult;
      return body;
    } catch {
      return { ok: false, providers: {} };
    }
  },
  setKey: (id: string, key: string) => api().setKey(id, key),
  getKeyPreview: (id: string) => api().getKeyPreview(id),
  deleteKey: (id: string) => api().deleteKey(id),

  // ── Multi-account ──────────────────────────────────────────────────────
  /** List a provider's accounts (System first, then saved). REST. */
  listAccounts: async (id: string): Promise<AccountInfo[]> => {
    try {
      const res = await apiFetch(`/api/providers/${encodeURIComponent(id)}/accounts`);
      if (!res.ok) return [];
      const body = (await res.json()) as { accounts?: AccountInfo[] };
      return body.accounts ?? [];
    } catch {
      return [];
    }
  },
  /** Create an account row (returns its id). REST. */
  createAccount: async (
    id: string,
    label: string,
    kind?: "cli" | "http",
  ): Promise<{ ok: boolean; account?: AccountInfo; error?: string }> => {
    try {
      const res = await apiFetch(`/api/providers/${encodeURIComponent(id)}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, kind }),
      });
      if (!res.ok) return { ok: false, error: await res.text() };
      const body = (await res.json()) as { account?: AccountInfo };
      return { ok: true, account: body.account };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  /** Delete an account row. `force` nulls any sessions still using it. REST. */
  deleteAccount: async (
    id: string,
    accountId: string,
    force = false,
  ): Promise<{ ok: boolean; error?: string; sessions?: number }> => {
    try {
      const qs = force ? "?force=1" : "";
      const res = await apiFetch(
        `/api/providers/${encodeURIComponent(id)}/accounts/${encodeURIComponent(accountId)}${qs}`,
        { method: "DELETE" },
      );
      if (res.status === 409) {
        const body = (await res.json()) as { sessions?: number };
        return { ok: false, error: "in_use", sessions: body.sessions };
      }
      if (!res.ok) return { ok: false, error: await res.text() };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  /** Make an account the provider's default. REST. */
  setDefaultAccount: async (id: string, accountId: string): Promise<ProvidersMutationResult> => {
    try {
      const res = await apiFetch(
        `/api/providers/${encodeURIComponent(id)}/accounts/${encodeURIComponent(accountId)}/default`,
        { method: "POST" },
      );
      return { ok: res.ok };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  /** Rename an account. REST. */
  renameAccount: async (id: string, accountId: string, label: string): Promise<ProvidersMutationResult> => {
    try {
      const res = await apiFetch(
        `/api/providers/${encodeURIComponent(id)}/accounts/${encodeURIComponent(accountId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        },
      );
      return { ok: res.ok };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  // HTTP key (keychain) + CLI login (PTY) go through the shell IPC.
  setAccountKey: (id: string, accountId: string, key: string) =>
    api().setAccountKey(id, accountId, key),
  getAccountKeyPreview: (id: string, accountId: string) =>
    api().getAccountKeyPreview(id, accountId),
  deleteAccountKey: (id: string, accountId: string) => api().deleteAccountKey(id, accountId),
  openAccountLogin: (id: string, accountId: string) => api().openAccountLogin(id, accountId),
  startAgentLogin: (id: string) => api().startAgentLogin(id),
  setEnabled: (id: string, enabled: boolean) => api().setEnabled(id, enabled),
  setDefault: (id: string, model?: string | null) => api().setDefault(id, model ?? null),
  setConnectedBulk: (connected: Record<string, boolean>, enabledAgents?: string[] | null) =>
    api().setConnectedBulk(connected, enabledAgents ?? null),
  testConnection: (id: string, key: string) => api().testConnection(id, key),
  ollamaProbe: (baseUrl?: string | null) => api().ollamaProbe(baseUrl ?? null),
  ollamaPs: (baseUrl?: string | null) => api().ollamaPs(baseUrl ?? null),
  ollamaPull: (model: string, baseUrl?: string | null) => api().ollamaPull(model, baseUrl ?? null),
  ollamaPullCancel: (model: string) => api().ollamaPullCancel(model),
  ollamaDelete: (model: string, baseUrl?: string | null) => api().ollamaDelete(model, baseUrl ?? null),
  setOllamaCloudBaseUrl: (baseUrl: string) => api().setOllamaCloudBaseUrl(baseUrl),
  onOllamaPullProgress: (cb: (e: OllamaPullEvent) => void) => api().onOllamaPullProgress(cb),
  setEnabledModels: (id: string, models: string[]) => api().setEnabledModels(id, models),
  setOllamaBaseUrl: (baseUrl: string) => api().setOllamaBaseUrl(baseUrl),
  setCloudflareAccountId: (accountId: string) => api().setCloudflareAccountId(accountId),
  /**
   * Verify a Cloudflare API token + account id for Workers AI access. Calls
   * the backend `/api/providers/cloudflare/verify` via `apiFetch`, consistent
   * with the other `/api/providers/*` calls (fetchHealth, apiScanProviders).
   * The account id can't be auto-discovered — a Workers-AI-scoped token can't
   * list accounts — so the user-supplied id rides in the JSON body alongside
   * the token. apiFetch attaches the Fleet session bearer when present
   * (harmless here) and keeps the call working if `/api` ever gains a blanket
   * auth layer.
   */
  cloudflareVerify: async (
    token: string,
    accountId: string,
  ): Promise<CloudflareVerifyResult> => {
    try {
      const res = await apiFetch("/api/providers/cloudflare/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, account_id: accountId }),
      });
      if (!res.ok) return { valid: false, error: `http ${res.status}` };
      return (await res.json()) as CloudflareVerifyResult;
    } catch (e) {
      return { valid: false, error: String(e) };
    }
  },
  onChanged: (cb: (payload: unknown) => void) => {
    const fn = api().onChanged;
    return fn ? fn(cb) : () => {};
  },
};
