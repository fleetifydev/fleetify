// Frontend HTTP client wrapping /api/plugins/* and /api/marketplace/*.
import { apiFetch } from "./api";
import type {
  AddSourceResult, CatalogPlugin, MarketplaceSource, PluginDetail,
  PluginInstall, ScopeType, UpdatePreview,
} from "@/types/plugin";

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) {
    let body: unknown = null;
    try { body = await r.json(); } catch { /* ignore */ }
    const detail = (body as { detail?: { message?: string } | string } | null)?.detail;
    const msg = (typeof detail === "object" && detail?.message) || detail || r.statusText;
    throw new HttpError(typeof msg === "string" ? msg : JSON.stringify(msg), r.status, body);
  }
  // 204 No Content ⇒ caller is responsible for typing this as `Promise<void>`.
  // We return `undefined as T` here because TypeScript doesn't let us narrow
  // T to `void` post-hoc; the contract is upheld by the typed exports below
  // (every void-returning helper is annotated `: Promise<void>`).
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

// ── Marketplace sources ─────────────────────────────────────────────────

export const fetchSources = (): Promise<MarketplaceSource[]> =>
  http("/api/marketplace/sources");

export const addSource = (
  repo_url: string, name?: string, description?: string,
): Promise<AddSourceResult> =>
  http("/api/marketplace/sources", {
    method: "POST",
    body: JSON.stringify({ repo_url, name, description }),
  });

export const deleteSource = (id: string): Promise<void> =>
  http(`/api/marketplace/sources/${encodeURIComponent(id)}`, { method: "DELETE" });

export const setSourceEnabled = (id: string, enabled: boolean): Promise<void> =>
  http(`/api/marketplace/sources/${encodeURIComponent(id)}?enabled=${enabled}`, { method: "PATCH" });

export const refreshSource = (id: string): Promise<void> =>
  http(`/api/marketplace/sources/${encodeURIComponent(id)}/refresh`, { method: "POST" });

// ── Marketplace catalog ─────────────────────────────────────────────────

export const listCatalog = (params: {
  q?: string; tag?: string; source?: string; featured?: boolean;
  // `refresh=true` tells the backend to bypass its disk-cache TTL and
  // re-fetch every source from GitHub. Sent when the user opens the
  // Marketplace so freshly-published / updated plugins appear at once.
  refresh?: boolean;
} = {}): Promise<CatalogPlugin[]> => {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  });
  const qs = u.toString();
  return http(`/api/marketplace/plugins${qs ? "?" + qs : ""}`);
};

export const getPluginDetail = (
  source_id: string, plugin_path: string,
): Promise<PluginDetail> => {
  const path = plugin_path === "" ? "_root" : plugin_path;
  return http(`/api/marketplace/plugins/${encodeURIComponent(source_id)}/${path}`);
};

// ── Installed plugins ────────────────────────────────────────────────────

export const fetchInstalls = (): Promise<PluginInstall[]> => http("/api/plugins");

export interface InstallRequest {
  source_id: string;
  plugin_path: string;
  scope: { scope_type: ScopeType; scope_id: string | null };
  secrets?: Record<string, string>;
}

export const installPlugin = (
  body: InstallRequest,
): Promise<{ install_id: string; plugin_name: string; version: string }> =>
  http("/api/plugins/install", { method: "POST", body: JSON.stringify(body) });

/** Full uninstall (every scope is torn down, install dir + DB rows go away). */
export const uninstallPlugin = (id: string): Promise<void> =>
  http(`/api/plugins/${encodeURIComponent(id)}/uninstall`, { method: "POST" });

/** Partial uninstall — peel off one scope. Keeps the install on disk
 *  so the user can re-enable later without re-downloading. */
export const uninstallScope = (
  id: string, scope_type: ScopeType, scope_id: string | null,
): Promise<void> => {
  const params = new URLSearchParams({ scope_type });
  if (scope_id) params.set("scope_id", scope_id);
  return http(
    `/api/plugins/${encodeURIComponent(id)}/uninstall?${params.toString()}`,
    { method: "POST" },
  );
};

export const previewUpdate = (id: string): Promise<UpdatePreview> =>
  http(`/api/plugins/${encodeURIComponent(id)}/update/preview`);

export const applyUpdate = (id: string, confirmed?: boolean): Promise<any> =>
  http(`/api/plugins/${encodeURIComponent(id)}/update?confirmed=${!!confirmed}`, { method: "POST" });

export const setAutoUpdate = (id: string, auto_update: boolean): Promise<void> =>
  http(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ auto_update }),
  });

/** Master enable / disable. With ``enabled=false`` the backend tears
 *  down every scope's materialised state (skill dirs, hook entries,
 *  MCP rows, etc.) without dropping the install. ``enabled=true`` puts
 *  it all back using the same enablement rows. */
export const setMasterEnabled = (id: string, enabled: boolean): Promise<void> =>
  http(`/api/plugins/${encodeURIComponent(id)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });

export const setScope = (
  install_id: string,
  scope_type: ScopeType,
  scope_id: string | null,
  enabled: boolean,
): Promise<void> =>
  http(`/api/plugins/${encodeURIComponent(install_id)}/scope?enabled=${enabled}`, {
    method: "POST",
    body: JSON.stringify({ scope_type, scope_id }),
  });
