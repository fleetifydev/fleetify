/**
 * BranchPickerMenu — pops up from the BranchStrip's branch label.
 *
 *   • Lists every local branch with a "PR #N · OPEN/MERGED" badge.
 *   • Click a row → checks that branch out, caller refreshes ctx + pr.
 *   • "+ Create new branch" carves a fresh `fleet/<topic>-<8hex>`
 *     from the current base and switches to it.
 *
 * One `gh pr list` call drives every badge (cheap), one `git_list_branches`
 * call drives the row list. Both fire when the menu opens.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import { Plus, GitBranch, Check, GitPullRequest, Loader2 } from "lucide-react";

interface PRSummary {
  number: number;
  state: string; // OPEN | CLOSED | MERGED
  headRefName: string;
  isDraft?: boolean;
}

interface Props {
  folder: string;
  /** Currently checked-out branch — rendered with a check and pinned
   *  to the top of the list. */
  currentBranch: string | null;
  /** Base branch to carve new feature branches from. Defaults to main. */
  baseBranch?: string;
  /** Suggested topic for the new branch name. We append `-<8hex>` to
   *  match the existing `fleet/<topic>-<sha>` convention. */
  newBranchTopic: string;
  onPick: (branch: string) => void;
  onCreateNew: (newBranch: string) => void;
  onDismiss: () => void;
}

interface ListBranchesResult {
  current: string | null;
  local: string[];
  remote: string[];
}

export function BranchPickerMenu({
  folder,
  currentBranch,
  baseBranch,
  newBranchTopic,
  onPick,
  onCreateNew,
  onDismiss,
}: Props) {
  const [branches, setBranches] = useState<ListBranchesResult | null>(null);
  const [prs, setPrs] = useState<PRSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // branch name being checked out
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Hydrate both branches + PR list on open. Parallel fetches.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, p] = await Promise.all([
          window.electronAPI?.listGitBranches?.(folder),
          window.electronAPI?.listPRs?.(folder, 100),
        ]);
        if (cancelled) return;
        if (b) setBranches(b);
        if (p?.ok && Array.isArray(p.prs)) setPrs(p.prs as PRSummary[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load branches");
      }
    })();
    return () => { cancelled = true; };
  }, [folder]);

  // Click-outside + Esc dismissal.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  // PR-state lookup table keyed by branch name. Newer entries win when
  // the same branch has multiple PRs (rare — happens on rebase + reopen).
  const prByBranch = useMemo(() => {
    const m = new Map<string, PRSummary>();
    for (const p of prs) {
      const prev = m.get(p.headRefName);
      // Prefer OPEN over MERGED/CLOSED so the badge tells the user
      // there's still something actionable.
      if (!prev || (p.state === "OPEN" && prev.state !== "OPEN")) {
        m.set(p.headRefName, p);
      }
    }
    return m;
  }, [prs]);

  const rows = useMemo(() => {
    if (!branches) return [] as string[];
    const seen = new Set<string>();
    const ordered: string[] = [];
    const push = (b: string) => {
      if (!b || seen.has(b)) return;
      seen.add(b);
      ordered.push(b);
    };
    if (branches.current) push(branches.current);
    for (const b of branches.local) push(b);
    // Remote-only branches (no local tracking) listed last with the
    // `origin/` prefix stripped for display, so the user can fetch
    // and switch to them from the picker.
    for (const r of branches.remote) {
      const trimmed = r.replace(/^origin\//, "");
      if (trimmed && trimmed !== "HEAD") push(trimmed);
    }
    return ordered;
  }, [branches]);

  const handlePick = async (branch: string) => {
    if (busy || creating) return;
    if (branch === currentBranch) {
      onDismiss();
      return;
    }
    setBusy(branch);
    setError(null);
    try {
      const r = await window.electronAPI?.gitCheckout?.(folder, branch, false);
      if (r?.ok === false) {
        setError(r.error || `git checkout ${branch} failed`);
        setBusy(null);
        return;
      }
      onPick(branch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setBusy(null);
    }
  };

  const handleCreate = async () => {
    if (busy || creating) return;
    setCreating(true);
    setError(null);
    const slug = (newBranchTopic || "scratch")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "scratch";
    // 8 hex chars to match the existing `fleet/<topic>-<sha>` pattern
    // the carveNextRound + auto-PR code already keys off.
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2, "0")).join("");
    const newBranch = `fleet/${slug}-${hex}`;
    try {
      const r = await window.electronAPI?.carveNextRound?.(
        folder,
        newBranch,
        baseBranch || "main",
      );
      if (r?.ok === false) {
        setError(r.error || "carve failed");
        setCreating(false);
        return;
      }
      onCreateNew(newBranch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Carve failed");
      setCreating(false);
    }
  };

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        minWidth: 280,
        maxWidth: 360,
        maxHeight: 420,
        overflow: "hidden",
        background: "var(--popover, #161616)",
        border: "1px solid var(--c-brd, rgba(255,255,255,0.10))",
        borderRadius: 8,
        boxShadow: "0 -10px 32px rgba(0,0,0,0.45)",
        padding: 4,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        animation: "fleet-popover-up 0.14s ease-out both",
      }}
    >
      <div style={{
        padding: "8px 10px 6px",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--c-low)",
      }}>
        Switch branch
      </div>

      <div style={{
        overflowY: "auto",
        flex: 1,
        display: "flex",
        flexDirection: "column",
      }}>
        {branches === null && (
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--c-low)" }}>
            <Loader2 size={12} style={{ animation: "spin 1s linear infinite", marginRight: 6, verticalAlign: -1 }} />
            Loading branches…
          </div>
        )}
        {branches !== null && rows.length === 0 && (
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--c-low)" }}>
            No branches yet.
          </div>
        )}
        {rows.map(branch => {
          const isCurrent = branch === currentBranch;
          const pr = prByBranch.get(branch);
          const isBusy = busy === branch;
          return (
            <button
              key={branch}
              onClick={() => handlePick(branch)}
              disabled={isBusy || creating}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 10px",
                background: isCurrent ? "rgba(255,255,255,0.06)" : "transparent",
                border: "none",
                borderRadius: 6,
                color: "var(--c-fg)",
                fontSize: 12.5,
                fontFamily: "inherit",
                textAlign: "left",
                cursor: isBusy || creating ? "default" : "pointer",
                transition: "background 0.1s",
              }}
              onMouseEnter={e => {
                if (isCurrent || isBusy || creating) return;
                e.currentTarget.style.background = "rgba(255,255,255,0.04)";
              }}
              onMouseLeave={e => {
                if (isCurrent || isBusy || creating) return;
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ display: "flex", color: "var(--c-low)", flexShrink: 0 }}>
                {isBusy
                  ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                  : <GitBranch size={12} />}
              </span>
              <span style={{
                flex: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontWeight: isCurrent ? 600 : 400,
              }}>
                {branch}
              </span>
              {pr && (
                <span
                  title={`PR #${pr.number} · ${pr.state}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: prBadgeBg(pr.state),
                    color: prBadgeFg(pr.state),
                    flexShrink: 0,
                  }}
                >
                  <GitPullRequest size={9} />
                  #{pr.number}
                </span>
              )}
              {isCurrent && (
                <Check size={11} style={{ color: "var(--c-med)", flexShrink: 0 }} />
              )}
            </button>
          );
        })}
      </div>

      <div style={{
        borderTop: "1px solid rgba(255,255,255,0.06)",
        padding: 4,
      }}>
        <button
          onClick={handleCreate}
          disabled={busy !== null || creating}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 10px",
            background: "transparent",
            border: "none",
            borderRadius: 6,
            color: "var(--c-fg)",
            fontSize: 12.5,
            fontFamily: "inherit",
            textAlign: "left",
            cursor: busy !== null || creating ? "default" : "pointer",
          }}
          onMouseEnter={e => {
            if (busy !== null || creating) return;
            e.currentTarget.style.background = "rgba(255,255,255,0.04)";
          }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
        >
          <span style={{ display: "flex", color: "var(--c-low)" }}>
            {creating
              ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              : <Plus size={13} strokeWidth={2.2} />}
          </span>
          <span style={{ flex: 1 }}>
            {creating ? "Creating branch…" : "Create new branch"}
          </span>
        </button>
      </div>

      {error && (
        <div style={{
          padding: "6px 10px 8px",
          fontSize: 11,
          color: "rgba(248,113,113,0.92)",
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

function prBadgeBg(state: string): string {
  switch (state.toUpperCase()) {
    case "OPEN":   return "rgba(74,222,128,0.14)";
    case "MERGED": return "rgba(167,139,250,0.18)";
    case "CLOSED": return "rgba(248,113,113,0.14)";
    default:       return "rgba(255,255,255,0.06)";
  }
}
function prBadgeFg(state: string): string {
  switch (state.toUpperCase()) {
    case "OPEN":   return "rgb(74,222,128)";
    case "MERGED": return "rgb(167,139,250)";
    case "CLOSED": return "rgb(248,113,113)";
    default:       return "var(--c-med)";
  }
}
