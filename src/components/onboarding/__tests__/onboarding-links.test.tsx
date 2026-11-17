/**
 * A link in an onboarding message opens in the system browser. It used to
 * be a plain markdown link: the main webview has no navigation guard, so a
 * click loaded the website in the app's window, in place of the onboarding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { Bubble } from "@/components/onboarding/onboarding-chat";

const win = window as unknown as {
  electronAPI?: unknown;
  happyDOM?: { setURL(url: string): void };
};
let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The release app's page: the embedded backend's origin.
  win.happyDOM?.setURL("http://127.0.0.1:8765/");
  openExternal = vi.fn(() => Promise.resolve(true));
  win.electronAPI = { openExternal };
});
afterEach(() => {
  delete win.electronAPI;
});

/** Clicks the link named `name`, and says whether the webview would follow
 *  it in place: whether nothing in the app cancelled the click. */
function followedInPlace(name: string): boolean {
  const link = screen.getByRole("link", { name });
  const click = createEvent.click(link);
  // happy-dom follows an uncancelled link click with window.open; stub it so
  // the test environment never navigates.
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    fireEvent(link, click);
  } finally {
    open.mockRestore();
  }
  return !click.defaultPrevented;
}

describe("onboarding messages", () => {
  it("open a link in the system browser, not in place of the onboarding", () => {
    render(
      <Bubble
        msg={{ id: "m1", sender: "assistant", text: "See [the docs](https://fleetify.dev/docs)." }}
        onProvidersConfirm={vi.fn()}
        onMainAgentPick={vi.fn()}
        onGithubResult={vi.fn()}
        onThemeConfirm={vi.fn()}
        onCloudSyncConsent={vi.fn()}
        onTelemetryConsent={vi.fn()}
      />,
    );
    expect(followedInPlace("the docs")).toBe(false);
    expect(openExternal).toHaveBeenCalledWith("https://fleetify.dev/docs");
  });
});
