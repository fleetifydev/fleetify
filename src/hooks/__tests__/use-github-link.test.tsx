/**
 * Renderer tests for the useGitHubLink hook. Mocks the github IPC
 * wrapper at module level so we can drive the state machine without
 * Electron in the loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// ── Mock the IPC wrapper. Hoist a shared store so each test can
//    re-shape getLink / beginOAuth / disconnect responses + manually
//    fire the onLinkChanged subscriber. ──────────────────────────────
const { ghMock, fireLinkChanged, fireBrowserFallback } = vi.hoisted(() => {
  type LinkPayload = {
    access_token: string; refresh_token: string;
    access_expires_at: string; refresh_expires_at: string;
    github_login: string; github_user_id: number;
    github_avatar_url: string; installation_id: number;
    connected_at: string;
  };
  type LinkChangedListener = (payload: { link: LinkPayload | null }) => void;
  type FallbackListener = (payload: { url: string }) => void;
  const linkChangedListeners = new Set<LinkChangedListener>();
  const browserFallbackListeners = new Set<FallbackListener>();
  const mock = {
    getLink: vi.fn(async () => ({ ok: true as boolean, link: null as LinkPayload | null })),
    beginOAuth: vi.fn(async () =>
      ({ ok: false, code: "TEST_DEFAULT", error: "override per test" } as
        | { ok: true; link: LinkPayload }
        | { ok: false; code: string; error: string }),
    ),
    disconnect: vi.fn(async () => ({ ok: true as boolean })),
    refreshLink: vi.fn(async () =>
      ({ ok: false, code: "TEST_DEFAULT", error: "override per test" } as
        | { ok: true; link: LinkPayload }
        | { ok: false; code: string; error: string }),
    ),
    openInstallation: vi.fn(async () => ({ ok: true as boolean })),
    onLinkChanged: vi.fn((cb: LinkChangedListener) => {
      linkChangedListeners.add(cb);
      return () => linkChangedListeners.delete(cb);
    }),
    offLinkChanged: vi.fn((cb: LinkChangedListener) => { linkChangedListeners.delete(cb); }),
    onBrowserFallback: vi.fn((cb: FallbackListener) => {
      browserFallbackListeners.add(cb);
      return () => browserFallbackListeners.delete(cb);
    }),
    offBrowserFallback: vi.fn((cb: FallbackListener) => { browserFallbackListeners.delete(cb); }),
  };
  return {
    ghMock: mock,
    fireLinkChanged: (link: LinkPayload | null) => {
      for (const l of linkChangedListeners) l({ link });
    },
    fireBrowserFallback: (url: string) => {
      for (const l of browserFallbackListeners) l({ url });
    },
  };
});

vi.mock("@/lib/github-link-api", () => ({ github: ghMock }));

// Sample payload used across tests.
const samplePayload = {
  access_token: "gho_test", refresh_token: "ghr_test",
  access_expires_at: "2026-05-13T10:00:00.000Z",
  refresh_expires_at: "2026-11-13T00:00:00.000Z",
  github_login: "greg", github_user_id: 42,
  github_avatar_url: "https://avatars.example/42",
  installation_id: 99, connected_at: "2026-05-13T09:00:00.000Z",
};

import { useGitHubLink } from "../use-github-link";

describe("useGitHubLink", () => {
  beforeEach(() => {
    ghMock.getLink.mockReset();
    ghMock.beginOAuth.mockReset();
    ghMock.disconnect.mockReset();
    ghMock.refreshLink.mockReset();
  });

  it("starts in loading, then resolves to disconnected when there's no link", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: false, link: null });
    const { result } = renderHook(() => useGitHubLink());
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state.status).toBe("disconnected"));
    expect(result.current.link).toBeNull();
  });

  it("resolves to connected when getLink returns a link", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: true, link: samplePayload });
    const { result } = renderHook(() => useGitHubLink());
    await waitFor(() => expect(result.current.state.status).toBe("connected"));
    expect(result.current.link?.github_login).toBe("greg");
  });

  it("connect() flips to connecting and then to connected on success", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: false, link: null });
    ghMock.beginOAuth.mockResolvedValueOnce({ ok: true, link: samplePayload });
    const { result } = renderHook(() => useGitHubLink());
    await waitFor(() => expect(result.current.state.status).toBe("disconnected"));

    let connectPromise: Promise<{ ok: boolean }>;
    act(() => { connectPromise = result.current.connect(); });
    // Pending after the act flush — we kicked off beginOAuth but it
    // hasn't resolved yet.
    expect(["connecting", "connected"]).toContain(result.current.state.status);
    await act(async () => { await connectPromise!; });
    expect(result.current.state.status).toBe("connected");
    expect(result.current.link?.github_login).toBe("greg");
  });

  it("connect() returns to disconnected on failure with the error payload", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: false, link: null });
    ghMock.beginOAuth.mockResolvedValueOnce({ ok: false, code: "TIMEOUT", error: "timed out" });
    const { result } = renderHook(() => useGitHubLink());
    await waitFor(() => expect(result.current.state.status).toBe("disconnected"));

    let out: { ok: boolean; code?: string; error?: string } | undefined;
    await act(async () => { out = await result.current.connect(); });
    expect(result.current.state.status).toBe("disconnected");
    expect(out?.ok).toBe(false);
    expect(out?.code).toBe("TIMEOUT");
  });

  it("disconnect() flips state to disconnected", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: true, link: samplePayload });
    ghMock.disconnect.mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => useGitHubLink());
    await waitFor(() => expect(result.current.state.status).toBe("connected"));

    await act(async () => { await result.current.disconnect(); });
    expect(result.current.state.status).toBe("disconnected");
  });

  it("github-link-changed event updates state across components", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: false, link: null });
    const { result } = renderHook(() => useGitHubLink());
    await waitFor(() => expect(result.current.state.status).toBe("disconnected"));

    act(() => { fireLinkChanged(samplePayload); });
    await waitFor(() => expect(result.current.state.status).toBe("connected"));
    expect(result.current.link?.github_login).toBe("greg");

    act(() => { fireLinkChanged(null); });
    await waitFor(() => expect(result.current.state.status).toBe("disconnected"));
  });

  it("browser-fallback event surfaces the URL", async () => {
    ghMock.getLink.mockResolvedValueOnce({ ok: false, link: null });
    const { result } = renderHook(() => useGitHubLink());
    await waitFor(() => expect(result.current.state.status).toBe("disconnected"));

    act(() => { fireBrowserFallback("https://github.com/apps/fleetify/installations/new?state=X"); });
    await waitFor(() => expect(result.current.browserFallbackUrl).toContain("github.com/apps/"));
  });
});
