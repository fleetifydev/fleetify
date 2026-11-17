/**
 * Product analytics wrapper. posthog-js is mocked: these tests pin when it
 * may start and what it is told, not PostHog itself.
 *
 * - While product analytics is off, posthog-js is never initialised, so it
 *   makes no request at all.
 * - Once the user opts in, it starts with automatic capture, remote config,
 *   feature flags and external scripts all off.
 * - identify sends the account id only.
 * - After an opt-out in the same session, nothing it would still send gets
 *   through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ph = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(),
  resetPersonPropertiesForFlags: vi.fn(),
  _send_request: vi.fn(),
}));
/** How many times posthog-js was loaded (once per fresh module registry). */
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("posthog-js", () => {
  loads.count += 1;
  return { default: ph };
});

let analytics: typeof import("@/lib/posthog");
/** posthog-js's own request function, which every request goes through. */
let send: ReturnType<typeof vi.fn>;

const EXPECTED_OPTIONS = {
  api_host: "https://us.i.posthog.com",
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_heatmaps: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_conversations: true,
  disable_product_tours: true,
  disable_web_experiments: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  persistence: "localStorage",
  bootstrap: { distinctID: "device-1" },
  loaded: expect.any(Function),
};

/** Let the wrapper's dynamic import of posthog-js finish. */
async function settle() {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  loads.count = 0;
  ph.has_opted_out_capturing.mockReturnValue(false);
  ph.init.mockImplementation((_key: string, config: { loaded?: (p: typeof ph) => void }) => {
    config.loaded?.(ph);
    return ph;
  });
  send = vi.fn();
  ph._send_request = send;
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  vi.stubEnv("VITE_POSTHOG_HOST", "");
  analytics = await import("@/lib/posthog");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("product analytics while it is off", () => {
  it("never initialises posthog-js", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: false });
    analytics.identifyUser("user-1");
    analytics.capture("message_sent", { text_length: 3 });
    analytics.pageview("/main", "main");
    analytics.optOut();
    await settle();
    // Not even loaded, let alone started.
    expect(loads.count).toBe(0);
    expect(ph.init).not.toHaveBeenCalled();
    expect(ph.identify).not.toHaveBeenCalled();
    expect(ph.capture).not.toHaveBeenCalled();
    expect(analytics.isReady()).toBe(false);
  });

  it("does nothing without a project key, even after an opt-in", async () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    analytics.optIn();
    await settle();
    expect(ph.init).not.toHaveBeenCalled();
    expect(analytics.isReady()).toBe(false);
  });
});

describe("opting in", () => {
  it("starts posthog-js at launch when the saved choice is on, with only Fleetify's own events", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.init).toHaveBeenCalledWith("phc_test", EXPECTED_OPTIONS);
    expect(analytics.isReady()).toBe(true);
  });

  it("starts posthog-js when the user opts in later, with the same options", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: false });
    analytics.optIn();
    await settle();
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.init).toHaveBeenCalledWith("phc_test", EXPECTED_OPTIONS);
    // No $opt_in event: it isn't one of the events Fleetify documents.
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it("clears an opt-out an older build stored, without an $opt_in event", async () => {
    ph.has_opted_out_capturing.mockReturnValue(true);
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    expect(ph.opt_in_capturing.mock.calls).toEqual([[{ captureEventName: false }]]);
  });

  it("drops the person properties older builds stored", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    expect(ph.resetPersonPropertiesForFlags).toHaveBeenCalledTimes(1);
  });

  it("keeps an opt-in the user made before the launch read arrived", async () => {
    analytics.optIn();
    await analytics.initPostHog({ distinctId: "device-1", enabled: false });
    expect(ph.init).toHaveBeenCalledTimes(1);
  });

  it("keeps an opt-out the user made before the launch read arrived", async () => {
    analytics.optOut();
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    await settle();
    expect(ph.init).not.toHaveBeenCalled();
  });

  it("does not start when the user opts out again while posthog-js loads", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: false });
    analytics.optIn();
    analytics.optOut();
    await settle();
    expect(ph.init).not.toHaveBeenCalled();
  });
});

describe("identify", () => {
  it("sends the account id only", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    analytics.identifyUser("user-1");
    expect(ph.identify.mock.calls).toEqual([["user-1"]]);
  });

  it("links a sign-in made before the opt-in once the user opts in", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: false });
    analytics.identifyUser("user-1");
    await settle();
    expect(ph.identify).not.toHaveBeenCalled();
    analytics.optIn();
    await settle();
    expect(ph.identify.mock.calls).toEqual([["user-1"]]);
  });
});

describe("opting out in the same session", () => {
  it("stops capturing, and no queued or retried request gets through", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    ph._send_request({ url: "/e/", data: {} });
    expect(send).toHaveBeenCalledTimes(1);

    analytics.optOut();
    expect(ph.opt_out_capturing).toHaveBeenCalledTimes(1);
    // What posthog-js still had queued, or was retrying, goes nowhere.
    ph._send_request({ url: "/e/", data: {} });
    ph._send_request({ url: "/flags/?v=2", data: {} });
    analytics.capture("message_sent", { text_length: 3 });
    analytics.pageview("/main", "main");
    analytics.identifyUser("user-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(ph.capture).not.toHaveBeenCalled();
    expect(ph.identify).not.toHaveBeenCalled();
    expect(analytics.isReady()).toBe(false);
  });

  it("opting back in lets requests through again, without an $opt_in event", async () => {
    await analytics.initPostHog({ distinctId: "device-1", enabled: true });
    analytics.optOut();
    analytics.optIn();
    expect(ph.opt_in_capturing).toHaveBeenLastCalledWith({ captureEventName: false });
    ph._send_request({ url: "/e/", data: {} });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ph.init).toHaveBeenCalledTimes(1);
  });
});
