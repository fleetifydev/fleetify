/**
 * posthog wrapper smoke tests.
 *
 * `VITE_POSTHOG_KEY` is unset in the vitest env, so `initPostHog`
 * short-circuits before importing the SDK. These tests lock in that
 * the public surface stays no-throw + no-op in that state — the
 * default mode for any contributor running tests locally without a
 * PostHog project key.
 */

import { describe, it, expect } from "vitest";

import {
  capture,
  identifyUser,
  initPostHog,
  isReady,
  optIn,
  optOut,
  pageview,
} from "@/lib/posthog";

describe("posthog wrapper (no key in env)", () => {
  it("is not ready before init", () => {
    expect(isReady()).toBe(false);
  });

  it("initPostHog without VITE_POSTHOG_KEY resolves without loading the SDK", async () => {
    await expect(
      initPostHog({ distinctId: "device-test", enabled: true }),
    ).resolves.toBeUndefined();
    // Still not ready — the key gate short-circuited.
    expect(isReady()).toBe(false);
  });

  it("capture / identifyUser / pageview / optIn / optOut never throw when not ready", () => {
    expect(() => capture("test_event", { k: "v" })).not.toThrow();
    expect(() => identifyUser("user-1", { plan: "pro" })).not.toThrow();
    expect(() => pageview("/main/fleet", "Fleet")).not.toThrow();
    expect(() => optIn()).not.toThrow();
    expect(() => optOut()).not.toThrow();
  });
});
