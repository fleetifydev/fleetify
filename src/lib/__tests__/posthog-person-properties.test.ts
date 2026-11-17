/**
 * The real posthog-js, started by the wrapper with Fleetify's real options,
 * identifies with the account id only. On its own, posthog-js attaches
 * `$set_once` person properties to `$identify` (the first address and
 * referrer it saw on this device and in this session); none of them, and no
 * `$set`, may reach PostHog.
 *
 * Events are read from posthog-js's `eventCaptured` hook, which sees each
 * event as it is queued for sending. fetch, XMLHttpRequest and
 * navigator.sendBeacon are stubbed before posthog-js loads, so nothing here
 * can reach the network.
 *
 * Its own file: posthog-js is a singleton that `vi.resetModules()` doesn't
 * reload.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CaptureResult } from "posthog-js";

class FakeXMLHttpRequest {
  withCredentials = false;
  readyState = 0;
  status = 0;
  open = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn();
  send = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
  // happy-dom reports webdriver, which posthog-js treats as a bot and drops
  // every event for. A real WebView doesn't.
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_dummy_test_key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
  delete (navigator as unknown as { webdriver?: unknown }).webdriver;
  localStorage.clear();
});

it("sends $identify with the account id and no person properties", async () => {
  const analytics = await import("@/lib/posthog");
  await analytics.initPostHog({ distinctId: "device-1", enabled: true });
  expect(analytics.isReady()).toBe(true);

  const { default: posthog } = await import("posthog-js");
  const queued: CaptureResult[] = [];
  posthog.on("eventCaptured", (event: CaptureResult) => queued.push(event));

  analytics.capture("message_sent", { text_length: 3 });
  analytics.identifyUser("user-1");
  analytics.capture("message_sent", { text_length: 4 });

  const identify = queued.find((e) => e.event === "$identify");
  expect(identify).toBeDefined();
  // What identify is for: linking the device's events to the account.
  expect(identify!.properties.distinct_id).toBe("user-1");
  expect(identify!.properties.$anon_distinct_id).toBe("device-1");

  expect(queued.map((e) => e.event)).toEqual(["message_sent", "$identify", "message_sent"]);
  for (const event of queued) {
    expect(event.$set_once).toBeUndefined();
    expect(event.$set).toBeUndefined();
    expect(event.properties.$set_once).toBeUndefined();
    expect(event.properties.$set).toBeUndefined();
  }
});
