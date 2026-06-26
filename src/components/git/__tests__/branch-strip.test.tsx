import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  gitContextMock, prStatusMock, prListMock, createPRMock, reviewDiffMock,
  diagnoseFailureMock, applyRecoveryMock, preflightCheckMock,
  applyPreflightFixMock, mergePRMock, markPRReadyMock, syncMainMock, carveNextRoundMock,
  pushNotificationMock, hasGhCliMock, getLinkMock, beginOAuthMock, openPRMock,
} = vi.hoisted(() => ({
  gitContextMock: vi.fn(),
  prStatusMock: vi.fn().mockResolvedValue({ ok: true, pr: null }),
  prListMock: vi.fn().mockResolvedValue({ ok: true, prs: [] }),
  createPRMock: vi.fn(),
  reviewDiffMock: vi.fn(),
  diagnoseFailureMock: vi.fn(),
  applyRecoveryMock: vi.fn(),
  preflightCheckMock: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  applyPreflightFixMock: vi.fn(),
  mergePRMock: vi.fn(),
  markPRReadyMock: vi.fn().mockResolvedValue({ ok: true }),
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
  openPRMock: vi.fn().mockResolvedValue({ ok: true }),
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
      prList: (folder: string, limit?: number) => prListMock(folder, limit),
      markPRReady: (folder: string, prNumber: number) =>
        markPRReadyMock(folder, prNumber),
      syncMain: (folder: string, baseBranch?: string) =>
        syncMainMock(folder, baseBranch),
      carveNextRound: (folder: string, branch: string, baseBranch?: string) =>
        carveNextRoundMock(folder, branch, baseBranch),
      openPR: (folder: string, prNumber?: number) => openPRMock(folder, prNumber),
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
    getPRStatus: (folder: string, num?: number) => prStatusMock(folder, num),
  },
});

import { usePrStore } from "@/stores/pr-store";

async function loadBranchStrip() {
  const mod = await import("../branch-strip");
  return mod;
}

beforeEach(() => {
  // Default: GitHub connected via Settings → Integrations (CLI method), so the
  // PR-display tests below see the merge cluster / switcher / merged states.
  // BranchStrip reads this synchronously to gate PR UI; the "not connected"
  // cases clear it to assert the branches-only state.
  try { localStorage.setItem("fleet:github-auth-method", "cli"); } catch { /* jsdom */ }
  // Reset the repo-wide PR store between every test so an empty store is
  // the default — only the switcher describe block seeds it. Without
  // this, a seeded store leaks into later tests and surfaces the chip /
  // merge cluster where those tests don't expect it.
  usePrStore.setState({ prs: [] });
  gitContextMock.mockReset();
  prStatusMock.mockReset();
  prListMock.mockReset();
  reviewDiffMock.mockReset();
  diagnoseFailureMock.mockReset();
  applyRecoveryMock.mockReset();
  preflightCheckMock.mockReset();
  applyPreflightFixMock.mockReset();
  mergePRMock.mockReset();
  markPRReadyMock.mockReset();
  syncMainMock.mockReset();
  carveNextRoundMock.mockReset();
  hasGhCliMock.mockReset();
  getLinkMock.mockReset();
  beginOAuthMock.mockReset();
  openPRMock.mockReset();
  openPRMock.mockResolvedValue({ ok: true });
  prStatusMock.mockResolvedValue({ ok: true, pr: null });
  prListMock.mockResolvedValue({ ok: true, prs: [] });
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
  markPRReadyMock.mockResolvedValue({ ok: true });
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
    await waitFor(() => expect(screen.getByRole("button", { name: /Create PR/i })).toBeEnabled());
  });

  it("STATE 5: feature + remote + no PR → existing happy path", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText(/fleet\/x-a1b2c3d4/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /Create PR/i })).toBeEnabled());
  });

  it("STATE 6: feature + remote + PR exists → Merge button", async () => {
    // The always-visible merge cluster targets the SELECTED open PR from
    // the repo-wide store (spec §6) — seed it to mirror the branch PR.
    // prList must echo it too, else the store's first poll wipes the seed.
    const repoPr42 = {
      number: 42, state: "OPEN", headRefName: "fleet/x-a1b2c3d4",
      isDraft: false, mergeable: "MERGEABLE", title: "PR 42", url: "https://github.com/u/r/pull/42",
    };
    usePrStore.setState({ prs: [repoPr42] });
    prListMock.mockResolvedValue({ ok: true, prs: [repoPr42] });
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

  it("STATE 1 + plannedBranch: renders 'main ← fleet/...' but NO Create PR (no git repo yet)", async () => {
    gitContextMock.mockResolvedValue({ branch: null, baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" />);
    // Both pills surface: dimmed "main" baseline + dimmed planned target
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.getByText(/fleet\/my-app-abc12345/)).toBeInTheDocument();
    // Create PR requires a real git repo — a non-git folder shows the planned
    // label only, no bootstrap CTA.
    expect(screen.queryByRole("button", { name: /Create PR/i })).toBeNull();
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
    reviewDiffMock.mockResolvedValue({ ok: true, review: "## Findings\n\n- looks good", cli: "claude-code" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
    const reviewBtn = await screen.findByRole("button", { name: /Review changes/i });
    fireEvent.click(reviewBtn);
    await waitFor(() => {
      expect(reviewDiffMock).toHaveBeenCalledWith("/repo", "main", "claude-code");
    });
    // The markdown ## Findings becomes an h2 with "Findings" text.
    await waitFor(() => expect(screen.getByText("Findings")).toBeInTheDocument());
    expect(screen.getByText(/looks good/)).toBeInTheDocument();
  });

  it("review error surfaces the message + Retry control", async () => {
    gitContextMock.mockResolvedValue({ branch: "fleet/foo-abc12345", baseBranch: "main", plus: 1, minus: 0, remoteHttpsUrl: null });
    reviewDiffMock.mockResolvedValue({ ok: false, error: "claude timed out" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
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
      // plus:1 keeps the diff non-empty so Create PR is ENABLED under the
      // empty-diff gating (plus:0 would disable it). baseBranch:null makes
      // the background auto-PR effect bail (it requires a resolved base),
      // so only the user's click lands on createPRMock — the dispatch
      // still targets "main" via the `ctx?.baseBranch || "main"` default.
      branch: "fleet/foo-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="codex-cli" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => {
      expect(createPRMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ tool: "codex-cli" }),
      );
    });
  });
});

describe("BranchStrip — auto-OAuth pre-flight on Create PR", () => {
  beforeEach(() => {
    createPRMock.mockReset();
    pushNotificationMock.mockReset();
    // executeCreatePR reads localStorage to skip the mid-flow auth picker.
    // Default to "oauth" so tests exercise beginOAuth without needing to
    // resolve the picker dialog.
    localStorage.setItem("fleet:github-auth-method", "oauth");
  });

  afterEach(() => {
    localStorage.removeItem("fleet:github-auth-method");
  });

  it("auto-triggers GitHub App OAuth when neither gh nor link is available", async () => {
    gitContextMock.mockResolvedValue({
      // plus:1 keeps the diff non-empty (Create PR ENABLED under the
      // empty-diff gating). baseBranch:null makes the background auto-PR
      // effect bail (it requires a resolved base), so it can't race
      // executeCreatePR's OAuth pre-flight; the dispatch still targets
      // "main" via the `ctx?.baseBranch || "main"` default.
      branch: "fleet/foo-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
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
      // plus:1 keeps the diff non-empty (Create PR ENABLED under the
      // empty-diff gating). baseBranch:null makes the background auto-PR
      // effect bail, so it can't race executeCreatePR; the dispatch
      // still targets "main" via the `ctx?.baseBranch || "main"` default.
      branch: "fleet/foo-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    hasGhCliMock.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    getLinkMock.mockResolvedValue({ ok: false, link: null });
    beginOAuthMock.mockResolvedValue({ ok: false, code: "USER_DECLINED", error: "user dismissed" });

    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));

    await waitFor(() => expect(beginOAuthMock).toHaveBeenCalledTimes(1));
    // Failure short-circuits — no createPR call.
    await waitFor(() => expect(createPRMock).not.toHaveBeenCalled());
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
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
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
      cli: "claude-code",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // Dialog header surfaces "Create PR failed" + the raw error.
    await waitFor(() => expect(screen.getByText(/Create PR failed/i)).toBeInTheDocument());
    expect(screen.getByText(/non-fast-forward/i)).toBeInTheDocument();
    // Diagnosis fetched with the raw error string.
    await waitFor(() => {
      expect(diagnoseFailureMock).toHaveBeenCalledWith(
        "/repo",
        expect.stringContaining("non-fast-forward"),
        "claude-code",
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
      cli: "claude-code",
    });
    applyRecoveryMock.mockResolvedValue({ ok: true, output: "Successfully rebased and updated." });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
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
      cli: "claude-code",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    await waitFor(() => expect(screen.getByText(/GitHub CLI isn't installed/i)).toBeInTheDocument());
    // No Apply button for manual actions.
    expect(screen.queryByRole("button", { name: /^Apply:/i })).toBeNull();
    // Close remains.
    expect(screen.getByRole("button", { name: /^Close$/i })).toBeInTheDocument();
  });

  it("Retry after Apply re-fires createPR with the same opts", async () => {
    // plus:1 keeps the diff non-empty so Create PR is ENABLED under the
    // empty-diff gating. baseBranch:null makes the background auto-PR
    // effect bail (it requires a resolved base), so it can't consume the
    // first mockResolvedValueOnce — the user's click is the first call to
    // `createPR` and triggers the recovery flow as intended. The dispatch
    // still targets "main" via the `ctx?.baseBranch || "main"` default.
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
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
      cli: "claude-code",
    });
    applyRecoveryMock.mockResolvedValue({ ok: true, output: "rebased" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" sessionTitle="t" />);
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
      // plus:1 → Create PR ENABLED under the empty-diff gating;
      // baseBranch:null disarms the background auto-PR effect so the
      // ONLY createPR path is the user's click (the preflight gate must
      // hold it back). Dispatch still uses "main" via the base default.
      branch: "fleet/x-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
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
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // Dialog opens with the issue description.
    await waitFor(() => expect(screen.getByText(/has its own \.git\/ but no commits/)).toBeInTheDocument());
    // Dispatcher was NOT called — preflight is gating.
    expect(createPRMock).not.toHaveBeenCalled();
  });

  it("Fix and Continue applies every actionable issue in sequence, then fires the dispatcher", async () => {
    gitContextMock.mockResolvedValue({
      // plus:1 → Create PR ENABLED; baseBranch:null disarms the
      // background auto-PR effect so createPR Times(1) counts only the
      // user's click. Dispatch still uses "main" via the base default.
      branch: "fleet/x-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
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
    render(<BranchStrip projectPath="/repo" tool="claude-code" sessionTitle="t" />);
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
      // plus:1 → Create PR ENABLED; baseBranch:null disarms the
      // background auto-PR effect so createPR Times(1) counts only the
      // user's click. Dispatch still uses "main" via the base default.
      branch: "fleet/x-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
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
    render(<BranchStrip projectPath="/repo" tool="claude-code" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue anyway/i }));
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
    // Continue anyway should NOT trigger any fixes.
    expect(applyPreflightFixMock).not.toHaveBeenCalled();
  });

  it("preflight failure (electron unavailable etc.) falls through to dispatcher — no hard block", async () => {
    gitContextMock.mockResolvedValue({
      // plus:1 → Create PR ENABLED; baseBranch:null disarms the
      // background auto-PR effect so createPR Times(1) counts only the
      // user's click. Dispatch still uses "main" via the base default.
      branch: "fleet/x-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    preflightCheckMock.mockResolvedValue({ ok: false, error: "electron unavailable" });
    createPRMock.mockResolvedValue({ ok: true, prNumber: 2, prUrl: "https://github.com/u/r/pull/2" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" sessionTitle="t" />);
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
      // plus:1 → Create PR ENABLED; baseBranch:null disarms the
      // background auto-PR effect so the user's click is the only
      // createPR path. applyRecovery still receives "main" via the base
      // default (`ctx?.baseBranch || "main"`).
      branch: "fleet/x-abc12345", baseBranch: null,
      plus: 1, minus: 0, remoteHttpsUrl: "https://github.com/u/r",
    });
    createPRMock.mockResolvedValue({ ok: false, error: "fatal: gh auth expired" });
    diagnoseFailureMock.mockResolvedValue({
      ok: true,
      summary: "gh token expired.",
      action: "custom-command",
      rationale: "Refresh the gh OAuth token.",
      command: "gh auth refresh",
      risk: "low",
      cli: "claude-code",
    });
    applyRecoveryMock.mockResolvedValue({ ok: true, output: "Refreshed." });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" tool="claude-code" />);
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
  // The repo-wide store entry mirroring `openPr` — the always-visible
  // merge cluster targets the SELECTED open PR, which must come from the
  // store (spec §6). Seed it in the OPEN-state tests; MERGED/CLOSED tests
  // intentionally leave it empty so the branch-PR-driven path renders.
  const openRepoPr = {
    number: 42, state: "OPEN", headRefName: "fleet/x-a1b2c3d4",
    isDraft: false, mergeable: "MERGEABLE", title: "PR 42", url: "https://github.com/u/r/pull/42",
  };

  beforeEach(() => {
    // markPRReady must return ok:true so onMerge doesn't bail before calling mergePR.
    markPRReadyMock.mockResolvedValue({ ok: true });
  });

  it("OPEN PR: surfaces BOTH 'Open · #N' and 'Merge' buttons", async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
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

  it("Open click forwards the PR number so the browser lands on /pull/<n>, not /pulls", async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({ ok: true, pr: openPr });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // Wait for git context to land — until then the selection can't be
    // recognised as the working branch's own PR and the click would take
    // the foreign-PR openExternal path instead of git.openPR.
    await screen.findByText("fleet/x-a1b2c3d4");
    const open = await screen.findByRole("button", { name: /Open · #42/i });
    fireEvent.click(open);
    await waitFor(() => expect(openPRMock).toHaveBeenCalledWith("/repo", 42));
  });

  it("OPEN PR with failing checks: Merge disabled with tooltip, Open still enabled", async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
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
    await screen.findByRole("button", { name: /^Merge$/i });
    // The merge cluster is store-driven so it renders before the branch
    // prStatus poll lands; wait for the resolved title (was a synchronous
    // assert when Merge only appeared after `pr` loaded). Re-query each
    // tick — React swaps the button node on re-render.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Merge$/i }))
        .toHaveAttribute("title", expect.stringMatching(/1 check failing/i)));
    expect(screen.getByRole("button", { name: /^Merge$/i })).toBeDisabled();
    // Open button stays usable so the user can drop to GitHub.
    expect(screen.getByRole("button", { name: /Open · #42/i })).toBeEnabled();
  });

  it("OPEN PR BLOCKED by pending required checks: Merge DISABLED + CI ring shown", async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    // GitHub reports BLOCKED while required checks are still running → the gate
    // makes Merge honestly un-clickable (no fabricated "(auto)": `merge_pr`
    // never queued an auto-merge, so that click used to just fail).
    prStatusMock.mockResolvedValue({
      ok: true,
      pr: {
        ...openPr,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        checks: {
          passing: 0, failing: 0, pending: 2, total: 2,
          runs: [{ name: "build", status: "IN_PROGRESS", conclusion: null, bucket: "pending", url: null }],
        },
      },
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // The CI ring only renders once the status poll lands (checks.total > 0),
    // so awaiting it also waits for `det` to be populated (past "Loading…").
    expect(await screen.findByTestId("pr-checks-ring")).toBeTruthy();
    const merge = screen.getByRole("button", { name: /^Merge/i });
    await waitFor(() => {
      expect(merge).toBeDisabled();
      expect(merge).toHaveAttribute("title", expect.stringMatching(/waiting on 2 checks/i));
    });
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
    await waitFor(() => expect(syncMainMock).toHaveBeenCalledWith("/repo", "main"));
    await waitFor(() => expect(carveNextRoundMock).toHaveBeenCalled());
  });

  it("Merge click forwards to git.mergePR with squash + the PR number", async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
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
    // The merge cluster is store-driven so it renders in a "Loading"
    // (disabled) state before the branch prStatus poll lands — wait for
    // it to enable before clicking. Re-query each tick: React replaces
    // the button element on re-render, so a captured ref goes stale.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Merge$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/i }));
    await waitFor(() => {
      expect(mergePRMock).toHaveBeenCalledWith("/repo", 42, "squash");
    });
    // onMerge done-ok now fires doSyncAndCarve directly. Wait for
    // that chain to settle so the in-flight promises don't leak
    // into the next test's beforeEach (which resets the mocks).
    await waitFor(() => expect(syncMainMock).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(carveNextRoundMock).toHaveBeenCalled(), { timeout: 3000 });
  });

  // Retry once: this scenario walks through three async chains (initial
  // prStatus poll → user click → post-merge prStatus refetch on 800ms
  // timeout → auto-cleanup effect). Under heavy load (cold runner,
  // happy-dom GC) the findByRole for Merge occasionally races the
  // initial prStatus resolution. The flake rate is ~10-20% locally;
  // one retry brings it under 1%.
  it("auto-cleanup: merge → state flips to MERGED → syncMain + carveNextRound fire automatically", { retry: 2 }, async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    // OPEN before the merge (so the user gets the Merge button), MERGED
    // after. State-driven rather than mockResolvedValueOnce because the
    // store-backed cluster + branch poll can both call prStatus and a
    // one-shot would be consumed non-deterministically by whichever
    // lands first.
    prStatusMock.mockReset();
    prStatusMock.mockImplementation(async () =>
      mergePRMock.mock.calls.length > 0
        ? { ok: true, pr: { ...openPr, state: "MERGED" } }
        : { ok: true, pr: openPr });
    mergePRMock.mockResolvedValue({ ok: true });
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: "fleet/x-a1b2c3d4" });
    carveNextRoundMock.mockResolvedValue({ ok: true, branch: "fleet/x-a1b2c3d4", base: "main" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-a1b2c3d4" />);
    // Default findByRole timeout (1000ms) races the auto-PR effect's
    // chain on slower machines — bump to 3000ms so the Merge button
    // has time to land after prStatus resolves with the OPEN pr. The
    // store-driven cluster renders disabled ("Loading") first, so wait
    // for it to enable before clicking. Re-query each tick — React swaps
    // the button node on re-render.
    await screen.findByRole("button", { name: /^Merge$/i }, { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Merge$/i })).toBeEnabled(), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: /^Merge$/i }));
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
    // After a successful createPR the component flips the strip to Merge.
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Open · #1/i })).toBeInTheDocument());
  });

  it("emits 'PR already exists' summary on r.existed", async () => {
    createPRMock.mockResolvedValue({
      ok: true, prNumber: 1, prUrl: "https://github.com/u/r/pull/1", existed: true,
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // existed:true is treated the same as a fresh create — strip flips to Merge.
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /Open · #1/i })).toBeInTheDocument());
  });

  it("emits guidance toast on REPO_CREATE_FORBIDDEN", async () => {
    createPRMock.mockResolvedValue({
      ok: false, code: "REPO_CREATE_FORBIDDEN", error: "Permission denied.",
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" sessionTitle="t" />);
    fireEvent.click(await screen.findByRole("button", { name: /Create PR/i }));
    // The component surfaces a pushChatError and does not open RecoveryDialog.
    await waitFor(() => expect(createPRMock).toHaveBeenCalledTimes(1));
    // Strip resets — Create PR button is still visible (no optimistic PR set).
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Merge$/i })).toBeNull());
  });
});

describe("BranchStrip — empty-diff gating", () => {
  it("feature branch + empty diff → Create PR, its chevron AND Review are hidden entirely", async () => {
    // Hide-not-disable: a dead Create PR (and a Review with nothing to
    // review) used to render grayed out; now the whole cluster is gone.
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // Wait for the strip to mount and the initial PR poll to resolve so
    // the "Checking…" placeholder has cleared before asserting absence.
    await screen.findByText("fleet/x-a1b2c3d4");
    await waitFor(() => expect(screen.queryByTitle("Checking PR status…")).toBeNull());
    expect(screen.queryByRole("button", { name: /^create pr$/i })).toBeNull();
    expect(screen.queryByTitle("More create options")).toBeNull();
    expect(screen.queryByRole("button", { name: /review changes/i })).toBeNull();
  });

  it("no git + plannedBranch shows NO Create PR (a real git repo is required)", async () => {
    gitContextMock.mockResolvedValue({ branch: null, baseBranch: null, plus: 0, minus: 0, remoteHttpsUrl: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/my-app-abc12345" />);
    await screen.findByText(/fleet\/my-app-abc12345/);
    expect(screen.queryByRole("button", { name: /^create pr$/i })).toBeNull();
  });

});

const OPEN_PR_5 = {
  number: 5, url: "https://github.com/u/r/pull/5", state: "OPEN", mergeable: "MERGEABLE",
  isDraft: false, baseRefName: "main", headRefName: "fleet/x-a1b2c3d4",
  checks: { passing: 1, failing: 0, pending: 0, total: 1 }, commentsCount: 0,
};
const OPEN_PR_7 = {
  ...OPEN_PR_5, number: 7, url: "https://github.com/u/r/pull/7", headRefName: "feat/other",
};
const REPO_PRS = [
  { number: 7, state: "OPEN", headRefName: "feat/other", isDraft: false, mergeable: "MERGEABLE", title: "Other feature", url: "https://github.com/u/r/pull/7" },
  { number: 5, state: "OPEN", headRefName: "fleet/x-a1b2c3d4", isDraft: false, mergeable: "MERGEABLE", title: "My branch PR", url: "https://github.com/u/r/pull/5" },
];

describe("BranchStrip — PR switcher + repo-wide merge", () => {
  beforeEach(() => {
    usePrStore.setState({ prs: REPO_PRS });
    prListMock.mockResolvedValue({ ok: true, prs: REPO_PRS });
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r" });
    prStatusMock.mockImplementation(async (_f: string, num?: number) =>
      ({ ok: true, pr: num === 7 ? OPEN_PR_7 : OPEN_PR_5 }));
  });
  afterEach(() => { usePrStore.setState({ prs: [] }); });

  it("renders the far-left PR chip defaulting to the working branch's PR", async () => {
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    await waitFor(() => expect(screen.getByText("#5")).toBeInTheDocument());
  });

  it("Create PR and Review hide while the working branch has an open PR — merge cluster stands alone", async () => {
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // Merge cluster targets the branch's own open PR…
    await screen.findByRole("button", { name: /Open · #5/i });
    // …and the blocked create slot (plus Review) is gone, not grayed out.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^create pr$/i })).toBeNull());
    expect(screen.queryByRole("button", { name: /review changes/i })).toBeNull();
  });

  it("not connected (no Settings GitHub link, no gh CLI auth) → branches-only: hides the PR chip, merge cluster, Create PR AND Review", async () => {
    // Same seeded open-PR state as the connected tests, but with BOTH
    // connection signals absent: the Settings → Integrations link is cleared
    // AND the gh CLI reports not-authed. The strip falls back to the
    // branches-only state: ALL PR affordances are gated off — no #5 chip, no
    // Open/Merge cluster, and (per prAffordancesEnabled) no Create PR or
    // Review either. Only the branch pills remain.
    localStorage.removeItem("fleet:github-auth-method");
    // The default beforeEach mocks gh as authed; override it here so the
    // async ghCliAuthed probe resolves false and `githubConnected` stays false
    // (without this, recognizing gh-CLI auth would now flip the strip to
    // connected and surface the PR UI this test asserts is hidden).
    hasGhCliMock.mockResolvedValue({ ok: true, version: "2.55.0", authed: false, ghLogin: null });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // The branch pill still renders (proves the strip mounted) — wait for it,
    // then assert every PR affordance is absent.
    await screen.findByText("fleet/x-a1b2c3d4");
    expect(screen.queryByRole("button", { name: /^create pr$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /review changes/i })).toBeNull();
    expect(screen.queryByText("#5")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open · #5/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch pull request/i })).toBeNull();
  });

  it("no Settings link but gh CLI authed → PR affordances appear (gh-CLI auth alone connects the strip)", async () => {
    // The new behavior: a user who ran `gh auth login` but never linked GitHub
    // in Fleetify Settings still gets the PR UI. The Settings flag is cleared,
    // but the async ghCliAuthed probe resolves authed → `githubConnected` true
    // via resolveGithubConnected, so the merge cluster + chip surface (same
    // seeded #5 open-PR state as the connected tests). Proves the backend's gh
    // fallback no longer requires a redundant second Fleetify connection.
    localStorage.removeItem("fleet:github-auth-method");
    hasGhCliMock.mockResolvedValue({ ok: true, version: "2.55.0", authed: true, ghLogin: "test" });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // The working branch's open PR surfaces in the merge cluster (Open · #5)
    // and the switcher chip (#5) — both gated on githubConnected, so their
    // presence proves gh-CLI auth alone enabled the strip's PR UI.
    await waitFor(() => expect(screen.getByRole("button", { name: /Open · #5/i })).toBeInTheDocument());
    expect(screen.getByText("#5")).toBeInTheDocument();
  });

  it("chip popover lists open PRs; picking one retargets Merge", async () => {
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    fireEvent.click(await screen.findByRole("button", { name: /switch pull request/i }));
    fireEvent.click(await screen.findByText("Other feature"));
    await waitFor(() => expect(screen.getByText("#7")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /merge/i }))
        .toHaveAttribute("title", expect.stringContaining("#7")));
  });

  it("merging a FOREIGN PR does not sync main or carve; working branch untouched", async () => {
    mergePRMock.mockResolvedValue({ ok: true });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    fireEvent.click(await screen.findByRole("button", { name: /switch pull request/i }));
    fireEvent.click(await screen.findByText("Other feature"));
    await screen.findByRole("button", { name: /merge/i });
    await waitFor(() => expect(screen.getByRole("button", { name: /merge/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /merge/i }));
    await waitFor(() => expect(mergePRMock).toHaveBeenCalledWith("/repo", 7, "squash"));
    expect(syncMainMock).not.toHaveBeenCalled();
    expect(carveNextRoundMock).not.toHaveBeenCalled();
  });

  it("merging the OWN-branch PR still syncs + carves the next round", async () => {
    mergePRMock.mockResolvedValue({ ok: true });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-a1b2c3d4" />);
    // Re-query each tick — React swaps the button node on re-render, so a
    // captured ref goes stale while the cluster resolves from "Loading".
    await screen.findByRole("button", { name: /merge/i });
    await waitFor(() => expect(screen.getByRole("button", { name: /merge/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /merge/i }));
    await waitFor(() => expect(mergePRMock).toHaveBeenCalledWith("/repo", 5, "squash"));
    await waitFor(() => expect(syncMainMock).toHaveBeenCalled());
    await waitFor(() => expect(carveNextRoundMock).toHaveBeenCalled());
  });

  // Fix 1 (review): MERGED transitional state must NOT strand the chip on
  // an unactionable PR. When the branch PR is MERGED (Sync main showing)
  // and the repo still has an open foreign PR, the chip selects that
  // foreign PR — so the selected PR's merge cluster must render ALONGSIDE
  // the Sync-main pair. Spec §6 ("merge section visible whenever the repo
  // has an open PR") holds through the MERGED transition.
  it("MERGED branch PR + open foreign PR: renders BOTH Sync main AND the foreign Merge", async () => {
    // Store holds only #7 (the merged branch PR #5 is no longer open).
    const REPO_PRS_7_ONLY = [
      { number: 7, state: "OPEN", headRefName: "feat/other", isDraft: false, mergeable: "MERGEABLE", title: "Other feature", url: "https://github.com/u/r/pull/7" },
    ];
    usePrStore.setState({ prs: REPO_PRS_7_ONLY });
    prListMock.mockResolvedValue({ ok: true, prs: REPO_PRS_7_ONLY });
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 0, minus: 0, remoteHttpsUrl: "https://github.com/u/r" });
    // Branch poll (no num / num===5) → MERGED; foreign detail poll (#7) → OPEN.
    prStatusMock.mockImplementation(async (_f: string, num?: number) =>
      num === 7
        ? { ok: true, pr: OPEN_PR_7 }
        : { ok: true, pr: { ...OPEN_PR_5, state: "MERGED" } });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    // Sync-main pair (just-merged branch PR) is present…
    await waitFor(() => expect(screen.getByRole("button", { name: /Sync main/i })).toBeEnabled());
    // …AND the foreign PR's Merge cluster renders alongside it.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Merge$/i }))
        .toHaveAttribute("title", expect.stringContaining("#7")));
  });

  // Fix 3 (review): foreign-PR `det`-gating — a selected foreign PR whose
  // detail poll reports failing checks must disable Merge with the
  // matching tooltip. Pins the riskiest new path (the foreign `selectedPr`
  // feeding the merge cluster's check gating).
  it("foreign PR with failing checks: Merge disabled with a failing-checks tooltip", async () => {
    usePrStore.setState({ prs: REPO_PRS });
    prListMock.mockResolvedValue({ ok: true, prs: REPO_PRS });
    gitContextMock.mockResolvedValue({ branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r" });
    // #7's detail poll reports 2 failing checks; #5 (the working branch) is clean.
    prStatusMock.mockImplementation(async (_f: string, num?: number) =>
      num === 7
        ? { ok: true, pr: { ...OPEN_PR_7, checks: { passing: 0, failing: 2, pending: 0, total: 2 } } }
        : { ok: true, pr: OPEN_PR_5 });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);
    fireEvent.click(await screen.findByRole("button", { name: /switch pull request/i }));
    fireEvent.click(await screen.findByText("Other feature"));
    await waitFor(() => expect(screen.getByText("#7")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Merge$/i }))
        .toHaveAttribute("title", expect.stringMatching(/2 checks failing/i)));
    expect(screen.getByRole("button", { name: /^Merge$/i })).toBeDisabled();
  });
});

describe("BranchStrip — re-poll PR status on window focus", () => {
  const openPr = {
    number: 42, url: "https://github.com/u/r/pull/42",
    state: "OPEN", mergeable: "MERGEABLE", isDraft: false,
    baseRefName: "main", headRefName: "fleet/x-a1b2c3d4",
    checks: { passing: 1, failing: 0, pending: 0, total: 1 },
    commentsCount: 0,
  };

  // The working-branch PR-status poll runs `git.prStatus(folder)` with NO PR
  // number — which reaches the mock as `getPRStatus(folder, undefined)`. The
  // number-addressable forms (foreign detail poll, post-create refine, resolve
  // watcher) always pass a real number. Counting only the undefined-number
  // calls isolates THIS poll from the others.
  const noNumberCalls = () =>
    prStatusMock.mock.calls.filter(c => c[1] === undefined).length;

  it("re-polls (no-number form) the instant the window regains focus, after the throttle window", { timeout: 10000 }, async () => {
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
    prStatusMock.mockResolvedValue({ ok: true, pr: openPr });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);

    // Initial poll resolves exactly once (no-number form).
    await waitFor(() => expect(noNumberCalls()).toBe(1));
    const before = noNumberCalls();

    // Wait past the 3s focus-refresh throttle so the listener isn't a no-op,
    // but well under the 10s interval so the extra call can only come from the
    // focus handler (not a scheduled tick).
    await new Promise(resolve => setTimeout(resolve, 3100));
    const afterWait = noNumberCalls();

    // The window regains focus (user merged the PR on GitHub, tabbed back).
    window.dispatchEvent(new Event("focus"));

    // The focus handler fires an immediate extra no-number poll.
    await waitFor(() => expect(noNumberCalls()).toBe(afterWait + 1));
    expect(afterWait + 1).toBeGreaterThan(before);
  });
});

describe("BranchStrip — auth-failure connection reset", () => {
  // The working-branch PR-status poll early-returns on a generic `!r.ok`
  // (transient blip — state preserved). But when the failure carries an
  // AUTH-FAILURE code (gh logout / expired token) the strip must RESET its
  // GitHub connection: clear the localStorage auth flag + ghCliAuthed so
  // `githubConnected` flips false and the UI honestly falls back to
  // branches-only instead of showing a connected strip where every op fails.
  const openRepoPr = {
    number: 42, state: "OPEN", headRefName: "fleet/x-a1b2c3d4",
    isDraft: false, mergeable: "MERGEABLE", title: "PR 42", url: "https://github.com/u/r/pull/42",
  };
  const openPr = {
    number: 42, url: "https://github.com/u/r/pull/42",
    state: "OPEN", mergeable: "MERGEABLE", isDraft: false,
    baseRefName: "main", headRefName: "fleet/x-a1b2c3d4",
    checks: { passing: 1, failing: 0, pending: 0, total: 1 },
    commentsCount: 0,
  };

  function seedOpen() {
    // Connected via the Settings flag; the merge cluster reads the store, so
    // seed + echo it. gh CLI reports NOT authed so the mount probe can't keep
    // `githubConnected` alive through ghCliAuthed once the flag is cleared
    // (otherwise the reset's localStorage clear wouldn't disconnect the strip).
    localStorage.setItem("fleet:github-auth-method", "cli");
    hasGhCliMock.mockResolvedValue({ ok: true, version: "2.55.0", authed: false, ghLogin: null });
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
    gitContextMock.mockResolvedValue({
      branch: "fleet/x-a1b2c3d4", baseBranch: "main",
      plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r",
    });
  }

  it("AUTH_FAILED on the next poll RESETS the connection: clears the auth flag + drops the PR UI to branches-only", { timeout: 10000 }, async () => {
    seedOpen();
    // First no-number poll → OPEN (strip connects, shows Open · #42 + Merge);
    // every subsequent no-number poll → an AUTH_FAILED failure. Number-
    // addressable polls (post-create refine etc.) stay OK so they can't
    // interfere with this branch poll's classification.
    let branchPolls = 0;
    prStatusMock.mockImplementation(async (_f: string, num?: number) => {
      if (num !== undefined) return { ok: true, pr: openPr };
      branchPolls += 1;
      return branchPolls <= 1
        ? { ok: true, pr: openPr }
        : { ok: false, code: "AUTH_FAILED", error: "gh: authentication failed" };
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);

    // Connected: the working branch's open PR surfaces (Open · #42 + Merge).
    await screen.findByText("fleet/x-a1b2c3d4");
    await waitFor(() => expect(screen.getByRole("button", { name: /Open · #42/i })).toBeInTheDocument());
    expect(localStorage.getItem("fleet:github-auth-method")).toBe("cli");

    // Wait past the 3s focus-refresh throttle, then refocus to fire the next
    // poll immediately (it now returns AUTH_FAILED). Mirrors the focus-repoll
    // test's throttle handling.
    await new Promise(resolve => setTimeout(resolve, 3100));
    window.dispatchEvent(new Event("focus"));

    // The reset fires: the localStorage auth flag is cleared…
    await waitFor(() => expect(localStorage.getItem("fleet:github-auth-method")).toBeNull());
    // …and the PR UI collapses to branches-only — no Open/Merge cluster, and
    // Create PR does NOT reappear (prAffordancesEnabled is false now).
    await waitFor(() => expect(screen.queryByRole("button", { name: /Open · #42/i })).toBeNull());
    expect(screen.queryByRole("button", { name: /^Merge$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^create pr$/i })).toBeNull();
    // The branch pill still renders — the strip fell back to branches-only,
    // it didn't unmount.
    expect(screen.getByText("fleet/x-a1b2c3d4")).toBeInTheDocument();
  });

  it("NETWORK (transient) on the next poll does NOT reset: PR UI stays, auth flag untouched", { timeout: 10000 }, async () => {
    seedOpen();
    let branchPolls = 0;
    prStatusMock.mockImplementation(async (_f: string, num?: number) => {
      if (num !== undefined) return { ok: true, pr: openPr };
      branchPolls += 1;
      return branchPolls <= 1
        ? { ok: true, pr: openPr }
        : { ok: false, code: "NETWORK", error: "network unreachable" };
    });
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" />);

    await screen.findByText("fleet/x-a1b2c3d4");
    await waitFor(() => expect(screen.getByRole("button", { name: /Open · #42/i })).toBeInTheDocument());

    await new Promise(resolve => setTimeout(resolve, 3100));
    window.dispatchEvent(new Event("focus"));
    // Give the transient-failure poll time to land + be tolerated.
    await new Promise(resolve => setTimeout(resolve, 200));

    // Transient failure is tolerated: the flag is untouched and the merge
    // cluster (Open · #42) is still present — the strip stays connected.
    expect(localStorage.getItem("fleet:github-auth-method")).toBe("cli");
    expect(screen.getByRole("button", { name: /Open · #42/i })).toBeInTheDocument();
  });
});

describe("BranchStrip — merge-conflict agent resolution", () => {
  const openPr = {
    number: 42, url: "https://github.com/u/r/pull/42",
    state: "OPEN", mergeable: "CONFLICTING", isDraft: false,
    baseRefName: "main", headRefName: "fleet/x-a1b2c3d4",
    checks: { passing: 2, failing: 0, pending: 0, total: 2 },
    commentsCount: 0,
  };
  const openRepoPr = {
    number: 42, state: "OPEN", headRefName: "fleet/x-a1b2c3d4",
    isDraft: false, mergeable: "CONFLICTING", title: "PR 42", url: "https://github.com/u/r/pull/42",
  };
  const ctx = { branch: "fleet/x-a1b2c3d4", baseBranch: "main", plus: 5, minus: 2, remoteHttpsUrl: "https://github.com/u/r" };

  beforeEach(() => {
    markPRReadyMock.mockResolvedValue({ ok: true });
    mergePRMock.mockReset();
    syncMainMock.mockResolvedValue({ ok: true, base: "main", prevBranch: null });
    carveNextRoundMock.mockResolvedValue({ ok: true, branch: "fleet/x-a1b2c3d4", base: "main" });
  });

  function seed(prOverrides: Partial<typeof openPr> = {}) {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
    gitContextMock.mockResolvedValue(ctx);
    prStatusMock.mockResolvedValue({ ok: true, pr: { ...openPr, ...prOverrides } });
  }

  it("CONFLICTING PR shows an enabled 'Resolve & merge' (not a disabled Merge)", async () => {
    seed();
    const onResolveConflicts = vi.fn();
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" onResolveConflicts={onResolveConflicts} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Resolve & merge/i })).toBeEnabled());
    expect(screen.queryByRole("button", { name: /^Merge$/i })).toBeNull();
  });

  it("Resolve & merge hands the conflict to the agent with base + push + PR# and enters resolving", async () => {
    seed();
    const onResolveConflicts = vi.fn();
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" onResolveConflicts={onResolveConflicts} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Resolve & merge/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Resolve & merge/i }));
    expect(onResolveConflicts).toHaveBeenCalledTimes(1);
    const prompt = String(onResolveConflicts.mock.calls[0]?.[0] ?? "");
    expect(prompt).toMatch(/main/);
    expect(prompt).toMatch(/git push/i);
    expect(prompt).toMatch(/#42/);
    await waitFor(() => expect(screen.getByRole("button", { name: /Resolving/i })).toBeInTheDocument());
  });

  it("plan mode blocks the resolve flow (no agent task sent)", async () => {
    seed();
    const onResolveConflicts = vi.fn();
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" permissionMode="plan" onResolveConflicts={onResolveConflicts} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Resolve & merge/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Resolve & merge/i }));
    expect(onResolveConflicts).not.toHaveBeenCalled();
  });

  it("checks-failing keeps Merge disabled — no Resolve action", async () => {
    seed({ mergeable: "CONFLICTING", checks: { passing: 1, failing: 1, pending: 0, total: 2 } });
    const onResolveConflicts = vi.fn();
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" onResolveConflicts={onResolveConflicts} />);
    await screen.findByRole("button", { name: /^Merge$/i });
    expect(screen.queryByRole("button", { name: /Resolve & merge/i })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Merge$/i })).toBeDisabled());
  });

  it("auto-completes the squash-merge once the agent's push clears the conflict", { timeout: 10000, retry: 2 }, async () => {
    usePrStore.setState({ prs: [openRepoPr] });
    prListMock.mockResolvedValue({ ok: true, prs: [openRepoPr] });
    gitContextMock.mockResolvedValue(ctx);
    let mergeable = "CONFLICTING";
    prStatusMock.mockImplementation(async () => ({ ok: true, pr: { ...openPr, mergeable } }));
    mergePRMock.mockResolvedValue({ ok: true });
    const onResolveConflicts = vi.fn();
    const { BranchStrip } = await loadBranchStrip();
    render(<BranchStrip projectPath="/repo" plannedBranch="fleet/x-a1b2c3d4" onResolveConflicts={onResolveConflicts} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Resolve & merge/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Resolve & merge/i }));
    expect(onResolveConflicts).toHaveBeenCalled();
    mergeable = "MERGEABLE"; // agent resolved + pushed
    await waitFor(() => expect(mergePRMock).toHaveBeenCalledWith("/repo", 42, "squash"), { timeout: 8000 });
  });
});
