/**
 * PrChecksPopover — per-check breakdown shown when the CI ring is clicked.
 *
 * Floats above the ring and dismisses on click-outside / Esc. Green ✓ / red ✗ /
 * spinner read the state at a glance; the ↗ to each check's GitHub page reveals
 * on row hover to keep the list calm. The merge-block reason lives on the Merge
 * button, so the popover stays focused on the checks themselves. Purely
 * presentational — the caller owns open/close and supplies the (already
 * normalized) runs.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Check, X, Loader2, ExternalLink, RotateCw } from "lucide-react";
import type { CSSProperties } from "react";
import type { CheckRun } from "@/lib/git-api";
import type { ChecksSummary } from "./pr-checks-indicator";

/** The app's established status green (matches pr-switcher-chip / sandbox). */
const GREEN = "rgb(64,180,120)";

interface Props {
  runs: CheckRun[];
  summary: ChecksSummary;
  onOpenCheck: (url: string) => void;
  onDismiss: () => void;
  /** Per-check re-run, fired for a failing + rerunnable row. Omit to hide the
   *  per-row controls. */
  onRerunCheck?: (run: CheckRun) => void;
  /** Bulk "Re-run failed checks". Omit to hide the footer action. */
  onRerunFailed?: () => void;
}

function RowIcon({ bucket }: { bucket: CheckRun["bucket"] }) {
  if (bucket === "passing")
    return <Check size={13} strokeWidth={2.5} style={{ color: GREEN, flexShrink: 0 }} />;
  if (bucket === "failing")
    return <X size={13} strokeWidth={2.5} style={{ color: "var(--c-err)", flexShrink: 0 }} />;
  return (
    <Loader2
      size={12}
      style={{ color: "var(--c-med)", flexShrink: 0, animation: "spin 1.2s linear infinite" }}
    />
  );
}

const panel: CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  right: 0,
  zIndex: 50,
  width: 256,
  maxHeight: 320,
  display: "flex",
  flexDirection: "column",
  background: "var(--popover, #161616)",
  border: "1px solid var(--c-brd)",
  borderRadius: 9,
  boxShadow: "0 -8px 28px rgba(0,0,0,0.42)",
  overflow: "hidden",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
};

export function PrChecksPopover({ runs, summary, onOpenCheck, onDismiss, onRerunCheck, onRerunFailed }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  // Coloured count summary — green passed · red failing · muted running.
  const segs: Array<{ t: string; c: string }> = [];
  if (summary.passing) segs.push({ t: `${summary.passing} passed`, c: GREEN });
  if (summary.failing) segs.push({ t: `${summary.failing} failing`, c: "var(--c-err)" });
  if (summary.pending) segs.push({ t: `${summary.pending} running`, c: "var(--c-med)" });

  // Failing checks that GitHub Actions can re-run (legacy statuses / external
  // CI aren't rerunnable) — gates both the per-row ↻ and the bulk footer.
  const failingRerunnable = runs.filter((r) => r.bucket === "failing" && r.rerunnable);

  return (
    <div ref={ref} role="dialog" aria-label="CI checks" style={panel}>
      <div
        style={{
          padding: "9px 12px",
          borderBottom: "1px solid var(--c-brd)",
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 11.5,
          fontWeight: 600,
        }}
      >
        {segs.length === 0 ? (
          <span style={{ color: "var(--c-dim)", fontWeight: 500 }}>No checks reported</span>
        ) : (
          segs.map((s, i) => (
            <Fragment key={s.t}>
              {i > 0 && <span style={{ color: "var(--c-ghost)", fontWeight: 400 }}>·</span>}
              <span style={{ color: s.c }}>{s.t}</span>
            </Fragment>
          ))
        )}
      </div>

      <div style={{ overflowY: "auto", padding: 4 }}>
        {runs.length === 0 ? (
          <div style={{ padding: "7px 9px", fontSize: 11.5, color: "var(--c-dim)" }}>
            No individual checks reported.
          </div>
        ) : (
          runs.map((r, i) => {
            const clickable = !!r.url;
            const hovered = hover === i;
            const canRerun = r.bucket === "failing" && !!r.rerunnable && !!onRerunCheck;
            return (
              <div
                key={`${r.name}-${i}`}
                role="button"
                tabIndex={clickable ? 0 : -1}
                onClick={() => r.url && onOpenCheck(r.url)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && r.url) {
                    e.preventDefault();
                    onOpenCheck(r.url);
                  }
                }}
                title={clickable ? `Open “${r.name}” on GitHub` : r.name}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "6px 9px",
                  background: hovered && clickable ? "var(--c-ghost)" : "transparent",
                  border: "none",
                  borderRadius: 6,
                  cursor: clickable ? "pointer" : "default",
                  color: "var(--c-fg)",
                  textAlign: "left",
                  transition: "background 0.1s",
                }}
              >
                <RowIcon bucket={r.bucket} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                    color: r.bucket === "pending" ? "var(--c-med)" : "var(--c-high)",
                  }}
                >
                  {r.name}
                </span>
                {canRerun ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRerunCheck!(r);
                    }}
                    aria-label={`Re-run ${r.name}`}
                    title={`Re-run “${r.name}”`}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 2,
                      borderRadius: 4,
                      color: "var(--c-dim)",
                      cursor: "pointer",
                      display: "flex",
                      flexShrink: 0,
                      opacity: hovered ? 0.9 : 0.5,
                      transition: "opacity 0.12s",
                    }}
                  >
                    <RotateCw size={11} strokeWidth={2} />
                  </button>
                ) : clickable ? (
                  <ExternalLink
                    size={11}
                    strokeWidth={1.85}
                    style={{
                      color: "var(--c-dim)",
                      flexShrink: 0,
                      opacity: hovered ? 0.8 : 0,
                      transition: "opacity 0.12s",
                    }}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {onRerunFailed && failingRerunnable.length > 0 ? (
        <button
          type="button"
          onClick={onRerunFailed}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "8px 12px",
            borderTop: "1px solid var(--c-brd)",
            background: "transparent",
            border: "none",
            color: "var(--c-high)",
            font: "inherit",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--c-ghost)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <RotateCw size={12} strokeWidth={2} />
          Re-run failed checks
        </button>
      ) : null}
    </div>
  );
}
