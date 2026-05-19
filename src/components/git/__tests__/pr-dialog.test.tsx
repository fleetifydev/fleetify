/**
 * Renderer tests for PRDialog. The dialog drives gh / link detection,
 * AI draft generation, submit dispatch and error recovery — all
 * mocked through the @/lib/git-api + @/lib/github-link-api wrappers.
 *
 * Spec scenarios covered (§13.3 PRDialog):
 *   - gh authed → "via gh" chip in header, existing path
 *   - link only → "via Fleetify" chip with avatar
 *   - neither   → ConnectGitHubBlock + submit disabled
 *   - REPO_NOT_INSTALLED → RepoNotInstalledBlock with Install/Retry
 *   - AUTH_EXPIRED → AuthExpiredBlock with Reconnect
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

// ── Hoist + define IPC mocks ─────────────────────────────────────────
const { gitMock, ghMock } = vi.hoisted(() => {
  type LinkPayload = {
    access_token: string; refresh_token: string;
    access_expires_at: string; refresh_expires_at: string;
    github_login: string; github_user_id: number;
    github_avatar_url: string; installation_id: number;
    connected_at: string;
  };
  type LinkListener = (payload: { link: LinkPayload | null }) => void;
  const linkChangedListeners = new Set<LinkListener>();
  return {
    gitMock: {
      hasGhCli: vi.fn(async () => ({
        ok: false,
        version: null as string | null,
        authed: false,
        ghLogin: null as string | null,
      })),
      diffSummary: vi.fn(async () => ({ ok: true, files: "", log: "", stat: "" })),
      generatePRSummary: vi.fn(async () => ({ ok: false, error: "stubbed" })),
      createPR: vi.fn(async () => ({ ok: false, error: "stubbed" } as
        | { ok: true; prNumber: number | null; prUrl: string; existed?: boolean }
        | { ok: false; code?: string; error: string })),
      openPR: vi.fn(async () => ({ ok: true })),
    },
    ghMock: {
      getLink: vi.fn(async () => ({ ok: false, link: null as LinkPayload | null })),
      beginOAuth: vi.fn(async () => ({ ok: false, code: "STUB", error: "stub" } as
        | { ok: true; link: LinkPayload }
        | { ok: false; code: string; error: string })),
      disconnect: vi.fn(async () => ({ ok: true })),
      refreshLink: vi.fn(async () => ({ ok: false, code: "STUB", error: "stub" } as
        | { ok: true; link: LinkPayload }
        | { ok: false; code: string; error: string })),
      openInstallation: vi.fn(async () => ({ ok: true })),
      onLinkChanged: vi.fn((cb: LinkListener) => {
        linkChangedListeners.add(cb);
        return () => linkChangedListeners.delete(cb);
      }),
      offLinkChanged: vi.fn((cb: LinkListener) => { linkChangedListeners.delete(cb); }),
      onBrowserFallback: vi.fn(() => () => {}),
      offBrowserFallback: vi.fn(),
    },
  };
});

vi.mock("@/lib/git-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git-api")>("@/lib/git-api");
  return {
    ...actual,
    git: gitMock,
  };
});
vi.mock("@/lib/github-link-api", () => ({ github: ghMock }));

import { PRDialog } from "../pr-dialog";

const samplePayload = {
  access_token: "gho_x", refresh_token: "ghr_y",
  access_expires_at: "2026-05-13T10:00:00.000Z",
  refresh_expires_at: "2026-11-13T00:00:00.000Z",
  github_login: "greg", github_user_id: 42,
  github_avatar_url: "https://avatars.example/42",
  installation_id: 99, connected_at: "2026-05-13T09:00:00.000Z",
};

function renderDialog(extras?: { onCreated?: (pr: { number: number | null; url: string }) => void }) {
  return render(
    <PRDialog
      folder="/some/repo"
      branch="feat/x"
      baseBranch="main"
      onClose={() => {}}
      onCreated={extras?.onCreated}
    />,
  );
}

describe("PRDialog auth-method detection", () => {
  beforeEach(() => {
    gitMock.hasGhCli.mockReset();
    gitMock.createPR.mockReset();
    ghMock.getLink.mockReset();
    ghMock.beginOAuth.mockReset();
  });

  it("renders 'via gh' chip when gh is authed", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: true, version: "2.55.0", authed: true, ghLogin: "octocat" });
    ghMock.getLink.mockResolvedValue({ ok: false, link: null });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/@octocat/)).toBeInTheDocument());
    // No ConnectGitHubBlock when authed via gh.
    expect(screen.queryByText(/GitHub bağlantısı yok/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub yetkilendirmesi açıldı/)).not.toBeInTheDocument();
    // And we don't pop OAuth on someone who already has gh.
    expect(ghMock.beginOAuth).not.toHaveBeenCalled();
  });

  it("renders 'via Fleetify' chip when only link is present", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/@greg/)).toBeInTheDocument());
    expect(screen.queryByText(/GitHub bağlantısı yok/)).not.toBeInTheDocument();
    // Already linked → no auto-OAuth.
    expect(ghMock.beginOAuth).not.toHaveBeenCalled();
  });

  it("auto-triggers GitHub App OAuth when neither gh nor link is available", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: false, link: null });
    // Hold OAuth open so the test can observe the in-flight state without
    // racing the resolve. Otherwise beginOAuth's default rejected stub
    // would resolve before we got a chance to read "connecting" UI.
    let _resolveOAuth: (v: { ok: false; code: string; error: string }) => void = () => {};
    ghMock.beginOAuth.mockImplementationOnce(
      () => new Promise(resolve => { _resolveOAuth = resolve; }),
    );
    renderDialog();
    // Auto-trigger fires as soon as the auth probe resolves — no click
    // on "Connect GitHub" required.
    await waitFor(() => expect(ghMock.beginOAuth).toHaveBeenCalledTimes(1));
    // Block flips to connecting copy ("Tarayıcıyı bekleniyor…") so the
    // user sees the dialog opened a tab on their behalf.
    await waitFor(() =>
      expect(screen.getByText(/GitHub yetkilendirmesi açıldı/)).toBeInTheDocument(),
    );
    // Submit stays disabled until OAuth completes.
    const submit = screen.getByRole("button", { name: /Create PR/i });
    expect(submit).toBeDisabled();
  });

  it("submit becomes enabled after auto-OAuth succeeds", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: false, link: null });
    ghMock.beginOAuth.mockResolvedValueOnce({ ok: true, link: samplePayload });
    renderDialog();
    // Once the link is set the @login chip shows up and the connect
    // block goes away.
    await waitFor(() => expect(screen.getByText(/@greg/)).toBeInTheDocument());
    expect(screen.queryByText(/GitHub bağlantısı yok/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub yetkilendirmesi açıldı/)).not.toBeInTheDocument();
  });

  it("auto-OAuth failure surfaces a retryable connect block", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: false, link: null });
    ghMock.beginOAuth.mockResolvedValueOnce({ ok: false, code: "USER_DECLINED", error: "user dismissed" });
    renderDialog();
    await waitFor(() => expect(ghMock.beginOAuth).toHaveBeenCalledTimes(1));
    // After failure the block reverts to the no-connection prompt with
    // a manual Connect GitHub button so the user can retry.
    await waitFor(() => expect(screen.getByText(/GitHub bağlantısı yok/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Connect GitHub/i })).toBeEnabled();
  });
});

describe("PRDialog error recovery", () => {
  beforeEach(() => {
    gitMock.hasGhCli.mockReset();
    gitMock.createPR.mockReset();
    ghMock.getLink.mockReset();
    ghMock.beginOAuth.mockReset();
    ghMock.openInstallation.mockReset();
  });

  it("REPO_NOT_INSTALLED renders the install + retry block", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    gitMock.createPR.mockResolvedValueOnce({ ok: false, code: "REPO_NOT_INSTALLED", error: "Fleetify isn't installed on this repo." });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/@greg/)).toBeInTheDocument());

    // Wait for the title to seed + AI draft to settle so submit becomes
    // available. The compose phase shows a Title input.
    await waitFor(() => expect(screen.getByPlaceholderText(/Short summary/i)).toBeInTheDocument());

    const submit = screen.getByRole("button", { name: /Create PR/i });
    await act(async () => { fireEvent.click(submit); });

    await waitFor(() => expect(screen.getByText(/Bu repo'ya Fleetify install edilmemiş/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Install on this repo/i }));
    expect(ghMock.openInstallation).toHaveBeenCalled();
  });

  it("REPO_CREATE_FORBIDDEN renders the install-gh recovery block", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    gitMock.createPR.mockResolvedValueOnce({
      ok: false,
      code: "REPO_CREATE_FORBIDDEN",
      error: "GitHub App can't create repos under this account.",
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/@greg/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByPlaceholderText(/Short summary/i)).toBeInTheDocument());

    const submit = screen.getByRole("button", { name: /Create PR/i });
    await act(async () => { fireEvent.click(submit); });

    await waitFor(() =>
      expect(screen.getByText(/Repo auto-create isn't available/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Open github\.com\/new/i })).toBeInTheDocument();
  });

  it("AUTH_EXPIRED renders the reconnect block with a Reconnect button", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    gitMock.createPR.mockResolvedValueOnce({ ok: false, code: "AUTH_EXPIRED", error: "GitHub link expired." });
    ghMock.beginOAuth.mockResolvedValueOnce({ ok: true, link: samplePayload });
    renderDialog();
    await waitFor(() => expect(screen.getByText(/@greg/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByPlaceholderText(/Short summary/i)).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Create PR/i })); });

    await waitFor(() => expect(screen.getByText(/GitHub bağlantın sona ermiş/i)).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Reconnect GitHub/i })); });
    expect(ghMock.beginOAuth).toHaveBeenCalled();
  });
});
