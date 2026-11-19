import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

// An install that finished onboarding before onboarding asked about
// dashboard sync goes straight to the main screen, so it never sees that
// step. The app asks it the question once there (DashboardSyncNotice), as
// long as no choice is saved. Someone who still has onboarding ahead
// answers the question in it instead.

// The screens themselves don't matter here.
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => <p>main</p> }));
vi.mock("@/components/onboarding/splash-screen", () => ({ SplashScreen: () => null }));
vi.mock("@/components/onboarding/welcome-screen", () => ({ WelcomeScreen: () => null }));
vi.mock("@/components/onboarding/setup-screen", () => ({ SetupScreen: () => null }));
vi.mock("@/components/onboarding/onboarding-chat", () => ({
  OnboardingChat: () => <p>onboarding</p>,
}));
// The launch sweep runs on the main screen; it isn't under test.
vi.mock("@/stores/plugin-store", () => ({
  usePluginStore: {
    getState: () => ({
      refreshInstalls: async () => {},
      refreshCatalog: async () => {},
      autoUpdateSweep: () => {},
    }),
  },
}));

import { App } from "@/App";

type Mock = ReturnType<typeof vi.fn>;
let api: {
  telemetryGetConfig: Mock;
  telemetrySetCloudEnabled: Mock;
  getConfig: Mock;
  setConfig: Mock;
  setWindowSize: Mock;
};

/** Lets pending reads finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function launch({
  onboardingComplete,
  cloudChoice,
}: {
  onboardingComplete: boolean;
  cloudChoice: boolean | null;
}) {
  api.getConfig.mockResolvedValue({ onboardingComplete, apiKeys: {} });
  api.telemetryGetConfig.mockResolvedValue({
    distinct_id: "device-1",
    posthog_enabled: false,
    cloud_enabled: false,
    cloud_choice: cloudChoice,
  });
  render(<App />);
}

beforeEach(() => {
  localStorage.setItem("fleet:onboarded", "1");
  (window as unknown as { fleetify: unknown }).fleetify = {
    getState: vi.fn(async () => ({
      signedIn: true,
      user: { sub: "user-1", name: "Mira Tester", email: "mira@example.com" },
    })),
    onAuthEvent: vi.fn(() => () => {}),
  };
  api = {
    telemetryGetConfig: vi.fn(),
    telemetrySetCloudEnabled: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(),
    setConfig: vi.fn(async () => ({ ok: true })),
    setWindowSize: vi.fn(async () => true),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
});

afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { fleetify?: unknown }).fleetify;
});

it("asks an install that finished onboarding before the dashboard step existed", async () => {
  // Only the old localStorage marker says onboarding is done: the app takes
  // it for finished and goes to the main screen.
  localStorage.setItem("fleet:setup-done", "1");
  launch({ onboardingComplete: false, cloudChoice: null });
  expect(await screen.findByText("main")).toBeInTheDocument();
  expect(await screen.findByRole("dialog", { name: "Dashboard sync" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Keep it on" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Turn it off" })).toBeInTheDocument();
  expect(api.telemetrySetCloudEnabled).not.toHaveBeenCalled();
});

it("doesn't ask when a choice is saved", async () => {
  launch({ onboardingComplete: true, cloudChoice: true });
  expect(await screen.findByText("main")).toBeInTheDocument();
  await settle();
  expect(screen.queryByRole("dialog", { name: "Dashboard sync" })).toBeNull();
});

it("leaves the question to onboarding when the intro isn't done yet", async () => {
  launch({ onboardingComplete: false, cloudChoice: null });
  expect(await screen.findByText("onboarding")).toBeInTheDocument();
  await settle();
  expect(screen.queryByRole("dialog", { name: "Dashboard sync" })).toBeNull();
});
