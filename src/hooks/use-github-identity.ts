/**
 * Single source of truth for the GitHub integration in Settings. Wraps
 * the two underlying auth paths (Fleetify OAuth + gh CLI) behind one
 * interface so the GitHubIntegrationTile doesn't have to juggle both.
 *
 * The "method" is whichever path completed most recently — persisted in
 * localStorage so a re-launched app remembers which surface to render.
 * "enabled" is the master switch users flip in the tile header; when
 * false, the tile shows a paused state and consumers ignore the
 * identity. Toggling enabled does NOT disconnect — re-enabling restores
 * the previous identity instantly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { github, type GitHubLinkPayload } from "@/lib/github-link-api";

const KEY_ENABLED = "fleet:settings:github-enabled";
const KEY_METHOD = "fleet:github-auth-method";

export type AuthMethod = "oauth" | "cli" | "skip" | null;

export type GitHubIdentity =
  | { source: "oauth"; login: string; avatarUrl: string; connectedAt: string }
  | { source: "cli"; login: string }
  | null;

export type GhCliState =
  | { kind: "probing" }
  | { kind: "missing" }
  | { kind: "needs-auth" }
  | { kind: "ready"; login: string };

export interface GhAuthEvent {
  phase: "code" | "url" | "log" | "done";
  code?: string;
  url?: string;
  line?: string;
  ok?: boolean;
  login?: string | null;
  error?: string | null;
}

export interface UseGitHubIdentity {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  method: AuthMethod;
  identity: GitHubIdentity;
  loading: boolean;
  ghCli: GhCliState;
  beginOAuth: () => Promise<{ ok: boolean; error?: string }>;
  beginCliAuth: () => Promise<{ ok: boolean; error?: string }>;
  cancelCliAuth: () => Promise<void>;
  disconnect: () => Promise<void>;
  onCliAuthEvent: (cb: (ev: GhAuthEvent) => void) => () => void;
  refresh: () => Promise<void>;
}

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KEY_ENABLED);
    return raw == null ? true : raw === "1";
  } catch {
    return true;
  }
}
function writeEnabled(v: boolean) {
  try { localStorage.setItem(KEY_ENABLED, v ? "1" : "0"); } catch { /* private mode */ }
}
function readMethod(): AuthMethod {
  try {
    const raw = localStorage.getItem(KEY_METHOD);
    if (raw === "oauth" || raw === "cli" || raw === "skip") return raw;
    return null;
  } catch {
    return null;
  }
}
function writeMethod(v: AuthMethod) {
  try {
    if (v === null) localStorage.removeItem(KEY_METHOD);
    else localStorage.setItem(KEY_METHOD, v);
  } catch { /* private mode */ }
}

type ElectronShim = {
  hasGhCli?: () => Promise<{
    ok: boolean;
    authed?: boolean;
    ghLogin?: string | null;
  }>;
  ghAuthLoginCapture?: () => Promise<
    | { ok: true; login?: string | null }
    | { ok: false; error?: string }
  >;
  ghAuthLoginCancel?: () => Promise<{ ok: boolean }>;
  onGhAuthEvent?: (cb: (ev: GhAuthEvent) => void) => () => void;
};
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

export function useGitHubIdentity(): UseGitHubIdentity {
  const [enabled, setEnabledState] = useState<boolean>(() => readEnabled());
  const [method, setMethodState] = useState<AuthMethod>(() => readMethod());
  const [identity, setIdentity] = useState<GitHubIdentity>(null);
  const [loading, setLoading] = useState(true);
  const [ghCli, setGhCli] = useState<GhCliState>({ kind: "probing" });
  const oauthLinkRef = useRef<GitHubLinkPayload | null>(null);

  // Probe gh CLI once on mount.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const r = await electron().hasGhCli?.();
        if (cancelled) return;
        if (!r || !r.ok) { setGhCli({ kind: "missing" }); return; }
        if (r.authed && r.ghLogin) {
          setGhCli({ kind: "ready", login: r.ghLogin });
        } else {
          setGhCli({ kind: "needs-auth" });
        }
      } catch {
        if (!cancelled) setGhCli({ kind: "missing" });
      }
    };
    void probe();
    return () => { cancelled = true; };
  }, []);

  // Resolve identity whenever method changes.
  const resolve = useCallback(async () => {
    const m = readMethod();
    setMethodState(m);
    if (m === "oauth") {
      const r = await github.getLink();
      if (r.ok && r.link) {
        oauthLinkRef.current = r.link;
        setIdentity({
          source: "oauth",
          login: r.link.github_login,
          avatarUrl: r.link.github_avatar_url,
          connectedAt: r.link.connected_at,
        });
      } else {
        setIdentity(null);
      }
    } else if (m === "cli") {
      const r = await electron().hasGhCli?.();
      if (r && r.ok && r.authed && r.ghLogin) {
        setIdentity({ source: "cli", login: r.ghLogin });
      } else {
        setIdentity(null);
      }
    } else {
      setIdentity(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await resolve();
      } catch {
        // Resolve only fails when both IPC paths throw (offline, broken
        // bridge). Identity stays null — already the right default. No
        // user-facing surface.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [resolve]);

  // Subscribe once: read the auth method via localStorage (readMethod()), not
  // React state, so this listener never holds a stale closure on `method`.
  // localStorage is the cross-component source of truth here.
  useEffect(() => {
    const off = github.onLinkChanged(({ link }) => {
      if (readMethod() !== "oauth") return;
      if (link) {
        oauthLinkRef.current = link;
        setIdentity({
          source: "oauth",
          login: link.github_login,
          avatarUrl: link.github_avatar_url,
          connectedAt: link.connected_at,
        });
      } else {
        setIdentity(null);
      }
    });
    return () => off();
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    writeEnabled(v);
    setEnabledState(v);
  }, []);

  const beginOAuth = useCallback(async () => {
    const r = await github.beginOAuth();
    if (r.ok) {
      writeMethod("oauth");
      oauthLinkRef.current = r.link;
      setMethodState("oauth");
      setIdentity({
        source: "oauth",
        login: r.link.github_login,
        avatarUrl: r.link.github_avatar_url,
        connectedAt: r.link.connected_at,
      });
      return { ok: true };
    }
    return { ok: false, error: r.error };
  }, []);

  const beginCliAuth = useCallback(async () => {
    // If the CLI is already authed, this is a single-tap accept — no
    // device-code dance needed. Caller still gets an ok result.
    if (ghCli.kind === "ready") {
      writeMethod("cli");
      setMethodState("cli");
      setIdentity({ source: "cli", login: ghCli.login });
      return { ok: true };
    }
    if (ghCli.kind !== "needs-auth") {
      return { ok: false, error: "gh CLI is not available." };
    }
    const r = await electron().ghAuthLoginCapture?.();
    if (r && r.ok) {
      const login = r.login ?? "";
      writeMethod("cli");
      setMethodState("cli");
      if (login) {
        setGhCli({ kind: "ready", login });
        setIdentity({ source: "cli", login });
      }
      return { ok: true };
    }
    return { ok: false, error: r && !r.ok ? r.error : "gh auth failed." };
  }, [ghCli]);

  const cancelCliAuth = useCallback(async () => {
    try { await electron().ghAuthLoginCancel?.(); } catch { /* best effort */ }
  }, []);

  const disconnect = useCallback(async () => {
    const m = readMethod();
    if (m === "oauth") {
      try { await github.disconnect(); } catch { /* best effort */ }
    }
    // CLI disconnect is intentionally a no-op on Fleetify's side — we
    // don't want to log the user out of gh on their machine. Clearing
    // the method is enough to stop driving PRs through that login.
    writeMethod(null);
    setMethodState(null);
    setIdentity(null);
  }, []);

  const onCliAuthEvent = useCallback(
    (cb: (ev: GhAuthEvent) => void) => {
      const off = electron().onGhAuthEvent?.(cb);
      return () => { try { off?.(); } catch { /* idempotent */ } };
    },
    [],
  );

  const refresh = useCallback(async () => {
    await resolve();
  }, [resolve]);

  return {
    enabled, setEnabled,
    method, identity, loading, ghCli,
    beginOAuth, beginCliAuth, cancelCliAuth,
    disconnect, onCliAuthEvent, refresh,
  };
}
