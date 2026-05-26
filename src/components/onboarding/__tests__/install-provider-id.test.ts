import { describe, it, expect } from "vitest";
// Vite's `?raw` query loads the file as a string at test time. We
// assert against the OnboardingChat source directly rather than
// driving the install button through the rendered component because
// the verify loop sits behind a typewriter intro + multi-bubble
// pacing, and the invariant we're guarding ("which tool key reaches
// the IPC?") is a single-line concern that a static check covers
// without timer plumbing.
//
// Regression context: passing `p.scanKey` ("agy_cli",
// "antigravity_sdk", "claude_cli"…) to `installProvider` lands at
// the backend's `shell_install_provider` which routes on the kebab
// `p.id` ("agy", "antigravity-sdk", "claude") and returns
// `unknown provider: <scanKey>` for every CLI install in onboarding.
import onboardingSrc from "@/components/onboarding/onboarding-chat.tsx?raw";

describe("OnboardingChat install IPC", () => {
  it("passes the kebab provider id to installProvider, not the snake-case scanKey", () => {
    expect(onboardingSrc).not.toMatch(/installProvider\(\s*p\.scanKey/);
    // Two call sites today — the auto-install fired during the
    // verify loop and the explicit handleInstall triggered from the
    // row's Install button. Both must use `p.id`.
    const matches = onboardingSrc.match(/installProvider\(\s*p\.id\b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
