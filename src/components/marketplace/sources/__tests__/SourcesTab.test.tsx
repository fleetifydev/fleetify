/**
 * A marketplace source's repository link opens in the system browser. It
 * used to be a `target="_blank"` link, and Tauri's webview refuses new
 * windows: clicking it opened nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

/** Runs `action` with `window.open` stubbed and returns the calls it got.
 *  happy-dom follows a link click nothing cancelled with `window.open(href,
 *  target)`, so no call also means the click stayed in the app. */
function windowOpensDuring(action: () => void): unknown[][] {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    action();
    return [...open.mock.calls];
  } finally {
    open.mockRestore();
  }
}

describe("SourcesTab", () => {
  it("opens a source's repository in the system browser, never a new window", () => {
    render(<SourcesTab />);
    const link = screen.getByRole("link", { name: REPO });
    expect(link).toHaveAttribute("href", REPO);
    expect(link).not.toHaveAttribute("target");
    expect(windowOpensDuring(() => fireEvent.click(link))).toEqual([]);
    expect(openExternal).toHaveBeenCalledWith(REPO);
  });
});
