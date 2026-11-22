import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WindowCard } from "../window-card";
import { GeneralSection } from "../general-section";

const KEEP_RUNNING = /keep fleetify running when you close the window/i;

const WINDOWS_STAYS =
  "Fleetify stays in the notification area, and your agents keep working. To quit, right-click the Fleetify icon at the right end of the taskbar (it may be under the ^ arrow) and choose Quit Fleetify.";
const WINDOWS_NO_ICON =
  "Fleetify couldn't add its notification-area icon this time, so closing the window quits it.";
const MAC_STAYS =
  "Fleetify stays in the Dock, and your agents keep working. To quit, press ⌘Q, or right-click its Dock icon and choose Quit.";

/** The bridge on `platform` (`win32`, `darwin` or `linux`), with `saved` as
 *  fleet.config.json. setConfig stores what it is given, as config_set does.
 *  windowCanKeepRunning answers `canKeepRunning`, as the shell does: false
 *  on Windows when the notification-area icon couldn't be added. */
function bridge(platform: string, saved: Record<string, unknown> = {}, canKeepRunning = true) {
  let stored = { ...saved };
  const api = {
    platform,
    getConfig: vi.fn(async () => ({ ...stored })),
    setConfig: vi.fn(async (next: Record<string, unknown>) => {
      stored = next;
      return { ok: true };
    }),
    windowCanKeepRunning: vi.fn(async () => canKeepRunning),
    openFolderDialog: vi.fn(async () => null),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return { api, stored: () => stored };
}

describe("WindowCard", () => {
  it("on Windows, is on by default and says where Fleetify stays and how to quit it", async () => {
    const { api } = bridge("win32", { onboardingComplete: true });
    render(<WindowCard />);
    const toggle = await screen.findByRole("switch", { name: KEEP_RUNNING });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(WINDOWS_STAYS)).toBeInTheDocument();
    expect(api.windowCanKeepRunning).toHaveBeenCalled();
  });

  // The shell hides the window only while its notification-area icon is
  // there, so the row mustn't promise the notification area without it.
  it("on Windows without the notification-area icon, says closing the window quits", async () => {
    bridge("win32", {}, false);
    render(<WindowCard />);
    const toggle = await screen.findByRole("switch", { name: KEEP_RUNNING });
    // Still the saved setting, for a launch that has the icon.
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(WINDOWS_NO_ICON)).toBeInTheDocument();
    expect(screen.queryByText(/stays in the notification area/)).toBeNull();
  });

  it("on Windows, keeps the usual description when the shell can't answer", async () => {
    const { api } = bridge("win32");
    api.windowCanKeepRunning.mockRejectedValue(new Error("tauri-ipc-unavailable"));
    render(<WindowCard />);
    expect(await screen.findByRole("switch", { name: KEEP_RUNNING })).toBeInTheDocument();
    expect(screen.getByText(WINDOWS_STAYS)).toBeInTheDocument();
  });

  it("on macOS, says Fleetify stays in the Dock and how to quit it", async () => {
    const { api } = bridge("darwin");
    render(<WindowCard />);
    expect(await screen.findByRole("switch", { name: KEEP_RUNNING })).toBeInTheDocument();
    expect(screen.getByText(MAC_STAYS)).toBeInTheDocument();
    // The Dock is always there: nothing to ask.
    expect(api.windowCanKeepRunning).not.toHaveBeenCalled();
  });

  it("saves keepRunningOnClose=false when switched off, keeping the other settings", async () => {
    const { api, stored } = bridge("win32", { onboardingComplete: true, gitAttribution: false });
    render(<WindowCard />);
    const toggle = await screen.findByRole("switch", { name: KEEP_RUNNING });
    fireEvent.click(toggle);
    await waitFor(() => expect(stored().keepRunningOnClose).toBe(false));
    // Read-merge-write: config_set replaces the whole file.
    expect(api.setConfig).toHaveBeenLastCalledWith({
      onboardingComplete: true,
      gitAttribution: false,
      keepRunningOnClose: false,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a saved opt-out as off, and switching it back on saves true", async () => {
    const { stored } = bridge("darwin", { keepRunningOnClose: false });
    render(<WindowCard />);
    const toggle = await screen.findByRole("switch", { name: KEEP_RUNNING });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(stored().keepRunningOnClose).toBe(true));
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  // The shell reads the file when the window closes: the switch must not say
  // off while the file still says on.
  it("flips back and shows why when the save fails", async () => {
    const { api } = bridge("win32");
    api.setConfig.mockResolvedValue({ ok: false, error: "disk full" } as never);
    render(<WindowCard />);
    const toggle = await screen.findByRole("switch", { name: KEEP_RUNNING });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

describe("GeneralSection — the Window section", () => {
  it.each([
    ["win32", "Windows"],
    ["darwin", "macOS"],
  ])("is there on %s (%s)", async (platform) => {
    bridge(platform);
    render(<GeneralSection />);
    expect(await screen.findByRole("switch", { name: KEEP_RUNNING })).toBeInTheDocument();
    expect(screen.getByText(/^Window$/)).toBeInTheDocument();
  });

  // Closing the window always quits on Linux (no tray icon to come back to),
  // so there is nothing to switch.
  it("isn't there on Linux", async () => {
    bridge("linux");
    render(<GeneralSection />);
    // The other cards have loaded by now.
    expect(await screen.findByRole("switch", { name: /credit fleetify/i })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: KEEP_RUNNING })).toBeNull();
    expect(screen.queryByText(KEEP_RUNNING)).toBeNull();
    expect(screen.queryByText(/^Window$/)).toBeNull();
  });
});
