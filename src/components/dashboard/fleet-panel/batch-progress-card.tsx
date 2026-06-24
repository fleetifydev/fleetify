/**
 * Batch progress — polls a running delegation batch and renders each dispatch's
 * status pill (queued / running / done / failed) with its summary or error.
 * Polling stops once the batch reports `done`. Visibility-aware like
 * `use-fleet-data` (no work while the tab is hidden).
 */
import { useEffect, useRef, useState } from "react";
import { getFleetBatch, type FleetBatch } from "@/lib/api";

const PILL: Record<string, string> = {
  queued: "var(--c-ghost)",
  running: "rgba(96,165,250,0.95)",
  done: "rgba(74,222,128,0.95)",
  failed: "rgba(248,113,113,0.95)",
};

export function BatchProgressCard({ batchId, pollMs = 2000 }: { batchId: string; pollMs?: number }) {
  const [batch, setBatch] = useState<FleetBatch | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    doneRef.current = false;

    const load = async () => {
      if (doneRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const b = await getFleetBatch(batchId);
        if (cancelled) return;
        setBatch(b);
        if (b.done) doneRef.current = true;
      } catch {
        /* transient — the next tick retries */
      }
    };

    load();
    const iv = setInterval(() => {
      if (!doneRef.current) load();
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [batchId, pollMs]);

  if (!batch) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
      {batch.dispatches.map((d, i) => (
        <div
          key={`${d.target_id}-${i}`}
          style={{
            display: "flex", gap: 7, alignItems: "flex-start",
            padding: "6px 8px", background: "var(--c-srf)",
            border: "1px solid var(--c-brd)", borderRadius: 6,
          }}
        >
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: 99, marginTop: 5, flexShrink: 0, background: PILL[d.status] ?? "var(--c-ghost)" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--c-high)" }}>
              {d.target_title}{" "}
              <span style={{ color: PILL[d.status], fontWeight: 500 }}>· {d.status}</span>
            </div>
            {(d.summary || d.error) && (
              <div style={{ fontSize: 11, color: d.error ? "rgba(248,113,113,0.9)" : "var(--c-low)", lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {d.error || d.summary}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
