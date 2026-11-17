import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/posthog", () => ({ resetIdentity: vi.fn() }));

import { handleAuthEvent } from "@/lib/auth-events";
import { resetIdentity } from "@/lib/posthog";
import { useAppStore } from "@/stores/app-store";

describe("handleAuthEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(resetIdentity).not.toHaveBeenCalled();
  });

  it("forgets the account in product analytics on signed-out, whatever the reason", () => {
    // On a shared machine the next account must not be linked to this one.
    handleAuthEvent({ kind: "signed-out", reason: "user" }, { onSignedOut: () => {} });
    handleAuthEvent({ kind: "signed-out", reason: "refresh-failed" }, { onSignedOut: () => {} });
    expect(resetIdentity).toHaveBeenCalledTimes(2);
  });

  it("leaves product analytics alone on keychain-unavailable", () => {
    handleAuthEvent({ kind: "keychain-unavailable" }, { onSignedOut: () => {} });
    expect(resetIdentity).not.toHaveBeenCalled();
  });
});
