import { useEffect, useState } from "react";
import { LogoMark } from "@/components/brand/logo-mark";
import { useChatStore } from "@/stores/chat-store";

/** Inline compaction status — rendered between the messages list and the
 *  streaming preview while a /compact flow runs.
 *
 *  States:
 *    - running → a glowing Fleetify mark + a shimmer "Compacting
 *                conversation…" label (the same live-indicator treatment as
 *                the "thinking" status), with a live progress bar + percent
 *                pushed to the right edge.
 *    - failed  → inline "Compaction failed" + reason, in soft red.
 *    - done    → nothing. The pill hands off to the plain CompactSummaryCard
 *                (rendered from the persisted summary message), which is the
 *                single "Compacted successfully" surface — identical live and
 *                on reload — so the pill has nothing left to show.
 *
 *  No box, no border, no background — the inline text IS the status. The
 *  pill persists across re-renders until chat-input clears it on the next
 *  user send.
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

  if (!pill) return null;

  // Done hands off to the summary card below — nothing left to render here.
  if (pill.state === "done") return null;

  const elapsedSec = pill.endedAt
    ? Math.max(0, Math.round((pill.endedAt - pill.startedAt) / 1000))
    : Math.max(0, Math.round((Date.now() - pill.startedAt) / 1000));

  if (pill.state === "running") {
    const pct =
      typeof pill.pct === "number" ? Math.max(0, Math.min(100, pill.pct)) : 0;
    // Same string in the node and in data-label — the .status-sheen sweep
    // overlays a ::after whose content is attr(data-label).
    const label = "Compacting conversation…";
    return (
      <Line tone="active">
        {/* Glowing Fleetify mark — the same node the live "thinking"
            indicator uses, keyed to compaction's soft-blue. */}
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
          {elapsedSec >= 2 && <Elapsed>{elapsedSec}s</Elapsed>}
        </span>
      </Line>
    );
  }

  // state === "failed"
  return (
    <Line tone="error">
      Compaction failed
      {pill.error && <Detail>— {pill.error}</Detail>}
    </Line>
  );
}

/** Inline single-line status row. Mirrors the live-indicator typography so
 *  the rhythm of inline-status text across the chat surface stays uniform;
 *  color is the only thing that differentiates state. */
function Line({
  tone,
  children,
}: {
  tone: "active" | "error";
  children: React.ReactNode;
}) {
  const color =
    tone === "error"
      ? "rgba(248,113,113,0.85)" // soft red for "Compaction failed"
      : "rgba(96,165,250,0.9)"; // soft blue for "Compacting…"
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
        color,
      }}
    >
      {children}
    </div>
  );
}

function Elapsed({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
        fontSize: 11,
        color: "var(--c-ghost)",
      }}
    >
      {children}
    </span>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return <span style={{ opacity: 0.65, fontWeight: 400 }}>{children}</span>;
}
