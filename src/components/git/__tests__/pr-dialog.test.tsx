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
import { escapeOwnedElsewhere, escapeWasClaimed } from "@/hooks/use-escape-to-stop";

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

describe("PRDialog — on-demand AI generation", () => {
  beforeEach(() => {
    gitMock.hasGhCli.mockReset();
    gitMock.createPR.mockReset();
    gitMock.generatePRSummary.mockReset();
    ghMock.getLink.mockReset();
    ghMock.beginOAuth.mockReset();
  });

  it("does NOT call generatePRSummary on mount; opens directly in compose", async () => {
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    render(<PRDialog folder="/repo" branch="fleet/x-a1b2c3d4" baseBranch="main" onClose={() => {}} />);
    // compose is immediate: title input enabled and prefilled from the branch name
    const title = await screen.findByPlaceholderText("Short summary…");
    expect((title as HTMLInputElement).value).not.toBe("");
    expect(gitMock.generatePRSummary).not.toHaveBeenCalled();
    // body starts EMPTY (no diff-summary seed)
    const body = screen.getByPlaceholderText("What changed and why?") as HTMLTextAreaElement;
    expect(body.value).toBe("");
  });

  it("Generate title fills ONLY the title", async () => {
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    gitMock.generatePRSummary.mockResolvedValue({ ok: true, title: "AI title", body: "AI body" });
    render(<PRDialog folder="/repo" branch="fleet/x" baseBranch="main" onClose={() => {}} />);
    const body = await screen.findByPlaceholderText("What changed and why?");
    fireEvent.change(body, { target: { value: "hand-written body" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate title with AI" }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText("Short summary…") as HTMLInputElement).value).toBe("AI title");
    });
    expect((body as HTMLTextAreaElement).value).toBe("hand-written body");
  });

  it("Generate description fills ONLY the body", async () => {
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    gitMock.generatePRSummary.mockResolvedValue({ ok: true, title: "AI title", body: "AI body" });
    render(<PRDialog folder="/repo" branch="fleet/x" baseBranch="main" onClose={() => {}} />);
    const title = await screen.findByPlaceholderText("Short summary…");
    fireEvent.change(title, { target: { value: "hand-written title" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate description with AI" }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText("What changed and why?") as HTMLTextAreaElement).value).toBe("AI body");
    });
    expect((title as HTMLInputElement).value).toBe("hand-written title");
  });

  it("per-field generation failure shows an inline error for that field only", async () => {
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    gitMock.generatePRSummary.mockResolvedValue({ ok: false, error: "agent unavailable" });
    render(<PRDialog folder="/repo" branch="fleet/x" baseBranch="main" onClose={() => {}} />);
    await screen.findByPlaceholderText("Short summary…");
    fireEvent.click(screen.getByRole("button", { name: "Generate description with AI" }));
    await waitFor(() => expect(screen.getByText(/agent unavailable/)).toBeInTheDocument());
  });

  it("blocks submit (button, other hint, and ⌘↵) while a field is generating", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: false, version: null, authed: false, ghLogin: null });
    ghMock.getLink.mockResolvedValue({ ok: true, link: samplePayload });
    // Hold the generation open with a deferred promise so we can observe
    // the in-flight locked state before it resolves.
    let resolveGen: (v: { ok: true; title: string; body: string }) => void = () => {};
    gitMock.generatePRSummary.mockImplementation(
      () => new Promise(r => { resolveGen = r; }),
    );
    render(<PRDialog folder="/repo" branch="fleet/x" baseBranch="main" onClose={() => {}} />);
    await screen.findByPlaceholderText("Short summary…");
    // Auth-ready: the @login chip means submit is otherwise eligible.
    await waitFor(() => expect(screen.getByText(/@greg/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Generate description with AI" }));

    // While generation is pending: submit is disabled, the OTHER hint is
    // disabled, and ⌘↵ must NOT fire createPR.
    const submit = screen.getByRole("button", { name: /create pr/i });
    await waitFor(() => expect(submit).toBeDisabled());
    expect(screen.getByRole("button", { name: "Generate title with AI" })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(gitMock.createPR).not.toHaveBeenCalled();

    // Resolve the generation — body fills and submit re-enables.
    await act(async () => {
      resolveGen({ ok: true, title: "T", body: "B" });
    });
    await waitFor(() =>
      expect((screen.getByPlaceholderText("What changed and why?") as HTMLTextAreaElement).value).toBe("B"),
    );
    await waitFor(() => expect(submit).toBeEnabled());
  });
});

/**
 * Regression: the dialog used to call `git.createPR` WITHOUT `featureBranch`.
 * For a session whose HEAD is still the default branch (the normal
 * off-worktree shape — its `fleet/…` branch is only *planned* until the first
 * PR), `create_pr_via_gh` then had nothing to carve: it ran `git add -A`,
 * committed onto `main`, and pushed `HEAD -> main`. Observed live as a
 * `main → main` dialog header and `! [rejected] HEAD -> main` in the trace —
 * only a stale remote stopped the agent's work from landing on the user's
 * default branch. The split-button path always sent it; the dialog must too.
 */
describe("PRDialog feature-branch carve", () => {
  beforeEach(() => {
    gitMock.hasGhCli.mockReset();
    gitMock.createPR.mockReset();
    ghMock.getLink.mockReset();
  });

  const submitWith = async (featureBranch?: string) => {
    gitMock.hasGhCli.mockResolvedValue({ ok: true, version: "2.55.0", authed: true, ghLogin: "octocat" });
    ghMock.getLink.mockResolvedValue({ ok: false, link: null });
    gitMock.createPR.mockResolvedValueOnce({ ok: true, prNumber: 1, prUrl: "https://x/1" });
    render(
      <PRDialog
        folder="/some/repo"
        branch="main"
        baseBranch="main"
        featureBranch={featureBranch}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByPlaceholderText(/Short summary/i)).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Create PR/i })); });
    await waitFor(() => expect(gitMock.createPR).toHaveBeenCalled());
    return gitMock.createPR.mock.calls[0][1] as Record<string, unknown>;
  };

  it("forwards the planned branch so the backend carves instead of committing to main", async () => {
    const opts = await submitWith("fleet/topic-abc12345");
    expect(opts.featureBranch).toBe("fleet/topic-abc12345");
  });

  it("omits featureBranch when the session is already on its feature branch", async () => {
    const opts = await submitWith(undefined);
    expect("featureBranch" in opts).toBe(false);
  });
});

// Escape-to-stop leaves alone an Escape that an overlay owns, whichever window
// listener runs first. Before the dialog's handler runs, the open dialog is an
// aria-modal surface. After it runs, the key is marked handled.
describe("PRDialog owns Escape", () => {
  it("is a modal surface while open and marks Escape handled when it closes", async () => {
    gitMock.hasGhCli.mockResolvedValue({ ok: true, version: "2.55.0", authed: true, ghLogin: "octocat" });
    ghMock.getLink.mockResolvedValue({ ok: false, link: null });
    const onClose = vi.fn();
    render(<PRDialog folder="/some/repo" branch="feat/x" baseBranch="main" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/@octocat/)).toBeInTheDocument());
    const modal = document.querySelectorAll("[aria-modal='true']");
    expect(modal).toHaveLength(1);
    expect(modal[0]).toHaveAccessibleName("Pull request");
    expect(escapeOwnedElsewhere(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    // The handler claims the key: marked handled for the stop, and used as far
    // as a pending permission card is concerned.
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(document.body, escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(escapeWasClaimed(escape)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
