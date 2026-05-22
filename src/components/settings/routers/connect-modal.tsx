import { useState } from "react";
import { ExternalLink } from "lucide-react";

interface ExtraField {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

interface Props {
  routerId: string;
  routerName: string;
  docsUrl?: string;
  extraFields?: ExtraField[];
  onClose: () => void;
  onSubmit: (secret: string, metadata: Record<string, unknown>) => Promise<boolean>;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const dialogStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--c-brd)",
  borderRadius: 10,
  padding: "20px 22px",
  width: "100%",
  maxWidth: 440,
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "var(--c-srf2)",
  border: "1px solid var(--c-brd)",
  borderRadius: 6,
  fontSize: 12.5,
  color: "var(--c-high)",
  fontFamily: "inherit",
  boxSizing: "border-box",
  outline: "none",
};

const submitBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "7px 14px",
  borderRadius: 7,
  background: "var(--c-fg)",
  border: "1px solid var(--c-fg)",
  color: "var(--card, #0d0d0d)",
  cursor: "pointer",
  fontWeight: 600,
  fontFamily: "inherit",
};

const cancelBtn: React.CSSProperties = {
  fontSize: 12.5,
  padding: "7px 12px",
  borderRadius: 7,
  background: "transparent",
  border: "1px solid var(--c-brd)",
  color: "var(--c-high)",
  cursor: "pointer",
  fontFamily: "inherit",
};

export function ConnectModal({
  routerId,
  routerName,
  docsUrl,
  extraFields = [],
  onClose,
  onSubmit,
}: Props) {
  const [secret, setSecret] = useState("");
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const ok = await onSubmit(secret, metadata);
    if (ok) {
      onClose();
    } else {
      setError("Connection failed");
      setSubmitting(false);
    }
  };

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      data-testid={`router-connect-modal-${routerId}`}
    >
      <div style={dialogStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14.5, fontWeight: 600, color: "var(--c-high)", margin: 0 }}>
            Connect {routerName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--c-dim)",
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11.5,
              color: "#60a5fa",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            Where to find your API key <ExternalLink size={11} />
          </a>
        )}
        <input
          type="password"
          style={{ ...inputStyle, marginTop: 14 }}
          placeholder="API Key"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoFocus
          data-testid={`router-secret-${routerId}`}
        />
        {extraFields.map((f) => (
          <input
            key={f.name}
            type="text"
            style={{ ...inputStyle, marginTop: 8 }}
            placeholder={f.placeholder || f.label}
            value={metadata[f.name] || ""}
            onChange={(e) =>
              setMetadata((m) => ({ ...m, [f.name]: e.target.value }))
            }
            data-testid={`router-field-${routerId}-${f.name}`}
          />
        ))}
        {error && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: "#fca5a5" }}>
            {error}
          </div>
        )}
        <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" style={cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={{
              ...submitBtn,
              opacity: !secret || submitting ? 0.5 : 1,
              cursor: !secret || submitting ? "not-allowed" : "pointer",
            }}
            disabled={!secret || submitting}
            onClick={submit}
            data-testid={`router-submit-${routerId}`}
          >
            {submitting ? "Connecting…" : "Connect & Validate"}
          </button>
        </div>
      </div>
    </div>
  );
}
