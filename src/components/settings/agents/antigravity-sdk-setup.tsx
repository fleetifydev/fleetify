import { Loader2, ExternalLink } from "lucide-react";
import { followLink } from "@/components/markdown-link";

interface Props {
  python: PythonRuntimeResult;
  sdkInstalled: boolean;
  installing: boolean;
  installError: string | null;
  onSetup: () => void;
}

const primaryBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--c-fg)",
  color: "var(--c-bg)",
  border: "none",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const linkBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "transparent",
  color: "var(--c-link, #4F8AFF)",
  border: "1px solid var(--c-brd)",
  textDecoration: "none",
  fontSize: 12,
  fontWeight: 500,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  width: "fit-content",
};

/** Where the "Download Python" link goes. */
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";

/**
 * Shared Setup affordance for the Antigravity SDK provider, rendered
 * in both Settings → Agents (agent-card.tsx) and the onboarding verify
 * panel. Three mutually-exclusive states:
 *
 *   1. Python missing  → "Python required" pill + Download Python link.
 *   2. Python present, SDK missing → [Setup] button.
 *   3. SDK installed   → render nothing (parent owns the auth/done UX).
 */
export function AntigravitySdkSetupRow({
  python,
  sdkInstalled,
  installing,
  installError,
  onSetup,
}: Props) {
  if (sdkInstalled) return null;

  if (!python.installed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            borderRadius: 999,
            background: "rgba(248,113,113,0.12)",
            color: "rgb(248,113,113)",
            fontSize: 11,
            fontWeight: 500,
            width: "fit-content",
          }}
        >
          ⚠ Python required
        </div>
        <div style={{ fontSize: 11.5, color: "var(--c-dim)" }}>
          The Antigravity SDK runs on a Python sidecar. Install Python 3.10+
          first, then click Setup.
        </div>
        <a
          href={PYTHON_DOWNLOAD_URL}
          rel="noreferrer"
          onClick={(e) => followLink(e, PYTHON_DOWNLOAD_URL)}
          style={linkBtn}
        >
          Download Python <ExternalLink size={11} />
        </a>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11.5, color: "var(--c-dim)" }}>
        Python {python.version ?? ""} detected. Setup installs{" "}
        <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
          google-antigravity
        </code>{" "}
        into your user site-packages.
      </div>
      <button
        type="button"
        onClick={onSetup}
        disabled={installing}
        style={{
          ...primaryBtn,
          width: "100%",
          justifyContent: "center",
          opacity: installing ? 0.6 : 1,
          fontFamily: "inherit",
        }}
      >
        {installing ? (
          <>
            <Loader2 size={12} className="spin" /> Installing…
          </>
        ) : (
          "Setup"
        )}
      </button>
      {installError && (
        <div style={{ fontSize: 11, color: "rgb(248,113,113)" }}>{installError}</div>
      )}
    </div>
  );
}
