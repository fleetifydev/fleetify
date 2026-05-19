/**
 * Renderer tests for the GitHubTile settings card. Drives the 3
 * visual states (disconnected / connecting / connected) by mocking
 * the useGitHubLink hook directly so we can hold each state in place
 * for assertion.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

type Hook = typeof import("@/hooks/use-github-link")["useGitHubLink"];
const useGitHubLinkMock = vi.fn<Hook>();
vi.mock("@/hooks/use-github-link", () => ({
  useGitHubLink: () => useGitHubLinkMock(),
}));

import { GitHubTile } from "../github-tile";

const samplePayload = {
  access_token: "gho_x", refresh_token: "ghr_y",
  access_expires_at: "2026-05-13T10:00:00.000Z",
  refresh_expires_at: "2026-11-13T00:00:00.000Z",
  github_login: "greg", github_user_id: 42,
  github_avatar_url: "https://avatars.example/42",
  installation_id: 99, connected_at: "2026-05-13T09:00:00.000Z",
};

function makeHookValue(overrides: Partial<ReturnType<Hook>>): ReturnType<Hook> {
  return {
    state: { status: "disconnected" },
    link: null,
    browserFallbackUrl: null,
    connect: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => ({ ok: true })),
    openInstallation: vi.fn(async () => ({ ok: true })),
    refresh: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as ReturnType<Hook>;
}

describe("GitHubTile", () => {
  it("renders the loading state with a spinner", () => {
    useGitHubLinkMock.mockReturnValue(makeHookValue({ state: { status: "loading" } }));
    render(<GitHubTile />);
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
  });

  it("renders the disconnected state with a Connect button that calls connect()", () => {
    const connect = vi.fn(async () => ({ ok: true }));
    useGitHubLinkMock.mockReturnValue(makeHookValue({ state: { status: "disconnected" }, connect }));
    render(<GitHubTile />);
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
    // Disambiguate from the "Not connected" line — go through the button role.
    fireEvent.click(screen.getByRole("button", { name: /Connect/i }));
    expect(connect).toHaveBeenCalled();
  });

  it("renders the connecting state with a 'waiting' label", () => {
    useGitHubLinkMock.mockReturnValue(makeHookValue({ state: { status: "connecting" } }));
    render(<GitHubTile />);
    expect(screen.getByText(/Waiting for authorization/i)).toBeInTheDocument();
  });

  it("shows the browser fallback URL when connecting + fallback fires", () => {
    useGitHubLinkMock.mockReturnValue(makeHookValue({
      state: { status: "connecting" },
      browserFallbackUrl: "https://github.com/apps/fleetify/installations/new?state=ABC",
    }));
    render(<GitHubTile />);
    expect(screen.getByText(/Browser couldn't open/i)).toBeInTheDocument();
    expect(screen.getByText(/github\.com\/apps\/fleetify/i)).toBeInTheDocument();
  });

  it("renders the connected state with avatar, login, and management link", () => {
    const openInstallation = vi.fn(async () => ({ ok: true }));
    useGitHubLinkMock.mockReturnValue(makeHookValue({
      state: { status: "connected", link: samplePayload },
      link: samplePayload,
      openInstallation,
    }));
    render(<GitHubTile />);
    expect(screen.getByText("@greg")).toBeInTheDocument();
    expect(screen.getByText(/Manage repositories on GitHub/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Manage repositories on GitHub/i));
    expect(openInstallation).toHaveBeenCalled();
  });

  it("Disconnect requires a Confirm step before calling disconnect()", () => {
    const disconnect = vi.fn(async () => ({ ok: true }));
    useGitHubLinkMock.mockReturnValue(makeHookValue({
      state: { status: "connected", link: samplePayload },
      link: samplePayload,
      disconnect,
    }));
    render(<GitHubTile />);
    fireEvent.click(screen.getByText(/^Disconnect$/));
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/^Confirm$/));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("Switch chains disconnect + connect", async () => {
    const disconnect = vi.fn(async () => ({ ok: true }));
    const connect = vi.fn(async () => ({ ok: true }));
    useGitHubLinkMock.mockReturnValue(makeHookValue({
      state: { status: "connected", link: samplePayload },
      link: samplePayload,
      disconnect, connect,
    }));
    render(<GitHubTile />);
    fireEvent.click(screen.getByText(/^Switch$/));
    // Switch handler is async — give the event loop a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(disconnect).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
  });
});
