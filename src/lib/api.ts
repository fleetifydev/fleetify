import type { EffortCapability } from "@/lib/providers-api";

const API_BASE = "/api";

// ── window.fleetify (provided by Electron preload) ────────────
declare global {
  interface Window {
    fleetify?: {
      signIn:         () => Promise<{ ok: boolean; user?: any; expiresAt?: number; error?: string; kind?: string }>;
      signOut:        () => Promise<{ ok: boolean }>;
      userinfo:       () => Promise<any>;
      getAccessToken: (opts?: { force?: boolean }) => Promise<{ token: string; expiresAt: number } | null>;
      getState:       () => Promise<{ signedIn: boolean; user?: any; noAuth?: boolean }>;
      /** This run's backend API token (the shell's `backend_api_token` command). */
      getApiToken:    () => Promise<string>;
      // Renderer → main bridge for the sidebar's "Give Feedback" modal.
      // The token is attached in main so the renderer never has to
      // touch it; the response is the {ok, data?, error?} envelope the
      // ipcMain handler wraps around the dashboard's reply.
      sendFeedback:   (body: {
        comment: string;
        email?: string | null;
        attachments?: Array<{ name: string; mime: string; data_url: string }>;
      }) => Promise<
        | { ok: true; data?: unknown }
        // Failure shape mirrors the dashboard Worker's envelope, flattened
        // by main:
        //   error     — user-facing message (rendered in the red banner)
        //   code      — stable server-side code (VALIDATION, UNAUTHORIZED, …)
        //   status    — HTTP status; -1 for pre-flight failures (no token, no bridge)
        //   requestId — for support / log correlation
        | { ok: false; error: string; code?: string; status?: number; requestId?: string }
      >;
      onAuthEvent:    (cb: (event: { kind: string; [k: string]: any }) => void) => () => void;
      /** List code editors installed on PATH (VS Code / Cursor / Visual Studio / …). */
      detectEditors(): Promise<{ editors: { id: string; label: string }[] }>;
      /** Launch a project directory in the chosen editor (id from detectEditors). */
      openInEditor(editorId: string, path: string): Promise<{ ok: boolean; error?: string }>;
    };
  }
}

// ── Auth helpers ──────────────────────────────────────────────
/** Keys that survive clearToken — they belong to the *machine*, not the
 *  current sign-in. Wiping them on sign-out forces the next user to redo
 *  onboarding even though they already completed it once on this device. */
const PERSISTENT_KEYS = new Set<string>([
  "fleet:setup-done", // chat-style onboarding completion (one-time per device)
]);

export function clearToken(): void {
  // Wipes fleet:* localStorage EXCEPT keys in PERSISTENT_KEYS. Does NOT
  // call signOut — callers that want a full sign-out should `await
  // window.fleetify.signOut()` first.
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("fleet:") && !PERSISTENT_KEYS.has(k)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch { /* fall through */ }
  localStorage.removeItem("fleet:onboarded");
  localStorage.removeItem("fleet:user");
}

async function authHeaders(): Promise<Record<string, string>> {
  const t = await window.fleetify?.getAccessToken();
  return t?.token ? { Authorization: `Bearer ${t.token}` } : {};
}

/** Bearer-attached fetch wrapper. Pulls a fresh access_token via
 *  window.fleetify.getAccessToken(); on a 401 it forces a refresh and
 *  retries once. A second 401 ends the session: we sign out via the
 *  main process and dispatch fleet:logout so App.tsx can route back to
 *  the sign-in screen. Exported so other modules (plugin-api, mcp-api,
 *  WorkflowsPage, etc.) share the same retry + sign-out semantics. */
export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const baseHeaders = (init?.headers ?? {}) as Record<string, string>;
  let res = await fetch(input, { ...init, headers: { ...baseHeaders, ...(await authHeaders()) } });
  if (res.status === 401) {
    await window.fleetify?.getAccessToken({ force: true });
    res = await fetch(input, { ...init, headers: { ...baseHeaders, ...(await authHeaders()) } });
    if (res.status === 401) {
      await window.fleetify?.signOut();
      window.dispatchEvent(new Event("fleet:logout"));
      throw new Error("Session expired");
    }
  }
  return res;
}

// ── SSH (Remote tab) ────────────────────────────────────────────
export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  identity_file?: string | null;
}

export async function sshTest(t: SshTarget): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`${API_BASE}/ssh/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(t),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as { detail?: string }));
    throw new Error(data.detail ?? `ssh test failed (${res.status})`);
  }
  return res.json();
}

export interface SshDirEntry { name: string; type: "file" | "folder"; size: number | null }
export async function sshListDir(t: SshTarget & { path?: string }): Promise<{ path: string; entries: SshDirEntry[] }> {
  const res = await apiFetch(`${API_BASE}/ssh/list-dir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(t),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as { detail?: string }));
    throw new Error(data.detail ?? `ssh list-dir failed (${res.status})`);
  }
  return res.json();
}

// ── Model catalog ──────────────────────────────────────────────
export interface CatalogModel { id: string; label: string; ctx?: string; note?: string }
export interface CatalogProvider { id: string; label: string; models: CatalogModel[] }

/** A model entry from the backend's discovery endpoints
 *  (`/agents/{id}/models`, `/providers/{id}/models`). `id`/`label` are always
 *  present; the richer fields are filled in when the backend resolved the
 *  lineup from the remote catalog (live ACP/CLI probes and the OpenRouter/
 *  Cloudflare proxies only know id+label+ctx, so the rest stay undefined and
 *  the renderer defaults them). */
export interface DiscoveredModel {
  id: string;
  label: string;
  ctx?: string;
  supports_effort?: boolean;
  effort?: EffortCapability;
  group?: string;
  note?: string;
  endpoint?: string;
  /** Backend marks exactly one model per agent/provider lineup as the catalog
   *  default (Task B1). Drives default-model resolution in the renderer. */
  default?: boolean;
  /** Catalog availability. `false` ⇒ retired: hidden from the picker and
   *  rejected at send. Absent/`true` ⇒ selectable. */
  active?: boolean;
  /** Picker sort weight from the catalog. Higher floats the model toward the
   *  top of its provider's list; ties keep catalog order. Absent ⇒ 0. */
  priority?: number;
}
export async function listModels(): Promise<{ providers: CatalogProvider[] }> {
  const res = await apiFetch(`${API_BASE}/models`);
  if (!res.ok) {
    // Non-fatal — caller falls back to its hardcoded list so the
    // picker still works while the API is unreachable.
    return { providers: [] };
  }
  return res.json();
}

/** Result of a catalog staleness probe. `changed` is the only bit callers act
 *  on: the served catalog identity moved, the backend cleared its cache, and
 *  any lineup the renderer is holding is stale. */
export type CatalogRevalidation = {
  changed: boolean;
  /** False when the backend's debounce collapsed the call. */
  probed: boolean;
  commit: string | null;
  tag: string | null;
};

const CATALOG_UNCHANGED: CatalogRevalidation = {
  changed: false,
  probed: false,
  commit: null,
  tag: null,
};

/** Ask the backend whether the published model catalog moved.
 *
 *  This is the cheap half of the remote-config split: the catalog PAYLOAD is
 *  immutable and long-cached, while a small POINTER says which payload is
 *  current. Probing the pointer costs a few hundred bytes, so it can run on
 *  natural triggers (window focus, picker open) instead of waiting out the
 *  backend's TTL — which is what actually decides how long a retired model
 *  keeps showing up in the picker.
 *
 *  Never throws: a failed probe reports "unchanged", so an unreachable catalog
 *  leaves the lineup the user already has exactly as it is. */
export async function revalidateCatalog(): Promise<CatalogRevalidation> {
  try {
    const res = await apiFetch(`${API_BASE}/providers/catalog/revalidate`, { method: "POST" });
    if (!res.ok) return CATALOG_UNCHANGED;
    const d = (await res.json()) as Partial<CatalogRevalidation>;
    return {
      changed: d.changed === true,
      probed: d.probed === true,
      commit: typeof d.commit === "string" ? d.commit : null,
      tag: typeof d.tag === "string" ? d.tag : null,
    };
  } catch {
    return CATALOG_UNCHANGED;
  }
}

/** Discovered model catalog for a live-model CLI agent (`opencode` / `cursor` /
 *  `github-copilot` / `hermes`), sourced at runtime by the backend (OpenCode via
 *  `opencode models`, Cursor via a short ACP `session/new` probe, Hermes via its
 *  inventory). Returns the full real list with ids that match what the bridge
 *  applies, plus `current` — the agent's configured/active model id (Hermes
 *  only; `null` otherwise), used to resolve & self-heal the `"default"`
 *  placeholder. An empty `models` array is the documented "discovery
 *  unavailable" signal (agent not installed / not logged in) — the caller then
 *  keeps its static CLI_MODELS fallback, so this is intentionally non-fatal and
 *  never throws. */
export async function fetchAgentModels(
  agentId: string,
  cwd?: string,
): Promise<{ models: DiscoveredModel[]; current: string | null }> {
  const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  try {
    const res = await apiFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/models${qs}`);
    if (!res.ok) return { models: [], current: null };
    const data = (await res.json()) as {
      models?: DiscoveredModel[];
      current?: string | null;
    };
    return {
      models: Array.isArray(data.models) ? data.models : [],
      current: typeof data.current === "string" ? data.current : null,
    };
  } catch {
    // Backend unreachable / transient — fall back to the static list.
    return { models: [], current: null };
  }
}

/** Discovered model catalog for an HTTP provider that exposes a live
 *  `/models` endpoint (currently `openrouter`, whose hundreds of models can't
 *  be curated statically). The backend fetches the provider's public catalog
 *  and normalizes it to `{id, label, ctx?}`. An empty array is the documented
 *  "discovery unavailable" signal (offline / upstream error) — the caller then
 *  keeps the provider's curated fallback, so this is non-fatal and never
 *  throws. */
export async function fetchProviderModels(
  providerId: string,
): Promise<DiscoveredModel[]> {
  try {
    const res = await apiFetch(
      `${API_BASE}/providers/${encodeURIComponent(providerId)}/models`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: DiscoveredModel[] };
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
  }
}

/** Hosts auto-discovered from the user's ~/.ssh/config. The label is
 *  the Host alias (so the UI can show "my-prod" instead of an IP). */
export interface SshKnownHost {
  label: string;
  host: string;
  user: string;
  port: number;
  identity_file: string | null;
}
export async function sshKnownHosts(): Promise<{ hosts: SshKnownHost[] }> {
  const res = await apiFetch(`${API_BASE}/ssh/known-hosts`);
  if (!res.ok) {
    // Non-fatal — return empty so the panel still lets the user add manually.
    return { hosts: [] };
  }
  return res.json();
}

/** Read a backend error body.
 *
 *  `ApiError::BadRequest` renders a **plain-text** body, not a
 *  `{detail}` envelope, so `res.json()` throws and the reason gets swallowed
 *  into a generic "(400)". Try JSON first (some handlers do return an
 *  envelope), then fall back to the raw text. */
async function errorDetail(res: Response, fallback: string): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { detail?: string };
      if (parsed?.detail) return parsed.detail;
    } catch {
      // Not JSON — the plain-text body IS the message.
    }
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

// ── Docker (Container tab) ──────────────────────────────────────
export interface DockerStatus { installed: boolean; running: boolean; error: string | null }
export async function dockerStatus(): Promise<DockerStatus> {
  const res = await apiFetch(`${API_BASE}/docker/status`);
  if (!res.ok) return { installed: false, running: false, error: `status ${res.status}` };
  return res.json();
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
}
export async function dockerContainers(): Promise<{ containers: DockerContainer[] }> {
  const res = await apiFetch(`${API_BASE}/docker/containers`);
  if (!res.ok) {
    throw new Error(await errorDetail(res, `docker ps failed (${res.status})`));
  }
  return res.json();
}

export async function dockerListDir(containerId: string, path: string): Promise<{ path: string; entries: SshDirEntry[] }> {
  const res = await apiFetch(`${API_BASE}/docker/list-dir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ container_id: containerId, path }),
  });
  if (!res.ok) {
    throw new Error(await errorDetail(res, `docker list-dir failed (${res.status})`));
  }
  return res.json();
}

export interface DockerImage { name: string; size: string; id: string }
/** Local images for the run-from-image picker. Non-fatal on any failure —
 *  the field still accepts a typed registry image, the list is a shortcut. */
export async function dockerImages(): Promise<{ images: DockerImage[] }> {
  try {
    const res = await apiFetch(`${API_BASE}/docker/images`);
    if (!res.ok) return { images: [] };
    return await res.json();
  } catch {
    return { images: [] };
  }
}

/** Generate a starter docker-compose.yml: the picked image as a service
 *  beside a `dev` service the agent runs in. Refuses to overwrite an
 *  existing compose file. */
export async function dockerComposeScaffold(
  dir: string,
  image: string,
): Promise<{ file: string; agent_service: string; service: string }> {
  const res = await apiFetch(`${API_BASE}/docker/compose-scaffold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir, image }),
  });
  if (!res.ok) {
    throw new Error(await errorDetail(res, `compose scaffold failed (${res.status})`));
  }
  return res.json();
}

export interface DockerAgentProbe { present: boolean; path: string }

/** Is the agent CLI installed inside this container? Drives the picker's
 *  preflight hint. Advisory only — the backend re-probes at spawn, because
 *  this answer goes stale as soon as the container is stopped or replaced. */
export async function dockerProbeAgent(containerId: string, agent = "claude"): Promise<DockerAgentProbe> {
  const res = await apiFetch(`${API_BASE}/docker/probe-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ container_id: containerId, agent }),
  });
  if (!res.ok) {
    throw new Error(await errorDetail(res, `docker probe-agent failed (${res.status})`));
  }
  return res.json();
}

// ── Auth API ─────────────────────────────────────────────────
export interface AuthUser { id: string; name: string; email: string }

export async function apiMe(): Promise<AuthUser | null> {
  if (!window.fleetify) return null;
  try {
    const u = await window.fleetify.userinfo();
    return { id: u.sub ?? u.id ?? "", name: u.name ?? "", email: u.email ?? "" };
  } catch {
    return null;
  }
}

// ── Providers ────────────────────────────────────────────────
export interface ProviderScan {
  claude_code:     { installed: boolean; authenticated: boolean; path: string | null };
  codex_cli:       { installed: boolean; authenticated: boolean; path: string | null };
  kimi_code:       { installed: boolean; authenticated: boolean; path: string | null };
  antigravity_cli: { installed: boolean; authenticated: boolean; path: string | null };
  /** Python interpreter + `google-antigravity` package + GEMINI_API_KEY
   *  state. Driving the SDK from Fleetify needs all three; this surface
   *  rolls them into the same `installed`/`authenticated` pair the other
   *  CLI agents report so the Settings → Agents card renders identically. */
  antigravity_sdk: { installed: boolean; authenticated: boolean; path: string | null };
  // CLI agents installed via npm (`opencode-ai`, `@github/copilot`) or a shell
  // script (Cursor, Hermes). Detected so onboarding shows Installed / Not
  // installed + an Install button instead of "Set up in Settings". Cursor /
  // Copilot / Hermes resolve off-PATH via their backend bridge helpers.
  opencode:        { installed: boolean; authenticated: boolean; path: string | null };
  cursor_cli:      { installed: boolean; authenticated: boolean; path: string | null };
  grok_build:      { installed: boolean; authenticated: boolean; path: string | null };
  github_copilot:  { installed: boolean; authenticated: boolean; path: string | null };
  hermes_agent:    { installed: boolean; authenticated: boolean; path: string | null };
  // `running` = live daemon probe; `installed` = durable presence (daemon
  // reachable OR the `ollama` binary on disk) the onboarding picker buckets on,
  // so an installed-but-stopped daemon isn't mislabelled "Installable".
  ollama: { running: boolean; installed: boolean; models: string[] };
  env_keys: { anthropic: boolean; openai: boolean; gemini: boolean; groq: boolean };
}

export async function apiScanProviders(): Promise<ProviderScan> {
  const res = await apiFetch(`${API_BASE}/providers/scan`);
  if (!res.ok) throw new Error("Scan failed");
  return res.json();
}

export async function checkPythonRuntime(): Promise<PythonRuntimeResult> {
  if (!window.electronAPI?.checkPythonRuntime) {
    return { installed: false, version: null, path: null };
  }
  return window.electronAPI.checkPythonRuntime();
}

export async function fetchSessions() {
  const res = await apiFetch(`${API_BASE}/sessions`);
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export async function createSession(data: {
  title: string;
  project_path?: string;
  tool?: string;
  notes?: string;
  model_name?: string;
  permission_mode?: string;
  session_mode?: string;
  claude_session_id?: string;
  /** Built-in template id (e.g. "reverse_engineering"). When set, the
   *  backend resolves the template's specialised system prompt and MCP
   *  tools for this session. Unknown ids are ignored server-side. */
  agent_template?: string;
  /** Whether the backend should carve a fleet/<slug>-<id> worktree
   *  for this session. Default true (Conductor parity). The toolbar's
   *  Worktree chip toggles this; setting false makes the agent run
   *  directly inside project_path. */
  use_worktree?: boolean;
  /** Which provider/agent account this session uses. Omitted ⇒ the System
   *  account (real HOME for CLI / default labeled key for HTTP). */
  account_id?: string;
  /** Reasoning effort the session starts at (low … max … ultra_code).
   *  Defaulted from the user's last-used session so they don't re-pick. */
  effort?: string;
  /** Git-mode branch pick: with `use_worktree` on, the carved worktree
   *  checks out THIS branch instead of an auto fleet/… one. */
  base_branch?: string;
  /** Where the agent runs. Orthogonal to the source above: `docker-run`
   *  composes with a Git worktree (the container bind-mounts the host
   *  checkout), `docker-attach` does not (the files live inside a
   *  container we did not create). Omitted ⇒ `host`. */
  exec_mode?: "host" | "docker-attach" | "docker-run";
  /** Attach target. Required for `docker-attach`; for `docker-run` the
   *  backend fills it in when it provisions. */
  container_id?: string;
  container_workdir?: string;
  /** Image to provision from, for `docker-run`. */
  container_image?: string;
  /** Opt in to mounting this provider's own credential directory into the
   *  container. Off by default — it carries a host login across the
   *  boundary, so it is always the user's explicit choice. */
  container_mount_credentials?: boolean;
  /** Recipe for `docker-run`: `image` (default), `dockerfile` (build
   *  `container_file` with the project as context) or `compose`
   *  (`docker compose up` on `container_file`, agent in
   *  `container_service`). */
  container_source?: "image" | "dockerfile" | "compose";
  container_file?: string;
  container_service?: string;
}) {
  const res = await apiFetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    // Bubble up the backend's real message (e.g. "Project path does not exist
    // or is not a directory") so the UI can show *why* instead of a generic
    // failure that ends up swallowed as "nothing happened".
    const detail = await res.text().catch(() => "");
    throw new Error(detail?.trim() || `Failed to create session (${res.status})`);
  }
  return res.json();
}

/** Create a session from an edited SpawnSpec (the inline Spawn Form card's
 *  "Create"). POSTs the canonical spec to /api/sessions/spawn. */
export async function spawnSession(spec: import("@/types/chat").SpawnSpecDraft) {
  const res = await apiFetch(`${API_BASE}/sessions/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail?.trim() || `Failed to spawn agent (${res.status})`);
  }
  return res.json();
}

export async function deleteSession(id: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete session");
  return res.json();
}

/** Purge zombie draft session rows ("New chat" or blank title, no
 *  project_path, zero messages) for the current user. Idempotent. */
export async function deleteEmptyDrafts(): Promise<{ deleted: number; ids: string[] }> {
  const res = await apiFetch(`${API_BASE}/sessions/empty-drafts`, { method: "DELETE" });
  if (!res.ok) return { deleted: 0, ids: [] };
  return res.json();
}

export async function archiveSession(id: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/archive`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to archive session");
  return res.json();
}

export async function clearSessionMessages(id: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/messages`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to clear messages");
  return res.json();
}

export async function updateSession(
  id: string,
  // Open-ended PATCH body — the backend already accepts every
  // session field that's safe to mutate (project_path,
  // permission_mode, tool, etc.); the type was over-narrow and
  // forced casts at every call site. We keep the well-known
  // fields enumerated for autocomplete and accept additional
  // string/number/null entries for the rest.
  data: {
    title?: string;
    group_path?: string;
    notes?: string;
    model_name?: string;
    project_path?: string;
    permission_mode?: string;
    tool?: string;
    effort?: string;
    account_id?: string | null;
    sandbox?: string | null;
    tool_overrides?: string | null;
  },
) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update session");
  return res.json();
}

/** Advance a worktree session to its next round (server carves the new
 *  worktree, repoints the session, tears down the old one). Returns the
 *  updated session + the branch that was removed (for remote cleanup). */
export async function sessionNextRoundWorktree(id: string, base?: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/worktree/next-round`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(base ? { base } : {}),
  });
  if (!res.ok) throw new Error("Failed to start next round");
  return res.json() as Promise<{ ok: boolean; session?: import("@/types/session").Session; removedBranch?: string }>;
}

/** Fetch the session's per-session rules text (empty string when none). The
 *  rules are materialized into the session's working-dir rule file so the CLI
 *  reads them automatically — this just returns the stored source text. */
export async function getSessionRules(sessionId: string): Promise<string> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/rules`);
  if (!res.ok) throw new Error("Failed to load session rules");
  const data = (await res.json()) as { rules?: string };
  return data.rules ?? "";
}

/** Set (or clear, with an empty string) the session's rules. The backend
 *  persists the text and re-materializes the marked block into the session's
 *  working-dir rule file for its provider. */
export async function setSessionRules(sessionId: string, rules: string): Promise<string> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules }),
  });
  if (!res.ok) throw new Error("Failed to save session rules");
  const data = (await res.json()) as { rules?: string };
  return data.rules ?? "";
}

/** Fetch the Fleet rule file (`~/.fleetify/FLEET.md`) — general, app-level
 *  rules for Fleet itself. Empty string when the file doesn't exist yet. */
export async function getFleetRules(): Promise<string> {
  const res = await apiFetch(`${API_BASE}/fleet/rules`);
  if (!res.ok) throw new Error("Failed to load Fleet rules");
  const data = (await res.json()) as { content?: string };
  return data.content ?? "";
}

/** Persist the Fleet rule file (`~/.fleetify/FLEET.md`). */
export async function setFleetRules(content: string): Promise<string> {
  const res = await apiFetch(`${API_BASE}/fleet/rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to save Fleet rules");
  const data = (await res.json()) as { content?: string };
  return data.content ?? "";
}

export async function forkSession(sessionId: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/fork`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to fork session");
  return res.json();
}

/** Cursor-paginated message fetch.
 *
 *   • Default: latest 50 messages (no `before`).
 *   • Older pages: pass `before=<oldest-timestamp-currently-in-store>`
 *     to get the previous 50. Returned in chronological order so the
 *     caller can prepend directly.
 *
 *  The previous unpaginated endpoint loaded *every* historical message
 *  on session open — for long-running agents that's hundreds of
 *  messages going through markdown parsing on every store update.
 *  Lazy loading slashes the initial render cost. */
export async function fetchMessages(
  sessionId: string,
  opts?: { limit?: number; before?: string },
) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", opts.before);
  const qs = params.toString();
  const url = `${API_BASE}/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

export async function startSession(id: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/start`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to start session");
  return res.json();
}

export async function stopSession(id: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/stop`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to stop session");
  return res.json();
}

export async function restartSession(id: string) {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/restart`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to restart session");
  return res.json();
}

/** Harder unstick than restart — clears the Claude resume id so the
 *  next send starts a brand-new Claude conversation. Use when the
 *  bridge is logging "No conversation found with session ID …".
 *  Local DB history is untouched; only the Claude-side cursor is
 *  dropped. */
export async function resetSession(id: string): Promise<{ ok: boolean; status: string; claude_session_id: string | null }> {
  const res = await apiFetch(`${API_BASE}/sessions/${id}/reset`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to reset session");
  return res.json();
}

/** Auto-mode planner — given a user prompt and the current fleet snapshot,
 *  returns a structured dispatch plan { dispatches: [{target_id, task}],
 *  summary }. The frontend converts each dispatch into a [[DIRECT_DISPATCH:]]
 *  token and sends them all through the staff WS so they hit the same
 *  deterministic dispatch path as @mention. Backed by Haiku — fast/cheap. */
export interface AutoPlanFleetAgent {
  id: string;
  name: string;
  project?: string | null;
  status?: string | null;
  description?: string | null;
}
export interface AutoPlanDispatch {
  target_id: string;
  task: string;
}
export interface AutoPlanResult {
  dispatches: AutoPlanDispatch[];
  summary: string;
}
export async function autoPlan(
  prompt: string,
  fleet: AutoPlanFleetAgent[],
  alreadyRouted?: AutoPlanDispatch[],
  parentSessionId?: string,
): Promise<AutoPlanResult> {
  const res = await apiFetch(`${API_BASE}/auto/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt, fleet,
      already_routed: alreadyRouted ?? [],
      parent_session_id: parentSessionId ?? null,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Auto plan failed: ${detail || res.statusText}`);
  }
  return res.json();
}

/** Send a follow-up task to a target agent from the staff/Fleet chat
 *  (powers the inline "Reply" button on a dispatch_result card). Mirrors
 *  back to the staff WS as dispatch_ack so the pending card appears
 *  immediately. */
export async function dispatchFollowUp(
  targetId: string,
  task: string,
  staffId?: string,
): Promise<{ success: boolean; target_id: string }> {
  const res = await apiFetch(`${API_BASE}/dispatch/followup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_id: targetId, task, staff_id: staffId ?? null }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Dispatch follow-up failed: ${detail || res.statusText}`);
  }
  return res.json();
}

export async function fetchGroups() {
  const res = await fetch(`${API_BASE}/groups`);
  if (!res.ok) throw new Error("Failed to fetch groups");
  return res.json();
}

export async function fetchSessionCosts(sessionId: string): Promise<number> {
  const messages = await fetchMessages(sessionId);
  return (messages as Array<{ cost_usd?: number }>).reduce(
    (sum: number, msg) => sum + (msg.cost_usd ?? 0),
    0,
  );
}

/** Curated knowledge item — persisted in `session_memory`. The
 *  `from_other_session` flag means this item was saved during a prior
 *  session on the same project (cross-session per-project recall). */
export interface SessionMemoryItem {
  id: string;
  title: string;
  content: string;
  kind: string;
  created_at: string;
  created_by: string;
  from_other_session?: boolean;
}

/** One row from the auto-captured activity ledger. Backend writes one
 *  per tool_end event; UI groups + filters by `kind`. */
export interface SessionActivityItem {
  id: string;
  kind: string;  // 'file_edit' | 'file_read' | 'command' | 'web_fetch' | 'todo' | 'plan' | 'error' | 'tool' | 'note'
  summary: string;
  ts: string;
  payload?: { tool?: string; duration_ms?: number; output?: string; error?: boolean; status?: string; activeForm?: string };
}

/** Aggregated file usage — derived from session_activity rows of kind
 *  file_edit / file_read, deduped by path. */
export interface SessionFileEntry {
  path: string;
  edits: number;
  reads: number;
  last_ts: string | null;
}

export interface SessionDetail {
  session_id: string;
  message_count: number;
  total_cost_usd: number;
  model: string | null;
  created_at: string | null;
  permission_mode: string | null;
  project_path: string | null;
  /** Count of assistant replies — what the chat-input popover
   *  shows as "Turns". Distinct from message_count, which counts
   *  every row including user prompts. */
  assistant_turns?: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number; last_input: number; last_cache_read: number };
  tools: Record<string, number>;
  todos: Array<{ content: string; status: string; activeForm?: string }>;
  /** SessionMemoryItem objects now (was string[] before — both shapes
   *  accepted client-side during migration). */
  memory_items: SessionMemoryItem[] | string[];
  plans: Array<{ name: string; file: string; from_other_session?: boolean }>;
}

export async function fetchSessionDetail(sessionId: string): Promise<SessionDetail> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/detail`);
  if (!res.ok) throw new Error("Failed to fetch session detail");
  return res.json();
}

/** Recent activity ledger entries (newest first). Optional kind filter
 *  matches one of: file_edit / file_read / command / web_fetch / todo /
 *  plan / error / tool / note. */
export async function fetchSessionActivity(
  sessionId: string,
  opts?: { kind?: string; limit?: number },
): Promise<SessionActivityItem[]> {
  const params = new URLSearchParams();
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const q = params.toString();
  const res = await apiFetch(
    `${API_BASE}/sessions/${sessionId}/activity${q ? "?" + q : ""}`,
  );
  if (!res.ok) throw new Error("Failed to fetch session activity");
  return res.json();
}

/** Unique files this session has read or written, with counts and
 *  last-touched timestamp. */
export async function fetchSessionFiles(sessionId: string): Promise<SessionFileEntry[]> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/files`);
  if (!res.ok) throw new Error("Failed to fetch session files");
  return res.json();
}

/** A single GitHub repository entry from `gh repo list`. */
export interface GhRepo {
  nameWithOwner: string;
  description: string | null;
  url: string;
  sshUrl: string;
  isPrivate: boolean;
  updatedAt: string;
}

/** List the authenticated user's GitHub repos via the gh CLI on
 *  the backend. Used by the toolbar's Git source tab so the user
 *  can pick from their own repos with one click instead of pasting
 *  a URL. */
export async function listUserRepos(limit = 100): Promise<GhRepo[]> {
  const res = await apiFetch(`${API_BASE}/git/repos?limit=${limit}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Failed to list repos: ${res.statusText}`);
  }
  return res.json();
}

/** Resolver result for the Git source tab: which credential served the
 *  list, or that GitHub isn't connected at all. Backed by the shell IPC
 *  `github.listRepos` (gh-first → OAuth → NOT_CONNECTED). Enumerating a
 *  user's repos needs GitHub auth; cloning by URL does not — so this
 *  gates only the browse list, never the URL input. */
export type ReposResult =
  | { connected: true; source: "gh" | "oauth"; repos: GhRepo[] }
  | { connected: false; error?: string };

export async function listReposResolved(): Promise<ReposResult> {
  const gh = (window as unknown as {
    electronAPI?: { github?: { listRepos?: () => Promise<
      | { ok: true; source: "gh" | "oauth"; repos: GhRepo[] }
      | { ok: false; code: string; error?: string }
    > } };
  }).electronAPI?.github?.listRepos;
  if (!gh) return { connected: false };
  const r = await gh();
  if (r.ok) return { connected: true, source: r.source, repos: r.repos };
  if (r.code === "NOT_CONNECTED") return { connected: false };
  return { connected: false, error: r.error || r.code };
}

/** Clone (or fetch) a git URL under ~/.fleetify/clones/<repo>/.
 *  Used by the toolbar's source picker — once the clone lands, the
 *  caller PATCHes session.project_path to the returned absolute path
 *  and the existing ensure_worktree flow takes over. */
export async function cloneRepository(
  url: string,
  branch?: string,
): Promise<{ path: string; branch: string }> {
  const res = await apiFetch(`${API_BASE}/git/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, branch }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Clone failed: ${res.statusText}`);
  }
  return res.json();
}

/** Verify that a git URL is reachable as a remote, without cloning.
 *  Backed by `git ls-remote` with `GIT_TERMINAL_PROMPT=0`. Resolves with
 *  `{ ok: true }` when reachable; throws an `Error` whose message carries
 *  git's stderr when the remote is unreachable / unauthorised / wrong
 *  URL. Auth flows through the system credential helper exactly like
 *  `cloneRepository`. */
/** List a remote's branches + default branch WITHOUT cloning (backend
 *  `git ls-remote`, same GitHub-token auth as the clone). Feeds the
 *  composer's branch chip while the clone is still deferred. */
export async function listRemoteBranches(
  url: string,
): Promise<{ default_branch: string | null; branches: string[] }> {
  const res = await apiFetch(`${API_BASE}/git/branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Branch list failed: ${res.statusText}`);
  }
  return res.json();
}

export async function checkRepoAccessible(url: string): Promise<{ ok: true }> {
  const res = await apiFetch(`${API_BASE}/git/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Check failed: ${res.statusText}`);
  }
  return res.json();
}

/** Account-wide rollup powering the new-session welcome canvas.
 *  See backend/app/routers/sessions.py::overview_stats for shape. */
export interface AccountStats {
  sessions: number;
  messages: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  active_days: number;
  current_streak: number;
  longest_streak: number;
  peak_hour: number | null;
  favorite_model: string | null;
  /** YYYY-MM-DD → message count, last 365 days. */
  heatmap: Record<string, number>;
}

export async function fetchAccountStats(): Promise<AccountStats> {
  const res = await apiFetch(`${API_BASE}/sessions/stats/overview`);
  if (!res.ok) throw new Error("Failed to fetch account stats");
  return res.json();
}

/** Memory items for this session AND its project (cross-session recall). */
export async function fetchSessionMemory(sessionId: string): Promise<SessionMemoryItem[]> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/memory`);
  if (!res.ok) throw new Error("Failed to fetch session memory");
  return res.json();
}

/** Save a curated memory item for this session (and project). */
export async function createSessionMemory(
  sessionId: string,
  body: { title: string; content: string; kind?: string },
): Promise<SessionMemoryItem> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Save memory failed: ${detail || res.statusText}`);
  }
  return res.json();
}

/** Update a memory item — patches only provided fields. */
export async function updateSessionMemory(
  sessionId: string,
  itemId: string,
  patch: { title?: string; content?: string; kind?: string },
): Promise<SessionMemoryItem> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/memory/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Update memory failed: ${detail || res.statusText}`);
  }
  return res.json();
}

/** Remove a memory item by id. */
export async function deleteSessionMemory(sessionId: string, itemId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/memory/${itemId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete memory item");
}

export async function fetchBulkStats(): Promise<Record<string, { message_count: number; total_cost_usd: number; input_tokens: number; output_tokens: number; cache_tokens: number }>> {
  const res = await apiFetch(`${API_BASE}/sessions/stats/bulk`);
  if (!res.ok) return {};
  return res.json();
}

export interface PathValidation {
  exists: boolean;
  is_dir: boolean;
  absolute: string;
}

export async function validatePath(path: string): Promise<PathValidation> {
  const res = await fetch(`${API_BASE}/fs/validate?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Failed to validate path");
  return res.json();
}

export async function fetchDefaultPath(): Promise<string> {
  const res = await fetch(`${API_BASE}/fs/default`);
  if (!res.ok) throw new Error("Failed to fetch default path");
  const data = (await res.json()) as { path: string };
  return data.path;
}

export async function pickFolder(initial?: string): Promise<string> {
  const qs = initial ? `?initial=${encodeURIComponent(initial)}` : "";
  const res = await fetch(`${API_BASE}/fs/pick${qs}`);
  if (!res.ok) throw new Error("Failed to open folder picker");
  const data = (await res.json()) as { path: string };
  return data.path;
}

export async function fetchTotalCosts(): Promise<number> {
  const sessions = await fetchSessions();
  const costs = await Promise.all(
    (sessions as Array<{ id: string }>).map((s) => fetchSessionCosts(s.id)),
  );
  return costs.reduce((sum, c) => sum + c, 0);
}

export async function fetchClaudeHistory(sessionId: string): Promise<unknown[]> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/claude-history`);
  if (!res.ok) return [];
  return res.json();
}

export interface ClaudeSession {
  session_id: string;
  summary: string;
  updated_at: string;
  /** Friendly label of the Claude account this transcript belongs to —
   *  `"System"` for `~/.claude`, the dir name (e.g. `".claude-2"`) for
   *  siblings. Backend populates it for the multi-account scan; older
   *  builds omit the field. */
  account_label?: string;
  /** Original filesystem path the conversation was held in — shown as a
   *  folder badge under each row so the user knows which project a session
   *  belongs to without having to click into it. */
  project_path?: string;
}

/** Resume-from-Claude history. With no `projectPath`, the backend returns
 *  EVERY conversation across EVERY signed-in Claude account (the global
 *  history the user expects from the toolbar History chip); with a path, it
 *  filters to that project (legacy single-project behaviour). */
export async function fetchClaudeSessions(projectPath?: string): Promise<ClaudeSession[]> {
  const q = projectPath ? `?path=${encodeURIComponent(projectPath)}` : "";
  const res = await apiFetch(`${API_BASE}/claude-sessions${q}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchCodexSessions(projectPath: string): Promise<ClaudeSession[]> {
  const res = await apiFetch(`${API_BASE}/codex-sessions?path=${encodeURIComponent(projectPath)}`);
  if (!res.ok) return [];
  return res.json();
}

export interface FileSearchEntry {
  name: string;
  path: string;
  relative: string;
  type: "file" | "folder";
}

export async function searchProjectFiles(
  root: string,
  q: string,
  limit = 50,
): Promise<FileSearchEntry[]> {
  const qs = new URLSearchParams({ root, q, limit: String(limit) });
  const res = await apiFetch(`${API_BASE}/fs/search?${qs.toString()}`);
  if (!res.ok) return [];
  return res.json();
}

export async function setBudgetLimit(sessionId: string, limit: number | null): Promise<void> {
  const res = await apiFetch(`${API_BASE}/sessions/${sessionId}/budget`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budget_limit: limit }),
  });
  if (!res.ok) throw new Error("Failed to set budget limit");
}

/** Result of /api/prompt/enhance.
 *
 *  - `enhanced` is what the chat input should hold after the click.
 *    On no_op = true it equals the original prompt, so the caller can
 *    safely replace the textarea value either way.
 *  - `no_op` signals "we didn't change anything" — frontend shows a
 *    quiet "looks good as is" toast instead of pretending it edited.
 *  - `rationale` (optional) is a one-line "why" for the change OR
 *    the no-op reason ("timeout", "already specific", etc.). Useful
 *    for diagnostics; not surfaced to the user by default. */
export interface PromptEnhanceResult {
  enhanced: string;
  no_op?: boolean;
  rationale?: string | null;
}

export async function enhancePrompt(
  prompt: string,
  opts?: {
    /** Owning session — lets the backend attribute the Haiku meta-cost
     *  to the right session's budget. Omitted ⇒ unattributed. */
    sessionId?: string | null;
    projectPath?: string;
    /** Active tool/provider — server uses it to pick the matching
     *  small-tier model (claude→haiku, openai/codex→gpt-5-mini,
     *  gemini→gemini-flash). Unspecified means Claude default. */
    tool?: string | null;
    /** Optional explicit small-tier model override; rarely needed. */
    model?: string | null;
  },
): Promise<PromptEnhanceResult> {
  const res = await apiFetch(`${API_BASE}/prompt/enhance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: opts?.sessionId ?? "",
      prompt,
      project_path: opts?.projectPath ?? null,
      tool: opts?.tool ?? null,
      model: opts?.model ?? null,
    }),
  });
  if (!res.ok) {
    // Fail-soft on the client too — the caller will fall back to
    // the original prompt rather than block the user's send flow.
    throw new Error(`Enhance failed: ${res.status}`);
  }
  return res.json();
}

/** Result of /api/fleet/analyze.
 *
 *  Fleet brain classifies the agent's last response and tells the
 *  caller what should happen next. Three branches:
 *   - continue → next_prompt is set (Fleet's proposed follow-up)
 *   - ask      → question is set (Fleet wants the user to decide)
 *   - done     → summary is set (Fleet thinks the task is complete)
 *  reasoning is always present — one-sentence "why this call". */
export interface FleetAnalyzeResult {
  decision: "continue" | "ask" | "done";
  reasoning: string;
  next_prompt?: string | null;
  question?: string | null;
  summary?: string | null;
  /** Structured report sections — only populated on `done` when the
   *  brain extracted them. Frontend renders as compact bullet groups. */
  sections?: {
    what_done?: string[] | null;
    decisions?: string[] | null;
    uncertain?: string[] | null;
    options?: string[] | null;
  } | null;
  /** Degraded path — backend couldn't actually analyze (Haiku
   *  timeout, breaker open, parse error). Frontend should NOT push
   *  a decision card; leave the user in plain chat. The other
   *  fields hold placeholder values for log forensics. */
  degraded?: boolean;
}

export interface FleetChatResult {
  text: string;
  cost_estimate_usd?: number;
}

/** Fleet meta-chat — ask Fleet brain a question with a prose snapshot
 *  of the fleet as context. Stateless; the caller composes the snapshot
 *  client-side (session titles + statuses + recent activity). */
export async function askFleet(
  opts: { question: string; fleetSnapshot: string; sessionId?: string | null },
): Promise<FleetChatResult> {
  const res = await apiFetch(`${API_BASE}/fleet/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: opts.sessionId ?? "",
      question: opts.question,
      fleet_snapshot: opts.fleetSnapshot,
    }),
  });
  if (!res.ok) {
    throw new Error(`Fleet chat failed: ${res.status}`);
  }
  return res.json();
}

/* ── Fleet orchestration bridge ──────────────────────────────────
   Plan a goal across existing agents, fire an approved batch, poll it. */

/** One planned (or approved) routing: a task for a specific existing agent. */
export interface PlanDispatch {
  target_id: string;
  task: string;
}

/** A dispatch inside a running delegation batch. */
export interface BatchDispatch {
  target_id: string;
  target_title: string;
  status: "queued" | "running" | "done" | "failed";
  summary: string;
  error: string;
}

export interface FleetBatch {
  batch_id: string;
  done: boolean;
  dispatches: BatchDispatch[];
}

/** Ask Fleet brain to route a goal across the user's existing agents.
 *  Side-effect-free — nothing is dispatched until the user approves. */
export async function planFleet(goal: string): Promise<{ dispatches: PlanDispatch[]; summary: string }> {
  const res = await apiFetch(`${API_BASE}/fleet/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) throw new Error(`Fleet plan failed: ${res.status}`);
  return res.json();
}

/** Fire an approved set of dispatches as one batch; returns its initial state. */
export async function delegateFleet(dispatches: PlanDispatch[]): Promise<{ batch_id: string; dispatches: BatchDispatch[] }> {
  const res = await apiFetch(`${API_BASE}/fleet/delegate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dispatches }),
  });
  if (!res.ok) throw new Error(`Fleet delegate failed: ${res.status}`);
  return res.json();
}

/** Poll a delegation batch's per-dispatch progress. */
export async function getFleetBatch(batchId: string): Promise<FleetBatch> {
  const res = await apiFetch(`${API_BASE}/fleet/delegate/${batchId}`);
  if (!res.ok) throw new Error(`Fleet batch fetch failed: ${res.status}`);
  return res.json();
}

/** A row of Fleet's personal memory about the user. */
export interface UserMemory {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  content: string;
  importance: number;
  source: "explicit" | "auto";
  created_at: string;
  updated_at: string | null;
}

export async function listUserMemory(limit = 200): Promise<UserMemory[]> {
  const res = await apiFetch(`${API_BASE}/user/memory?limit=${limit}`);
  if (!res.ok) throw new Error(`List memory failed: ${res.status}`);
  return res.json();
}

export async function createUserMemory(
  m: { title: string; content: string; kind?: string; importance?: number },
): Promise<UserMemory> {
  const res = await apiFetch(`${API_BASE}/user/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(m),
  });
  if (!res.ok) throw new Error((await res.text()) || `Create memory failed: ${res.status}`);
  return res.json();
}

export async function updateUserMemory(
  id: string,
  patch: { title?: string; content?: string; kind?: string; importance?: number },
): Promise<UserMemory> {
  const res = await apiFetch(`${API_BASE}/user/memory/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Update memory failed: ${res.status}`);
  return res.json();
}

export async function deleteUserMemory(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/user/memory/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete memory failed: ${res.status}`);
}

export async function analyzeFleetResponse(
  opts: {
    priorPrompt: string;
    agentText: string;
    projectPath?: string | null;
    /** Owning session — attributes the analyze meta-cost to its budget. */
    sessionId?: string | null;
  },
): Promise<FleetAnalyzeResult> {
  const res = await apiFetch(`${API_BASE}/fleet/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: opts.sessionId ?? "",
      prior_prompt: opts.priorPrompt,
      agent_text: opts.agentText,
      project_path: opts.projectPath ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`Fleet analyze failed: ${res.status}`);
  }
  return res.json();
}

/** Connect to the shared interactive browser stream. Binary messages are
 *  live JPEG frames (DOWN); JSON text messages are user input (UP) —
 *  `{type:"navigate"|"click"|"scroll"|"type"|"key"|"back"|"forward"|"reload", …}`.
 *  Unauthenticated (loopback) for now; the page content is just the agent's
 *  browser viewport. */
export function createBrowserWebSocket(): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/ws/browser`);
}

export async function createChatWebSocket(sessionId: string): Promise<WebSocket> {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  // WebSocket browsers don't expose a way to send Authorization headers,
  // so the JWT rides as a query param. Backend validates + ownership-checks
  // before accepting any messages on the socket.
  const t = await window.fleetify?.getAccessToken();
  const qs = t?.token ? `?token=${encodeURIComponent(t.token)}` : "";
  return new WebSocket(`${protocol}//${host}/ws/chat/${sessionId}${qs}`);
}

/** Open the multiplexed sessions socket — ONE physical connection
 *  carries traffic for every active session. The renderer uses
 *  type="subscribe" / "unsubscribe" wire messages to manage which
 *  session ids ride this socket; outgoing payloads include
 *  `session_id` so the backend can route. */
export async function createSessionsWebSocket(): Promise<WebSocket> {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  // Try cached/expiry-aware token first. If we got nothing back (the
  // refresh threw silently — network blip, revoked refresh token,
  // etc.) try once more with force:true so we don't open a WS with
  // an empty `?token=` query string just to have the backend reject
  // it with "Unauthorized — missing or invalid token". A clean throw
  // is much better UX than that delayed system message.
  let t = await window.fleetify?.getAccessToken();
  if (!t?.token) {
    t = await window.fleetify?.getAccessToken({ force: true });
  }
  if (!t?.token) {
    throw new Error("No access token — sign in required");
  }
  const qs = `?token=${encodeURIComponent(t.token)}`;
  return new WebSocket(`${protocol}//${host}/ws/sessions${qs}`);
}

// ── Routing summary (Fleet right sidebar Router section) ──────

export interface RoutingDecisionInfo {
  ts: number; // epoch seconds
  agent: string;
  model: string;
  source: string; // "builtin" | "notdiamond" | "weave"
  fallback_used: boolean;
  task_flow: "chat" | "dispatch";
}

export interface RoutingSummary {
  enabled: boolean;
  active_decision_router: { id: string; display_name: string };
  active_proxy_gateway: { id: string; display_name: string };
  totals_24h: {
    decisions: number;
    fallbacks: number;
    avg_latency_ms: number;
    last_decision_ts: number | null;
  };
  last_decision: RoutingDecisionInfo | null;
  recent: RoutingDecisionInfo[];
  routed_session_ids: string[];
}

/** Null on any failure — the Router section hides rather than erroring. */
export async function fetchRoutingSummary(): Promise<RoutingSummary | null> {
  try {
    const res = await apiFetch(`${API_BASE}/routing/summary`);
    if (!res.ok) return null;
    return (await res.json()) as RoutingSummary;
  } catch {
    return null;
  }
}
