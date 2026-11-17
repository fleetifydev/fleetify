import { useAppStore } from "@/stores/app-store";
import { resetIdentity } from "@/lib/posthog";

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
 * - `signed-out`: hands off to `onSignedOut`, drops the keychain warning,
 *   which was about the sign-in that just ended, and makes product analytics
 *   forget the account (`resetIdentity`), so on a shared machine the next
 *   account isn't linked to it.
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
    resetIdentity();
  } else if (event.kind === "keychain-unavailable") {
    useAppStore.getState().setKeychainWarning(true);
  }
}
