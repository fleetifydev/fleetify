import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SpawnFormBlock } from "@/types/chat";

const { spawnSessionMock } = vi.hoisted(() => ({
  spawnSessionMock: vi.fn().mockResolvedValue({ id: "new-1" }),
}));

vi.mock("@/lib/api", () => ({ spawnSession: spawnSessionMock }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (sel: (s: { setActiveSession: () => void }) => unknown) =>
    sel({ setActiveSession: vi.fn() }),
}));

import { SpawnFormCard } from "../spawn-form-card";

function block(over: Partial<SpawnFormBlock> = {}): SpawnFormBlock {
  return {
    type: "spawn_form",
    request_id: "r1",
    status: "pending",
    gaps: [{ field: "project_path", reason: "missing", candidates: [] }],
    draft: {
      title: "codex-test_a",
      tool: "codex-cli",
      first_task: "Briefly introduce yourself.",
    },
    ...over,
  };
}

describe("SpawnFormCard (folder picker)", () => {
  beforeEach(() => spawnSessionMock.mockClear());

  it("shows the agent context and the folder prompt", () => {
    render(<SpawnFormCard block={block()} />);
    expect(screen.getByText(/codex-test_a · codex/)).toBeTruthy();
    expect(screen.getByText("Pick a folder…")).toBeTruthy();
  });

  it("disables Create until a folder is picked", () => {
    render(<SpawnFormCard block={block()} />);
    expect(
      (screen.getByText("Create").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a candidate chip fills the folder and Create posts the spec with worktree off", () => {
    render(
      <SpawnFormCard
        block={block({
          gaps: [
            {
              field: "project_path",
              reason: "ambiguous",
              candidates: ["/home/u/test_a", "/home/u/test_b"],
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByText("test_a"));
    const btn = screen.getByText("Create").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(spawnSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_path: "/home/u/test_a",
        tool: "codex-cli",
        first_task: "Briefly introduce yourself.",
        use_worktree: false,
      }),
    );
  });

  it("renders the created card when status is created", () => {
    render(
      <SpawnFormCard
        block={block({
          status: "created",
          created_session_id: "s-9",
          draft: { title: "codex-test_a", project_path: "/home/u/test_a" },
          gaps: [],
        })}
      />,
    );
    expect(screen.getByText(/Created agent/)).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
  });
});
