/**
 * Shared visual primitives for the General settings cards.
 *
 * Each card (startup, notifications, updates, privacy, attribution)
 * renders a `CardShell` wrapping one or more `Row`s with a `Toggle` (or
 * other control) on the right. Keeping the primitives co-located here
 * means adding a new General card stays a one-import affair and the
 * cards stay visually identical without copy/paste drift.
 */

export function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      borderRadius: 10, border: "1px solid var(--c-brd)",
      background: "var(--card)", overflow: "hidden", marginBottom: 22,
    }}>{children}</div>
  );
}

export function Row({ title, desc, children, last, disabled }: {
  title: string; desc?: string; children?: React.ReactNode; last?: boolean; disabled?: boolean;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "13px 14px", gap: 16,
      borderBottom: last ? "none" : "1px solid var(--c-brd)",
      opacity: disabled ? 0.55 : 1,
      pointerEvents: disabled ? "none" : "auto",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--c-high)", lineHeight: 1.3 }}>
          {title}
        </div>
        {desc && (
          <div style={{ fontSize: 12, color: "var(--c-low)", marginTop: 3, lineHeight: 1.5 }}>
            {desc}
          </div>
        )}
      </div>
      {children && <div style={{ flexShrink: 0 }}>{children}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, label }: {
  on: boolean; onChange: () => void;
  /** Accessible name — usually the row title, so screen readers announce what the switch controls. */
  label?: string;
}) {
  return (
    <button
      onClick={onChange}
      role="switch" aria-checked={on} aria-label={label}
      style={{
        width: 36, height: 21, borderRadius: 999, padding: 0, position: "relative",
        border: `1px solid ${on ? "transparent" : "var(--c-brd)"}`, cursor: "pointer", flexShrink: 0,
        background: on ? "rgb(64,180,120)" : "var(--c-srf2)",
        transition: "background 0.18s", outline: "none",
      }}>
      <span style={{
        position: "absolute", top: 2, left: on ? 17 : 2,
        width: 15, height: 15, borderRadius: "50%",
        background: on ? "#fff" : "var(--c-ghost)",
        boxShadow: on ? "0 1px 2px rgba(0,0,0,0.2)" : "none",
        transition: "left 0.18s cubic-bezier(0.4,0,0.2,1), background 0.18s",
      }} />
    </button>
  );
}
