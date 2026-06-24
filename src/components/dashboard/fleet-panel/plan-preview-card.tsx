/**
 * Plan preview — shows the Haiku-planned routing of a goal across existing
 * agents (one row per dispatch: agent → task). The user drops any rows they
 * don't want, then approves with "Dispatch all". An empty plan renders the
 * planner's summary as guidance and offers no confirm button.
 */
import { useState } from "react";
import { X, ArrowRight } from "lucide-react";
import type { PlanDispatch } from "@/lib/api";

export function PlanPreviewCard({ dispatches, summary, onConfirm, onCancel, titleFor }: {
  dispatches: PlanDispatch[];
  summary: string;
  onConfirm: (dispatches: PlanDispatch[]) => void;
  onCancel: () => void;
  titleFor: (targetId: string) => string;
}) {
  const [rows, setRows] = useState(dispatches);
  const empty = rows.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 9 }}>
      {summary && (
        <div style={{ fontSize: 11.5, color: "var(--c-med)", lineHeight: 1.4 }}>{summary}</div>
      )}
      {rows.map((r, i) => (
        <div
          key={`${r.target_id}-${i}`}
          style={{
            display: "flex", gap: 7, alignItems: "flex-start",
            padding: "6px 8px", background: "var(--c-srf)",
            border: "1px solid var(--c-brd)", borderRadius: 6,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--c-high)" }}>{titleFor(r.target_id)}</div>
            <div style={{ fontSize: 11.5, color: "var(--c-low)", lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.task}</div>
          </div>
          <button
            aria-label="Remove dispatch"
            onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--c-ghost)", padding: 2, flexShrink: 0 }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        {!empty && (
          <button
            onClick={() => onConfirm(rows)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "5px 11px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              color: "var(--c-high)", background: "var(--c-srf2)",
              border: "1px solid var(--c-brd2)", cursor: "pointer", fontFamily: "inherit",
            }}
          >
            <ArrowRight size={11} strokeWidth={2} /> Dispatch all ({rows.length})
          </button>
        )}
        <button
          onClick={onCancel}
          style={{
            padding: "5px 11px", borderRadius: 6, fontSize: 12, color: "var(--c-med)",
            background: "transparent", border: "1px solid var(--c-brd)",
            cursor: "pointer", fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
