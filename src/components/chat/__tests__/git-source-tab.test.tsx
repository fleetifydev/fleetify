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
    render(<GitSourceTab onPick={() => {}} cloning={false} onClone={() => {}} />);
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
    render(<GitSourceTab onPick={() => {}} cloning={false} onClone={() => {}} />);
    await waitFor(() => expect(screen.getByText("me/app")).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Filter repositories/i)).toBeInTheDocument();
  });

  it("expands owner/repo shorthand to a full github URL before invoking onClone", async () => {
    listReposResolvedMock.mockResolvedValue({ connected: false });
    const onClone = vi.fn();
    render(<GitSourceTab onPick={() => {}} cloning={false} onClone={onClone} />);
    const input = await screen.findByPlaceholderText(/owner\/repo/i);
    fireEvent.change(input, { target: { value: "agentscope-ai/QwenPaw" } });
    fireEvent.click(screen.getByRole("button", { name: /Clone/i }));
    expect(onClone).toHaveBeenCalledWith("https://github.com/agentscope-ai/QwenPaw");
  });

  it("passes a full https github URL through unchanged on submit", async () => {
    listReposResolvedMock.mockResolvedValue({ connected: false });
    const onClone = vi.fn();
    render(<GitSourceTab onPick={() => {}} cloning={false} onClone={onClone} />);
    const input = await screen.findByPlaceholderText(/owner\/repo/i);
    fireEvent.change(input, { target: { value: "https://github.com/agentscope-ai/QwenPaw.git" } });
    fireEvent.click(screen.getByRole("button", { name: /Clone/i }));
    expect(onClone).toHaveBeenCalledWith("https://github.com/agentscope-ai/QwenPaw.git");
  });
});
