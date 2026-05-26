import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GitHubIntegrationTile } from "../github-integration-tile";

type Hook = typeof import("@/hooks/use-github-identity")["useGitHubIdentity"];
const hookMock = vi.fn<Hook>();
vi.mock("@/hooks/use-github-identity", () => ({
  useGitHubIdentity: () => hookMock(),
}));

function makeHook(over: Partial<ReturnType<Hook>> = {}): ReturnType<Hook> {
  return {
    enabled: true,
    setEnabled: vi.fn(),
    method: null,
    identity: null,
    loading: false,
    ghCli: { kind: "needs-auth" },
    beginOAuth: vi.fn(async () => ({ ok: true })),
    cancelOAuth: vi.fn(async () => {}),
    beginCliAuth: vi.fn(async () => ({ ok: true })),
    cancelCliAuth: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    onCliAuthEvent: vi.fn(() => () => {}),
    refresh: vi.fn(async () => {}),
    ...over,
  } as ReturnType<Hook>;
}

describe("GitHubIntegrationTile", () => {
  it("renders loading state", () => {
    hookMock.mockReturnValue(makeHook({ loading: true }));
    render(<GitHubIntegrationTile />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it("shows master toggle in the header", () => {
    hookMock.mockReturnValue(makeHook());
    render(<GitHubIntegrationTile />);
    expect(screen.getByRole("switch", { name: /GitHub/i })).toBeInTheDocument();
  });

  it("renders OAuth + CLI choice rows when enabled and no method picked", () => {
    hookMock.mockReturnValue(makeHook({ method: null, identity: null }));
    render(<GitHubIntegrationTile />);
    expect(screen.getByRole("button", { name: /Connect with GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Use GitHub CLI/i })).toBeInTheDocument();
  });

  it("renders 'Not Installed' badge on the CLI row when gh is missing", () => {
    hookMock.mockReturnValue(makeHook({ ghCli: { kind: "missing" } }));
    render(<GitHubIntegrationTile />);
    expect(screen.getByText(/Not Installed/i)).toBeInTheDocument();
  });

  it("renders the OAuth-connected state with login and avatar", () => {
    hookMock.mockReturnValue(makeHook({
      method: "oauth",
      identity: { source: "oauth", login: "octocat", avatarUrl: "https://e.x/a", connectedAt: "2026-05-13T09:00:00.000Z" },
    }));
    render(<GitHubIntegrationTile />);
    expect(screen.getByText(/@octocat/)).toBeInTheDocument();
    expect(screen.getByText(/via Fleetify OAuth/)).toBeInTheDocument();
  });

  it("renders the CLI-connected state", () => {
    hookMock.mockReturnValue(makeHook({
      method: "cli",
      identity: { source: "cli", login: "octocat" },
    }));
    render(<GitHubIntegrationTile />);
    expect(screen.getByText(/@octocat/)).toBeInTheDocument();
    expect(screen.getByText(/via gh CLI/)).toBeInTheDocument();
  });

  it("clicking the master toggle calls setEnabled with the inverse value", () => {
    const setEnabled = vi.fn();
    hookMock.mockReturnValue(makeHook({ enabled: true, setEnabled }));
    render(<GitHubIntegrationTile />);
    fireEvent.click(screen.getByRole("switch", { name: /GitHub/i }));
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it("clicking Connect with GitHub calls beginOAuth", async () => {
    const beginOAuth = vi.fn(async () => ({ ok: true }));
    hookMock.mockReturnValue(makeHook({ beginOAuth }));
    render(<GitHubIntegrationTile />);
    fireEvent.click(screen.getByRole("button", { name: /Connect with GitHub/i }));
    expect(beginOAuth).toHaveBeenCalled();
  });
});
