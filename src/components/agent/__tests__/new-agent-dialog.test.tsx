/**
 * Renderer tests for the worktree checkbox in NewAgentDialog. The
 * dialog has many fields and side-effects; we mock the heavy ones
 * (createSession, plugin templates, suggestion fetcher) so the test
 * stays focused on the checkbox surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { createSessionMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn().mockResolvedValue({ id: "s1" }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    createSession: createSessionMock,
    fetchClaudeSessions: async () => [],
    fetchCodexSessions: async () => [],
    apiFetch: async () => ({ ok: true, json: async () => ({}) }),
  };
});

// Suppress getGitContext pre-check; hasGit must return ok:true so the
// WorktreeToggle doesn't collapse to "Git required" mode (which forces
// use_worktree to false and hides the "will initialize" hint).
Object.defineProperty(window, "electronAPI", {
  configurable: true,
  value: {
    getGitContext: async () => ({ branch: "main", baseBranch: "main" }),
    openFolderDialog: async () => null,
    hasGit: async () => ({ ok: true }),
  },
});

async function loadDialog() {
  const mod = await import("../new-agent-dialog");
  return mod;
}

beforeEach(() => { createSessionMock.mockReset(); createSessionMock.mockResolvedValue({ id: "s1" }); });

describe("NewAgentDialog — worktree checkbox", () => {
  it("renders the Isolated workspace checkbox checked by default", async () => {
    const { NewAgentDialog } = await loadDialog();
    render(<NewAgentDialog onClose={() => {}} />);
    const cb = screen.getByRole("checkbox", { name: /Isolated workspace/i }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it("flips helper text when unchecked", async () => {
    const { NewAgentDialog } = await loadDialog();
    render(<NewAgentDialog onClose={() => {}} />);
    expect(screen.getByText(/fresh checkout under/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Isolated workspace/i }));
    expect(screen.getByText(/shares your working directory/i)).toBeInTheDocument();
  });
});

describe("NewAgentDialog — createSession payload wiring", () => {
  it("passes use_worktree: true by default when Launch is clicked", async () => {
    const { NewAgentDialog } = await loadDialog();
    const { findByPlaceholderText } = render(<NewAgentDialog onClose={() => {}} />);
    // Path is required; name is optional. The Launch button enables once
    // path is non-empty and (for "new" mode) no resume id is needed.
    const folderInput = await findByPlaceholderText(/\/Users\/you\/projects/);
    fireEvent.change(folderInput, { target: { value: "/work/repo" } });

    const launch = screen.getByRole("button", { name: /Launch Agent/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);

    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ use_worktree: true, project_path: "/work/repo" }),
    );
  });

  it("passes use_worktree: false when the checkbox is unchecked before Launch", async () => {
    const { NewAgentDialog } = await loadDialog();
    const { findByPlaceholderText } = render(<NewAgentDialog onClose={() => {}} />);
    // Uncheck the Isolated workspace checkbox.
    const cb = screen.getByRole("checkbox", { name: /Isolated workspace/i }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);

    const folderInput = await findByPlaceholderText(/\/Users\/you\/projects/);
    fireEvent.change(folderInput, { target: { value: "/work/shared" } });

    const launch = screen.getByRole("button", { name: /Launch Agent/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);

    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ use_worktree: false, project_path: "/work/shared" }),
    );
  });
});

describe("NewAgentDialog — default workspace folder seeding", () => {
  it("pre-fills the Folder field from the configured default workspace folder", async () => {
    const original = window.electronAPI;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { ...original, getConfig: async () => ({ defaultFolder: "/work/default-ws" }) },
    });

    const { NewAgentDialog } = await loadDialog();
    const { findByPlaceholderText } = render(<NewAgentDialog onClose={() => {}} />);
    const input = (await findByPlaceholderText(/\/Users\/you\/projects/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("/work/default-ws"));

    Object.defineProperty(window, "electronAPI", { configurable: true, value: original });
  });

  it("falls back to getProjectRoot when no default workspace folder is set", async () => {
    const original = window.electronAPI;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        ...original,
        getConfig: async () => ({}),
        getProjectRoot: async () => "/work/project-root",
      },
    });

    const { NewAgentDialog } = await loadDialog();
    const { findByPlaceholderText } = render(<NewAgentDialog onClose={() => {}} />);
    const input = (await findByPlaceholderText(/\/Users\/you\/projects/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("/work/project-root"));

    Object.defineProperty(window, "electronAPI", { configurable: true, value: original });
  });
});

describe("NewAgentDialog — use_worktree wiring + folderInGit", () => {
  it("shows 'will initialize' hint when folder isn't a git repo", async () => {
    // Override the electronAPI mock just for this test.
    const original = window.electronAPI;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { ...original, getGitContext: async () => ({ branch: null, baseBranch: null }) },
    });

    const { NewAgentDialog } = await loadDialog();
    const { findByPlaceholderText } = render(<NewAgentDialog onClose={() => {}} />);
    const input = await findByPlaceholderText(/\/Users\/you\/projects/);
    fireEvent.change(input, { target: { value: "/no-git-folder" } });

    await waitFor(() => {
      expect(screen.getByText(/Folder isn't a git repo yet/i)).toBeInTheDocument();
    });

    // Restore for downstream tests
    Object.defineProperty(window, "electronAPI", { configurable: true, value: original });
  });
});
