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

  // Tick every second while running so the 5-second elapsed step lands
  // promptly; the displayed value only changes on each 5s boundary.
  const [, force] = useState(0);
  useEffect(() => {
    if (!pill || pill.state !== "running") return;
    const id = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [pill?.state, pill?.startedAt, pill]);

  // Only the running state renders here.
  if (!pill || pill.state !== "running") return null;

  const elapsed = Math.max(0, Date.now() - pill.startedAt);
  const label = "Compacting conversation…";

  // Same row as the live "Thinking…" indicator: glowing Fleetify mark +
  // shimmer label + a soft elapsed time that steps every 5s (no percent).
  return (
    <div className="fade-in" style={{ margin: "8px 0", maxWidth: 640 }}>
      <div
        role="status"
        style={{
          display: "inline-flex", alignItems: "center", gap: 7,
        }}
      >
        <LogoMark size={13} glow style={{ flexShrink: 0, color: "var(--c-high)" }} />
        <span
          className="thinking-shimmer-text"
          data-label={label}
          style={{
            fontSize: 12, fontWeight: 500,
            fontFamily: "var(--font-sans)", letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {elapsed >= 5000 && (
          <span style={{
            fontSize: 9.5, color: "var(--c-ghost)", opacity: 0.5,
            fontFamily: "var(--font-mono)", letterSpacing: 0,
          }}>
            {fmtDuration(Math.floor(elapsed / 5000) * 5000)}
          </span>
        )}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
}
