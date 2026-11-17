import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// Product analytics is linked to the account. A user who was already signed
// in when Fleetify started must be linked too, once they opt in, with their
// id only. The analytics wrapper is real here; posthog-js is mocked.

const ph = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  resetPersonPropertiesForFlags: vi.fn(),
  _send_request: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: ph }));

// The screens themselves don't matter here.
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/onboarding/splash-screen", () => ({ SplashScreen: () => null }));
vi.mock("@/components/onboarding/welcome-screen", () => ({ WelcomeScreen: () => null }));
vi.mock("@/components/onboarding/setup-screen", () => ({ SetupScreen: () => null }));
vi.mock("@/components/onboarding/onboarding-chat", () => ({ OnboardingChat: () => null }));

import { App } from "@/App";
import { optIn } from "@/lib/posthog";

type Mock = ReturnType<typeof vi.fn>;
let api: Record<string, Mock>;

beforeEach(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  ph.init.mockImplementation((_key: string, config: { loaded?: (p: typeof ph) => void }) => {
    config.loaded?.(ph);
    return ph;
  });
  localStorage.setItem("fleet:onboarded", "1");
  (window as unknown as { fleetify: unknown }).fleetify = {
    getState: vi.fn(async () => ({
      signedIn: true,
      user: { sub: "user-1", name: "Mira Tester", email: "mira@example.com" },
    })),
    onAuthEvent: vi.fn(() => () => {}),
  };
  api = {
    telemetryGetConfig: vi.fn(async () => ({
      distinct_id: "device-1",
      posthog_enabled: false,
      cloud_enabled: false,
    })),
    getConfig: vi.fn(async () => ({ onboardingComplete: false, apiKeys: {} })),
    setConfig: vi.fn(async () => ({ ok: true })),
    setWindowSize: vi.fn(async () => true),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
});

it("links a user signed in at launch once they opt in from Settings, with the id only", async () => {
  render(<App />);
  // The signed-in launch path has run (it reads the config right after
  // taking the user).
  await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
  // Product analytics is off: nothing has reached posthog-js.
  expect(ph.init).not.toHaveBeenCalled();
  expect(ph.identify).not.toHaveBeenCalled();

  // What Settings → Privacy → Product analytics does when switched on.
  optIn();
  await waitFor(() => expect(ph.init).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(ph.identify).toHaveBeenCalled());
  expect(ph.identify.mock.calls).toEqual([["user-1"]]);
});
