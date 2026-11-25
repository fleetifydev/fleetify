import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

// The screens before the main shell (splash, sign-in, setup, the onboarding
// chat) share one moving backdrop behind them. It stays mounted from one of
// these screens to the next, so its motion carries on instead of starting
// over, and it goes away with them once the main shell shows.

const splash = vi.hoisted(() => ({ finish: null as (() => void) | null }));

vi.mock("@/components/onboarding/splash-screen", async () => {
  const { useEffect } = await import("react");
  return {
    SplashScreen: ({ onDone }: { onDone: () => void }) => {
      useEffect(() => {
        splash.finish = onDone;
        return () => { splash.finish = null; };
      }, [onDone]);
      return <p>splash</p>;
    },
  };
});
vi.mock("@/components/onboarding/welcome-screen", () => ({ WelcomeScreen: () => <p>welcome</p> }));
vi.mock("@/components/onboarding/setup-screen", () => ({ SetupScreen: () => null }));
vi.mock("@/components/onboarding/onboarding-chat", () => ({
  OnboardingChat: () => <p>onboarding</p>,
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => <p>main</p> }));
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
let api: Record<string, Mock>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function launch({ signedIn, introComplete = true }: { signedIn: boolean; introComplete?: boolean }) {
  if (signedIn) localStorage.setItem("fleet:onboarded", "1");
  const idle = { state: "idle" };
  (window as unknown as { fleetify: unknown }).fleetify = {
    getState: vi.fn(async () => (signedIn
      ? { signedIn: true, user: { sub: "user-1", name: "Mira Tester", email: "mira@example.com" } }
      : { signedIn: false })),
    onAuthEvent: vi.fn(() => () => {}),
    updaterStatus: vi.fn(async () => idle),
    updaterCheck: vi.fn(async () => idle),
    updaterRestart: vi.fn(async () => {}),
    onUpdaterStatus: vi.fn(() => () => {}),
  };
  api.getConfig!.mockResolvedValue({ onboardingComplete: introComplete, apiKeys: {} });
  render(<App />);
}

const backdrop = () => screen.queryByTestId("onboarding-backdrop");

beforeEach(() => {
  splash.finish = null;
  api = {
    telemetryGetConfig: vi.fn(async () => ({
      distinct_id: "device-1",
      posthog_enabled: false,
      cloud_enabled: true,
      cloud_choice: true,
    })),
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

it("keeps one backdrop behind the splash and the sign-in screen", async () => {
  launch({ signedIn: false });
  expect(await screen.findByText("splash")).toBeInTheDocument();
  const first = backdrop();
  expect(first).toBeInTheDocument();
  // Decoration only: hidden from assistive technology.
  expect(first).toHaveAttribute("aria-hidden", "true");

  await settle();
  act(() => splash.finish?.());
  expect(await screen.findByText("welcome")).toBeInTheDocument();
  // The same element: the motion carries on rather than starting over.
  expect(backdrop()).toBe(first);
});

it("shows it during onboarding", async () => {
  launch({ signedIn: true, introComplete: false });
  expect(await screen.findByText("onboarding")).toBeInTheDocument();
  expect(backdrop()).toBeInTheDocument();
});

it("removes it once the main shell shows", async () => {
  launch({ signedIn: true });
  expect(await screen.findByText("main")).toBeInTheDocument();
  expect(backdrop()).toBeNull();
});
