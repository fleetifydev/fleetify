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

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        margin: "8px 2px",
        fontSize: 12.5,
        fontWeight: 450,
        letterSpacing: "-0.015em",
        color: "rgba(96,165,250,0.9)",
      }}
    >
      {/* Glowing Fleetify mark — the same node the live "thinking" indicator
          uses, keyed to compaction's soft-blue. */}
      <LogoMark
        size={13}
        glow
        style={{ flexShrink: 0, color: "rgba(96,165,250,0.95)" }}
      />
      {/* Shimmer label. .status-sheen keeps currentColor (so it stays
          soft-blue) while a bright band sweeps across — the animated
          "thinking" feel, without hard-coding the ghost/high tones. */}
      <span
        className="status-sheen"
        data-label={label}
        style={{
          color: "rgba(96,165,250,0.92)",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--font-sans)",
          letterSpacing: "-0.01em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {/* Progress group — bar + percent, pushed to the right edge. */}
      <span
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        {/* Live progress bar — fills as the summariser streams tokens. */}
        <span
          aria-hidden
          style={{
            position: "relative",
            display: "inline-block",
            width: 80,
            height: 4,
            borderRadius: 2,
            background: "rgba(96,165,250,0.18)",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              position: "absolute",
              insetBlock: 0,
              left: 0,
              width: `${pct}%`,
              background: "rgba(96,165,250,0.9)",
              borderRadius: 2,
              transition: "width 180ms ease-out",
            }}
          />
        </span>
        <span
          style={{
            fontFamily:
              "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
            fontSize: 11,
            color: "rgba(96,165,250,0.92)",
            minWidth: 30,
            textAlign: "right",
          }}
        >
          {pct}%
        </span>
        {elapsedSec >= 2 && (
          <span
            style={{
              fontFamily:
                "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
              fontSize: 11,
              color: "var(--c-ghost)",
            }}
          >
            {elapsedSec}s
          </span>
        )}
      </span>
    </div>
  );
}
