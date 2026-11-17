import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { OnboardingChat } from "../onboarding-chat";
import { capture, optIn, optOut } from "@/lib/posthog";

// The two privacy questions that close onboarding: dashboard sync, then
// product analytics. Both are opt-in, so the only way to switch either on is
// an explicit yes; a failed save is reported and never blocks the finish.

// No network on mount: the provider scan is the only api call on this path.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiScanProviders: vi.fn(async () => null),
  checkPythonRuntime: vi.fn(async () => null),
}));

vi.mock("@/lib/posthog", () => ({
  capture: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
}));

const USER = { id: "u-1", name: "Mira Tester", email: "mira@example.com" };

const DASHBOARD_QUESTION =
  "One more thing, Mira. Want to see your sessions on your fleetify.dev dashboard? Fleetify would send session titles (the start of your first message), project folder names, the kind of each agent action, token usage and cost to your account. Never your code, file contents, commands or API keys. It stays off unless you turn it on, and you can change it anytime in **Settings → Privacy**.";
const ANALYTICS_QUESTION =
  "Last thing — would you help us improve Fleetify? We'd send usage data (which screens, which providers, how long onboarding takes), linked to your account. Never message content, API keys or file paths. You can change this anytime in **Settings → Privacy**.";

type Mock = ReturnType<typeof vi.fn>;
let api: { telemetrySetCloudEnabled: Mock; telemetrySetPosthogEnabled: Mock };

beforeEach(() => {
  vi.useFakeTimers();
  api = {
    telemetrySetCloudEnabled: vi.fn(async () => ({ ok: true })),
    telemetrySetPosthogEnabled: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  vi.mocked(capture).mockClear();
  vi.mocked(optIn).mockClear();
  vi.mocked(optOut).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the typewriter finish every queued line, up to the next question. */
async function settle() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

/** A fully typed assistant line: its text without the `**` markers. */
function line(markdown: string): HTMLElement {
  const text = markdown.replace(/\*\*/g, "");
  return screen.getByText((_, el) => el?.tagName === "P" && el.textContent === text);
}

/** Both questions end on a bold **Settings → Privacy**. */
function expectQuestion(markdown: string) {
  expect(within(line(markdown)).getByText("Settings → Privacy").tagName).toBe("STRONG");
}

async function pickTheme() {
  render(<OnboardingChat user={USER} onDone={() => {}} startAt="theme" />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await settle();
}

async function answer(button: string) {
  fireEvent.click(screen.getByRole("button", { name: button }));
  await settle();
}

const enterFleet = () => screen.getByRole("button", { name: /enter fleet/i });

describe("onboarding privacy questions", () => {
  it("asks about dashboard sync right after the theme step, verbatim", async () => {
    await pickTheme();
    expectQuestion(DASHBOARD_QUESTION);
    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(api.telemetrySetCloudEnabled).not.toHaveBeenCalled();
    expect(enterFleet()).toBeDisabled();
  });

  it("Turn on switches dashboard sync on, then asks about product analytics verbatim", async () => {
    await pickTheme();
    await answer("Turn on");
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[true]]);
    expect(screen.getByText("Turn on", { selector: "p" })).toBeInTheDocument(); // the user's bubble
    expectQuestion(ANALYTICS_QUESTION);
    expect(screen.getByRole("button", { name: "Sure, help out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(api.telemetrySetPosthogEnabled).not.toHaveBeenCalled();
  });

  it("Not now leaves dashboard sync off, then asks about product analytics", async () => {
    await pickTheme();
    await answer("Not now");
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[false]]);
    expect(screen.getByText("Not now", { selector: "p" })).toBeInTheDocument();
    expectQuestion(ANALYTICS_QUESTION);
  });

  it("Not now to both never opts in, and onboarding finishes", async () => {
    await pickTheme();
    await answer("Not now");
    await answer("Not now");
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[false]]);
    expect(api.telemetrySetPosthogEnabled.mock.calls).toEqual([[false]]);
    expect(optIn).not.toHaveBeenCalled();
    expect(optOut).toHaveBeenCalled();
    expect(enterFleet()).toBeEnabled();
  });

  it("says when a choice wasn't saved, and still finishes", async () => {
    const cloudError =
      "Couldn't save the cloud sync setting: disk full. The change applies until Fleetify restarts.";
    const posthogError =
      "Couldn't save the product analytics setting: disk full. The change applies until Fleetify restarts.";
    api.telemetrySetCloudEnabled.mockResolvedValueOnce({ ok: false, error: cloudError });
    api.telemetrySetPosthogEnabled.mockResolvedValueOnce({ ok: false, error: posthogError });
    await pickTheme();
    await answer("Turn on");
    line(`I couldn't save that choice: ${cloudError}`);
    expectQuestion(ANALYTICS_QUESTION);
    await answer("Sure, help out");
    line(`I couldn't save that choice: ${posthogError}`);
    // The backend still applied the opt-in for this session.
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(optOut).not.toHaveBeenCalled();
    expect(enterFleet()).toBeEnabled();
  });

  it("still finishes when a consent call never reaches the backend", async () => {
    api.telemetrySetCloudEnabled.mockRejectedValueOnce(new Error("ipc down"));
    api.telemetrySetPosthogEnabled.mockRejectedValueOnce(new Error("ipc down"));
    await pickTheme();
    await answer("Turn on");
    line("I couldn't save that choice: Couldn't change this setting.");
    expectQuestion(ANALYTICS_QUESTION);
    await answer("Sure, help out");
    expect(screen.getAllByText("I couldn't save that choice: Couldn't change this setting.")).toHaveLength(2);
    // Nothing recorded the opt-in, so the SDK stops capturing again.
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("onboarding_completed", { telemetry_opt_in: false });
    expect(enterFleet()).toBeEnabled();
  });
});
