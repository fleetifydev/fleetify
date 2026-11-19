/**
 * Settings' links to the web open in the system browser and never ask for a
 * new window: Tauri's webview refuses new windows, so the old fallback to
 * `window.open` opened nothing. Where there is no bridge (the renderer in a
 * plain browser), a click does nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The same store stubs as settings-diagnostics-button.test.tsx: the page's
// shell reads them, and the real stores write to localStorage and the DOM.
vi.mock("@/stores/app-store", () => ({
  useAppStore: (selector?: (s: unknown) => unknown) => {
    const state = { setMainView: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/stores/theme-store", () => ({
  useThemeStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      mode: "dark" as const,
      theme: "dark" as const,
      colorTheme: "zinc" as const,
      setMode: vi.fn(),
      cycleMode: vi.fn(),
      setColorTheme: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

import { SettingsPage } from "../settings-page";

const HOSTED_SETTINGS = "https://app.fleetify.dev/dashboard/settings";
const DOCS = "https://fleetify.dev/docs";

const win = window as unknown as { electronAPI?: unknown };
let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openExternal = vi.fn(() => Promise.resolve(true));
  win.electronAPI = { openExternal };
});
afterEach(() => {
  delete win.electronAPI;
});

/** Runs `action` with `window.open` stubbed and returns the calls it got. */
function windowOpensDuring(action: () => void): unknown[][] {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    action();
    return [...open.mock.calls];
  } finally {
    open.mockRestore();
  }
}

describe("Settings links to the web", () => {
  it("Account → Change settings opens the hosted settings in the system browser", () => {
    render(<SettingsPage initialTab="Account" onClose={() => {}} />);
    const button = screen.getByRole("button", { name: /Change settings/i });
    expect(windowOpensDuring(() => fireEvent.click(button))).toEqual([]);
    expect(openExternal).toHaveBeenCalledWith(HOSTED_SETTINGS);
  });

  it("Get Help opens the docs in the system browser", () => {
    render(<SettingsPage initialTab="Account" onClose={() => {}} />);
    const button = screen.getByRole("button", { name: "Get Help" });
    expect(windowOpensDuring(() => fireEvent.click(button))).toEqual([]);
    expect(openExternal).toHaveBeenCalledWith(DOCS);
  });

  it("open no new window where there is no bridge", () => {
    delete win.electronAPI;
    render(<SettingsPage initialTab="Account" onClose={() => {}} />);
    const changeSettings = screen.getByRole("button", { name: /Change settings/i });
    const getHelp = screen.getByRole("button", { name: "Get Help" });
    expect(windowOpensDuring(() => fireEvent.click(changeSettings))).toEqual([]);
    expect(windowOpensDuring(() => fireEvent.click(getHelp))).toEqual([]);
  });
});
