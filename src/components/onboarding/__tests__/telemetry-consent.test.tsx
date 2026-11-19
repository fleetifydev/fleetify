import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { OnboardingChat } from "../onboarding-chat";
import { capture, optIn, optOut } from "@/lib/posthog";

// The two privacy steps that close onboarding. Dashboard sync is on by
// default, so its step says what it sends and offers to turn it off; either
// button saves the choice. Product analytics stays opt-in: only an explicit
// yes turns it on. A failed save is reported and never blocks the finish.

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

const DASHBOARD_DISCLOSURE =
  "One more thing, Mira. Your sessions will show up on your fleetify.dev dashboard. To do that, Fleetify sends session titles (the folder name, or a name you typed), project folder names, which agent and model each session uses, the kind of each agent action, token usage and cost, and a heartbeat every minute while it's open, to your account. Never your code, file contents, commands or API keys. It's on by default — you can turn it off now or anytime in **Settings → Privacy**.";
/** The dashboard step when the saved choice is off: what sync sends, then
 *  that it is off. */
const DASHBOARD_DISCLOSURE_WHEN_OFF =
  "One more thing, Mira. Your sessions will show up on your fleetify.dev dashboard. To do that, Fleetify sends session titles (the folder name, or a name you typed), project folder names, which agent and model each session uses, the kind of each agent action, token usage and cost, and a heartbeat every minute while it's open, to your account. Never your code, file contents, commands or API keys. Dashboard sync is off. You can keep it off or turn it on.";
const SYNC_KEPT_ON = "Great — your sessions will appear on your dashboard.";
const SYNC_TURNED_OFF =
  "Dashboard sync is off. You can turn it on anytime in **Settings → Privacy**.";
const ANALYTICS_QUESTION =
  "Last thing — would you help us improve Fleetify? We'd send usage data (which screens, which providers, how long onboarding takes), linked to your account. Never message content, API keys or file paths. You can change this anytime in **Settings → Privacy**.";
const NOT_CHANGED =
  "I couldn't change that setting. You can try again in **Settings → Privacy**.";

type Mock = ReturnType<typeof vi.fn>;
let api: {
  telemetrySetCloudEnabled: Mock;
  telemetrySetPosthogEnabled: Mock;
  /** Absent unless a test sets it: the step then can't read a saved choice. */
  telemetryGetConfig?: Mock;
};

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

/** These lines end on a bold **Settings → Privacy**. */
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
  it("discloses dashboard sync right after the theme step, verbatim", async () => {
    await pickTheme();
    expectQuestion(DASHBOARD_DISCLOSURE);
    expect(screen.getByRole("button", { name: "Keep it on" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn it off" })).toBeInTheDocument();
    expect(api.telemetrySetCloudEnabled).not.toHaveBeenCalled();
    expect(enterFleet()).toBeDisabled();
  });

  it("gives both choices of each privacy step the same look, in the same order", async () => {
    /** Both buttons share one inline style, the quiet one, yes before no. */
    function expectEqualWeight(yes: string, no: string) {
      const yesButton = screen.getByRole("button", { name: yes });
      const noButton = screen.getByRole("button", { name: no });
      expect(yesButton.getAttribute("style")).toBe(noButton.getAttribute("style"));
      expect(yesButton.getAttribute("style")).toContain("var(--secondary)");
      expect(yesButton.style.fontWeight).toBe("500");
      expect(
        yesButton.compareDocumentPosition(noButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    await pickTheme();
    expectEqualWeight("Keep it on", "Turn it off");
    await answer("Keep it on");
    expectEqualWeight("Sure, help out", "Not now");
  });

  it("Keep it on saves dashboard sync on, then asks about product analytics verbatim", async () => {
    await pickTheme();
    await answer("Keep it on");
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[true]]);
    expect(screen.getByText("Keep it on", { selector: "p" })).toBeInTheDocument(); // the user's bubble
    line(SYNC_KEPT_ON);
    expectQuestion(ANALYTICS_QUESTION);
    expect(screen.getByRole("button", { name: "Sure, help out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(api.telemetrySetPosthogEnabled).not.toHaveBeenCalled();
  });

  it("Turn it off saves dashboard sync off, then asks about product analytics", async () => {
    await pickTheme();
    await answer("Turn it off");
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[false]]);
    expect(screen.getByText("Turn it off", { selector: "p" })).toBeInTheDocument();
    expectQuestion(SYNC_TURNED_OFF);
    expectQuestion(ANALYTICS_QUESTION);
  });

  it("Turn it off, then Not now, never opts in to product analytics, and onboarding finishes", async () => {
    await pickTheme();
    await answer("Turn it off");
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
    await answer("Turn it off");
    line(`I couldn't save that choice: ${cloudError}`);
    // The backend still turned sync off for this session.
    expectQuestion(SYNC_TURNED_OFF);
    expectQuestion(ANALYTICS_QUESTION);
    await answer("Sure, help out");
    line(`I couldn't save that choice: ${posthogError}`);
    // The backend still applied the opt-in for this session.
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(optOut).not.toHaveBeenCalled();
    expect(enterFleet()).toBeEnabled();
  });

  describe("when onboarding runs again", () => {
    /** What `telemetryGetConfig` reports as the saved dashboard sync choice. */
    function savedChoice(cloudChoice: boolean | null) {
      api.telemetryGetConfig = vi.fn(async () => ({
        distinct_id: "device-1",
        posthog_enabled: false,
        cloud_enabled: false,
        cloud_choice: cloudChoice,
      }));
    }

    it("says dashboard sync is off when the saved choice is off, and offers to keep it off or turn it on", async () => {
      savedChoice(false);
      await pickTheme();
      line(DASHBOARD_DISCLOSURE_WHEN_OFF);
      const keepOff = screen.getByRole("button", { name: "Keep it off" });
      const turnOn = screen.getByRole("button", { name: "Turn it on" });
      expect(keepOff.getAttribute("style")).toBe(turnOn.getAttribute("style"));
      expect(keepOff.compareDocumentPosition(turnOn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep it on" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Turn it off" })).toBeNull();
      expect(screen.queryByText(/It's on by default/)).toBeNull();
      expect(api.telemetrySetCloudEnabled).not.toHaveBeenCalled();
    });

    it("Keep it off saves dashboard sync off", async () => {
      savedChoice(false);
      await pickTheme();
      await answer("Keep it off");
      expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[false]]);
      expect(screen.getByText("Keep it off", { selector: "p" })).toBeInTheDocument();
      expectQuestion(SYNC_TURNED_OFF);
      expectQuestion(ANALYTICS_QUESTION);
    });

    it("Turn it on saves dashboard sync on", async () => {
      savedChoice(false);
      await pickTheme();
      await answer("Turn it on");
      expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[true]]);
      expect(screen.getByText("Turn it on", { selector: "p" })).toBeInTheDocument();
      line(SYNC_KEPT_ON);
      expectQuestion(ANALYTICS_QUESTION);
    });

    it("keeps the on-by-default question when the saved choice is on, or there is none", async () => {
      savedChoice(true);
      const first = render(<OnboardingChat user={USER} onDone={() => {}} startAt="theme" />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await settle();
      expectQuestion(DASHBOARD_DISCLOSURE);
      expect(screen.getByRole("button", { name: "Keep it on" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Turn it off" })).toBeInTheDocument();
      first.unmount();

      savedChoice(null);
      await pickTheme();
      expectQuestion(DASHBOARD_DISCLOSURE);
      expect(screen.getByRole("button", { name: "Keep it on" })).toBeInTheDocument();
    });
  });

  it("still finishes when a consent call never reaches the backend", async () => {
    api.telemetrySetCloudEnabled.mockRejectedValueOnce(new Error("ipc down"));
    api.telemetrySetPosthogEnabled.mockRejectedValueOnce(new Error("ipc down"));
    await pickTheme();
    await answer("Turn it off");
    expectQuestion(NOT_CHANGED);
    // Nothing turned sync off, so nothing may say it is off.
    const offLine = SYNC_TURNED_OFF.replace(/\*\*/g, "");
    expect(
      screen.queryByText((_, el) => el?.tagName === "P" && el.textContent === offLine),
    ).toBeNull();
    expect(screen.queryByText(/Dashboard sync is off/)).toBeNull();
    expectQuestion(ANALYTICS_QUESTION);
    await answer("Sure, help out");
    const plain = NOT_CHANGED.replace(/\*\*/g, "");
    expect(
      screen.getAllByText((_, el) => el?.tagName === "P" && el.textContent === plain),
    ).toHaveLength(2);
    // Nothing recorded the opt-in, so the SDK stops capturing again.
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("onboarding_completed", { telemetry_opt_in: false });
    expect(enterFleet()).toBeEnabled();
  });
});
