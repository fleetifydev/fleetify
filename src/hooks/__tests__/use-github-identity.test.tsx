import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useGitHubIdentity } from "../use-github-identity";

const samplePayload = {
  access_token: "gho_x", refresh_token: "ghr_y",
  access_expires_at: "2026-05-13T10:00:00.000Z",
  refresh_expires_at: "2026-11-13T00:00:00.000Z",
  github_login: "octocat", github_user_id: 42,
  github_avatar_url: "https://avatars.example/42",
  installation_id: 99, connected_at: "2026-05-13T09:00:00.000Z",
};

function mockElectron(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    github: {
      getLink: vi.fn(async () => ({ ok: true, link: null })),
      beginOAuth: vi.fn(async () => ({ ok: true, link: samplePayload })),
      disconnect: vi.fn(async () => ({ ok: true })),
      refreshLink: vi.fn(async () => ({ ok: true, link: samplePayload })),
      openInstallation: vi.fn(async () => ({ ok: true })),
      onLinkChanged: vi.fn(() => () => {}),
      offLinkChanged: vi.fn(),
      onBrowserFallback: vi.fn(() => () => {}),
      offBrowserFallback: vi.fn(),
    },
    hasGhCli: vi.fn(async () => ({ ok: true, authed: false, ghLogin: null })),
    ghAuthLoginCapture: vi.fn(async () => ({ ok: true, login: "octocat" })),
    ghAuthLoginCancel: vi.fn(async () => ({ ok: true })),
    onGhAuthEvent: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe("useGitHubIdentity", () => {
  beforeEach(() => {
    localStorage.clear();
    mockElectron();
  });

  it("starts enabled by default (master toggle ON)", async () => {
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
  });

  it("persists enabled state to localStorage", async () => {
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setEnabled(false));
    expect(localStorage.getItem("fleet:settings:github-enabled")).toBe("0");
  });

  it("resolves OAuth identity when method=oauth and link exists", async () => {
    localStorage.setItem("fleet:github-auth-method", "oauth");
    mockElectron({
      github: {
        getLink: vi.fn(async () => ({ ok: true, link: samplePayload })),
        beginOAuth: vi.fn(),
        disconnect: vi.fn(),
        refreshLink: vi.fn(),
        openInstallation: vi.fn(),
        onLinkChanged: vi.fn(() => () => {}),
        offLinkChanged: vi.fn(),
        onBrowserFallback: vi.fn(() => () => {}),
        offBrowserFallback: vi.fn(),
      },
    });
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.identity).toEqual({
      source: "oauth",
      login: "octocat",
      avatarUrl: "https://avatars.example/42",
      connectedAt: "2026-05-13T09:00:00.000Z",
    });
  });

  it("resolves CLI identity when method=cli and gh is authed", async () => {
    localStorage.setItem("fleet:github-auth-method", "cli");
    mockElectron({
      hasGhCli: vi.fn(async () => ({ ok: true, authed: true, ghLogin: "octocat" })),
    });
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.identity).toEqual({ source: "cli", login: "octocat" });
  });

  it("returns identity=null when method=skip", async () => {
    localStorage.setItem("fleet:github-auth-method", "skip");
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.identity).toBeNull();
  });

  it("beginOAuth sets method=oauth on success", async () => {
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.beginOAuth(); });
    expect(localStorage.getItem("fleet:github-auth-method")).toBe("oauth");
  });

  it("disconnect clears method and identity", async () => {
    localStorage.setItem("fleet:github-auth-method", "oauth");
    const { result } = renderHook(() => useGitHubIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.disconnect(); });
    expect(localStorage.getItem("fleet:github-auth-method")).toBeNull();
    expect(result.current.identity).toBeNull();
  });
});
