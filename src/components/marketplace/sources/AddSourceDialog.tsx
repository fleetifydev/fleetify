/**
 * AddSourceDialog — match InstallDialog's recipe (var(--sidebar)
 * card, --c-high primary button paired with --card text, modal
 * scrim + pop animation) so both modals feel like one family.
 */
import { useState } from "react";
import { X } from "lucide-react";
import { usePluginStore } from "@/stores/plugin-store";

interface Props {
  onClose: () => void;
}

export function AddSourceDialog({ onClose }: Props) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addSource = usePluginStore(s => s.addSource);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addSource(url.trim(), name.trim() || undefined);
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        animation: "mp-modal-fade 0.16s ease-out both",
      }}
    >
      <style>{`
        @keyframes mp-modal-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes mp-modal-pop {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      <form
        onSubmit={onSubmit}
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--sidebar)",
          border: "1px solid var(--sidebar-border)",
          borderRadius: 12,
          padding: 22, width: "100%", maxWidth: 460,
          display: "flex", flexDirection: "column", gap: 16,
          boxShadow: "0 20px 50px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",
          animation: "mp-modal-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1) both",
          color: "var(--c-high)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <h2 style={{
            margin: 0, fontSize: 16, fontWeight: 600,
            color: "var(--c-high)", letterSpacing: "-0.01em",
          }}>
            Add marketplace
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              width: 24, height: 24, borderRadius: 5,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: "var(--c-dim)",
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--c-dim)"; }}
          >
            <X size={14} />
          </button>
        </div>

        <p style={{
          margin: 0, fontSize: 12, color: "var(--c-dim)",
          lineHeight: 1.55,
        }}>
          Paste a GitHub repository URL. Fleet auto-detects whether it's a
          multi-plugin marketplace or a single-plugin repo and adds it to your sources.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <FieldLabel>GitHub repo URL</FieldLabel>
          <Input
            type="url"
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={e => setUrl(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <FieldLabel>Display name (optional)</FieldLabel>
          <Input
            type="text"
            placeholder="Defaults to the marketplace's own name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>

        {error && (
          <div style={{
            padding: "8px 12px",
            background: "rgba(248,113,113,0.10)",
            border: "1px solid rgba(248,113,113,0.35)",
            borderRadius: 7, fontSize: 12, color: "#f87171",
          }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "7px 14px",
              background: "transparent",
              border: "1px solid var(--sidebar-border)",
              borderRadius: 7,
              color: "var(--c-med)",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 500,
              transition: "background 0.08s, color 0.08s",
            }}
            onMouseEnter={e => { if (busy) return; e.currentTarget.style.background = "var(--c-srf)"; e.currentTarget.style.color = "var(--c-high)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--c-med)"; }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !url.trim()}
            style={{
              padding: "7px 18px",
              background: "var(--c-high)",
              border: "none",
              borderRadius: 7,
              color: "var(--card)",
              cursor: busy ? "wait" : "pointer",
              fontSize: 12, fontWeight: 600,
              opacity: (busy || !url.trim()) ? 0.55 : 1,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={e => { if (!busy && url.trim()) e.currentTarget.style.opacity = "0.88"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = (busy || !url.trim()) ? "0.55" : "1"; }}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600,
      color: "var(--c-ghost)",
      textTransform: "uppercase",
      letterSpacing: "0.10em",
    }}>{children}</span>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: "100%", padding: "8px 12px",
        background: "var(--c-srf)",
        border: "1px solid var(--sidebar-border)",
        borderRadius: 7,
        color: "var(--c-high)",
        fontSize: 12.5,
        fontFamily: props.type === "url" ? "var(--font-mono)" : "inherit",
        outline: "none",
        boxSizing: "border-box",
        transition: "border-color 0.10s",
        ...(props.style ?? {}),
      }}
      onFocus={e => (e.currentTarget.style.borderColor = "var(--c-brd)")}
      onBlur={e => (e.currentTarget.style.borderColor = "var(--sidebar-border)")}
    />
  );
}
