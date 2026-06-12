/**
 * Far-left PR chip + switcher popover for the BranchStrip.
 *
 * Shows the currently *selected* open PR (`#N` + status dot). Clicking
 * opens an upward popover listing every open PR in the repo (from the
 * pr-store's 7s prList poll) — number, title, draft badge, conflict
 * dot, per-row external-open. Selection is owned by BranchStrip.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink } from "lucide-react";
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

  // Chip dot — the detailed PRStatus drives it once loaded; until then
  // fall back to the prList entry so a draft still reads gray (not the
  // "unknown" low-gray) during the first detail-poll window.
  const selectedRepo = openPrs.find(p => p.number === selectedNumber) ?? null;
  const dotColor = selectedStatus
    ? prIconColor(selectedStatus)
    : selectedRepo
      ? (selectedRepo.isDraft ? DRAFT_DOT : "rgb(64,180,120)")
      : "var(--c-low)";

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
        title={`${openPrs.length} open PR${openPrs.length > 1 ? "s" : ""} — click to switch`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "2px 7px", borderRadius: 6,
          background: "rgba(var(--fg-rgb), 0.04)",
          border: "1px solid var(--c-brd, rgba(127,127,127,0.18))",
          color: "var(--c-fg)", cursor: "pointer",
          fontSize: 11.5, fontWeight: 500, fontFamily: "var(--font-mono)",
          outline: "none",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: dotColor, flexShrink: 0 }} />
        #{selectedNumber}
        <ChevronDown size={10} strokeWidth={2.25} style={{
          opacity: 0.7,
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
