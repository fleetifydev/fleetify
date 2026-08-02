/**
 * Dev-server URL per working directory.
 *
 * Keyed by cwd rather than session id: a dev server belongs to a project
 * directory, and `activeCwd` is already in scope both where the terminal
 * mounts (workspace-panel.tsx) and where the preview renders — so nothing has
 * to be threaded through props.
 *
 * `tail` exists because a PTY delivers up to 8 KB per chunk and a boot banner
 * can split mid-URL across two events. We match against the rolling tail, not
 * the individual chunk, so the split case still resolves.
 */
import { create } from "zustand";
import { detectDevServerUrl } from "@/lib/dev-server-url";

/** Enough to hold any boot banner; small enough to re-scan on every chunk. */
const TAIL_CAP = 4096;

interface CwdEntry {
  /** Rolling window of recent PTY output. */
  tail: string;
  /** Last auto-detected URL. Sticky — a later chunk with no URL never clears it. */
  detected: string | null;
  /** User-pinned URL. Wins over `detected` until cleared. */
  manual: string | null;
}

export interface DevServerState {
  byCwd: Record<string, CwdEntry>;
}

const EMPTY: CwdEntry = { tail: "", detected: null, manual: null };

export const useDevServerStore = create<DevServerState>(() => ({ byCwd: {} }));

/** Append a PTY chunk for `cwd` and re-run detection over the rolling tail. */
export function feedPtyChunk(cwd: string, chunk: string): void {
  if (!cwd || !chunk) return;
  useDevServerStore.setState(s => {
    const prev = s.byCwd[cwd] ?? EMPTY;
    const joined = prev.tail + chunk;
    const tail = joined.length > TAIL_CAP ? joined.slice(joined.length - TAIL_CAP) : joined;
    const hit = detectDevServerUrl(tail);
    return {
      byCwd: { ...s.byCwd, [cwd]: { ...prev, tail, detected: hit ?? prev.detected } },
    };
  });
}

/** Pin an address for `cwd`, or pass null to fall back to detection. */
export function setManualUrl(cwd: string, url: string | null): void {
  if (!cwd) return;
  useDevServerStore.setState(s => ({
    byCwd: { ...s.byCwd, [cwd]: { ...(s.byCwd[cwd] ?? EMPTY), manual: url } },
  }));
}

/** Manual pin wins; otherwise the detected URL; otherwise null. */
export function selectDevUrl(cwd: string) {
  return (s: DevServerState): string | null => {
    const e = s.byCwd[cwd];
    return e ? (e.manual ?? e.detected) : null;
  };
}
