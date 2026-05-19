import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";

/** Inline compaction status — rendered between the messages list and the
 *  streaming preview while a /compact flow runs. Matches the typography
 *  of the "Thinking…" idle status (size 12.5, weight 450) so the rhythm
 *  of inline-status text across the chat surface stays uniform, but the
 *  tone is keyed to the state: soft blue while running, soft green on
 *  success, soft red on failure. No box, no border, no background — the
 *  inline text IS the status.
 *
 *  States:
 *    - running → spinner + "Compacting..." (+ elapsed seconds after 2s)
 *    - done    → "Compacted" in green (+ dim · pre→post chars if known)
 *    - failed  → "Compact failed" + reason in dim red
 *
 *  The pill persists across re-renders until chat-input clears it on
 *  the next user send so the success state stays visible briefly.
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

  const elapsedSec = pill.endedAt
    ? Math.max(0, Math.round((pill.endedAt - pill.startedAt) / 1000))
    : Math.max(0, Math.round((Date.now() - pill.startedAt) / 1000));

  if (pill.state === "running") {
    return (
      <Line tone="active">
        <Loader2
          size={12}
          aria-hidden
          style={{
            flex: "none",
            // Manual rotation so we don't depend on a tailwind preset; matches
            // the soft-blue text color.
            animation: "compaction-spin 0.9s linear infinite",
          }}
        />
        <style>{`@keyframes compaction-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }`}</style>
        <span>Compacting conversation...</span>
        {elapsedSec >= 2 && (
          <Elapsed>{elapsedSec}s</Elapsed>
        )}
      </Line>
    );
  }

  if (pill.state === "failed") {
    return (
      <Line tone="error">
        Compact failed
        {pill.error && (
          <Detail>— {pill.error}</Detail>
        )}
      </Line>
    );
  }

  // state === "done"
  const hasChars =
    typeof pill.preChars === "number" && typeof pill.postChars === "number"
    && pill.preChars > 0;
  const charDetail = hasChars
    ? ` · ${fmtChars(pill.preChars!)} → ${fmtChars(pill.postChars!)}`
    : null;

  return (
    <Line tone="success">
      Compacted
      {charDetail && <Detail>{charDetail}</Detail>}
    </Line>
  );
}

/** Inline single-line status row. Mirrors the "Thinking…" element's
 *  typography (size 12.5, weight 450, -0.015em letter-spacing) so the
 *  rhythm of inline-status text across the chat surface stays uniform.
 *  Color is the only thing that differentiates state. */
function Line({
  tone,
  children,
}: {
  tone: "active" | "success" | "error";
  children: React.ReactNode;
}) {
  const color =
    tone === "error"
      ? "rgba(248,113,113,0.85)"
      : tone === "success"
        ? "rgba(74,222,128,0.9)"      // soft green for "Compacted"
        : "rgba(96,165,250,0.9)";     // soft blue for "Compacting..."
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        margin: "6px 2px",
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
        marginLeft: 2,
      }}
    >
      {children}
    </span>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ opacity: 0.65, fontWeight: 400 }}>
      {children}
    </span>
  );
}

function fmtChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M chars`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k chars`;
  return `${n} chars`;
}
