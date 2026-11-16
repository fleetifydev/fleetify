import type { CSSProperties, JSX } from "react";
import { AlertCircle } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { usesInAppTitleBar } from "@/lib/utils";

const MESSAGE =
  "Fleetify couldn't save your sign-in to the system keychain, so you'll need to sign in again next time. On Linux, install or unlock GNOME Keyring or KWallet to stay signed in.";

/**
 * Says up front that the sign-in will not survive a restart. The shell
 * emits `keychain-unavailable` when the OS keychain refuses the refresh
 * token (Linux without an unlocked Secret Service, or a dismissed unlock
 * prompt); src/lib/auth-events.ts turns that into the store's
 * `keychainWarning`. Sign-in keeps working for this session, but the next
 * launch starts signed out.
 *
 * Mounted at the top of AppShell, as an inset card like the sidebar and the
 * right panel. Like <ChatError>, the only red is the icon. On macOS there
 * is no in-app title bar, so the card starts right of the traffic lights
 * (the same 84px inset the page top bars use).
 */
export function KeychainWarningBanner(): JSX.Element | null {
  const show = useAppStore(s => s.keychainWarning);
  const setKeychainWarning = useAppStore(s => s.setKeychainWarning);

  if (!show) return null;

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
      <AlertCircle size={14} aria-hidden style={{ color: "var(--c-err)", flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.5, color: "var(--c-high)" }}>
        {MESSAGE}
      </span>
      <button
        type="button"
        onClick={() => setKeychainWarning(false)}
        style={dismissStyle}
        onMouseEnter={e => {
          e.currentTarget.style.background = "var(--c-srf)";
          e.currentTarget.style.color = "var(--c-high)";
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--c-med)";
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/** Secondary button, as in <ConfirmDialog>. */
const dismissStyle: CSSProperties = {
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
