import { useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, GitMerge, Loader2 } from "lucide-react";

import { git } from "@/lib/git-api";
import { useOpenPrs, usePrStore, nextOpenAfter, type RepoPr } from "@/stores/pr-store";

/**
 * Repo-wide Merge box — the switcher half of the two-box PR UI (spec §5.5/§5.6,
 * D1/C5). Cycles every OPEN PR in the repo (from the shared PR store), shows
 * draft/active status, opens a PR in the browser, and merges (squash). After a
 * merge it auto-selects the next open PR; when the merged PR is THIS session's
 * work branch it asks the parent to run sync + carve-next-round (`onMergedOwnBranch`),
 * otherwise it only updates the store (merge-scope rule C5).
 */
export function MergeBox({
  folder,
  workBranch,
  onMergedOwnBranch,
}: {
  folder: string | null;
  /** This session's feature branch — used for the merge-scope rule. */
  workBranch?: string | null;
  /** Called after merging a PR whose head IS this session's branch, so the
   *  parent can run the existing source-sync + carve-next-round flow. */
  onMergedOwnBranch?: () => void;
}) {
  const open = useOpenPrs();
  const removePr = usePrStore((s) => s.remove);
  const [selected, setSelected] = useState<number | null>(null);
  const [merging, setMerging] = useState(false);

  if (open.length === 0) return null;
  // Selection is DERIVED during render (no effect): the user's pick if it's
  // still open, else the newest open PR. This avoids a set-state-in-effect
  // loop — `useOpenPrs` returns a fresh array reference every render.
  const found = open.findIndex((p) => p.number === selected);
  const idx = found >= 0 ? found : 0;
  const pr: RepoPr = open[idx]!;

  const step = (delta: number) => {
    const n = open.length;
    setSelected(open[(idx + delta + n) % n]!.number);
  };

  const onOpen = () => {
    if (pr.url) window.electronAPI?.openExternal?.(pr.url)?.catch?.(() => {});
  };

  const onMerge = async () => {
    if (!folder || merging) return;
    setMerging(true);
    try {
      if (pr.isDraft) {
        const ready = await git.markPRReady(folder, pr.number);
        if (!ready.ok) return;
      }
      const r = await git.mergePR(folder, pr.number, "squash");
      if (!r.ok) return;
      const isOwn = !!workBranch && pr.headRefName === workBranch;
      const next = nextOpenAfter(usePrStore.getState().prs, pr.number);
      removePr(pr.number); // optimistic — poll reconciles
      setSelected(next?.number ?? null);
      // Merge-scope (C5): only this session's branch triggers sync + carve.
      if (isOwn) onMergedOwnBranch?.();
    } finally {
      setMerging(false);
    }
  };

  return (
    <div style={boxStyle} data-testid="merge-box">
      {open.length > 1 && (
        <button onClick={() => step(-1)} aria-label="Previous PR" style={navBtn}>
          <ChevronLeft size={13} />
        </button>
      )}
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-med)", flexShrink: 0 }}>
        #{pr.number}
      </span>
      <span style={titleStyle} title={pr.title || pr.headRefName}>
        {pr.title || pr.headRefName}
      </span>
      <span style={pr.isDraft ? draftBadge : openBadge}>{pr.isDraft ? "Draft" : "Open"}</span>
      {open.length > 1 && (
        <button onClick={() => step(1)} aria-label="Next PR" style={navBtn}>
          <ChevronRight size={13} />
        </button>
      )}
      <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
        <button onClick={onOpen} title="Open in GitHub" style={actionBtn}>
          <ExternalLink size={11} /> Open
        </button>
        <button onClick={onMerge} disabled={merging} style={actionBtn}>
          {merging ? (
            <Loader2 size={11} style={{ animation: "spin 1.2s linear infinite" }} />
          ) : (
            <GitMerge size={11} />
          )}{" "}
          Merge
        </button>
      </div>
    </div>
  );
}

const boxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  marginTop: 4,
  borderRadius: 6,
  background: "rgba(var(--fg-rgb), 0.04)",
};
const navBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: "var(--c-dim)",
  cursor: "pointer",
  padding: 0,
};
const actionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 10px",
  borderRadius: 6,
  background: "rgba(var(--fg-rgb), 0.05)",
  border: "1px solid transparent",
  color: "var(--c-med)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "inherit",
};
const titleStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--c-high)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 220,
};
const draftBadge: CSSProperties = {
  fontSize: 10.5,
  padding: "1px 6px",
  borderRadius: 999,
  background: "rgba(234, 179, 8, 0.15)",
  color: "#eab308",
  flexShrink: 0,
};
const openBadge: CSSProperties = {
  fontSize: 10.5,
  padding: "1px 6px",
  borderRadius: 999,
  background: "rgba(34, 197, 94, 0.15)",
  color: "#22c55e",
  flexShrink: 0,
};
