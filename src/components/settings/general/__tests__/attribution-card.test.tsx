import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttributionCard } from "../attribution-card";

describe("AttributionCard", () => {
  it("is on by default and saves gitAttribution=false when switched off", async () => {
    const setConfig = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true, apiKeys: {} }),
      setConfig,
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(
        'Adds a "Co-Authored-By: Fleetify" line to commits Fleetify makes and a short footer to pull requests it opens.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    // Read-merge-write: the rest of the config is written back untouched.
    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ onboardingComplete: true, apiKeys: {}, gitAttribution: false }),
      ),
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a saved opt-out as off", async () => {
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true, apiKeys: {}, gitAttribution: false }),
      setConfig: vi.fn().mockResolvedValue({ ok: true }),
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  // config_set answers `{ ok: false, error }` when it couldn't write the file.
  // The switch must not show "off" while the file still says on: the next
  // Create PR reads the file and would still add the trailer.
  it("flips back and shows the shell's message when the save fails", async () => {
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
      setConfig: vi.fn().mockResolvedValue({ ok: false, error: "x" }),
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("x");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("clears the message on the next save that works", async () => {
    const setConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "x" })
      .mockResolvedValue({ ok: true });
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
      setConfig,
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("x");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ gitAttribution: false }),
    );
  });

  it("shows the message when the bridge throws", async () => {
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
      setConfig: vi.fn().mockRejectedValue(new Error("IPC closed")),
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("IPC closed");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("ends on the saved value when two quick changes both fail", async () => {
    // The second click is computed from the first one's optimistic value;
    // reverting each to "what it replaced" would leave the switch off.
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
      setConfig: vi.fn().mockResolvedValue({ ok: false, error: "x" }),
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    fireEvent.click(toggle); // on → off
    fireEvent.click(toggle); // off → on
    await waitFor(() =>
      expect(window.electronAPI!.setConfig).toHaveBeenCalledTimes(2),
    );
    await screen.findByRole("alert");
    // Let the second failure land too.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
