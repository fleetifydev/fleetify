import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

// The pane re-fetches a worker's transcript over HTTP when none is in memory.
// Stub it so the test stays off the network and can count the fetches.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchMessages: vi.fn(),
}));

import { fetchMessages } from "@/lib/api";
import { SubagentContent } from "@/components/workspace/workspace-panel";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, type SubagentTask } from "@/stores/chat-store";
import { pinnedSessionIds } from "@/lib/session-pins";
import { sweepInactiveSessions } from "@/lib/session-eviction";
import type { Session } from "@/types/session";

const text = (t: string) => ({ type: "text" as const, text: t });

/** A finished Fleet dispatch. Its `content` is the lossy dispatch-stream log
 *  that the pane falls back to when the worker's own transcript is missing. */
const finishedTask = (id: string): SubagentTask => ({
  id,
  toolUseId: null,
  description: "Fix the flaky outbox test",
  taskType: null,
  status: "completed",
  startedAt: 0,
  endedAt: 1,
  totalTokens: 0,
  toolUses: 0,
  durationMs: 1,
  lastToolName: null,
  summary: null,
  content: [text("lossy dispatch log")],
  streamingText: "",
  streamingThinking: "",
  activeToolCalls: {},
});

const transcript = [
  { id: "m-1", role: "assistant" as const, content: [text("full worker transcript")], timestamp: new Date(0).toISOString() },
];

beforeEach(() => {
  vi.mocked(fetchMessages).mockReset();
  vi.mocked(fetchMessages).mockResolvedValue(transcript);
  useChatStore.setState({ sessions: {} });
  // The user is in the parent agent's chat. The worker is not the active,
  // staff or split-pane session, so only a pin keeps the sweep off it.
  useAppStore.setState({
    activeSessionId: "parent",
    staffSessionId: "staff",
    splitPaneIds: [],
    sessions: [{ id: "worker-1", title: "worker" } as Session],
  });
});

describe("SubagentContent (Agent pane)", () => {
  it("keeps a finished worker's full transcript on screen through a sweep", () => {
    // Regression: a Fleet worker's messages stream into chat-store while it
    // runs. Once it stopped, the next sweep emptied them, since the worker was
    // not the active, staff or split-pane session, and the pane silently
    // dropped to the lossy dispatch log. Its re-fetch never brought them back.
    useChatStore.getState().setMessages("worker-1", transcript);
    render(<SubagentContent task={finishedTask("worker-1")} />);
    expect(screen.getByText("full worker transcript")).toBeInTheDocument();

    act(() => sweepInactiveSessions());

    expect(screen.getByText("full worker transcript")).toBeInTheDocument();
    expect(screen.queryByText("lossy dispatch log")).not.toBeInTheDocument();
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("pins the worker's session only while the pane shows it", () => {
    useChatStore.getState().setMessages("worker-1", transcript);
    const { unmount } = render(<SubagentContent task={finishedTask("worker-1")} />);
    expect(pinnedSessionIds()).toEqual(["worker-1"]);

    unmount();

    expect(pinnedSessionIds()).toEqual([]);
  });

  it("pins nothing for a sub-agent that has no session of its own", () => {
    // Claude SDK Task / Codex spawnAgent sub-agents live in the parent's
    // `subagentTasks`, which the sweep never touches. There is no session to keep.
    render(<SubagentContent task={finishedTask("sdk-task-1")} />);
    expect(pinnedSessionIds()).toEqual([]);
  });
});
