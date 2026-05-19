/**
 * Fleet decision card — surfaces what the co-pilot thinks should
 * happen next after the agent finishes a turn.
 *
 * Three shapes depending on the decision kind:
 *
 *  - continue → "Fleet's next prompt is X" with [Send] [Edit] [Skip]
 *  - ask      → "Fleet has a question" with the question text +
 *               [Answer in chat] [Dismiss]
 *  - done     → "Fleet thinks this is complete" with [Mark complete]
 *               [Keep going]
 *
 * Renders inside chat-view's slotAbove, next to the permission
 * card. Pulls its decision out of fleet-store keyed by sessionId
 * so it stays scoped to the active session.
 */
import { useState } from "react";
import { Check, X, ChevronDown, ChevronUp, ArrowRight, MessageCircleQuestion } from "lucide-react";
import { useFleetStore, type FleetDecision } from "@/stores/fleet-store";

interface Props {
  sessionId: string;
  /** Called when user picks "Send" on a continue decision OR "Mark
   *  complete" — the chat-view turns this into an outgoing message
   *  (continue) or a no-op (done; the decision was already done). */
  onSend: (text: string) => void;
  /** Called when user picks "Answer in chat" — chat-view focuses
   *  the textarea and pre-fills it with the question. */
  onAnswer: (question: string) => void;
}

export function FleetDecisionCard({ sessionId, onSend, onAnswer }: Props) {
  const decision = useFleetStore(s => s.pendingForSession(sessionId));
  const resolveDecision = useFleetStore(s => s.resolveDecision);
  // Mode gate: manual sessions never show the decision card, even if a
  // stale decision survived in localStorage from a prior co-pilot run.
  // Subscribing reactively here means flipping the mode chip back to
  // manual instantly hides any pending card.
  const mode = useFleetStore(s => s.getSession(sessionId).mode);
  const [showWhy, setShowWhy] = useState(false);

  if (mode === "manual") return null;
  if (!decision) return null;

  const dismiss = () => resolveDecision(decision.id);

  // Tone colors per decision kind. Subtle — same nested-card surface
  // as the refine card, just different accent on the header chip.
  const accent = decision.kind === "continue" ? "rgba(96,165,250,0.95)"
              : decision.kind === "ask"      ? "rgba(251,146,60,0.95)"
              :                                "rgba(74,222,128,0.95)";

  const kindLabel = decision.kind === "continue" ? "Wants to continue"
                  : decision.kind === "ask"      ? "Needs your input"
                  :                                "Thinks it's done";

  return (
    <div style={{
      marginBottom: 8,
      padding: "10px 12px",
      background: "var(--c-srf)",
      border: "1px solid var(--c-brd)",
      borderRadius: 9,
      display: "flex", flexDirection: "column", gap: 8,
      animation: "fleet-pane-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) both",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 11.5,
      }}>
        <span style={{
          fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
          fontSize: 11, fontWeight: 700,
          letterSpacing: "-0.005em",
          color: "var(--c-high)",
        }}>Fleet</span>
        <span style={{
          fontSize: 10.5, fontWeight: 600,
          color: accent,
          letterSpacing: "0.02em",
        }}>· {kindLabel}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowWhy(v => !v)}
          title={showWhy ? "Hide reasoning" : "Show reasoning"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--c-ghost)",
            padding: "2px 4px", borderRadius: 4,
            fontSize: 10.5, fontFamily: "inherit",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
        >
          why
          {showWhy ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
        <button
          onClick={dismiss}
          title="Dismiss"
          style={{
            width: 18, height: 18, borderRadius: 4,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "none", border: "none", cursor: "pointer",
            color: "var(--c-ghost)",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-med)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--c-ghost)"; }}
        >
          <X size={11} />
        </button>
      </div>

      {/* Body — different layout per decision kind */}
      {decision.kind === "continue" && (
        <ContinueBody decision={decision} onSend={onSend} onDismiss={dismiss} />
      )}
      {decision.kind === "ask" && (
        <AskBody decision={decision} onAnswer={onAnswer} onDismiss={dismiss} />
      )}
      {decision.kind === "done" && (
        <DoneBody decision={decision} onDismiss={dismiss} />
      )}

      {showWhy && (
        <div style={{
          fontSize: 11, color: "var(--c-dim)",
          padding: "6px 8px",
          background: "var(--sidebar)",
          border: "1px solid var(--c-brd)",
          borderRadius: 6,
          lineHeight: 1.45,
        }}>
          {decision.reasoning}
        </div>
      )}
    </div>
  );
}

function ContinueBody({ decision, onSend, onDismiss }: {
  decision: FleetDecision;
  onSend: (text: string) => void;
  onDismiss: () => void;
}) {
  const nextPrompt = decision.nextPrompt ?? "";
  return (
    <>
      <div style={{
        fontSize: 13, lineHeight: 1.5,
        color: "var(--c-high)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {nextPrompt}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => { onSend(nextPrompt); onDismiss(); }}
          style={pillStyle("primary")}
          onMouseEnter={pillHover(true, "primary")}
          onMouseLeave={pillHover(false, "primary")}
        >
          <ArrowRight size={11} strokeWidth={2} />
          <span>Send this</span>
        </button>
        <button
          onClick={onDismiss}
          style={pillStyle("secondary")}
          onMouseEnter={pillHover(true, "secondary")}
          onMouseLeave={pillHover(false, "secondary")}
        >
          Skip
        </button>
      </div>
    </>
  );
}

function AskBody({ decision, onAnswer, onDismiss }: {
  decision: FleetDecision;
  onAnswer: (q: string) => void;
  onDismiss: () => void;
}) {
  const question = decision.question ?? "";
  return (
    <>
      <div style={{
        fontSize: 13, lineHeight: 1.5,
        color: "var(--c-high)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        display: "flex", alignItems: "flex-start", gap: 7,
      }}>
        <MessageCircleQuestion size={13} strokeWidth={2} style={{
          color: "rgba(251,146,60,0.95)", flexShrink: 0, marginTop: 2,
        }}/>
        <span>{question}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => { onAnswer(question); onDismiss(); }}
          style={pillStyle("primary")}
          onMouseEnter={pillHover(true, "primary")}
          onMouseLeave={pillHover(false, "primary")}
        >
          Answer below
        </button>
        <button
          onClick={onDismiss}
          style={pillStyle("secondary")}
          onMouseEnter={pillHover(true, "secondary")}
          onMouseLeave={pillHover(false, "secondary")}
        >
          Dismiss
        </button>
      </div>
    </>
  );
}

function DoneBody({ decision, onDismiss }: {
  decision: FleetDecision;
  onDismiss: () => void;
}) {
  const summary = decision.summary ?? decision.reasoning;
  return (
    <>
      <div style={{
        fontSize: 13, lineHeight: 1.5,
        color: "var(--c-high)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        display: "flex", alignItems: "flex-start", gap: 7,
      }}>
        <Check size={13} strokeWidth={2.4} style={{
          color: "rgba(74,222,128,0.95)", flexShrink: 0, marginTop: 2,
        }}/>
        <span>{summary}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={onDismiss}
          style={pillStyle("primary")}
          onMouseEnter={pillHover(true, "primary")}
          onMouseLeave={pillHover(false, "primary")}
        >
          Mark complete
        </button>
      </div>
    </>
  );
}

/* ── pill button helpers ─────────────────────────────────────── */

type PillTone = "primary" | "secondary";

function pillStyle(tone: PillTone): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "5px 11px", borderRadius: 6,
    fontSize: 12, fontWeight: tone === "primary" ? 600 : 500,
    color: tone === "primary" ? "var(--c-high)" : "var(--c-med)",
    background: tone === "primary" ? "var(--c-srf2)" : "transparent",
    border: `1px solid ${tone === "primary" ? "var(--c-brd2)" : "var(--c-brd)"}`,
    cursor: "pointer", fontFamily: "inherit",
    transition: "background 0.1s, color 0.1s, border-color 0.1s",
  };
}

function pillHover(enter: boolean, tone: PillTone) {
  return (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget as HTMLElement;
    if (enter) {
      el.style.background = tone === "primary" ? "var(--c-brd)" : "var(--c-srf)";
      if (tone === "secondary") el.style.color = "var(--c-high)";
    } else {
      el.style.background = tone === "primary" ? "var(--c-srf2)" : "transparent";
      if (tone === "secondary") el.style.color = "var(--c-med)";
    }
  };
}
