import { describe, it, expect } from "vitest";
import { hasOffWorktreeConflict } from "../new-agent-dialog";

const sess = (project_path: string, worktree_path: string | null) => ({ project_path, worktree_path });

describe("hasOffWorktreeConflict", () => {
  it("blocks a 2nd off-worktree session on the same folder", () => {
    const sessions = [sess("/clones/o/api", null)];
    expect(hasOffWorktreeConflict("/clones/o/api", false, sessions)).toBe(true);
  });

  it("allows when the new session uses a worktree", () => {
    const sessions = [sess("/clones/o/api", null)];
    expect(hasOffWorktreeConflict("/clones/o/api", true, sessions)).toBe(false);
  });

  it("does not conflict with on-worktree sessions (they are isolated)", () => {
    const sessions = [sess("/clones/o/api", "/clones/o/api/.fleetify-worktrees/abc")];
    expect(hasOffWorktreeConflict("/clones/o/api", false, sessions)).toBe(false);
  });

  it("ignores sessions in other folders", () => {
    const sessions = [sess("/clones/o/other", null)];
    expect(hasOffWorktreeConflict("/clones/o/api", false, sessions)).toBe(false);
  });

  it("is false for an empty path", () => {
    expect(hasOffWorktreeConflict("", false, [sess("", null)])).toBe(false);
  });
});
