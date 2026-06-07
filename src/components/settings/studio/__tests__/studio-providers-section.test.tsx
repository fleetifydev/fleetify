/**
 * Smoke tests for StudioProvidersSection:
 * - renders a loading state initially
 * - renders the Higgsfield card when installed+authenticated
 * - renders install hint when not installed
 * - renders auth hint when installed but not authenticated
 * - Refresh button re-fetches
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/lib/studio-api", () => ({
  studioApi: { getTools: vi.fn() },
}));

import { StudioProvidersSection } from "../studio-providers-section";
import { studioApi } from "@/lib/studio-api";
const m = studioApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

const higgsfieldConnected = {
  id: "higgsfield",
  display_name: "Higgsfield",
  install_hint: "pip install higgsfield-cli",
  installed: true,
  authenticated: true,
};

const higgsfieldNotInstalled = {
  ...higgsfieldConnected,
  installed: false,
  authenticated: false,
};

const higgsfieldNotAuthenticated = {
  ...higgsfieldConnected,
  installed: true,
  authenticated: false,
};

beforeEach(() => {
  m.getTools.mockReset();
});
afterEach(() => cleanup());

describe("StudioProvidersSection", () => {
  it("shows loading state immediately", () => {
    m.getTools.mockReturnValue(new Promise(() => {})); // never resolves
    render(<StudioProvidersSection />);
    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });

  it("renders Higgsfield card when installed and authenticated", async () => {
    m.getTools.mockResolvedValue([higgsfieldConnected]);
    render(<StudioProvidersSection />);
    expect(await screen.findByText("Higgsfield")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Ready to use in Studio sessions.")).toBeInTheDocument();
  });

  it("shows install hint when not installed", async () => {
    m.getTools.mockResolvedValue([higgsfieldNotInstalled]);
    render(<StudioProvidersSection />);
    expect(await screen.findByText("Higgsfield")).toBeInTheDocument();
    expect(screen.getByText("pip install higgsfield-cli")).toBeInTheDocument();
  });

  it("shows auth hint when installed but not authenticated", async () => {
    m.getTools.mockResolvedValue([higgsfieldNotAuthenticated]);
    render(<StudioProvidersSection />);
    expect(await screen.findByText("Higgsfield")).toBeInTheDocument();
    expect(screen.getByText("hf auth login")).toBeInTheDocument();
  });

  it("Refresh button re-fetches getTools", async () => {
    m.getTools.mockResolvedValue([higgsfieldConnected]);
    render(<StudioProvidersSection />);
    await screen.findByText("Higgsfield");
    m.getTools.mockResolvedValue([higgsfieldConnected]);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(m.getTools).toHaveBeenCalledTimes(2));
  });

  it("shows fallback when getTools returns empty list", async () => {
    m.getTools.mockResolvedValue([]);
    render(<StudioProvidersSection />);
    expect(await screen.findByText(/No studio providers found/i)).toBeInTheDocument();
  });

  it("shows fallback on error", async () => {
    m.getTools.mockRejectedValue(new Error("network"));
    render(<StudioProvidersSection />);
    expect(await screen.findByText(/No studio providers found/i)).toBeInTheDocument();
  });
});
