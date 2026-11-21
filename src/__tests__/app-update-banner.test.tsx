import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import type { UpdateStatus } from "@/lib/api";
import { useUpdateStore } from "@/stores/update-store";

// The shell checks for updates whether anyone is signed in or not. App
// follows the updater and mounts the one update banner outside its screen
// gates, so Restart to update shows on the welcome, sign-in and onboarding
// screens too: a release that breaks sign-in can still be updated away.

const splash = vi.hoisted(() => ({ finish: null as (() => void) | null }));

// The screens themselves don't matter here. The main shell keeps only the
// place it gives the banner.
vi.mock("@/components/onboarding/splash-screen", async () => {
  const { useEffect } = await import("react");
  return {
    // Finishes when a test says so; the real one finishes on a timer.
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
vi.mock("@/components/layout/app-shell", async () => {
  const { UpdateBannerSlot } = await import("@/components/layout/update-ready-banner");
  return {
    AppShell: () => (
      <div data-testid="shell">
        <p>main</p>
        <UpdateBannerSlot />
      </div>
    ),
  };
});
vi.mock("@/components/settings-page", () => ({ SettingsPage: () => <p>settings</p> }));
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

const READY: UpdateStatus = { state: "ready", version: "0.2.1" };
const PROMPT = "Fleetify 0.2.1 is ready to install.";
const initial = useUpdateStore.getState();

type Mock = ReturnType<typeof vi.fn>;
let api: Record<string, Mock>;

/** Lets pending reads finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Starts the app with an update that has downloaded and verified. */
function launch({ signedIn, introComplete = true }: { signedIn: boolean; introComplete?: boolean }) {
  if (signedIn) localStorage.setItem("fleet:onboarded", "1");
  (window as unknown as { fleetify: unknown }).fleetify = {
    getState: vi.fn(async () => (signedIn
      ? { signedIn: true, user: { sub: "user-1", name: "Mira Tester", email: "mira@example.com" } }
      : { signedIn: false })),
    onAuthEvent: vi.fn(() => () => {}),
    updaterStatus: vi.fn(async () => READY),
    updaterCheck: vi.fn(async () => READY),
    updaterRestart: vi.fn(async () => {}),
    onUpdaterStatus: vi.fn(() => () => {}),
  };
  api.getConfig!.mockResolvedValue({ onboardingComplete: introComplete, apiKeys: {} });
  render(<App />);
}

beforeEach(() => {
  useUpdateStore.setState(initial, true);
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

/** Signed out: the splash, then the welcome screen once the splash is done. */
async function reachWelcome() {
  launch({ signedIn: false });
  expect(await screen.findByText("splash")).toBeInTheDocument();
  await settle();
  act(() => splash.finish?.());
  expect(await screen.findByText("welcome")).toBeInTheDocument();
}

it("offers Restart to update on the welcome screen, signed out", async () => {
  await reachWelcome();
  const banner = (await screen.findByText(PROMPT)).closest<HTMLElement>('[role="status"]')!;
  expect(within(banner).getByRole("button", { name: "Restart to update" })).toBeInTheDocument();
  expect(within(banner).getByRole("button", { name: "Later" })).toBeInTheDocument();
  expect(screen.queryByTestId("shell")).toBeNull();
  expect(screen.getAllByText(PROMPT)).toHaveLength(1);
});

it("offers it during onboarding", async () => {
  launch({ signedIn: true, introComplete: false });
  expect(await screen.findByText("onboarding")).toBeInTheDocument();
  expect(await screen.findByText(PROMPT)).toBeInTheDocument();
  expect(screen.getAllByText(PROMPT)).toHaveLength(1);
});

it("puts it in the place the main shell gives it, once", async () => {
  launch({ signedIn: true });
  const shell = await screen.findByTestId("shell");
  expect(await within(shell).findByText(PROMPT)).toBeInTheDocument();
  expect(screen.getAllByText(PROMPT)).toHaveLength(1);
});

it("floats it over Settings, while the shell is hidden underneath", async () => {
  launch({ signedIn: true });
  const shell = await screen.findByTestId("shell");
  await within(shell).findByText(PROMPT);

  act(() => { window.dispatchEvent(new CustomEvent("fleet:open-settings")); });
  expect(await screen.findByText("settings")).toBeInTheDocument();
  const prompt = screen.getByText(PROMPT);
  expect(shell).not.toContainElement(prompt);
  expect(screen.getAllByText(PROMPT)).toHaveLength(1);
});

it("waits for the splash to finish", async () => {
  launch({ signedIn: false });
  expect(await screen.findByText("splash")).toBeInTheDocument();
  await settle();
  expect(useUpdateStore.getState().status).toEqual(READY);
  expect(screen.queryByText(PROMPT)).toBeNull();

  act(() => splash.finish?.());
  expect(await screen.findByText(PROMPT)).toBeInTheDocument();
});
