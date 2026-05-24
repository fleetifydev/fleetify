import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { GeneralSection } from "../general-section";

beforeEach(() => {
  localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getConfig: vi.fn(async () => ({})),
    setConfig: vi.fn(async () => true),
    openFolderDialog: vi.fn(async () => null),
  };
});

describe("GeneralSection (composed)", () => {
  it("renders all four section headers", async () => {
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/^Startup$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^Notifications$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Updates$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Privacy$/i)).toBeInTheDocument();
  });

  it("renders the four signature rows", async () => {
    render(<GeneralSection />);
    await waitFor(() => {
      expect(screen.getByText(/Launch on system startup/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Desktop notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic updates/i)).toBeInTheDocument();
    expect(screen.getByText(/Anonymous usage analytics/i)).toBeInTheDocument();
  });
});
