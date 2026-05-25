/**
 * Single source of truth for Settings → Models tile health.
 *
 * On mount:
 *   - calls apiScanProviders() once to learn Ollama running state +
 *     model list.
 *   - for every API tile with `has_key === true`, kicks off
 *     providers.testConnection(id) in parallel and stores the result.
 *
 * Exposes:
 *   - ollama: union (scanning | missing | installing | running | error)
 *   - providers: per-id union (no_key | testing | ok | failed)
 *   - installOllama(): runs the install IPC + polls the scan endpoint
 *     until the daemon appears (cap 10 minutes).
 *   - cancelInstall(): UI-side abort. Native installer may still run;
 *     this only stops the poll + flips the tile back to missing.
 *   - refresh(): re-runs the mount-time logic. Use after a manual
 *     key Save / Disconnect so the pill updates immediately.
 *
 * No cache, no retry, no periodic re-validation. Spec §"Non-goals".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiScanProviders } from "@/lib/api";
import { providers as providersApi, type ProviderTile, type ProviderHealthSnapshot } from "@/lib/providers-api";

function snapToHealth(
  snap: ProviderHealthSnapshot | undefined,
  hasKey: boolean,
): ProviderHealth {
  if (!snap) return hasKey ? { kind: "testing" } : { kind: "no_key" };
  switch (snap.kind) {
    case "no_key": return { kind: "no_key" };
    case "ok": return { kind: "ok", latencyMs: snap.latency_ms, modelCount: snap.model_count ?? undefined };
    case "failed": return { kind: "failed", code: snap.code, message: snap.message ?? undefined };
  }
}

export type InstallSubstate = "running-installer" | "waiting-daemon" | "timeout";

export type OllamaHealth =
  | { kind: "scanning" }
  | { kind: "missing" }
  | { kind: "installing"; substate: InstallSubstate; openedBrowser?: boolean; message?: string }
  | { kind: "running"; models: string[] }
  | { kind: "error"; message: string };

export type ProviderHealth =
  | { kind: "no_key" }
  | { kind: "testing" }
  | { kind: "ok"; latencyMs: number; modelCount?: number | null }
  | { kind: "failed"; code?: string; message?: string };

export interface UseProviderHealth {
  ollama: OllamaHealth;
  providers: Record<string, ProviderHealth>;
  installOllama: () => Promise<void>;
  cancelInstall: () => void;
  refresh: () => Promise<void>;
}

interface ElectronShim {
  installOllama?: () => Promise<{
    success: boolean;
    output?: string;
    error?: string;
    openedBrowser?: boolean;
  }>;
}
function electron(): ElectronShim {
  return (window as unknown as { electronAPI?: ElectronShim }).electronAPI ?? {};
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ITERATIONS = 300; // 10 minutes

export function useProviderHealth({ tiles }: { tiles: ProviderTile[] }): UseProviderHealth {
  const [ollama, setOllama] = useState<OllamaHealth>({ kind: "scanning" });
  const [providers, setProviders] = useState<Record<string, ProviderHealth>>({});
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Stable signature of the tile set used by the scan. Identity-stable
  // tiles arrays cause useEffect to re-run on every render, which the
  // scan's setState triggers — boom, infinite loop. Keying off the
  // (id, kind, has_key) triple keeps the effect inert when the parent
  // re-renders with an equivalent but freshly-constructed array.
  const tilesSig = useMemo(
    () => tiles.map((t) => `${t.spec.id}:${t.spec.kind}:${t.has_key ? 1 : 0}`).join("|"),
    [tiles],
  );
  const tilesRef = useRef(tiles);
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  const runScan = useCallback(async () => {
    const currentTiles = tilesRef.current;
    setOllama({ kind: "scanning" });
    setProviders((prev) => {
      const next: Record<string, ProviderHealth> = { ...prev };
      for (const t of currentTiles) {
        if (t.spec.kind !== "api") continue;
        next[t.spec.id] = t.has_key ? { kind: "testing" } : { kind: "no_key" };
      }
      return next;
    });

    // 1. Ollama scan.
    let scanResult: Awaited<ReturnType<typeof apiScanProviders>> | null = null;
    try {
      scanResult = await apiScanProviders();
    } catch (e) {
      setOllama({ kind: "error", message: e instanceof Error ? e.message : "scan failed" });
    }
    if (scanResult) {
      if (scanResult.ollama.running) {
        setOllama({ kind: "running", models: scanResult.ollama.models });
      } else {
        setOllama({ kind: "missing" });
      }
    }

    // 2. Per-provider health — cache-first, fan-out fallback.
    const apiTiles = currentTiles.filter((t) => t.spec.kind === "api");
    let usedCache = false;
    try {
      const health = await providersApi.fetchHealth();
      if (health.ok && Object.keys(health.providers).length > 0) {
        usedCache = true;
        setProviders((prev) => {
          const next = { ...prev };
          for (const t of apiTiles) {
            next[t.spec.id] = snapToHealth(health.providers[t.spec.id], t.has_key);
          }
          return next;
        });
      }
    } catch {
      // fetchHealth failed — fall through to local fan-out below.
    }

    if (!usedCache) {
      // Fan-out fallback: used on cold start (cache empty) or if fetchHealth threw.
      const keyedTiles = apiTiles.filter((t) => t.has_key);
      await Promise.all(
        keyedTiles.map(async (t) => {
          try {
            // Empty key tells the backend to use the saved keychain key.
            const r = await providersApi.testConnection(t.spec.id, "");
            setProviders((prev) => ({
              ...prev,
              [t.spec.id]: r.ok
                ? { kind: "ok", latencyMs: r.latency_ms, modelCount: r.model_count }
                : { kind: "failed", code: r.code, message: r.error },
            }));
          } catch (e) {
            setProviders((prev) => ({
              ...prev,
              [t.spec.id]: { kind: "failed", message: e instanceof Error ? e.message : "test threw" },
            }));
          }
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesSig]);

  // Mount + when tile list changes (e.g., after a Save adds a new key).
  useEffect(() => {
    cancelRef.current = { cancelled: false };
    void runScan();
    return () => { cancelRef.current.cancelled = true; };
  }, [runScan]);

  const cancelInstall = useCallback(() => {
    cancelRef.current.cancelled = true;
    setOllama({ kind: "missing" });
  }, []);

  const installOllama = useCallback(async () => {
    cancelRef.current = { cancelled: false };
    const localCancel = cancelRef.current;
    setOllama({ kind: "installing", substate: "running-installer" });

    let installResult: Awaited<ReturnType<NonNullable<ElectronShim["installOllama"]>>> | undefined;
    try {
      installResult = await electron().installOllama?.();
    } catch (e) {
      if (!localCancel.cancelled) {
        setOllama({ kind: "error", message: e instanceof Error ? e.message : "install threw" });
      }
      return;
    }
    if (localCancel.cancelled) return;

    if (!installResult) {
      if (localCancel.cancelled) return;
      setOllama({ kind: "error", message: "installOllama IPC unavailable" });
      return;
    }

    const openedBrowser = installResult.openedBrowser === true;
    if (!installResult.success && !openedBrowser) {
      if (localCancel.cancelled) return;
      setOllama({ kind: "error", message: installResult.error ?? "installer failed" });
      return;
    }

    // Begin polling for the daemon. Either we got success and we're
    // waiting for the daemon to start, or we got a browser fallback and
    // we're waiting for the user to complete the install in-browser.
    if (localCancel.cancelled) return;
    setOllama({ kind: "installing", substate: "waiting-daemon", openedBrowser });

    for (let i = 0; i < POLL_MAX_ITERATIONS; i++) {
      if (localCancel.cancelled) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (localCancel.cancelled) return;
      let s: Awaited<ReturnType<typeof apiScanProviders>> | null = null;
      try { s = await apiScanProviders(); } catch { /* keep polling */ }
      if (s?.ollama.running) {
        setOllama({ kind: "running", models: s.ollama.models });
        return;
      }
    }
    if (!localCancel.cancelled) {
      setOllama({ kind: "installing", substate: "timeout", openedBrowser });
    }
  }, []);

  const refresh = useCallback(async () => {
    await runScan();
  }, [runScan]);

  return { ollama, providers, installOllama, cancelInstall, refresh };
}
