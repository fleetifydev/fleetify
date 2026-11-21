/**
 * The sign-in screen links fleetify.dev's Terms of Service and Privacy
 * Policy. Each link opens in the system browser: the main window doesn't
 * stop a page from another site, so a link followed in place would load the
 * website in the app's window, in place of the sign-in screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { WelcomeScreen } from "@/components/onboarding/welcome-screen";

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

/** Clicks `link`, and says whether the webview would follow it in place:
 *  whether nothing in the app cancelled the click. */
function followedInPlace(link: HTMLElement): boolean {
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

describe("the sign-in screen", () => {
  it("says that signing in accepts the Terms of Service, and points to the Privacy Policy", () => {
    render(<WelcomeScreen onAuth={vi.fn()} />);
    const line = screen.getByRole("link", { name: "Terms of Service" }).closest("p");
    expect(line?.textContent).toBe(
      "By signing in, you agree to the Terms of Service and acknowledge the Privacy Policy.",
    );
  });

  it.each([
    ["Terms of Service", "https://fleetify.dev/legal/terms"],
    ["Privacy Policy", "https://fleetify.dev/legal/privacy"],
  ])("opens the %s in the system browser, not in place of the sign-in screen", (name, url) => {
    render(<WelcomeScreen onAuth={vi.fn()} />);
    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", url);
    expect(followedInPlace(link)).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
  });
});
