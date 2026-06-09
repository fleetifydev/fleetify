import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SpawnFormBlock } from "@/types/chat";

const { spawnSessionMock } = vi.hoisted(() => ({
  spawnSessionMock: vi.fn().mockResolvedValue({ id: "new-1" }),
}));

vi.mock("@/lib/api", () => ({ spawnSession: spawnSessionMock }));
vi.mock("@/hooks/use-providers-config", () => ({
  useProvidersConfig: () => ({
    tiles: [{ spec: { id: "claude", display_name: "Claude Code", default_models: [] } }],
  }),
}));
vi.mock("@/lib/capabilities", () => ({
  permissionCapabilityFor: () => ({ kind: "modes" }),
  permissionModesFor: () => [
    { id: "default", label: "Ask" },
    { id: "bypassPermissions", label: "Full auto" },
  ],
}));
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
    gaps: [],
    draft: {
      title: "code-reviewer",
      project_path: "/tmp/xyz",
      tool: "claude",
      model_name: "claude-opus-4-8",
      permission_mode: "bypassPermissions",
    },
    ...over,
  };
}

describe("SpawnFormCard", () => {
  beforeEach(() => spawnSessionMock.mockClear());

  it("prefills fields from the draft", () => {
    render(<SpawnFormCard block={block()} />);
    expect((screen.getByPlaceholderText("Agent name") as HTMLInputElement).value).toBe(
      "code-reviewer",
    );
    expect(screen.getByText("/tmp/xyz")).toBeTruthy();
  });

  it("Create posts the edited spec", () => {
    render(<SpawnFormCard block={block()} />);
    fireEvent.click(screen.getByText("Create"));
    expect(spawnSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_path: "/tmp/xyz", tool: "claude" }),
    );
  });

  it("disables Create when project_path is empty (gap)", () => {
    render(
      <SpawnFormCard
        block={block({
          draft: { tool: "claude" },
          gaps: [{ field: "project_path", reason: "missing", candidates: [] }],
        })}
      />,
    );
    expect(
      (screen.getByText("Create").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
