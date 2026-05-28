import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PrivacyCard } from "../privacy-card";

vi.mock("@/lib/posthog", () => ({
  optIn: vi.fn(),
  optOut: vi.fn(),
}));

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getConfig: vi.fn(async () => ({
      telemetryEnabled: true,
      crashReportsEnabled: true,
    })),
    setConfig: vi.fn(async () => true),
    telemetryGetConfig: vi.fn(async () => ({
      distinct_id: "device-test",
      posthog_enabled: false,
    })),
    telemetrySetPosthogEnabled: vi.fn(async () => ({ ok: true })),
  };
});

describe("PrivacyCard", () => {
  it("renders all three rows (two existing + PostHog)", async () => {
    render(<PrivacyCard />);
    await waitFor(() => {
      expect(
        screen.getByText(/Anonymous usage analytics/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Crash reports/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Product analytics \(PostHog\)/i),
    ).toBeInTheDocument();
  });

  it("PostHog row copy promises the same privacy floor as the other rows", async () => {
    render(<PrivacyCard />);
    await waitFor(() => {
      expect(
        screen.getByText(/Product analytics \(PostHog\)/i),
      ).toBeInTheDocument();
    });
    // Description should explicitly mention what's NOT sent.
    expect(
      screen.getByText(
        /no message content, keys, or file paths/i,
      ),
    ).toBeInTheDocument();
  });

  it("calls telemetryGetConfig at mount to read the persisted PostHog flag", async () => {
    render(<PrivacyCard />);
    await waitFor(() => {
      expect(
        screen.getByText(/Product analytics \(PostHog\)/i),
      ).toBeInTheDocument();
    });
    const electronAPI = (window as unknown as {
      electronAPI: { telemetryGetConfig: ReturnType<typeof vi.fn> };
    }).electronAPI;
    expect(electronAPI.telemetryGetConfig).toHaveBeenCalledTimes(1);
  });
});
