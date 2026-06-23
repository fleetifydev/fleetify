import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Session } from "@/types/session";
import { SessionPreviewCard } from "../session-preview-card";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1", title: "My session", tool: "claude-code",
    project_path: "C:\\Users\\me\\Desktop\\fleetify",
    worktree_path: null, worktree_branch: null,
    model_name: "claude-opus-4-8", status: "idle",
    ...over,
  } as unknown as Session;
}

it("shows folder tail, branch, title, and model label", () => {
  render(
    <SessionPreviewCard
      session={session({ worktree_branch: "feat/new-message" })}
      gitContext={null}
    />,
  );
  expect(screen.getByText("Desktop\\fleetify")).toBeTruthy();
  expect(screen.getByText("feat/new-message")).toBeTruthy();
  expect(screen.getByText("My session")).toBeTruthy();
  expect(screen.getByText("Opus 4.8")).toBeTruthy();
});

it("renders the diff stat and branch from gitContext", () => {
  render(
    <SessionPreviewCard
      session={session()}
      gitContext={{ branch: "main", plus: 42, minus: 8 }}
    />,
  );
  expect(screen.getByText("main")).toBeTruthy();
  expect(screen.getByText("+42")).toBeTruthy();
  expect(screen.getByText("-8")).toBeTruthy();
});
