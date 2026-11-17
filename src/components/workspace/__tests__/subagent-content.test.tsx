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
/** A chat-store message, the shape streaming leaves in memory. */
const message = (id: string, t: string) => ({
  id, role: "assistant" as const, content: [text(t)], timestamp: new Date(0).toISOString(),
});
/** A row exactly as GET /sessions/:id/messages returns it. The backend keeps
 *  `content` as JSON-encoded text (crates/fleetify-backend/src/models/message.rs). */
const row = (sessionId: string, id: string, t: string) => ({
  id, session_id: sessionId, role: "assistant", content: JSON.stringify([text(t)]),
  model: null, usage_json: null, cost_usd: 0, timestamp: new Date(0).toISOString(),
});
const worker = (id: string) => ({ id, title: id } as Session);
const messagesOf = (sid: string) => useChatStore.getState().sessions[sid]?.messages ?? [];

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

const transcript = [message("m-1", "full worker transcript")];
const transcriptRows = [row("worker-1", "m-1", "full worker transcript")];

/** Holds every fetchMessages call open until the test settles it, so a test
 *  decides when, and in what order, transcripts arrive. */
function holdFetches() {
  const pending = new Map<string, (rows: unknown) => void>();
  vi.mocked(fetchMessages).mockImplementation(
    (id: string) => new Promise((resolve) => { pending.set(id, resolve); }),
  );
  return async (id: string, rows: unknown) => {
    const resolve = pending.get(id);
    if (!resolve) throw new Error(`no fetch is pending for ${id}`);
    await act(async () => { resolve(rows); });
  };
}

beforeEach(() => {
  vi.mocked(fetchMessages).mockReset();
  vi.mocked(fetchMessages).mockResolvedValue(transcriptRows);
  useChatStore.setState({ sessions: {} });
  // The user is in the parent agent's chat. The worker is not the active,
  // staff or split-pane session, so only a pin keeps the sweep off it.
  useAppStore.setState({
    activeSessionId: "parent",
    staffSessionId: "staff",
    splitPaneIds: [],
    sessions: [worker("worker-1")],
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

describe("SubagentContent fetching a transcript that isn't in memory", () => {
  it("fetches the worker's transcript and shows it instead of the dispatch log", async () => {
    // Regressions: (1) the effect kept the attempted id in state listed in its
    // own deps, so recording the attempt re-ran it and the cleanup dropped the
    // fetch it had just started. (2) Once results landed, the raw rows (content
    // still a JSON string) were stored as-is and MessageContent threw on them,
    // taking the whole app down.
    const settle = holdFetches();
    render(<SubagentContent task={finishedTask("worker-1")} />);
    expect(screen.getByText("lossy dispatch log")).toBeInTheDocument(); // until it lands

    await settle("worker-1", transcriptRows);

    expect(screen.getByText("full worker transcript")).toBeInTheDocument();
    expect(screen.queryByText("lossy dispatch log")).not.toBeInTheDocument();
    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });

  it("drops a fetch that lands after the pane moved to another task, and fetches the new one", async () => {
    useAppStore.setState({ sessions: [worker("worker-1"), worker("worker-2")] });
    const settle = holdFetches();
    const { rerender } = render(<SubagentContent task={finishedTask("worker-1")} />);
    rerender(<SubagentContent task={finishedTask("worker-2")} />);

    await settle("worker-1", transcriptRows); // the old task's answer arrives late
    expect(messagesOf("worker-1")).toHaveLength(0);

    await settle("worker-2", [row("worker-2", "m-2", "second worker transcript")]);
    expect(screen.getByText("second worker transcript")).toBeInTheDocument();
  });

  it("fetches a task again when the pane comes back to it after its first fetch was dropped", async () => {
    // Regression: a dropped attempt still counted as the task's one fetch. With
    // worker-1's fetch in flight the pane moved to worker-2 (already in memory,
    // so no fetch) and back, and worker-1 was never fetched again.
    useAppStore.setState({ sessions: [worker("worker-1"), worker("worker-2")] });
    useChatStore.getState().setMessages("worker-2", [message("m-2", "second worker transcript")]);
    const settle = holdFetches();
    const { rerender } = render(<SubagentContent task={finishedTask("worker-1")} />);
    rerender(<SubagentContent task={finishedTask("worker-2")} />);
    rerender(<SubagentContent task={finishedTask("worker-1")} />);

    expect(vi.mocked(fetchMessages).mock.calls.map(([id]) => id)).toEqual(["worker-1", "worker-1"]);
    await settle("worker-1", transcriptRows);
    expect(screen.getByText("full worker transcript")).toBeInTheDocument();
  });

  it("drops a fetch that lands after the pane closed", async () => {
    const settle = holdFetches();
    const { unmount } = render(<SubagentContent task={finishedTask("worker-1")} />);
    unmount();

    await settle("worker-1", transcriptRows);

    expect(messagesOf("worker-1")).toHaveLength(0);
  });

  it("drops a fetch that lands after a fresher transcript streamed in", async () => {
    const settle = holdFetches();
    render(<SubagentContent task={finishedTask("worker-1")} />);
    act(() => useChatStore.getState().setMessages("worker-1", [message("m-live", "live transcript")]));

    await settle("worker-1", transcriptRows); // an older snapshot, arriving late

    expect(messagesOf("worker-1").map(m => m.id)).toEqual(["m-live"]);
    expect(screen.getByText("live transcript")).toBeInTheDocument();
  });

  it("fetches at most once per task id", async () => {
    const settle = holdFetches();
    render(<SubagentContent task={finishedTask("worker-1")} />);
    await settle("worker-1", []); // nothing recorded yet: the pane stays on the log

    // The transcript arrives from elsewhere, then goes away again.
    act(() => useChatStore.getState().setMessages("worker-1", transcript));
    act(() => useChatStore.getState().setMessages("worker-1", []));

    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });
});
