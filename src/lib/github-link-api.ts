/**
 * Renderer-side wrapper around the Electron GitHub-link IPC bridge.
 *
 * Same convention as lib/git-api.ts: every method resolves to
 * `{ ok, ... }` so callers branch with `if (r.ok) ...`. When Electron
 * isn't available (e.g. running the renderer in a plain browser for
 * tests / Storybook) every method returns a deterministic no-op.
 *
 * The access_token field lives in the type for completeness but
 * renderer code MUST NOT pass it around — REST calls happen in main.
 */

export interface GitHubLinkPayload {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  github_login: string;
  github_user_id: number;
  github_avatar_url: string;
  installation_id: number;
  connected_at: string;
}

type LinkResult =
  | { ok: true; link: GitHubLinkPayload }
  | { ok: false; code: string; error: string };

type LinkListener = (payload: { link: GitHubLinkPayload | null }) => void;
type BrowserFallbackListener = (payload: { url: string }) => void;

interface GitHubAPI {
  getLink: () => Promise<{ ok: boolean; link: GitHubLinkPayload | null; error?: string }>;
  beginOAuth: () => Promise<LinkResult>;
  disconnect: () => Promise<{ ok: boolean; error?: string }>;
  refreshLink: () => Promise<LinkResult>;
  openInstallation: () => Promise<{ ok: boolean; error?: string }>;
  onLinkChanged: (cb: LinkListener) => () => void;
  offLinkChanged: (cb: LinkListener) => void;
  onBrowserFallback: (cb: BrowserFallbackListener) => () => void;
  offBrowserFallback: (cb: BrowserFallbackListener) => void;
}

function api(): GitHubAPI {
  const w = (typeof window !== "undefined" ? window : {}) as { electronAPI?: { github?: GitHubAPI } };
  return w.electronAPI?.github ?? {
    getLink:          async () => ({ ok: false, link: null, error: "electron unavailable" }),
    beginOAuth:       async () => ({ ok: false, code: "ELECTRON_UNAVAILABLE", error: "electron unavailable" }),
    disconnect:       async () => ({ ok: false, error: "electron unavailable" }),
    refreshLink:      async () => ({ ok: false, code: "ELECTRON_UNAVAILABLE", error: "electron unavailable" }),
    openInstallation: async () => ({ ok: false, error: "electron unavailable" }),
    onLinkChanged:    () => () => {},
    offLinkChanged:   () => {},
    onBrowserFallback: () => () => {},
    offBrowserFallback: () => {},
  };
}

export const github = {
  getLink:            () => api().getLink(),
  beginOAuth:         () => api().beginOAuth(),
  disconnect:         () => api().disconnect(),
  refreshLink:        () => api().refreshLink(),
  openInstallation:   () => api().openInstallation(),
  onLinkChanged:      (cb: LinkListener) => api().onLinkChanged(cb),
  offLinkChanged:     (cb: LinkListener) => api().offLinkChanged(cb),
  onBrowserFallback:  (cb: BrowserFallbackListener) => api().onBrowserFallback(cb),
  offBrowserFallback: (cb: BrowserFallbackListener) => api().offBrowserFallback(cb),
};
