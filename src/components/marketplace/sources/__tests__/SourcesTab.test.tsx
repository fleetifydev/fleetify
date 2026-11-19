/**
 * A marketplace source's repository link opens in the system browser, and
 * the click never loads the repository in place of the app. It used to be a
 * `target="_blank"` link, and Tauri's webview refuses new windows: clicking
 * it opened nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { usePluginStore } from "@/stores/plugin-store";
import { SourcesTab } from "../SourcesTab";

const REPO = "https://github.com/acme/fleet-plugins";

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
  usePluginStore.setState({
    sources: [{ id: "acme", name: "Acme plugins", repo_url: REPO, is_official: false, enabled: true }],
  });
});
afterEach(() => {
  delete win.electronAPI;
  usePluginStore.setState({ sources: [] });
});

/** Clicks `link` and reports what the app did with the click: whether it
 *  left the click to the webview (nothing cancelled it, so the webview loads
 *  the link in place of the app), and the `window.open` calls the app's code
 *  made. happy-dom follows a link through its own window object, not the
 *  global `window.open`, so the stub sees app code only. */
function click(link: HTMLElement): { leftToWebview: boolean; windowOpens: unknown[][] } {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    const event = createEvent.click(link);
    fireEvent(link, event);
    return { leftToWebview: !event.defaultPrevented, windowOpens: [...open.mock.calls] };
  } finally {
    open.mockRestore();
  }
}

describe("SourcesTab", () => {
  it("opens a source's repository in the system browser, not in the app's window", () => {
    render(<SourcesTab />);
    const link = screen.getByRole("link", { name: REPO });
    expect(link).toHaveAttribute("href", REPO);
    expect(link).not.toHaveAttribute("target");
    expect(click(link)).toEqual({ leftToWebview: false, windowOpens: [] });
    expect(openExternal).toHaveBeenCalledWith(REPO);
  });
});
