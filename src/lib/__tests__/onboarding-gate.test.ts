import { describe, it, expect } from "vitest";
import { isIntroComplete } from "@/lib/onboarding-gate";

describe("isIntroComplete", () => {
  it("is complete when the durable config flag is set", () => {
    expect(isIntroComplete({ onboardingComplete: true })).toBe(true);
  });

  it("is complete when only the legacy localStorage marker is present (migration)", () => {
    // Users who finished onboarding before the gate moved to durable config
    // still have fleet:setup-done in localStorage — they must NOT be forced
    // through the intro again.
    expect(isIntroComplete({ legacySetupDone: true })).toBe(true);
  });

  it("is complete when config flag is unset but legacy marker is present", () => {
    expect(
      isIntroComplete({ onboardingComplete: false, legacySetupDone: true }),
    ).toBe(true);
  });

  it("is complete when config flag is set but legacy marker is absent", () => {
    // Cross-port / cross-mode: localStorage is origin-scoped and may be empty
    // on this port, but the device-level config carries the truth.
    expect(
      isIntroComplete({ onboardingComplete: true, legacySetupDone: false }),
    ).toBe(true);
  });

  it("is NOT complete when neither signal is present", () => {
    expect(isIntroComplete({})).toBe(false);
    expect(
      isIntroComplete({ onboardingComplete: false, legacySetupDone: false }),
    ).toBe(false);
  });

  it("treats null/undefined signals as not-complete (no accidental skip)", () => {
    expect(
      isIntroComplete({ onboardingComplete: null, legacySetupDone: null }),
    ).toBe(false);
    expect(
      isIntroComplete({ onboardingComplete: undefined, legacySetupDone: undefined }),
    ).toBe(false);
  });
});
