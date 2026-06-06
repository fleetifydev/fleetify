import { useEffect } from "react";
import { create } from "zustand";

import { git } from "@/lib/git-api";

/**
 * Repo-wide open-PR store — the single source of truth for the Merge box's
 * cross-PR switcher and the branch-picker PR badges (spec §5.5/§5.6, D1/C5).
 *
 * A `listPRs` poll fills it (server wins on each reconcile); create/merge apply
 * optimistic edits between polls. The pure reducer helpers below carry the
 * tricky bits (dedupe, open-only ordering, after-merge "next PR" selection) and
 * are unit-tested without React/Zustand.
 */
export interface RepoPr {
  number: number;
  /** "OPEN" | "MERGED" | "CLOSED" (upper-cased by the backend mappers). */
  state: string;
  headRefName: string;
  isDraft?: boolean;
  mergeable?: string;
  title?: string;
  url?: string;
}

// ── Pure reducer helpers (no React/Zustand — unit-tested) ──

function dedupe(prs: RepoPr[]): RepoPr[] {
  const seen = new Set<number>();
  const out: RepoPr[] = [];
  for (const p of prs) {
    if (seen.has(p.number)) continue;
    seen.add(p.number);
    out.push(p);
  }
  return out;
}

/** Open PRs only, newest first (descending number). */
export function openPrs(prs: RepoPr[]): RepoPr[] {
  return prs
    .filter((p) => (p.state || "").toUpperCase() === "OPEN")
    .sort((a, b) => b.number - a.number);
}

/** Replace the whole set from a poll result (server wins). */
export function setPrs(_prev: RepoPr[], incoming: RepoPr[]): RepoPr[] {
  return dedupe(incoming);
}

/** Optimistic insert/update by number (e.g. just-created PR). */
export function upsertPr(prev: RepoPr[], pr: RepoPr): RepoPr[] {
  return dedupe([pr, ...prev.filter((p) => p.number !== pr.number)]);
}

/** Optimistic remove by number (e.g. just-merged PR). */
export function removePr(prev: RepoPr[], num: number): RepoPr[] {
  return prev.filter((p) => p.number !== num);
}

/** The next OPEN PR to surface after `num` is merged/removed — the newest
 *  remaining open PR, or null when none remain (Merge box then hides). */
export function nextOpenAfter(prev: RepoPr[], num: number): RepoPr | null {
  return openPrs(prev.filter((p) => p.number !== num))[0] ?? null;
}

// ── Zustand store ──

interface PrStoreState {
  prs: RepoPr[];
  /** Replace from a poll result. */
  setAll: (incoming: RepoPr[]) => void;
  /** Optimistic create. */
  upsert: (pr: RepoPr) => void;
  /** Optimistic merge/remove. */
  remove: (num: number) => void;
}

export const usePrStore = create<PrStoreState>((set) => ({
  prs: [],
  setAll: (incoming) => set((s) => ({ prs: setPrs(s.prs, incoming) })),
  upsert: (pr) => set((s) => ({ prs: upsertPr(s.prs, pr) })),
  remove: (num) => set((s) => ({ prs: removePr(s.prs, num) })),
}));

/** Selector hook: the open PRs (newest first) for the Merge-box switcher.
 *  Selects the STABLE `prs` reference and derives outside the selector —
 *  computing `openPrs` inside the selector returns a fresh array each call and
 *  trips Zustand's "getSnapshot should be cached" infinite loop. */
export function useOpenPrs(): RepoPr[] {
  const prs = usePrStore((s) => s.prs);
  return openPrs(prs);
}

/**
 * Poll `listPRs` (~7 s) into the store while a folder is active. Each poll
 * reconciles to the server's truth; optimistic create/merge edits bridge the
 * gap between polls. Call once near the PR UI.
 */
export function useRepoPrs(folder: string | null | undefined): void {
  const setAll = usePrStore((s) => s.setAll);
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    const poll = async () => {
      const r = await git.prList(folder, 100);
      if (!cancelled && r.ok && Array.isArray(r.prs)) {
        setAll(r.prs as RepoPr[]);
      }
    };
    void poll();
    const t = setInterval(poll, 7000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [folder, setAll]);
}
