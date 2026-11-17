/**
 * PrChecksPopover — per-check breakdown shown when the CI ring is clicked.
 *
 * Floats above the ring and dismisses on click-outside / Esc. Green ✓ / red ✗ /
 * spinner read the state at a glance, and EVERY row carries a visible ↗ to its
 * page on GitHub — passing and running checks are just as worth opening as red
 * ones, and a hover-only glyph read as "not clickable". Runs GitHub reports
 * without a `detailsUrl` (queued ones often lack it) fall back to the PR's own
 * checks tab, as does the footer action, so there is always a way out to CI.
 * A failure that GitHub reports as re-runnable swaps its glyph for a re-run
 * control (the row still opens the check), and a bulk "Re-run failed checks"
 * sits above the escape hatch when there is anything to re-run.
 * The merge-block reason lives on the Merge button, so the popover stays
 * focused on the checks themselves. Purely presentational — the caller owns
 * open/close and supplies the (already normalized) runs.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { claimEscape } from "@/hooks/use-escape-to-stop";
import { Check, X, Loader2, ExternalLink, RotateCw } from "lucide-react";
import type { CSSProperties } from "react";
import type { CheckRun } from "@/lib/git-api";
import type { ChecksSummary } from "./pr-checks-indicator";

/** The app's established status green (matches pr-switcher-chip / sandbox). */
const GREEN = "rgb(64,180,120)";

interface Props {
  runs: CheckRun[];
  summary: ChecksSummary;
  /** The PR's checks tab (`<pr-url>/checks`). Target of the footer action and
   *  the fallback for runs GitHub reported without a link of their own. Absent
   *  → both degrade to nothing rather than to a broken link. */
  prChecksUrl?: string | null;
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

export function PrChecksPopover({
  runs,
  summary,
  prChecksUrl = null,
  onOpenCheck,
  onDismiss,
  onRerunCheck,
  onRerunFailed,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // -1 is the footer action; 0..n-1 are the check rows.
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claim the key so closing this does nothing else: no stop, no back
      // to Fleet, no permission deny. This document listener runs before
      // those window ones.
      claimEscape(e);
      onDismiss();
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

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
        {runs.length === 0 ? (
          <div style={{ padding: "7px 9px", fontSize: 11.5, color: "var(--c-dim)" }}>
            No individual checks reported.
          </div>
        ) : (
          runs.map((r, i) => {
            // Own link when GitHub gave one, else the PR's checks tab — a
            // queued run with no `detailsUrl` should still take you to CI.
            const target = r.url ?? prChecksUrl;
            const clickable = !!target;
            const hovered = hover === i;
            const canRerun = r.bucket === "failing" && !!r.rerunnable && !!onRerunCheck;
            return (
              <div
                key={`${r.name}-${i}`}
                // A div, not a button: the row hosts the re-run button and
                // nesting buttons is invalid HTML. Keyboard affordances are
                // therefore explicit.
                role="button"
                tabIndex={clickable ? 0 : -1}
                onClick={() => target && onOpenCheck(target)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && target) {
                    e.preventDefault();
                    onOpenCheck(target);
                  }
                }}
                title={
                  r.url
                    ? `Open “${r.name}” on GitHub`
                    : clickable
                      ? `“${r.name}” has no direct link yet — open the PR's checks on GitHub`
                      : r.name
                }
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
                {/* A re-runnable failure offers the re-run control instead of
                    the link glyph — the row itself still opens the check. */}
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
                  // Always visible — dim at rest, brighter on hover. Hiding it
                  // until hover made passing/running rows read as inert.
                  <ExternalLink
                    size={11}
                    strokeWidth={1.85}
                    style={{
                      color: hovered ? "var(--c-med)" : "var(--c-dim)",
                      flexShrink: 0,
                      opacity: hovered ? 0.95 : 0.45,
                      transition: "opacity 0.12s, color 0.12s",
                    }}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* Primary footer action when something failed and can be re-run. */}
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

      {/* Footer escape hatch — one always-present way to the CI pages, whatever
          the checks are doing. Covers the cases the rows can't: no runs
          reported at all, or a run list that outgrew the scroll box. */}
      {prChecksUrl ? (
        <button
          type="button"
          onClick={() => onOpenCheck(prChecksUrl)}
          onMouseEnter={() => setHover(-1)}
          onMouseLeave={() => setHover((h) => (h === -1 ? null : h))}
          title="Open this PR's checks tab on GitHub"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "7px 12px",
            borderTop: "1px solid var(--c-brd)",
            borderLeft: "none",
            borderRight: "none",
            borderBottom: "none",
            background: hover === -1 ? "var(--c-ghost)" : "transparent",
            color: hover === -1 ? "var(--c-high)" : "var(--c-med)",
            font: "inherit",
            fontSize: 11.5,
            fontWeight: 500,
            textAlign: "left",
            cursor: "pointer",
            transition: "background 0.1s, color 0.12s",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>Open checks on GitHub</span>
          <ExternalLink
            size={11}
            strokeWidth={1.85}
            style={{ flexShrink: 0, opacity: hover === -1 ? 0.95 : 0.55 }}
          />
        </button>
      ) : null}
    </div>
  );
}
