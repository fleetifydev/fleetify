import { useEffect, useRef } from "react";

/* In-app confirm modal — replaces the OS-native window.confirm so the
   dialog matches the rest of the theme (dark surface, app font, app
   button shapes). Scrim-click and Escape both cancel; Enter confirms;
   the primary action focuses on open.

   Extracted from WorkflowsPage so any destructive surface (sidebar
   session delete, routine delete, …) shares one polished confirmation. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter")  { e.preventDefault(); onConfirm(); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel, onConfirm]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        animation: "rt-confirm-fade 0.16s ease-out both",
      }}
    >
      <style>{`
        @keyframes rt-confirm-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes rt-confirm-pop {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rt-confirm-title"
        style={{
          width: "100%", maxWidth: 380,
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 12,
          padding: 18,
          boxShadow: "0 20px 50px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",
          animation: "rt-confirm-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1) both",
          color: "var(--c-high)",
        }}
      >
        <h2
          id="rt-confirm-title"
          style={{
            margin: 0,
            fontSize: 14, fontWeight: 600,
            color: "var(--c-high)",
            letterSpacing: "-0.005em",
            lineHeight: 1.3,
          }}
        >{title}</h2>
        {message && (
          <p style={{
            margin: "6px 0 0",
            fontSize: 12, color: "var(--c-dim)",
            lineHeight: 1.5,
          }}>{message}</p>
        )}
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: 6,
          marginTop: 18,
        }}>
          <button onClick={onCancel} style={secondaryBtnStyle}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            style={destructive ? {
              ...pillBtnStyle,
              background: "rgba(248,113,113,0.16)",
              borderColor: "rgba(248,113,113,0.35)",
              color: "#fca5a5",
            } : pillBtnStyle}
            onMouseEnter={e => {
              if (destructive) e.currentTarget.style.background = "rgba(248,113,113,0.22)";
            }}
            onMouseLeave={e => {
              if (destructive) e.currentTarget.style.background = "rgba(248,113,113,0.16)";
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

const pillBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "5px 10px",
  background: "var(--c-srf2)",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-high)",
  fontSize: 11.5, fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "background 0.08s, border-color 0.08s",
  lineHeight: 1,
  height: 26,
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "5px 10px",
  background: "transparent",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-med)",
  fontSize: 11.5, fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "background 0.08s, color 0.08s",
  lineHeight: 1,
  height: 26,
};
