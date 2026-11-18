/**
 * The backend's per-run API token. The shell makes it at startup and gives it
 * to the renderer over IPC (`window.fleetify.getApiToken`, the
 * `backend_api_token` command). Every request to the backend carries it:
 * fetches in the `X-Fleetify-Token` header (through `apiFetch` /
 * `backendFetch` in api.ts), and WebSocket / EventSource URLs, which can't
 * set a header, in the `api_token` query parameter (`withApiTokenQuery`).
 */

export const API_TOKEN_HEADER = "X-Fleetify-Token";
export const API_TOKEN_QUERY = "api_token";

let asked: Promise<string | null> | null = null;

/** Fetched once over IPC (window.fleetify.getApiToken) and memoised; null when there is no Tauri bridge
 *  (a plain-browser dev run with FLEETIFY_NOAUTH=1, where the backend doesn't ask for it).
 *  A failed ask resolves to null and is not memoised, so the next call asks again. */
export function apiToken(): Promise<string | null> {
  const bridge = typeof window === "undefined" ? undefined : window.fleetify;
  if (!bridge || typeof bridge.getApiToken !== "function") return Promise.resolve(null);
  if (!asked) {
    const ask: Promise<string | null> = Promise.resolve()
      .then(() => bridge.getApiToken())
      .then((token) => (typeof token === "string" && token !== "" ? token : null))
      .catch(() => null);
    asked = ask;
    void ask.then((token) => {
      if (token === null && asked === ask) asked = null;
    });
  }
  return asked;
}

/** `init` plus the token header; the headers already in `init` stay. */
export async function withApiToken(init: RequestInit = {}): Promise<RequestInit> {
  const token = await apiToken();
  if (token === null) return init;
  const headers = new Headers(init.headers);
  headers.set(API_TOKEN_HEADER, token);
  return { ...init, headers };
}

/** `url` plus `api_token=<token>`, after `?` or `&` as the URL needs. */
export async function withApiTokenQuery(url: string): Promise<string> {
  const token = await apiToken();
  if (token === null) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const separator = !base.includes("?") ? "?" : /[?&]$/.test(base) ? "" : "&";
  return `${base}${separator}${API_TOKEN_QUERY}=${encodeURIComponent(token)}${hash}`;
}

/** Forget the memoised token, so each test starts from the shell again. */
export function resetApiTokenForTests(): void {
  asked = null;
}
