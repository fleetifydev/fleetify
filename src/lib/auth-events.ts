import { useAppStore } from "@/stores/app-store";

/** Payload of the shell's `fleet:auth-event` (src-tauri/src/shell/auth.rs). */
export interface AuthEvent {
  kind: string;
  [k: string]: unknown;
}

export interface AuthEventHandlers {
  /** The shell ended the session: the user signed out, or a refresh failed. */
  onSignedOut: () => void;
}

/**
 * Routes one shell auth event from `window.fleetify.onAuthEvent`. Lives
 * outside App.tsx so it can be tested without mounting the whole app.
 *
 * - `signed-out`: hands off to `onSignedOut` and drops the keychain warning,
 *   which was about the sign-in that just ended.
 * - `keychain-unavailable`: the shell could not save the sign-in to the OS
 *   keychain, so the next launch starts signed out. Raises the warning
 *   banner (<KeychainWarningBanner />).
 *
 * Other kinds (`refreshed`, ...) need nothing here.
 */
export function handleAuthEvent(event: AuthEvent, { onSignedOut }: AuthEventHandlers): void {
  if (event.kind === "signed-out") {
    onSignedOut();
    useAppStore.getState().setKeychainWarning(false);
  } else if (event.kind === "keychain-unavailable") {
    useAppStore.getState().setKeychainWarning(true);
  }
}
