import { createContext, useContext, type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowDownCircle } from "lucide-react";
import { useUpdateStore } from "@/stores/update-store";
import { usesInAppTitleBar } from "@/lib/utils";
import { WINDOWS_TITLEBAR_HEIGHT_PX } from "./window-controls";

/**
 * Offers the update the shell has downloaded and verified: Restart to
 * update installs it and restarts into it, and Later hides the banner until
 * another version is ready. Settings → General → Updates offers the same
 * restart. When an install fails, the shell usually keeps the update ready,
 * and the banner says why next to the same buttons. If the install task
 * itself dies, the status is failed, the update is gone and the banner goes;
 * the next check downloads it again.
 *
 * App mounts it once, outside its screen gates, so it shows on every screen
 * after the splash, signed in or not: a release that breaks sign-in can still
 * be updated away. While the main shell shows, the banner renders in the
 * place the shell gives it under its title bar (`slot`, from
 * UpdateBannerSlot), as an inset card next to the Keychain banner. On every
 * other screen the same card floats across the top of the window, under any
 * title bar: over the welcome, sign-in and onboarding screens, which centre
 * their content in the whole window, and over Settings and Library. It sits
 * above the page and below every dialog and menu.
 *
 * On macOS the card starts right of the traffic lights. As in the Keychain
 * banner, the only red is the icon: the reason is drawn in the text colour,
 * which keeps it readable in light mode.
 */
export function UpdateReadyBanner({ slot = null }: {
  /** The main shell's place for the banner, while the shell shows. */
  slot?: HTMLElement | null;
}): JSX.Element | null {
  const status = useUpdateStore(s => s.status);
  const dismissedVersion = useUpdateStore(s => s.dismissedVersion);
  const restartError = useUpdateStore(s => s.restartError);
  const restart = useUpdateStore(s => s.restart);
  const dismiss = useUpdateStore(s => s.dismiss);

  if (status?.state !== "ready" || status.version === dismissedVersion) return null;

  const card = (
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
        // Floating over a page, it needs a shadow to stand off it.
        ...(slot ? {} : { boxShadow: FLOATING_SHADOW, pointerEvents: "auto" }),
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

  if (slot) return createPortal(card, slot);
  return (
    <div
      style={{
        position: "fixed",
        top: usesInAppTitleBar() ? WINDOWS_TITLEBAR_HEIGHT_PX : 0,
        left: 0,
        right: 0,
        zIndex: FLOATING_Z_INDEX,
        // Only the card takes clicks; the strip around it stays the page's.
        pointerEvents: "none",
      }}
    >
      {card}
    </div>
  );
}

/** Lets the main shell hand App its place for the banner. */
export const UpdateBannerSlotContext = createContext<(slot: HTMLElement | null) => void>(() => {});

/**
 * The main shell's place for the update banner, under its title bar. App
 * mounts the banner itself, once, and renders it here while the shell shows.
 * The place adds no box of its own, so the banner lays out as if the shell
 * held it.
 */
export function UpdateBannerSlot(): JSX.Element {
  const register = useContext(UpdateBannerSlotContext);
  return <div ref={register} style={{ display: "contents" }} />;
}

/** Above the page (whose layers stay under 100) and below every dialog
 *  (100 and up) and menu (1000 and up). */
const FLOATING_Z_INDEX = 90;

/** The lighter half of the dialogs' shadow. */
const FLOATING_SHADOW = "0 4px 12px rgba(0,0,0,0.25)";

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
