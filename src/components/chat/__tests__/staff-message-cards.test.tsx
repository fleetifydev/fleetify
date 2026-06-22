import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffCard, MemoryFilesCard } from "../staff-message-cards";

describe("DiffCard", () => {
  it("renders the diff text and the changed-file count", () => {
    render(<DiffCard diff={"diff --git a/x b/x\n+hi"} files={1} isRepo />);
    expect(screen.getByText(/1 file changed/i)).toBeInTheDocument();
    expect(screen.getByText(/diff --git/)).toBeInTheDocument();
  });

  it("shows a clean-tree empty state", () => {
    render(<DiffCard diff="" files={0} isRepo />);
    expect(screen.getByText(/No changes/i)).toBeInTheDocument();
  });

  it("shows a not-a-repo state", () => {
    render(<DiffCard diff="" files={0} isRepo={false} />);
    expect(screen.getByText(/Not a git repository/i)).toBeInTheDocument();
  });
});

describe("MemoryFilesCard", () => {
  it("lists each CLAUDE.md file with path, scope and content", () => {
    render(<MemoryFilesCard files={[{ path: "/p/CLAUDE.md", content: "# rules", scope: "project" }]} />);
    expect(screen.getByText("/p/CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("# rules")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("shows an empty state when there are no files", () => {
    render(<MemoryFilesCard files={[]} />);
    expect(screen.getByText(/No memory files/i)).toBeInTheDocument();
  });
});
