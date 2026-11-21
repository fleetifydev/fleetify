import type { CSSProperties, JSX } from "react";
import { AlertCircle, ArrowDownCircle } from "lucide-react";
import { useUpdateStore } from "@/stores/update-store";
import { usesInAppTitleBar } from "@/lib/utils";

/**
 * Offers the update the shell has downloaded and verified: Restart to
 * update installs it and restarts into it, and Later hides the banner until
 * another version is ready. Settings → General → Updates offers the same
 * restart. When an install fails, the shell usually keeps the update ready,
 * and the banner says why next to the same buttons. If the install task
 * itself dies, the status is failed, the update is gone and the banner goes;
 * the next check downloads it again.
 *
 * Mounted at the top of AppShell next to <KeychainWarningBanner>, as the
 * same inset card; on macOS it starts right of the traffic lights. As there,
 * the only red is the icon: the reason is drawn in the text colour, which
 * keeps it readable in light mode.
 */
export function UpdateReadyBanner(): JSX.Element | null {
  const status = useUpdateStore(s => s.status);
  const dismissedVersion = useUpdateStore(s => s.dismissedVersion);
  const restartError = useUpdateStore(s => s.restartError);
  const restart = useUpdateStore(s => s.restart);
  const dismiss = useUpdateStore(s => s.dismiss);

  if (status?.state !== "ready" || status.version === dismissedVersion) return null;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexShrink: 0,
        margin: usesInAppTitleBar() ? "8px 8px 0" : "8px 8px 0 84px",
        padding: "6px 6px 6px 12px",
        borderRadius: 8,
        border: "1px solid var(--c-brd)",
        background: "var(--sidebar)",
      }}
    >
      {restartError
        ? <AlertCircle size={14} aria-hidden style={{ color: "var(--c-err)", flexShrink: 0 }} />
        : <ArrowDownCircle size={14} aria-hidden style={{ color: "var(--c-med)", flexShrink: 0 }} />}
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.5, color: "var(--c-high)" }}>
        {`Fleetify ${status.version} is ready to install.`}
        {restartError && (
          <span role="alert" style={{ marginLeft: 6, color: "var(--c-high)" }}>{restartError}</span>
        )}
      </span>
      <button type="button" onClick={() => void restart()} style={primaryStyle}>
        Restart to update
      </button>
      <button
        type="button"
        onClick={dismiss}
        style={secondaryStyle}
        onMouseEnter={e => {
          e.currentTarget.style.background = "var(--c-srf)";
          e.currentTarget.style.color = "var(--c-high)";
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--c-med)";
        }}
      >
        Later
      </button>
    </div>
  );
}

/** Secondary button, as in <ConfirmDialog> and <KeychainWarningBanner>. */
const secondaryStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 10px",
  height: 26,
  background: "transparent",
  border: "1px solid var(--sidebar-border)",
  borderRadius: 7,
  color: "var(--c-med)",
  fontSize: 11.5,
  fontWeight: 500,
  fontFamily: "inherit",
  lineHeight: 1,
  cursor: "pointer",
  transition: "background 0.08s, color 0.08s",
};

/** Primary button, as <ConfirmDialog>'s confirm. */
const primaryStyle: CSSProperties = {
  ...secondaryStyle,
  background: "var(--c-srf2)",
  color: "var(--c-high)",
  transition: "background 0.08s, border-color 0.08s",
};
