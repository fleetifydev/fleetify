/**
 * The real posthog-js, started by the wrapper with Fleetify's real options,
 * makes no request once product analytics is turned off: not the batch it
 * had queued, not the 3 s flush, not the beacon it sends when the page
 * hides. fetch, XMLHttpRequest and navigator.sendBeacon are all stubbed
 * before posthog-js loads, so nothing here can reach the network.
 *
 * One test, because posthog-js is a singleton that `vi.resetModules()`
 * doesn't reload.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";

let fetches: unknown[][];
let xhrSends: number;
let beacons: unknown[][];

class FakeXMLHttpRequest {
  withCredentials = false;
  readyState = 0;
  status = 0;
  open = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn();
  send = vi.fn(() => {
    xhrSends += 1;
  });
}

const sent = () => ({ fetch: fetches.length, xhr: xhrSends, beacon: beacons.length });

/** Run posthog-js's timers, then let its async compression finish. */
async function runFor(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 100));
  vi.useFakeTimers();
}

beforeEach(() => {
  fetches = [];
  xhrSends = 0;
  beacons = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]) => {
      fetches.push(args);
      return new Response("{}", { status: 200 });
    }),
  );
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: vi.fn((...args: unknown[]) => {
      beacons.push(args);
      return true;
    }),
  });
  // happy-dom reports webdriver, which posthog-js treats as a bot and drops
  // every event for. A real WebView doesn't.
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_dummy_test_key");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
  delete (navigator as unknown as { webdriver?: unknown }).webdriver;
  localStorage.clear();
});

it("sends nothing after an opt-out: not the queued batch, the 3 s flush or the pagehide beacon", async () => {
  const analytics = await import("@/lib/posthog");
  await analytics.initPostHog({ distinctId: "device-1", enabled: true });
  expect(analytics.isReady()).toBe(true);
  // Starting it fetched nothing: no remote config, no flags, no scripts.
  expect(sent()).toEqual({ fetch: 0, xhr: 0, beacon: 0 });
  expect(document.querySelectorAll("script[src]")).toHaveLength(0);

  // Control: while opted in, the 3 s flush does reach the stubbed transport,
  // so the checks below can see a request if one is made.
  analytics.capture("message_sent", { text_length: 3 });
  await runFor(3_500);
  expect(sent().fetch).toBeGreaterThan(0);
  const beforeOptOut = sent();

  analytics.capture("message_sent", { text_length: 4 });
  analytics.optOut();
  await runFor(3_500);
  window.dispatchEvent(new Event("pagehide"));
  await runFor(1_000);
  expect(sent()).toEqual(beforeOptOut);
});
