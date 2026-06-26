/**
 * PrChecksPopover — per-check breakdown shown when the CI ring is clicked.
 *
 * Floats above the ring (the strip sits at the bottom of the composer) and
 * dismisses on click-outside / Esc, mirroring {@link AuthChoicePopover}. Each
 * row links out to the check's page on GitHub. Purely presentational: the
 * caller owns open/close state and supplies the (already-normalized) runs.
 */
import { useEffect, useRef } from "react";
import { Check, X, Loader2, ExternalLink } from "lucide-react";
import type { CSSProperties } from "react";
import type { CheckRun } from "@/lib/git-api";
import type { ChecksSummary } from "./pr-checks-indicator";

interface Props {
  runs: CheckRun[];
  summary: ChecksSummary;
  /** One-line reason the merge is held up (from the merge gate), if any. */
  blockedReason?: string | null;
  onOpenCheck: (url: string) => void;
  onDismiss: () => void;
}

function RowIcon({ bucket }: { bucket: CheckRun["bucket"] }) {
  if (bucket === "failing") return <X size={12} style={{ color: "var(--c-err)", flexShrink: 0 }} />;
  if (bucket === "pending")
    return (
      <Loader2
        size={12}
        style={{ color: "var(--c-med)", flexShrink: 0, animation: "spin 1.2s linear infinite" }}
      />
    );
  return <Check size={12} style={{ color: "var(--c-med)", flexShrink: 0 }} />;
}

const panel: CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  right: 0,
  zIndex: 50,
  width: 280,
  maxHeight: 320,
  display: "flex",
  flexDirection: "column",
  background: "var(--c-srf)",
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
  overflow: "hidden",
  // left-align text inside an otherwise right-anchored popover
  textAlign: "left",
};

export function PrChecksPopover({ runs, summary, blockedReason, onOpenCheck, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);

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

  const summaryLine =
    [
      summary.passing ? `${summary.passing} passed` : null,
      summary.failing ? `${summary.failing} failing` : null,
      summary.pending ? `${summary.pending} running` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "No checks";

  return (
    <div ref={ref} role="dialog" aria-label="CI checks" style={panel}>
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--c-brd)",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-fg)" }}>{summaryLine}</span>
        {blockedReason ? (
          <span style={{ fontSize: 11, color: "var(--c-err)" }}>{blockedReason}</span>
        ) : null}
      </div>

      <div style={{ overflowY: "auto", padding: 4 }}>
        {runs.length === 0 ? (
          <div style={{ padding: "8px 8px", fontSize: 11.5, color: "var(--c-dim)" }}>
            No individual checks reported.
          </div>
        ) : (
          runs.map((r, i) => {
            const clickable = !!r.url;
            return (
              <button
                key={`${r.name}-${i}`}
                type="button"
                onClick={() => r.url && onOpenCheck(r.url)}
                disabled={!clickable}
                title={clickable ? `Open “${r.name}” on GitHub` : r.name}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 6,
                  cursor: clickable ? "pointer" : "default",
                  color: "var(--c-fg)",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (clickable) e.currentTarget.style.background = "var(--c-ghost)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
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
                  }}
                >
                  {r.name}
                </span>
                {clickable ? (
                  <ExternalLink size={11} strokeWidth={1.85} style={{ color: "var(--c-dim)", flexShrink: 0 }} />
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
