import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttributionCard } from "../attribution-card";

describe("AttributionCard", () => {
  it("is on by default and saves gitAttribution=false when switched off", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
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
  });

  it("shows a saved opt-out as off", async () => {
    window.electronAPI = {
      getConfig: vi.fn().mockResolvedValue({ onboardingComplete: true, apiKeys: {}, gitAttribution: false }),
      setConfig: vi.fn().mockResolvedValue(undefined),
    } as never;
    render(<AttributionCard />);
    const toggle = await screen.findByRole("switch", {
      name: /credit fleetify in commits and pull requests/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
