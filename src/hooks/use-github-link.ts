import { useCallback, useEffect, useState } from "react";
import { github, type GitHubLinkPayload } from "@/lib/github-link-api";

type State =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; link: GitHubLinkPayload };

interface UseGitHubLink {
  state: State;
  link: GitHubLinkPayload | null;
  /** Non-null while a Connect attempt couldn't launch a browser and
   *  the URL is sitting in the clipboard ready to paste. Cleared when
   *  the attempt resolves (success or otherwise). */
  browserFallbackUrl: string | null;
  connect: () => Promise<{ ok: boolean; error?: string; code?: string }>;
  disconnect: () => Promise<{ ok: boolean }>;
  openInstallation: () => Promise<{ ok: boolean }>;
  refresh: () => Promise<{ ok: boolean }>;
}

export function useGitHubLink(): UseGitHubLink {
  const [state, setState] = useState<State>({ status: "loading" });
  const [browserFallbackUrl, setBrowserFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    github.getLink().then((r) => {
      if (cancelled) return;
      if (r.ok && r.link) setState({ status: "connected", link: r.link });
      else setState({ status: "disconnected" });
    });

    const off = github.onLinkChanged(({ link }) => {
      if (cancelled) return;
      if (link) setState({ status: "connected", link });
      else setState({ status: "disconnected" });
    });

    const offFallback = github.onBrowserFallback(({ url }) => {
      if (!cancelled) setBrowserFallbackUrl(url);
    });

    return () => { cancelled = true; off(); offFallback(); };
  }, []);

  const connect = useCallback(async () => {
    setBrowserFallbackUrl(null);
    setState({ status: "connecting" });
    const r = await github.beginOAuth();
    setBrowserFallbackUrl(null);
    if (r.ok) {
      setState({ status: "connected", link: r.link });
      return { ok: true };
    }
    setState({ status: "disconnected" });
    return { ok: false, error: r.error, code: r.code };
  }, []);

  const disconnect = useCallback(async () => {
    setState((prev) => prev);   // capture current via closure below
    const r = await github.disconnect();
    if (r.ok) setState({ status: "disconnected" });
    return { ok: !!r.ok };
  }, []);

  const openInstallation = useCallback(async () => {
    const r = await github.openInstallation();
    return { ok: !!r.ok };
  }, []);

  const refresh = useCallback(async () => {
    const r = await github.refreshLink();
    if (r.ok) setState({ status: "connected", link: r.link });
    return { ok: !!r.ok };
  }, []);

  const link = state.status === "connected" ? state.link : null;

  return { state, link, browserFallbackUrl, connect, disconnect, openInstallation, refresh };
}
