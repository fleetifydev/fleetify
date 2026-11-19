import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { DashboardSyncNotice } from "../dashboard-sync-notice";

// An install that finished onboarding before onboarding asked about
// dashboard sync has no saved choice, so the shell keeps sync off and sends
// nothing. Once the user is signed in and past the intro, the notice asks
// the onboarding step's question, word for word, with its two buttons.
// Either button saves the answer and closes the notice; nothing else does.

const QUESTION =
  "Your sessions will show up on your fleetify.dev dashboard. To do that, Fleetify sends session titles (the folder name, or a name you typed), project folder names, which agent and model each session uses, the kind of each agent action, token usage and cost, and a heartbeat every minute while it's open, to your account. Never your code, file contents, commands or API keys. It's on by default — you can turn it off now or anytime in **Settings → Privacy**.";

type Mock = ReturnType<typeof vi.fn>;
let api: { telemetryGetConfig: Mock; telemetrySetCloudEnabled: Mock };

/** What `telemetryGetConfig` reports as the saved dashboard sync choice. */
function savedChoice(cloudChoice: boolean | null) {
  api.telemetryGetConfig.mockResolvedValue({
    distinct_id: "device-1",
    posthog_enabled: false,
    cloud_enabled: false,
    cloud_choice: cloudChoice,
  });
}

beforeEach(() => {
  api = {
    telemetryGetConfig: vi.fn(),
    telemetrySetCloudEnabled: vi.fn(async () => ({ ok: true })),
  };
  savedChoice(null);
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Lets the saved-choice read and any answer finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const notice = () => screen.queryByRole("dialog", { name: "Dashboard sync" });

async function shown() {
  return screen.findByRole("dialog", { name: "Dashboard sync" });
}

describe("DashboardSyncNotice", () => {
  it("asks once signed in and past the intro with no saved choice, in the onboarding step's words", async () => {
    render(<DashboardSyncNotice signedIn introComplete />);
    const dialog = await shown();
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const text = QUESTION.replace(/\*\*/g, "");
    const paragraph = within(dialog).getByText(
      (_, el) => el?.tagName === "P" && el.textContent === text,
    );
    expect(within(paragraph).getByText("Settings → Privacy").tagName).toBe("STRONG");

    // The onboarding step's two buttons: the same look, keep before change.
    const keep = within(dialog).getByRole("button", { name: "Keep it on" });
    const turnOff = within(dialog).getByRole("button", { name: "Turn it off" });
    expect(keep.getAttribute("style")).toBe(turnOff.getAttribute("style"));
    expect(keep.compareDocumentPosition(turnOff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getAllByRole("button")).toHaveLength(2);
    expect(api.telemetrySetCloudEnabled).not.toHaveBeenCalled();
  });

  it("stays hidden when a choice is saved", async () => {
    savedChoice(true);
    const { unmount } = render(<DashboardSyncNotice signedIn introComplete />);
    await settle();
    expect(api.telemetryGetConfig).toHaveBeenCalled();
    expect(notice()).toBeNull();
    unmount();

    savedChoice(false);
    render(<DashboardSyncNotice signedIn introComplete />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("stays hidden when signed out, or before the intro is complete", async () => {
    const { rerender } = render(<DashboardSyncNotice signedIn={false} introComplete />);
    await settle();
    expect(notice()).toBeNull();

    rerender(<DashboardSyncNotice signedIn introComplete={false} />);
    await settle();
    expect(notice()).toBeNull();

    // Signing in past the intro asks.
    rerender(<DashboardSyncNotice signedIn introComplete />);
    await shown();
  });

  it("stays hidden while the saved choice can't be read", async () => {
    api.telemetryGetConfig.mockRejectedValue(new Error("ipc down"));
    render(<DashboardSyncNotice signedIn introComplete />);
    await settle();
    expect(notice()).toBeNull();
  });

  it("Keep it on saves dashboard sync on, then closes", async () => {
    render(<DashboardSyncNotice signedIn introComplete />);
    fireEvent.click(within(await shown()).getByRole("button", { name: "Keep it on" }));
    await settle();
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[true]]);
    expect(notice()).toBeNull();
  });

  it("Turn it off saves dashboard sync off, then closes", async () => {
    render(<DashboardSyncNotice signedIn introComplete />);
    fireEvent.click(within(await shown()).getByRole("button", { name: "Turn it off" }));
    await settle();
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[false]]);
    expect(notice()).toBeNull();
  });

  it("closes after an answer that couldn't be saved, or never reached the shell", async () => {
    api.telemetrySetCloudEnabled.mockResolvedValueOnce({
      ok: false,
      error: "Couldn't save the cloud sync setting: disk full. The change applies until Fleetify restarts.",
    });
    const first = render(<DashboardSyncNotice signedIn introComplete />);
    fireEvent.click(within(await shown()).getByRole("button", { name: "Turn it off" }));
    await settle();
    expect(notice()).toBeNull();
    first.unmount();

    api.telemetrySetCloudEnabled.mockRejectedValueOnce(new Error("ipc down"));
    render(<DashboardSyncNotice signedIn introComplete />);
    fireEvent.click(within(await shown()).getByRole("button", { name: "Keep it on" }));
    await settle();
    expect(notice()).toBeNull();
  });

  it("closes only through its buttons", async () => {
    render(<DashboardSyncNotice signedIn introComplete />);
    const dialog = await shown();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(dialog.parentElement!);
    fireEvent.click(dialog);
    await settle();
    expect(notice()).not.toBeNull();
    expect(api.telemetrySetCloudEnabled).not.toHaveBeenCalled();
  });

  it("answers once, however often it is clicked", async () => {
    render(<DashboardSyncNotice signedIn introComplete />);
    const dialog = await shown();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn it off" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it on" }));
    await settle();
    expect(api.telemetrySetCloudEnabled.mock.calls).toEqual([[false]]);
  });

  it("doesn't ask again after an answer when the user signs in again in the same session", async () => {
    // The answer wasn't saved, so the shell still reports no choice; it is
    // asked again at the next launch, not now.
    api.telemetrySetCloudEnabled.mockResolvedValueOnce({ ok: false, error: "disk full" });
    const { rerender } = render(<DashboardSyncNotice signedIn introComplete />);
    fireEvent.click(within(await shown()).getByRole("button", { name: "Keep it on" }));
    await settle();

    rerender(<DashboardSyncNotice signedIn={false} introComplete={false} />);
    await settle();
    rerender(<DashboardSyncNotice signedIn introComplete />);
    await settle();
    expect(notice()).toBeNull();
  });
});
