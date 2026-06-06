import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/git-api", () => ({
  git: {
    markPRReady: vi.fn(async () => ({ ok: true })),
    mergePR: vi.fn(async () => ({ ok: true })),
  },
}));

import { MergeBox } from "@/components/chat/merge-box";
import { usePrStore, type RepoPr } from "@/stores/pr-store";
import { git } from "@/lib/git-api";

const pr = (n: number, extra: Partial<RepoPr> = {}): RepoPr => ({
  number: n,
  state: "OPEN",
  headRefName: `fleet/x-${n}`,
  title: `feat ${n}`,
  url: `https://gh/pull/${n}`,
  ...extra,
});

beforeEach(() => {
  usePrStore.setState({ prs: [] });
  vi.clearAllMocks();
});

describe("MergeBox", () => {
  it("renders nothing with no open PRs", () => {
    render(<MergeBox folder="/x" />);
    expect(screen.queryByTestId("merge-box")).toBeNull();
  });

  it("shows the selected PR with number, title, and status badge", () => {
    usePrStore.setState({ prs: [pr(5, { isDraft: true })] });
    render(<MergeBox folder="/x" />);
    expect(screen.getByText("#5")).toBeInTheDocument();
    expect(screen.getByText("feat 5")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows prev/next nav only with >1 open PR and cycles newest-first", () => {
    usePrStore.setState({ prs: [pr(9), pr(4)] }); // openPrs orders desc: 9, 4
    render(<MergeBox folder="/x" />);
    expect(screen.getByText("#9")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Next PR"));
    expect(screen.getByText("#4")).toBeInTheDocument();
  });

  it("merges own-branch PR → git.mergePR + onMergedOwnBranch + store removal", async () => {
    const onOwn = vi.fn();
    usePrStore.setState({ prs: [pr(7, { headRefName: "fleet/own" })] });
    render(<MergeBox folder="/x" workBranch="fleet/own" onMergedOwnBranch={onOwn} />);
    fireEvent.click(screen.getByRole("button", { name: /merge/i }));
    await waitFor(() => expect(git.mergePR).toHaveBeenCalledWith("/x", 7, "squash"));
    await waitFor(() => expect(onOwn).toHaveBeenCalled());
    expect(usePrStore.getState().prs.find((p) => p.number === 7)).toBeUndefined();
  });

  it("merging another session's PR does NOT trigger onMergedOwnBranch", async () => {
    const onOwn = vi.fn();
    usePrStore.setState({ prs: [pr(8, { headRefName: "fleet/other" })] });
    render(<MergeBox folder="/x" workBranch="fleet/own" onMergedOwnBranch={onOwn} />);
    fireEvent.click(screen.getByRole("button", { name: /merge/i }));
    await waitFor(() => expect(git.mergePR).toHaveBeenCalledWith("/x", 8, "squash"));
    expect(onOwn).not.toHaveBeenCalled();
  });
});
