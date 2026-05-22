/**
 * BranchPickerMenu — opens above the BranchStrip pills.
 *
 * Two modes:
 *   • mode="base"     → only the detected base branch + "Create new main
 *                       branch" (text input). Pins the new branch as the
 *                       logical base via `setBaseBranch`. Nondestructive
 *                       — does not touch the remote default.
 *   • mode="working"  → every other branch (base filtered out) + a
 *                       "Create new branch" action that carves a fresh
 *                       fleet/<topic>-<hex> off the current base.
 *
 * Both modes show a per-branch PR badge (one `gh pr list` call drives
 * every row). Click-outside / Esc dismiss.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import { Plus, GitBranch, Check, GitPullRequest, Loader2, GitMerge } from "lucide-react";
import { pushChatError } from "@/stores/chat-store";
import { useAppStore, COMPOSER_CHAT_KEY } from "@/stores/app-store";

// Surface a branch-op failure as a red bubble in the active chat in
// addition to the picker's inline error line — the inline copy
// vanishes the moment the menu closes, the chat record persists.
function surfaceBranchError(message: string) {
  const sid = useAppStore.getState().activeSessionId || COMPOSER_CHAT_KEY;
  pushChatError(sid, message);
}

interface PRSummary {
  number: number;
  state: string; // OPEN | CLOSED | MERGED
  headRefName: string;
  isDraft?: boolean;
}

interface Props {
  folder: string;
  /** "base" pill click → shows the detected base + new-main action.
   *  "working" pill click → shows every other branch + new-branch action. */
  mode: "base" | "working";
  /** Currently checked-out branch — rendered with a check and pinned
   *  to the top of the list. */
  currentBranch: string | null;
  /** Detected base for this clone (`git_get_context.baseBranch`). When
   *  null we fall back to "main" for the carve-from arg, but the base
   *  menu hides its "Create new" affordance so we never end up writing
   *  `fleetify.baseBranch` for a repo that doesn't have one yet. */
  baseBranch: string | null;
  /** Suggested topic for the new working branch name. We append
   *  `-<8hex>` to match the existing `fleet/<topic>-<sha>` convention. */
  newBranchTopic: string;
  onPick: (branch: string) => void;
  onCreateNew: (newBranch: string) => void;
  /** Fired after a successful setBaseBranch — caller refreshes
   *  context so the strip picks up the new base. */
  onBaseChanged?: (newBase: string) => void;
  onDismiss: () => void;
}

interface ListBranchesResult {
  current: string | null;
  local: string[];
  remote: string[];
}

export function BranchPickerMenu({
  folder,
  mode,
  currentBranch,
  baseBranch,
  newBranchTopic,
  onPick,
  onCreateNew,
  onBaseChanged,
  onDismiss,
}: Props) {
  const [branches, setBranches] = useState<ListBranchesResult | null>(null);
  const [prs, setPrs] = useState<PRSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // branch name being checked out
  const [creating, setCreating] = useState(false);
  // "base" mode: when null the row + button are visible; when set, the
  // input is open with this value (typed text). Submit pins it.
  const [newBaseDraft, setNewBaseDraft] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (newBaseDraft !== null) inputRef.current?.focus();
  }, [newBaseDraft]);

  // Click-outside + Esc dismissal. Esc on the new-base input cancels
  // just the input instead of closing the whole menu.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (newBaseDraft !== null) {
        setNewBaseDraft(null);
        setError(null);
        e.stopPropagation();
        return;
      }
      onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss, newBaseDraft]);

  // PR-state lookup keyed by branch name. Newer entries win when the
  // same branch has multiple PRs (rare — happens on rebase + reopen).
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

  // Rows depend on mode. Base mode shows only the detected base (we
  // could surface a "main-ish" candidate list but the user's spec only
  // calls for the current main + the new-main action). Working mode
  // shows everything except the base.
  const rows = useMemo(() => {
    if (!branches) return [] as string[];
    const seen = new Set<string>();
    const ordered: string[] = [];
    const push = (b: string) => {
      if (!b || seen.has(b)) return;
      seen.add(b);
      ordered.push(b);
    };

    if (mode === "base") {
      if (baseBranch) push(baseBranch);
      return ordered;
    }

    // working mode
    if (branches.current && branches.current !== baseBranch) push(branches.current);
    for (const b of branches.local) {
      if (b === baseBranch) continue;
      push(b);
    }
    for (const r of branches.remote) {
      const trimmed = r.replace(/^origin\//, "");
      if (!trimmed || trimmed === "HEAD") continue;
      if (trimmed === baseBranch) continue;
      push(trimmed);
    }
    return ordered;
  }, [branches, mode, baseBranch]);

  // What counts as "the selected row" per mode — drives both the
  // isCurrent visual (bold + check + soft background) and the no-op
  // dismissal when the user clicks the already-selected entry:
  //   • base mode    → baseBranch is the source of branching. We never
  //                    try to `git checkout` it because in a worktree
  //                    session main is locked to the source repo's HEAD
  //                    and the checkout would fail with `fatal: 'main'
  //                    is already used by worktree at …`.
  //   • working mode → currentBranch is the worktree's HEAD; switching
  //                    to it is a no-op so we just dismiss.
  const selectedBranch = mode === "base" ? baseBranch : currentBranch;

  const handlePick = async (branch: string) => {
    if (busy || creating || pinning) return;
    // Base mode is read-only: the base branch isn't somewhere you
    // switch TO from a feature branch, it's where you carve FROM.
    // Clicking it (or anything else in the base list) just closes
    // the menu without touching git.
    if (mode === "base") {
      onDismiss();
      return;
    }
    if (branch === selectedBranch) {
      onDismiss();
      return;
    }
    setBusy(branch);
    setError(null);
    try {
      const r = await window.electronAPI?.gitCheckout?.(folder, branch, false);
      if (r?.ok === false) {
        const msg = r.error || `git checkout ${branch} failed`;
        setError(msg);
        surfaceBranchError(msg);
        setBusy(null);
        return;
      }
      onPick(branch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Checkout failed";
      setError(msg);
      surfaceBranchError(msg);
      setBusy(null);
    }
  };

  const handleCreateWorking = async () => {
    if (busy || creating || pinning) return;
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
        const msg = r.error || `Carve ${newBranch} failed`;
        setError(msg);
        surfaceBranchError(msg);
        setCreating(false);
        return;
      }
      onCreateNew(newBranch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Carve failed";
      setError(msg);
      surfaceBranchError(msg);
      setCreating(false);
    }
  };

  const handlePinBase = async () => {
    const name = (newBaseDraft || "").trim();
    if (!name) {
      setError("Type a branch name first.");
      return;
    }
    if (busy || creating || pinning) return;
    setPinning(true);
    setError(null);
    try {
      const r = await window.electronAPI?.setBaseBranch?.(folder, name);
      if (!r?.ok) {
        const msg = r?.error || `Couldn't pin base branch '${name}'`;
        setError(msg);
        surfaceBranchError(msg);
        setPinning(false);
        return;
      }
      onBaseChanged?.(r.base || name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't pin base branch.";
      setError(msg);
      surfaceBranchError(msg);
      setPinning(false);
    }
  };

  const title = mode === "base" ? "Switch base branch" : "Switch working branch";

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
        {title}
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
            {mode === "base" ? "No base branch detected yet." : "No other branches."}
          </div>
        )}
        {rows.map(branch => {
          // In base mode the base entry reads as "selected" even when
          // the worktree's actual HEAD is on a feature branch — the
          // base IS what this side of the picker tracks.
          const isCurrent = branch === selectedBranch;
          const isBase = branch === baseBranch;
          const pr = prByBranch.get(branch);
          const isBusy = busy === branch;
          return (
            <button
              key={branch}
              onClick={() => handlePick(branch)}
              disabled={isBusy || creating || pinning}
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
                cursor: isBusy || creating || pinning ? "default" : "pointer",
                transition: "background 0.1s",
              }}
              onMouseEnter={e => {
                if (isCurrent || isBusy || creating || pinning) return;
                e.currentTarget.style.background = "rgba(255,255,255,0.04)";
              }}
              onMouseLeave={e => {
                if (isCurrent || isBusy || creating || pinning) return;
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ display: "flex", color: "var(--c-low)", flexShrink: 0 }}>
                {isBusy
                  ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                  : isBase
                    ? <GitMerge size={12} />
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
        {mode === "working" && (
          <button
            onClick={handleCreateWorking}
            disabled={busy !== null || creating || pinning}
            style={createButtonStyle(busy !== null || creating || pinning)}
            onMouseEnter={e => {
              if (busy !== null || creating || pinning) return;
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
        )}

        {mode === "base" && newBaseDraft === null && (
          <button
            onClick={() => { setNewBaseDraft(""); setError(null); }}
            disabled={busy !== null || creating || pinning}
            style={createButtonStyle(busy !== null || creating || pinning)}
            onMouseEnter={e => {
              if (busy !== null || creating || pinning) return;
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
            }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", color: "var(--c-low)" }}>
              <Plus size={13} strokeWidth={2.2} />
            </span>
            <span style={{ flex: 1 }}>Create new main branch</span>
          </button>
        )}

        {mode === "base" && newBaseDraft !== null && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
            }}
          >
            <input
              ref={inputRef}
              value={newBaseDraft}
              onChange={e => setNewBaseDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handlePinBase();
                }
              }}
              placeholder="e.g. release-v3"
              spellCheck={false}
              autoComplete="off"
              disabled={pinning}
              style={{
                flex: 1,
                height: 28,
                padding: "0 8px",
                fontSize: 12.5,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 5,
                color: "var(--c-fg)",
                outline: "none",
              }}
            />
            <button
              onClick={handlePinBase}
              disabled={pinning || !newBaseDraft?.trim()}
              style={{
                height: 28,
                padding: "0 11px",
                fontSize: 11.5,
                fontWeight: 600,
                borderRadius: 5,
                background: "var(--c-fg)",
                color: "var(--c-bg, #0c0c0c)",
                border: "none",
                cursor: pinning || !newBaseDraft?.trim() ? "default" : "pointer",
                opacity: pinning || !newBaseDraft?.trim() ? 0.55 : 1,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              {pinning && <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />}
              Pin
            </button>
          </div>
        )}
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

function createButtonStyle(disabled: boolean): React.CSSProperties {
  return {
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
    cursor: disabled ? "default" : "pointer",
  };
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
