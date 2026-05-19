import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  gitContextMock, prStatusMock, createPRMock, reviewDiffMock,
  diagnoseFailureMock, applyRecoveryMock, preflightCheckMock,
  applyPreflightFixMock, mergePRMock, syncMainMock, carveNextRoundMock,
  pushNotificationMock, hasGhCliMock, getLinkMock, beginOAuthMock,
} = vi.hoisted(() => ({
  gitContextMock: vi.fn(),
  prStatusMock: vi.fn().mockResolvedValue({ ok: true, pr: null }),
  createPRMock: vi.fn(),
  reviewDiffMock: vi.fn(),
  diagnoseFailureMock: vi.fn(),
  applyRecoveryMock: vi.fn(),
  preflightCheckMock: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  applyPreflightFixMock: vi.fn(),
  mergePRMock: vi.fn(),
  syncMainMock: vi.fn(),
  carveNextRoundMock: vi.fn(),
  pushNotificationMock: vi.fn(),
  // Auth probes for executeCreatePR's pre-flight. Default: gh authed
  // so the existing scenarios (which were written against the old
  // "no pre-flight" code path) skip the OAuth branch and land on
  // createPR like before. Individual tests opt into the no-auth
  // path by overriding both probes to return false.
  hasGhCliMock: vi.fn().mockResolvedValue({ ok: true, version: "2.55.0", authed: true, ghLogin: "test" }),
  getLinkMock: vi.fn().mockResolvedValue({ ok: false, link: null }),
  beginOAuthMock: vi.fn().mockResolvedValue({ ok: false, code: "STUB", error: "stub" }),
}));

vi.mock("@/lib/git-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git-api")>("@/lib/git-api");
  return {
    ...actual,
    git: {
      ...actual.git,
      createPR: (folder: string, opts: { title: string; body?: string; base?: string; draft?: boolean; tool?: string; featureBranch?: string }) =>
        createPRMock(folder, opts),
      diffSummary: async () => ({ ok: true, files: "", log: "", stat: "" }),
      generatePRSummary: async () => ({ ok: false, error: "" }),
      hasGhCli: () => hasGhCliMock(),
      reviewDiff: (folder: string, baseBranch?: string, tool?: string) =>
        reviewDiffMock(folder, baseBranch, tool),
      diagnoseFailure: (folder: string, errorMessage: string, tool?: string, context?: string, baseBranch?: string) =>
        diagnoseFailureMock(folder, errorMessage, tool, context, baseBranch),
      applyRecovery: (folder: string, action: string, baseBranch?: string, command?: string) =>
        applyRecoveryMock(folder, action, baseBranch, command),
      preflightCheck: (folder: string) => preflightCheckMock(folder),
      applyPreflightFix: (folder: string, action: string, data?: object) =>
        applyPreflightFixMock(folder, action, data),
      mergePR: (folder: string, prNumber: number | null, method?: string) =>
        mergePRMock(folder, prNumber, method),
      syncMain: (folder: string, baseBranch?: string) =>
        syncMainMock(folder, baseBranch),
      carveNextRound: (folder: string, branch: string, baseBranch?: string) =>
        carveNextRoundMock(folder, branch, baseBranch),
    },
  };
});

vi.mock("@/lib/github-link-api", () => ({
  github: {
    getLink: () => getLinkMock(),
    beginOAuth: () => beginOAuthMock(),
    disconnect: async () => ({ ok: true }),
    refreshLink: async () => ({ ok: false, code: "STUB", error: "stub" }),
    openInstallation: async () => ({ ok: true }),
    onLinkChanged: () => () => {},
    offLinkChanged: () => {},
    onBrowserFallback: () => () => {},
    offBrowserFallback: () => {},
  },
}));

vi.mock("@/stores/app-store", async () => {
  const actual = await vi.importActual<typeof import("@/stores/app-store")>("@/stores/app-store");
  return {
    ...actual,
    useAppStore: Object.assign(
      () => ({ pushNotification: pushNotificationMock }),
      { getState: () => ({ pushNotification: pushNotificationMock }) },
    ),
  };
});

Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: {
    getGitContext: (folder: string) => gitContextMock(folder),
    getProjectRoot: async () => "/repo",
    getPRStatus: (folder: string) => prStatusMock(folder),
  },
});

async function loadBranchStrip() {
  const mod = await import("../chat-input");
  return mod;
}

beforeEach(() => {
  gitContextMock.mockReset();
  prStatusMock.mockReset();
  reviewDiffMock.mockReset();
  diagnoseFailureMock.mockReset();
  applyRecoveryMock.mockReset();
  preflightCheckMock.mockReset();
  applyPreflightFixMock.mockReset();
  mergePRMock.mockReset();
  syncMainMock.mockReset();
  carveNextRoundMock.mockReset();
  hasGhCliMock.mockReset();
  getLinkMock.mockReset();
  beginOAuthMock.mockReset();
  prStatusMock.mockResolvedValue({ ok: true, pr: null });
  // Default: preflight clean + auth available (gh authed). Individual
  // tests override these to exercise the no-auth → auto-OAuth branch.
  preflightCheckMock.mockResolvedValue({ ok: true, issues: [] });
  hasGhCliMock.mockResolvedValue({ ok: true, version: "2.55.0", authed: true, ghLogin: "test" });
  getLinkMock.mockResolvedValue({ ok: false, link: null });
  beginOAuthMock.mockResolvedValue({ ok: false, code: "STUB", error: "stub" });
  // onMerge done-ok now fires doSyncAndCarve directly, which calls
  // syncMain + carveNextRound. Tests that exercise the Merge button
  // need sensible defaults so the post-merge chain doesn't throw on
  // unmocked promises. Individual tests can still override.
  syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: null });
  carveNextRoundMock.mockResolvedValue({ ok: true, branch: "fleet/x-a1b2c3d4", base: "main" });
});

describe("BranchStrip — 6 visual states", () => {
  it("STATE 1: no git → '⊘ No git' pill + NO Create PR (branch carving not yet wired)", async () => {
    gitContextMock.mockResolvedValue({ branch: null, baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText(/No git/i)).toBeInTheDocument());
    // Branch-carving for noGit is future work — button hidden for now
    expect(screen.queryByRole("button", { name: /Create PR/i })).toBeNull();
  });

  it("STATE 3a: on main + no diff + no remote → just 'main' pill, no Create PR", async () => {
    gitContextMock.mockResolvedValue({ branch: "main", baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Create PR/i })).toBeNull();
  });

  it("STATE 3b: on main + diff + no remote → 'main' pill, NO Create PR (carving not yet wired)", async () => {
    gitContextMock.mockResolvedValue({ branch: "main", baseBranch: null, plus: 5, minus: 2, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Create PR/i })).toBeNull();
  });

  it("STATE 4: feature + no remote (bug fix) → 'main ← fleet/x' + Create PR", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/auth-fix-a1b2c3d4", baseBranch: null, plus: 5, minus: 2, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText(/fleet\/auth-fix-a1b2c3d4/)).toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();   // assumed base
    // ArrowLeft (lucide) renders an SVG; assert on data-testid or
    // class so we don't rely on text content. The existing block
    // uses `<ArrowLeft ... aria-hidden />` — find by its SVG role.
    const arrows = document.querySelectorAll("svg.lucide-arrow-left");
    expect(arrows.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Create PR/i })).toBeEnabled();
  });

  it("STATE 5: feature + remote + no PR → existing happy path", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText(/fleet\/x-a1b2c3d4/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Create PR/i })).toBeEnabled();
  });

  it("STATE 6: feature + remote + PR exists → Merge button", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r" });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: {
        number: 42, url: "https://github.com/u/r/pull/42",
        state: "OPEN", mergeable: "MERGEABLE", isDraft: false,
        baseRefName: "main", headRefName: "fleet/x-a1b2c3d4",
        checks: { passing: 0, failing: 0, pending: 0, total: 0 },
        commentsCount: 0,
      },
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Merge/i })).toBeEnabled());
  });

  it("STATE 4: very long branch name is middle-truncated with ellipsis", async () => {
    const longBranch = "fleet/an-extraordinarily-long-feature-branch-name-with-many-words-a1b2c3d4";
    gitContextMock.mockResolvedValue({ branch: longBranch, baseBranch: null, plus: 1, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // After truncateMid(branch, 32), the rendered text should contain an ellipsis (…).
    await waitFor(() => expect(screen.getByText(/…/)).toBeInTheDocument());
  });
});

describe("BranchStrip — onDefaultBranch logic", () => {
  it("null baseBranch + 'main' branch → no arrow (on default)", async () => {
    gitContextMock.mockResolvedValue({ branch: "main", baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    // No ArrowLeft icon on default — there's nothing to merge into
    expect(document.querySelectorAll("svg.lucide-arrow-left").length).toBe(0);
  });

  it("null baseBranch + 'fleet/x' → ArrowLeft visible (not default)", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText(/fleet\/x-a1b2c3d4/)).toBeInTheDocument());
    expect(document.querySelectorAll("svg.lucide-arrow-left").length).toBeGreaterThan(0);
  });
});

describe("computeBranchName", () => {
  it("mirrors the backend's fleet/<slug>-<short-id> convention", async () => {
    const { computeBranchName } = await loadBranchStrip();
    const result = computeBranchName("My cool app!", "abc12345-x-y-z");
    expect(result).toBe("fleet/My-cool-app-abc12345");
  });

  it("falls back to session_id when label is empty / null", async () => {
    const { computeBranchName } = await loadBranchStrip();
    expect(computeBranchName(null, "abc12345-x-y-z")).toMatch(/^fleet\/abc12345-x-y-z/);
    expect(computeBranchName("", "abc12345-x-y-z")).toMatch(/^fleet\/abc12345-x-y-z/);
  });

  it("strips invalid characters from the slug", async () => {
    const { computeBranchName } = await loadBranchStrip();
    const result = computeBranchName("feat: auth + 2FA!!", "abc12345-x-y-z");
    expect(result).not.toMatch(/[+!:]/);
    expect(result).toMatch(/^fleet\/feat-auth-2FA/);
  });
});

describe("BranchStrip — planned label + bootstrap Create PR", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    pushNotificationMock.mockReset();
  });

  it("STATE 1 + plannedBranch: renders 'main ← fleet/...' AND a working Create PR button", async () => {
    gitContextMock.mockResolvedValue({ branch: null, baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" />);
    // Both pills surface: dimmed "main" baseline + dimmed planned target
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.getByText(/fleet\/my-app-abc12345/)).toBeInTheDocument();
    // The bootstrap CTA is now exposed (Phase-1 hide is lifted when we have a plannedBranch)
    expect(screen.getByRole("button", { name: /Create PR/i })).toBeEnabled();
  });

  it("STATE 1 + plannedBranch: clicking Create PR passes featureBranch to the dispatcher", async () => {
    gitContextMock.mockResolvedValue({ branch: null, baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    createPRMock.mockResolvedValue({
      ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1",
      repoCreated: true, repoUrl: "https://github.com/u/r",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" sessionTitle="My app" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(createPRMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ featureBranch: "fleet/my-app-abc12345" }),
      );
    });
  });

  it("STATE 3b + plannedBranch: on-default with diff renders the planned target dimmed beside main", async () => {
    gitContextMock.mockResolvedValue({ branch: "main", baseBranch: null, plus: 5, minus: 2, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" />);
    await waitFor(() => expect(screen.getByText(/fleet\/my-app-abc12345/)).toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create PR/i })).toBeEnabled();
  });

  it("STATE 3b + plannedBranch: click forwards featureBranch", async () => {
    gitContextMock.mockResolvedValue({ branch: "main", baseBranch: null, plus: 5, minus: 2, remoteHttpsUrl: null });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 7, prUrl: "https://github.com/u/r/pull/7" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(createPRMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ featureBranch: "fleet/my-app-abc12345" }),
      );
    });
  });

  it("STATE 5: feature branch already carved → click does NOT forward featureBranch", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/my-app-abc12345", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 9, prUrl: "https://github.com/u/r/pull/9" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(createPRMock).toHaveBeenCalled();
      const args = createPRMock.mock.calls[0]?.[1] as { featureBranch?: string } | undefined;
      expect(args?.featureBranch).toBeUndefined();
    });
  });
});

describe("BranchStrip — Review button + dialog", () => {
  beforeEach(() => {
    reviewDiffMock.mockReset();
    createPRMock.mockReset();
  });

  it("STATE 1 (noGit): Review button is hidden — nothing to review yet", async () => {
    gitContextMock.mockResolvedValue({ branch: null, baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/foo-abc12345" />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Review/i })).toBeNull();
  });

  it("STATE 4 (feature branch): Review button is visible", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/foo-abc12345", baseBranch: null, plus: 1, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Review changes/i })).toBeInTheDocument());
  });

  it("clicking Review opens the dialog and renders the agent's markdown when ready", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/foo-abc12345", baseBranch: "main", plus: 3, minus: 1, remoteHttpsUrl: null });
    reviewDiffMock.mockResolvedValue({ ok: true, review: "## Findings\n\n- looks good", cli: "claude" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    const reviewBtn = await screen.findByRole("button", { name: /Review changes/i });
    fireEvent.click(reviewBtn);
    await waitFor(() => {
      expect(reviewDiffMock).toHaveBeenCalledWith("/repo", "main", "claude");
    });
    // The markdown ## Findings becomes an h2 with "Findings" text.
    await waitFor(() => expect(screen.getByText("Findings")).toBeInTheDocument());
    expect(screen.getByText(/looks good/)).toBeInTheDocument();
  });

  it("review error surfaces the message + Retry control", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/foo-abc12345", baseBranch: "main", plus: 1, minus: 0, remoteHttpsUrl: null });
    reviewDiffMock.mockResolvedValue({ ok: false, error: "claude timed out" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Review changes/i }));
    await waitFor(() => expect(screen.getByText(/claude timed out/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Retry/i })).toBeEnabled();
  });
});

describe("BranchStrip — createPR forwards `tool` to dispatcher", () => {
  beforeEach(() => {
    createPRMock.mockReset();
  });

  it("passes the session's tool string in opts so the dispatcher can pick the right CLI", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/foo-abc12345", baseBranch: "main",
      plus: 2, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="codex" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(createPRMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ tool: "codex" }),
      );
    });
  });
});

describe("BranchStrip — auto-OAuth pre-flight on Create PR", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    pushNotificationMock.mockReset();
  });

  it("auto-triggers GitHub App OAuth when neither gh nor link is available", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/foo-abc12345", baseBranch: "main",
      plus: 2, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    // No auth on either path → executeCreatePR must auto-OAuth
    // before falling through to createPR.
    hasGhCliMock.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    getLinkMock.mockResolvedValue({ ok: false, link: null });
    beginOAuthMock.mockResolvedValue({
      ok: true,
      link: {
        access_token: "x", refresh_token: "y",
        access_expires_at: "", refresh_expires_at: "",
        github_login: "auto", github_user_id: 1,
        github_avatar_url: "", installation_id: 1, connected_at: "",
      },
    });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 11, prUrl: "https://github.com/u/r/pull/11" });

    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));

    await waitFor(() => expect(beginOAuthMock).toHaveBeenCalledTimes(1));
    // OAuth resolved → createPR proceeds in the same click.
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
  });

  it("surfaces a toast and skips createPR when auto-OAuth fails", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/foo-abc12345", baseBranch: "main",
      plus: 2, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    hasGhCliMock.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    getLinkMock.mockResolvedValue({ ok: false, link: null });
    beginOAuthMock.mockResolvedValue({ ok: false, code: "USER_DECLINED", error: "user dismissed" });

    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));

    await waitFor(() => expect(beginOAuthMock).toHaveBeenCalledTimes(1));
    // Failure short-circuits — no createPR call, and a failure toast lands.
    expect(createPRMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/GitHub bağlantısı kurulamadı/) }),
      ),
    );
  });

  it("skips OAuth when gh is already authed", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/foo-abc12345", baseBranch: "main",
      plus: 2, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    // Default beforeEach sets gh authed → no auto-OAuth.
    createPRMock.mockResolvedValue({ ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1" });

    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));

    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
    expect(beginOAuthMock).not.toHaveBeenCalled();
  });
});

describe("BranchStrip — sad-path RecoveryDialog", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    diagnoseFailureMock.mockReset();
    applyRecoveryMock.mockReset();
    pushNotificationMock.mockReset();
  });

  it("REPO_CREATE_FORBIDDEN still uses the dedicated toast, not the RecoveryDialog", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: false, code: "REPO_CREATE_FORBIDDEN", error: "GitHub returned 403." });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: { label: "Open github.com/new", url: "https://github.com/new" },
        }),
      );
    });
    // Diagnose flow must NOT fire for this error code.
    expect(diagnoseFailureMock).not.toHaveBeenCalled();
  });

  it("non-REPO_CREATE_FORBIDDEN failure opens the RecoveryDialog and calls diagnoseFailure with the raw error", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: false, error: "! [rejected] HEAD -> main (non-fast-forward)" });
    diagnoseFailureMock.mockResolvedValue({
      ok: true,
      summary: "Push was rejected because the remote is ahead.",
      action: "pull-rebase",
      rationale: "Rebasing your commits onto the remote tip resolves the divergence.",
      command: "git pull --rebase origin main",
      risk: "low",
      cli: "claude",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // Dialog header surfaces "Create PR failed" + the raw error.
    await waitFor(() => expect(screen.getByText(/Create PR failed/i)).toBeInTheDocument());
    expect(screen.getByText(/non-fast-forward/i)).toBeInTheDocument();
    // Diagnosis fetched with the raw error string.
    await waitFor(() => {
      expect(diagnoseFailureMock).toHaveBeenCalledWith(
        "/repo",
        expect.stringContaining("non-fast-forward"),
        "claude",
        "Create PR",
        "main",
      );
    });
    // Once the diagnosis resolves the summary is rendered.
    await waitFor(() => expect(screen.getByText(/remote is ahead/i)).toBeInTheDocument());
    // Apply button surfaces with the human label for the action.
    expect(screen.getByRole("button", { name: /Apply: Pull \(rebase\) and retry/i })).toBeEnabled();
  });

  it("Apply triggers applyRecovery with the diagnosed action + baseBranch", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: false, error: "rejected non-fast-forward" });
    diagnoseFailureMock.mockResolvedValue({
      ok: true,
      summary: "Push rejected.",
      action: "pull-rebase",
      rationale: "Rebase onto origin/main.",
      command: "git pull --rebase origin main",
      risk: "low",
      cli: "claude",
    });
    applyRecoveryMock.mockResolvedValue({ ok: true, output: "Successfully rebased and updated." });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    const applyBtn = await screen.findByRole("button", { name: /Apply: Pull \(rebase\) and retry/i });
    fireEvent.click(applyBtn);
    await waitFor(() => {
      // command arg is undefined for whitelisted verbs — only custom-command passes a real string.
      expect(applyRecoveryMock).toHaveBeenCalledWith("/repo", "pull-rebase", "main", undefined);
    });
    // Success branch surfaces a Retry Create PR button.
    await waitFor(() => expect(screen.getByRole("button", { name: /Retry Create PR/i })).toBeInTheDocument());
  });

  it("manual diagnoses don't show an Apply button — only Close", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: false, error: "gh: command not found" });
    diagnoseFailureMock.mockResolvedValue({
      ok: true,
      summary: "GitHub CLI isn't installed. Install gh, then retry.",
      action: "manual",
      rationale: "No automated recovery — install gh from cli.github.com.",
      command: null,
      risk: "low",
      cli: "claude",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => expect(screen.getByText(/GitHub CLI isn't installed/i)).toBeInTheDocument());
    // No Apply button for manual actions.
    expect(screen.queryByRole("button", { name: /^Apply:/i })).toBeNull();
    // Close remains.
    expect(screen.getByRole("button", { name: /^Close$/i })).toBeInTheDocument();
  });

  it("Retry after Apply re-fires createPR with the same opts", async () => {
    // plus:0, minus:0 — suppresses the BranchStrip's auto-PR effect so
    // the first call to `createPR` is the user's Create PR click, not
    // the background draft auto-fire. Otherwise the auto-PR consumes
    // the first mockResolvedValueOnce and the user click gets the
    // success value, never triggering the recovery flow.
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock
      .mockResolvedValueOnce({ ok: false, error: "rejected non-fast-forward" })
      .mockResolvedValue({ ok: true, prNumber: 7, prUrl: "https://github.com/u/r/pull/7" });
    diagnoseFailureMock.mockResolvedValue({
      ok: true,
      summary: "Rebase.",
      action: "pull-rebase",
      rationale: "Rebase.",
      command: "git pull --rebase origin main",
      risk: "low",
      cli: "claude",
    });
    applyRecoveryMock.mockResolvedValue({ ok: true, output: "rebased" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Apply: Pull/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Retry Create PR/i }));
    await waitFor(() => {
      // First click (failed) + Retry (succeeds) = 2 invocations.
      expect(createPRMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("BranchStrip — preflight gate", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    preflightCheckMock.mockReset();
    applyPreflightFixMock.mockReset();
  });

  it("opens PreflightDialog when preflightCheck returns issues; does NOT fire createPR yet", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    preflightCheckMock.mockResolvedValue({
      ok: true,
      issues: [{
        id: "nested-no-commits:calculate_len",
        type: "nested-no-commits",
        severity: "blocking",
        description: "'calculate_len/' has its own .git/ but no commits.",
        data: { path: "calculate_len" },
        action: "nest-ignore",
        command: 'echo "calculate_len/" >> .gitignore && git add -A',
        risk: "low",
      }],
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // Dialog opens with the issue description.
    await waitFor(() => expect(screen.getByText(/has its own \.git\/ but no commits/)).toBeInTheDocument());
    // Dispatcher was NOT called — preflight is gating.
    expect(createPRMock).not.toHaveBeenCalled();
  });

  it("Fix and Continue applies every actionable issue in sequence, then fires the dispatcher", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    preflightCheckMock.mockResolvedValue({
      ok: true,
      issues: [
        {
          id: "nested-no-commits:calc",
          type: "nested-no-commits",
          severity: "blocking",
          description: "nested no commits at calc/",
          data: { path: "calc" },
          action: "nest-ignore",
          command: 'echo "calc/" >> .gitignore',
          risk: "low",
        },
        {
          id: "mid-rebase",
          type: "mid-rebase",
          severity: "blocking",
          description: "Rebase in progress",
          data: {},
          action: "abort-rebase",
          command: "git rebase --abort",
          risk: "low",
        },
      ],
    });
    applyPreflightFixMock.mockResolvedValue({ ok: true, output: "done" });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix and Continue/i }));
    await waitFor(() => {
      // Both fixes called in order — nest-ignore first, then abort-rebase.
      expect(applyPreflightFixMock).toHaveBeenNthCalledWith(1, "/repo", "nest-ignore", { path: "calc" });
      expect(applyPreflightFixMock).toHaveBeenNthCalledWith(2, "/repo", "abort-rebase", {});
    });
    // After all fixes apply, the dispatcher fires.
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
  });

  it("Continue anyway skips the fixes and fires the dispatcher", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    preflightCheckMock.mockResolvedValue({
      ok: true,
      issues: [{
        id: "mid-rebase",
        type: "mid-rebase",
        severity: "blocking",
        description: "Rebase in progress",
        data: {},
        action: "abort-rebase",
        command: "git rebase --abort",
        risk: "low",
      }],
    });
    applyPreflightFixMock.mockResolvedValue({ ok: true });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue anyway/i }));
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
    // Continue anyway should NOT trigger any fixes.
    expect(applyPreflightFixMock).not.toHaveBeenCalled();
  });

  it("preflight failure (electron unavailable etc.) falls through to dispatcher — no hard block", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    preflightCheckMock.mockResolvedValue({ ok: false, error: "electron unavailable" });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 2, prUrl: "https://github.com/u/r/pull/2" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
  });
});

describe("BranchStrip — recovery dialog custom-command", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    diagnoseFailureMock.mockReset();
    applyRecoveryMock.mockReset();
  });

  it("renders the agent's exact command and forwards it on Apply", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: false, error: "fatal: gh auth expired" });
    diagnoseFailureMock.mockResolvedValue({
      ok: true,
      summary: "gh token expired.",
      action: "custom-command",
      rationale: "Refresh the gh OAuth token.",
      command: "gh auth refresh",
      risk: "low",
      cli: "claude",
    });
    applyRecoveryMock.mockResolvedValue({ ok: true, output: "Refreshed." });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // Wait for diagnosis to surface (summary text).
    await waitFor(() => expect(screen.getByText(/gh token expired/i)).toBeInTheDocument());
    // The exact command appears literally in the dialog.
    expect(screen.getByText("gh auth refresh")).toBeInTheDocument();
    // Apply label uses the human verb for custom-command.
    const applyBtn = screen.getByRole("button", { name: /Apply: Run command/i });
    fireEvent.click(applyBtn);
    await waitFor(() => {
      expect(applyRecoveryMock).toHaveBeenCalledWith("/repo", "custom-command", "main", "gh auth refresh");
    });
  });
});

describe("BranchStrip — post-PR lifecycle", () => {
  beforeEach(() => {
    mergePRMock.mockReset();
    syncMainMock.mockReset();
    pushNotificationMock.mockReset();
  });

  const openPr = {
    number: 42, url: "https://github.com/u/r/pull/42",
    state: "OPEN", mergeable: "MERGEABLE", isDraft: false,
    baseRefName: "main", headRefName: "fleet/x-a1b2c3d4",
    checks: { passing: 2, failing: 0, pending: 0, total: 2 },
    commentsCount: 0,
  };

  it("OPEN PR: surfaces BOTH 'Open · #N' and 'Merge' buttons", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({ ok: true, pr: openPr });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Open · #42/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Merge$/i })).toBeEnabled();
  });

  it("OPEN PR with failing checks: Merge disabled with tooltip, Open still enabled", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: { ...openPr, mergeable: "MERGEABLE",
        checks: { passing: 1, failing: 1, pending: 0, total: 2 } },
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    const merge = await screen.findByRole("button", { name: /^Merge$/i });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("title", expect.stringMatching(/1 check failing/i));
    // Open button stays usable so the user can drop to GitHub.
    expect(screen.getByRole("button", { name: /Open · #42/i })).toBeEnabled();
  });

  it("OPEN PR with PENDING checks: Merge ENABLED — gh --auto queues it; label flips to 'Merge (auto)'", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: { ...openPr, mergeable: "MERGEABLE",
        checks: { passing: 0, failing: 0, pending: 2, total: 2 } },
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    const merge = await screen.findByRole("button", { name: /Merge \(auto\)/i });
    expect(merge).toBeEnabled();
    expect(merge).toHaveAttribute("title", expect.stringMatching(/auto-merge queued/i));
  });

  it("MERGED PR: surfaces 'Open · #N' + 'Sync main' instead of just the merged indicator", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: { ...openPr, state: "MERGED" },
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Sync main/i })).toBeEnabled());
    expect(screen.getByRole("button", { name: /Open · #42/i })).toBeEnabled();
  });

  it("Sync main hits the SOURCE path AND auto-carves next round in the WORKTREE path", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: { ...openPr, state: "MERGED" },
    });
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: "fleet/x-a1b2c3d4" });
    carveNextRoundMock.mockResolvedValue({ ok: true, branch: "fleet/My-app-abc12345", base: "main" });
    const { BranchStrip } = await loadBranchStrip();
    // projectPath is the WORKTREE (worktree-on session); sourcePath
    // is the real repo. Sync main hits the SOURCE; carveNextRound
    // hits the WORKTREE (the agent's working dir).
    render(
      <BranchStrip
        projectPath="/repo/.fleetify-worktrees/abc"
        sourcePath="/repo"
        plannedBranch="fleet/My-app-abc12345"
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /Sync main/i }));
    await waitFor(() => {
      expect(syncMainMock).toHaveBeenCalledWith("/repo", "main");
    });
    await waitFor(() => {
      expect(carveNextRoundMock).toHaveBeenCalledWith(
        "/repo/.fleetify-worktrees/abc",
        "fleet/My-app-abc12345",
        "main",
      );
    });
    // Toast confirms the next-round shape.
    await waitFor(() => {
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/next round/i) }),
      );
    });
  });

  it("Sync main success but carveNextRound failure: soft warning, source still synced", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: { ...openPr, state: "MERGED" },
    });
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: "fleet/x-a1b2c3d4" });
    carveNextRoundMock.mockResolvedValue({ ok: false, error: "Working tree has uncommitted changes. Commit or stash first." });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-abc12345" />);
    fireEvent.click(await screen.findByRole("button", { name: /Sync main/i }));
    await waitFor(() => {
      // Toast acknowledges the partial success.
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/next round skipped/i),
          summary: expect.stringMatching(/uncommitted changes/i),
        }),
      );
    });
  });

  it("Merge click forwards to git.mergePR with squash + the PR number", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({ ok: true, pr: openPr });
    mergePRMock.mockResolvedValue({ ok: true });
    // Re-anchor the post-merge mocks here too — beforeEach sets
    // defaults, but other tests in the describe block sometimes
    // override and the test runner has been observed to occasionally
    // race the mockResolvedValue order. Belt + suspenders.
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: null });
    carveNextRoundMock.mockResolvedValue({ ok: true, branch: "fleet/x-a1b2c3d4", base: "main" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-a1b2c3d4" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/i }));
    await waitFor(() => {
      expect(mergePRMock).toHaveBeenCalledWith("/repo", 42, "squash");
    });
    // onMerge done-ok now fires doSyncAndCarve directly. Wait for
    // that chain to settle so the in-flight promises don't leak
    // into the next test's beforeEach (which resets the mocks).
    await waitFor(() => expect(syncMainMock).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(carveNextRoundMock).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("auto-cleanup: merge → state flips to MERGED → syncMain + carveNextRound fire automatically", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    // First prStatus poll: OPEN (so the user gets the Merge button).
    // Subsequent polls (post-merge timeout + interval): MERGED.
    prStatusMock.mockReset();
    prStatusMock.mockResolvedValueOnce({ ok: true, pr: openPr });
    prStatusMock.mockResolvedValue({ ok: true, pr: { ...openPr, state: "MERGED" } });
    mergePRMock.mockResolvedValue({ ok: true });
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: "fleet/x-a1b2c3d4" });
    carveNextRoundMock.mockResolvedValue({ ok: true, branch: "fleet/x-a1b2c3d4", base: "main" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-a1b2c3d4" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Merge$/i }));
    // The post-merge prStatus refetch fires after an 800ms timeout,
    // then the auto-cleanup useEffect picks up the MERGED state.
    await waitFor(() => {
      expect(syncMainMock).toHaveBeenCalled();
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(carveNextRoundMock).toHaveBeenCalledWith(
        "/repo",
        "fleet/x-a1b2c3d4",
        "main",
      );
    });
  });

  it("auto-cleanup does NOT fire for pre-existing MERGED state (e.g. someone merged on github.com)", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    // PR is already MERGED at mount — user did not merge from the app.
    // justMergedRef stays false → effect should NOT fire.
    prStatusMock.mockResolvedValue({ ok: true, pr: { ...openPr, state: "MERGED" } });
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: "fleet/x-a1b2c3d4" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-a1b2c3d4" />);
    // Confirm the MERGED state is visible.
    await waitFor(() => expect(screen.getByRole("button", { name: /Sync main/i })).toBeInTheDocument());
    // Give the effect time to NOT fire.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(syncMainMock).not.toHaveBeenCalled();
  });

  it("CLOSED PR: only Open button surfaces — nothing else to do", async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: { ...openPr, state: "CLOSED" },
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Closed · #42/i })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Merge$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sync main/i })).toBeNull();
  });
});

describe("BranchStrip — toast variants on auto-create", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    pushNotificationMock.mockReset();
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
  });

  it("emits 'PR created' + View on GitHub when repoCreated:true", async () => {
    createPRMock.mockResolvedValue({
      ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1",
      repoCreated: true, repoUrl: "https://github.com/u/r",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    const btn = await screen.findByRole("button", { name: /Create PR/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "PR created",
          action: { label: "View on GitHub", url: "https://github.com/u/r" },
        }),
      );
    });
  });

  it("emits 'PR already exists' summary on r.existed", async () => {
    createPRMock.mockResolvedValue({
      ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1", existed: true,
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "PR already exists" }),
      );
    });
  });

  it("emits guidance toast on REPO_CREATE_FORBIDDEN", async () => {
    createPRMock.mockResolvedValue({
      ok: false, code: "REPO_CREATE_FORBIDDEN", error: "Permission denied.",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(pushNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          action: { label: "Open github.com/new", url: "https://github.com/new" },
        }),
      );
    });
  });
});
