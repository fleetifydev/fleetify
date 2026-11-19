import { type CSSProperties, useState } from "react";

/** One answer to a privacy question: its button's label, and what it turns
 *  the setting to. */
export interface ConsentChoice {
  label: string;
  enabled: boolean;
}

/* ── ConsentWidget — two-button answer to a privacy question ──
   Used for dashboard sync (keep it as it is or change it) and product
   analytics (off by default: opt in or not), in onboarding, and for
   dashboard sync in <DashboardSyncNotice>. Both buttons look the same, so
   neither answer is pushed; they show in the order given. The first click
   disables both and answers once — refusal is not a blocker.          */
export function ConsentWidget({
  choices,
  onChoice,
}: {
  choices: readonly [ConsentChoice, ConsentChoice];
  onChoice: (enabled: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pick = (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    onChoice(enabled);
  };
  const buttonStyle: CSSProperties = {
    padding: "9px 16px",
    borderRadius: 8,
    background: "var(--secondary)",
    color: "var(--c-high)",
    border: "1px solid rgba(255,255,255,0.08)",
    cursor: busy ? "default" : "pointer",
    fontSize: 13,
    fontWeight: 500,
    opacity: busy ? 0.6 : 1,
    transition: "all 0.2s ease",
  };
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginTop: 10,
        flexWrap: "wrap",
      }}
    >
      {choices.map((choice) => (
        <button
          key={choice.label}
          onClick={() => pick(choice.enabled)}
          disabled={busy}
          style={buttonStyle}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
