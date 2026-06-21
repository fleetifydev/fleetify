/**
 * Far-left PR chip + switcher popover for the BranchStrip.
 *
 * Shows the currently *selected* open PR (`#N` + status dot). Clicking
 * opens an upward popover listing every open PR in the repo (from the
 * pr-store's 7s prList poll) — number, title, draft badge, conflict
 * dot, per-row external-open. Selection is owned by BranchStrip.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, GitPullRequest } from "lucide-react";
import type { RepoPr } from "@/stores/pr-store";
import type { PRStatus } from "@/lib/git-api";

/** Draft PRs read as "not in play yet" — a neutral theme-aware gray
 *  (GitHub parity) instead of the green/red/amber live-status ramp. */
const DRAFT_DOT = "var(--c-dim)";

/** Status-dot palette — mirrors the BranchStrip glyph colours. */
export function prIconColor(pr: PRStatus | null): string {
  if (!pr) return "var(--c-low)";
  if (pr.state === "MERGED") return "#a78bfa";
  if (pr.state === "CLOSED") return "#f87171";
  if (pr.isDraft) return DRAFT_DOT;
  if (pr.checks.failing > 0) return "#f87171";
  if (pr.mergeable === "CONFLICTING") return "#fb923c";
  if (pr.checks.pending > 0) return "#fbbf24";
  return "rgb(64,180,120)";
}

/** Labeled status for the chip pill: a state WORD + its text colour + a
 *  faint matching background tint. Replaces the bare 6px coloured dot —
 *  the word spells out what the colour meant ("Open", "Draft", "Conflict",
 *  …) so the PR's state reads at a glance instead of decoding a dot. */
export type PrStateLabel = { word: string; color: string; tint: string };
export function prStateLabel(pr: PRStatus | null): PrStateLabel {
  if (!pr) return { word: "PR", color: "var(--c-low)", tint: "rgba(var(--fg-rgb),0.06)" };
  if (pr.state === "MERGED") return { word: "Merged", color: "#a78bfa", tint: "rgba(167,139,250,0.13)" };
  if (pr.state === "CLOSED") return { word: "Closed", color: "#f87171", tint: "rgba(248,113,113,0.13)" };
  if (pr.isDraft) return { word: "Draft", color: "var(--c-dim)", tint: "rgba(var(--fg-rgb),0.06)" };
  if (pr.checks.failing > 0) return { word: "Failing", color: "#f87171", tint: "rgba(248,113,113,0.13)" };
  if (pr.mergeable === "CONFLICTING") return { word: "Conflict", color: "#fb923c", tint: "rgba(251,146,60,0.13)" };
  if (pr.checks.pending > 0) return { word: "Pending", color: "#fbbf24", tint: "rgba(251,191,36,0.13)" };
  return { word: "Open", color: "rgb(64,180,120)", tint: "rgba(64,180,120,0.13)" };
}

export function PrSwitcherChip({ openPrs, selectedNumber, selectedStatus, onSelect, onOpenUrl }: {
  openPrs: RepoPr[];
  selectedNumber: number;
  /** Full PRStatus for the selected PR when loaded (drives the dot). */
  selectedStatus: PRStatus | null;
  onSelect: (n: number) => void;
  onOpenUrl: (pr: RepoPr) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Chip label — the detailed PRStatus drives the state word + colour
  // once loaded; until then fall back to the prList entry so a draft
  // still reads "Draft" (not the "unknown" low-gray) during the first
  // detail-poll window.
  const selectedRepo = openPrs.find(p => p.number === selectedNumber) ?? null;
  const label: PrStateLabel = selectedStatus
    ? prStateLabel(selectedStatus)
    : selectedRepo
      ? (selectedRepo.isDraft
          ? { word: "Draft", color: "var(--c-dim)", tint: "rgba(var(--fg-rgb),0.06)" }
          : selectedRepo.mergeable === "CONFLICTING"
            ? { word: "Conflict", color: "#fb923c", tint: "rgba(251,146,60,0.13)" }
            : { word: "Open", color: "rgb(64,180,120)", tint: "rgba(64,180,120,0.13)" })
      : { word: "PR", color: "var(--c-low)", tint: "rgba(var(--fg-rgb),0.06)" };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        onMouseDown={e => e.preventDefault()}
        aria-label="Switch pull request"
        title={`#${selectedNumber} · ${label.word} — ${openPrs.length} open PR${openPrs.length > 1 ? "s" : ""}, click to switch`}
        style={{
          // Labeled status pill — a tinted rounded chip carrying the PR
          // icon, #N, and the spelled-out state word (coloured by state).
          // Replaces the bare dot + #N: the word explains the colour, and
          // the single chip consolidates the PR identity so the merge
          // cluster on the right no longer needs to repeat #N.
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "1.5px 7px",
          background: label.tint,
          border: "1px solid transparent",
          borderRadius: 999,
          color: "var(--c-med)", cursor: "pointer",
          fontSize: 11.5, fontWeight: 500, fontFamily: "var(--font-mono)",
          outline: "none",
          transition: "filter 0.12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.filter = "brightness(1.18)"; }}
        onMouseLeave={e => { e.currentTarget.style.filter = "none"; }}
      >
        <GitPullRequest size={11} strokeWidth={2} style={{ color: label.color, flexShrink: 0 }} />
        <span style={{ color: "var(--c-med)" }}>#{selectedNumber}</span>
        <span aria-hidden style={{ opacity: 0.4 }}>·</span>
        <span style={{ color: label.color, fontWeight: 600 }}>{label.word}</span>
        <ChevronDown size={10} strokeWidth={2.25} style={{
          opacity: 0.6,
          transform: open ? "rotate(180deg)" : "none",
          transition: "transform 0.15s",
        }} />
      </button>

      {open && (
        <div style={{
          // Upward like the create menu — the strip sits just above
          // the composer pinned to the viewport bottom.
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          minWidth: 260, maxWidth: 360,
          background: "var(--popover, #161616)",
          border: "1px solid var(--c-brd, rgba(127,127,127,0.18))",
          borderRadius: 8,
          boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
          padding: 4, zIndex: 50,
          display: "flex", flexDirection: "column",
          animation: "fleet-popover-up 0.14s ease-out both",
        }}>
          {openPrs.map(p => (
            <div
              key={p.number}
              role="button"
              tabIndex={0}
              onClick={() => { onSelect(p.number); setOpen(false); }}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.number); setOpen(false); } }}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 8px", borderRadius: 5, cursor: "pointer",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(var(--fg-rgb), 0.06)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: 999, flexShrink: 0,
                background: p.isDraft ? DRAFT_DOT
                  : p.mergeable === "CONFLICTING" ? "#fb923c"
                  : "rgb(64,180,120)",
              }} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--c-fg)", flexShrink: 0 }}>
                #{p.number}
              </span>
              {p.isDraft && (
                <span style={{
                  fontSize: 9.5, fontWeight: 600, letterSpacing: "0.04em",
                  padding: "1px 5px", borderRadius: 999, flexShrink: 0,
                  background: "rgba(var(--fg-rgb), 0.07)", color: "var(--c-low)",
                  textTransform: "uppercase",
                }}>draft</span>
              )}
              <span style={{
                flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", fontSize: 11.5, color: "var(--c-low)",
              }}>{p.title ?? p.headRefName}</span>
              {p.number === selectedNumber && (
                <Check size={11} strokeWidth={2.5} style={{ color: "var(--c-fg)", flexShrink: 0 }} />
              )}
              <button
                onClick={e => { e.stopPropagation(); onOpenUrl(p); }}
                title={`Open #${p.number} on GitHub`}
                style={{
                  background: "none", border: "none", padding: 2, borderRadius: 4,
                  color: "var(--c-dim)", cursor: "pointer", display: "flex", flexShrink: 0,
                }}
              >
                <ExternalLink size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
