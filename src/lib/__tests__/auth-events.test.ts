import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleAuthEvent } from "@/lib/auth-events";
import { useAppStore } from "@/stores/app-store";

describe("handleAuthEvent", () => {
  beforeEach(() => {
    useAppStore.setState({ keychainWarning: false });
  });

  it("raises the keychain warning on keychain-unavailable", () => {
    const onSignedOut = vi.fn();
    handleAuthEvent({ kind: "keychain-unavailable" }, { onSignedOut });
    expect(useAppStore.getState().keychainWarning).toBe(true);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("hands signed-out to the sign-out handler", () => {
    const onSignedOut = vi.fn();
    handleAuthEvent({ kind: "signed-out", reason: "refresh-failed" }, { onSignedOut });
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("drops a pending keychain warning on signed-out, since it was about that sign-in", () => {
    // Otherwise a later sign-in whose token DID save would reach the main
    // screen still showing the old warning.
    useAppStore.setState({ keychainWarning: true });
    handleAuthEvent({ kind: "signed-out", reason: "user" }, { onSignedOut: () => {} });
    expect(useAppStore.getState().keychainWarning).toBe(false);
  });

  it("ignores other events such as refreshed", () => {
    const onSignedOut = vi.fn();
    handleAuthEvent({ kind: "refreshed", expiresAt: 1_700_000_000 }, { onSignedOut });
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(useAppStore.getState().keychainWarning).toBe(false);
  });
});
