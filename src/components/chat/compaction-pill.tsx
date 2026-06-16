import { useEffect, useState } from "react";
import { LogoMark } from "@/components/brand/logo-mark";
import { useChatStore } from "@/stores/chat-store";

/** Inline compaction status — rendered between the messages list and the
 *  streaming preview while a /compact flow runs. It renders ONLY the running
 *  state: a glowing Fleetify mark + a shimmer "Compacting conversation…"
 *  label (the same live-indicator treatment as the "thinking" status), with
 *  a live progress bar + percent pushed to the right edge.
 *
 *  Everything else hands off: done → the plain CompactSummaryCard (the
 *  persisted summary message), and failures are cleared + surfaced through
 *  the shared <ChatError> like every other in-chat error. So once compaction
 *  leaves the running state, the pill has nothing to show.
 *
 *  No box, no border, no background — the inline text IS the status.
 */
export function CompactionPill({ sessionId }: { sessionId: string }) {
  const pill = useChatStore(s => s.sessions[sessionId]?.compactionPill ?? null);

  // Tick once a second while running so the elapsed-seconds suffix stays
  // current without re-rendering at 60Hz.
  const [, force] = useState(0);
  useEffect(() => {
    if (!pill || pill.state !== "running") return;
    const id = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [pill?.state, pill?.startedAt, pill]);

  // Only the running state renders here.
  if (!pill || pill.state !== "running") return null;

  const elapsedSec = Math.max(
    0,
    Math.round((Date.now() - pill.startedAt) / 1000),
  );
  const pct =
    typeof pill.pct === "number" ? Math.max(0, Math.min(100, pill.pct)) : 0;
  // Same string in the node and in data-label — the .status-sheen sweep
  // overlays a ::after whose content is attr(data-label).
  const label = "Compacting conversation…";

  const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, monospace)";

  return (
    <div
      role="status"
      className="fade-in"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "8px 2px",
      }}
    >
      {/* Plain Fleetify mark — its natural colour, no accent/glow. The shimmer
          label carries the live "working" motion. */}
      <LogoMark size={14} style={{ flexShrink: 0 }} />
      {/* Shimmer label — neutral foreground with a bright band sweeping across
          (same .status-sheen as the "thinking" indicator). Monochrome. */}
      <span
        className="status-sheen"
        data-label={label}
        style={{
          // Dim base so the .status-sheen sweep (a band toward --c-high) reads
          // as a clear travelling glow across the label.
          color: "var(--c-low)",
          fontSize: 12.5,
          fontWeight: 550,
          fontFamily: "var(--font-sans)",
          letterSpacing: "-0.01em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {/* Progress — a soft middot separator + percent, with the elapsed time
          trailing even softer. The middot ties it to the label so it reads as
          one quiet status line, not a bare numeric readout. */}
      <span
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexShrink: 0,
          fontFamily: MONO,
          fontSize: 11,
        }}
      >
        <span aria-hidden style={{ color: "var(--c-ghost)" }}>·</span>
        <span style={{ color: "var(--c-dim)", fontVariantNumeric: "tabular-nums" }}>
          {pct}%
        </span>
        {elapsedSec >= 2 && (
          <span style={{ color: "var(--c-ghost)", fontSize: 10.5 }}>
            {elapsedSec}s
          </span>
        )}
      </span>
    </div>
  );
}
