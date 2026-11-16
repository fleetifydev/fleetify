/**
 * The keychain warning banner: the shell emits `{ kind: "keychain-unavailable" }`
 * when it cannot save the refresh token to the OS keychain, so the user is
 * told now instead of finding themselves signed out at the next launch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { KeychainWarningBanner } from "../keychain-warning-banner";
import { useAppStore } from "@/stores/app-store";
import { handleAuthEvent } from "@/lib/auth-events";

const MESSAGE =
  "Fleetify couldn't save your sign-in to the system keychain, so you'll need to sign in again next time. On Linux, install or unlock GNOME Keyring or KWallet to stay signed in.";

describe("KeychainWarningBanner", () => {
  beforeEach(() => {
    useAppStore.setState({ keychainWarning: false });
  });

  it("renders nothing while the flag is false", () => {
    const { container } = render(<KeychainWarningBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the exact warning and a Dismiss button when the flag is set", () => {
    useAppStore.setState({ keychainWarning: true });
    render(<KeychainWarningBanner />);
    const status = screen.getByRole("status");
    expect(status).toContainElement(screen.getByText(MESSAGE));
    expect(status).toContainElement(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("Dismiss clears the flag and hides the banner", () => {
    useAppStore.setState({ keychainWarning: true });
    const { container } = render(<KeychainWarningBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useAppStore.getState().keychainWarning).toBe(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("appears when the shell reports keychain-unavailable through the auth-event handler", () => {
    // Stand-in for window.fleetify.onAuthEvent: keeps the listener so the
    // test can fire a shell event at it, the way App subscribes.
    let emit: ((event: { kind: string }) => void) | undefined;
    const onAuthEvent = vi.fn((cb: (event: { kind: string }) => void) => {
      emit = cb;
      return () => {};
    });
    const onSignedOut = vi.fn();
    onAuthEvent((event) => handleAuthEvent(event, { onSignedOut }));

    const { container } = render(<KeychainWarningBanner />);
    expect(container).toBeEmptyDOMElement();

    act(() => emit?.({ kind: "keychain-unavailable" }));

    expect(useAppStore.getState().keychainWarning).toBe(true);
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
