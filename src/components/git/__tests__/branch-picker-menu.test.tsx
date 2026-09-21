import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BranchPickerMenu } from "@/components/git/branch-picker-menu";

/**
 * `git for-each-ref --format=%(refname:short) refs/remotes` shortens
 * `refs/remotes/origin/HEAD` to the BARE remote name — "origin". Every clone
 * has that symref, so the working-branch picker offered a row called "origin";
 * clicking it ran `git checkout origin`, which SUCCEEDS into a detached HEAD
 * and strands the session's worktree off its branch (the strip then loses
 * Review / Create PR entirely).
 */
function stubApi(remote: string[], local: string[] = ["main"]) {
  const listGitBranches = vi.fn(async () => ({ current: "main", local, remote }));
  const gitCheckout = vi.fn(async () => ({ ok: true }));
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    listGitBranches,
    listPRs: async () => ({ ok: true, prs: [] }),
    gitCheckout,
  };
  return { listGitBranches, gitCheckout };
}

const renderMenu = () =>
  render(
    <BranchPickerMenu
      folder="C:/repo"
      mode="working"
      currentBranch="main"
      baseBranch="main"
      newBranchTopic="topic"
      onPick={() => {}}
      onCreateNew={() => {}}
      onDismiss={() => {}}
    />,
  );

describe("BranchPickerMenu remote rows", () => {
  beforeEach(() => {
    stubApi(["origin", "origin/main", "origin/feature/alpha"]);
  });
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it("never offers the bare remote name (origin/HEAD symref)", async () => {
    renderMenu();
    await waitFor(() => expect(screen.getByText("feature/alpha")).toBeTruthy());
    expect(screen.queryByText("origin")).toBeNull();
  });

  it("still offers real remote branches, remote prefix stripped", async () => {
    renderMenu();
    await waitFor(() => expect(screen.getByText("feature/alpha")).toBeTruthy());
    // The base branch is filtered out; the feature branch survives with the
    // `origin/` prefix removed so the checkout targets a local branch name.
    expect(screen.queryByText("origin/feature/alpha")).toBeNull();
  });

  it("strips a non-origin remote's name too", async () => {
    stubApi(["upstream", "upstream/release/v2"]);
    renderMenu();
    await waitFor(() => expect(screen.getByText("release/v2")).toBeTruthy());
    expect(screen.queryByText("upstream")).toBeNull();
    expect(screen.queryByText("upstream/release/v2")).toBeNull();
  });
});
