/**
 * Signing out with the real posthog-js, started by the wrapper with
 * Fleetify's real options. After `resetIdentity()` the app's events no
 * longer carry the account that signed out (on a shared machine, the next
 * account must not be linked to it), Fleetify's own `platform` property is
 * back, no flags are fetched (reset() asks for them again), and an opt-out
 * made in this session survives (reset() clears posthog-js's stored consent).
 *
 * Events are read from posthog-js's `eventCaptured` hook. fetch,
 * XMLHttpRequest and navigator.sendBeacon are stubbed before posthog-js
 * loads, so nothing here can reach the network.
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

let fetched: string[];

beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      fetched.push(String(input));
      return new Response("{}", { status: 200 });
    }),
  );
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

it("drops the signed-out account from later events, fetches no flags and keeps an opt-out", async () => {
  const analytics = await import("@/lib/posthog");
  await analytics.initPostHog({ distinctId: "device-1", enabled: true });
  const { default: posthog } = await import("posthog-js");
  const queued: CaptureResult[] = [];
  posthog.on("eventCaptured", (event: CaptureResult) => queued.push(event));

  analytics.identifyUser("user-1");
  analytics.capture("message_sent", { text_length: 1 });
  const signedIn = queued.at(-1)!;
  expect(signedIn.properties.distinct_id).toBe("user-1");
  expect(signedIn.properties.$user_id).toBe("user-1");

  analytics.resetIdentity();
  analytics.capture("message_sent", { text_length: 2 });
  const signedOut = queued.at(-1)!;
  // A new anonymous id: not the account, and not the device id, which
  // PostHog has linked to the account.
  expect(signedOut.properties.distinct_id).not.toBe("user-1");
  expect(signedOut.properties.distinct_id).not.toBe("device-1");
  expect(signedOut.properties.$user_id).toBeUndefined();
  expect(signedOut.properties.$device_id).toBe("device-1");
  expect(signedOut.properties.platform).toBe(signedIn.properties.platform);

  // reset() schedules a flags reload; advanced_disable_flags must keep it
  // from fetching. Wait out its debounce. Only events may have gone out
  // ($identify is sent at once, not batched).
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fetched.filter((url) => !new URL(url).pathname.startsWith("/e/"))).toEqual([]);

  // Turned off in this session, then signed out: posthog-js stays opted out.
  analytics.optOut();
  analytics.resetIdentity();
  expect(posthog.has_opted_out_capturing()).toBe(true);
});
