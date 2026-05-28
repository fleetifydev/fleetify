import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { listReposResolvedMock } = vi.hoisted(() => ({
  listReposResolvedMock: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, listReposResolved: listReposResolvedMock };
});

import { GitSourceTab } from "../git-source-tab";

describe("GitSourceTab", () => {
  beforeEach(() => listReposResolvedMock.mockReset());

  it("shows the not-connected panel when GitHub is disconnected", async () => {
    listReposResolvedMock.mockResolvedValue({ connected: false });
    render(<GitSourceTab onPick={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/GitHub not connected/i)).toBeInTheDocument()
    );
    // URL input stays usable regardless of connection state.
    expect(screen.getByPlaceholderText(/github\.com\/owner\/repo/i)).toBeInTheDocument();
    // The list/filter is gated away.
    expect(screen.queryByPlaceholderText(/Filter repositories/i)).not.toBeInTheDocument();
  });

  it("renders the repo list when connected", async () => {
    listReposResolvedMock.mockResolvedValue({
      connected: true,
      source: "gh",
      repos: [
        { nameWithOwner: "me/app", description: null, url: "u", sshUrl: "s", isPrivate: false, updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    render(<GitSourceTab onPick={() => {}} />);
    await waitFor(() => expect(screen.getByText("me/app")).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Filter repositories/i)).toBeInTheDocument();
  });

  it("expands owner/repo shorthand AND checks accessibility before calling onPick", async () => {
    listReposResolvedMock.mockResolvedValue({ connected: false });
    const onPick = vi.fn();
    const checkUrl = vi.fn().mockResolvedValue({ ok: true });
    render(<GitSourceTab onPick={onPick} checkUrl={checkUrl} />);
    const input = await screen.findByPlaceholderText(/owner\/repo/i);
    fireEvent.change(input, { target: { value: "agentscope-ai/QwenPaw" } });
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("https://github.com/agentscope-ai/QwenPaw"));
    expect(checkUrl).toHaveBeenCalledWith("https://github.com/agentscope-ai/QwenPaw");
  });

  it("passes a full https github URL through unchanged on submit", async () => {
    listReposResolvedMock.mockResolvedValue({ connected: false });
    const onPick = vi.fn();
    const checkUrl = vi.fn().mockResolvedValue({ ok: true });
    render(<GitSourceTab onPick={onPick} checkUrl={checkUrl} />);
    const input = await screen.findByPlaceholderText(/owner\/repo/i);
    fireEvent.change(input, { target: { value: "https://github.com/agentscope-ai/QwenPaw.git" } });
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("https://github.com/agentscope-ai/QwenPaw.git"));
  });

  it("does NOT call onPick when the accessibility check rejects — error surfaces inline", async () => {
    listReposResolvedMock.mockResolvedValue({ connected: false });
    const onPick = vi.fn();
    const checkUrl = vi.fn().mockRejectedValue(new Error("Repository not found"));
    render(<GitSourceTab onPick={onPick} checkUrl={checkUrl} />);
    const input = await screen.findByPlaceholderText(/owner\/repo/i);
    fireEvent.change(input, { target: { value: "ghost-user/nope" } });
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));
    await waitFor(() => expect(screen.getByText(/Repository not found/i)).toBeInTheDocument());
    expect(onPick).not.toHaveBeenCalled();
  });

  it("clicking a repo row calls onPick with the row's URL (no accessibility check — list came from GitHub)", async () => {
    listReposResolvedMock.mockResolvedValue({
      connected: true,
      source: "gh",
      repos: [
        { nameWithOwner: "agentscope-ai/QwenPaw", description: null, url: "https://github.com/agentscope-ai/QwenPaw", sshUrl: "s", isPrivate: false, updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const onPick = vi.fn();
    const checkUrl = vi.fn();
    render(<GitSourceTab onPick={onPick} checkUrl={checkUrl} />);
    const row = await screen.findByRole("button", { name: /agentscope-ai\/QwenPaw/i });
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith("https://github.com/agentscope-ai/QwenPaw");
    expect(checkUrl).not.toHaveBeenCalled();
  });
});
