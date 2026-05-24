import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage } from "@/types/chat";
import type { Session } from "@/types/session";

// `@/lib/api` reads window.electronAPI and fires fetch on import-side
// helpers; stub the surface createWelcomeSession touches so the existing-
// staff path (which bails before any API call) doesn't drag the real
// helpers into the test environment.
vi.mock("@/lib/api", () => ({
  apiCreateSession: vi.fn(),
  fetchSessions: vi.fn(),
  deleteEmptyDrafts: vi.fn(),
  updateSession: vi.fn(),
}));

const { useAppStore } = await import("@/stores/app-store");
const { useChatStore } = await import("@/stores/chat-store");

const minimalSession = (id: string, title: string): Session => ({
  id,
  title,
  project_path: "",
  group_path: "",
  tool: "claude",
  command: "",
  status: "idle",
  pinned: false,
  parent_id: null,
  worktree_path: null,
  worktree_branch: null,
  claude_session_id: null,
  model_name: "claude-sonnet-4-6",
  permission_mode: "bypassPermissions",
  session_mode: "interactive",
  order_idx: 0,
  created_at: new Date().toISOString(),
  last_accessed: null,
  notes: null,
});

const buildMessages = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `existing message ${i}` }],
    timestamp: new Date(2026, 0, 1, 12, i).toISOString(),
  }));

describe("createWelcomeSession — returning-user guard", () => {
  beforeEach(() => {
    // Reset stores to a known-empty baseline before each scenario.
    useAppStore.setState({
      sessions: [],
      staffSessionId: null,
      activeSessionId: null,
    });
    useChatStore.setState({ sessions: {} });
    try { localStorage.removeItem("fleet:staffSessionId"); } catch { /* noop */ }
  });

  it("returns durationMs: 0 and does NOT clobber existing chat history when a staff session already exists", async () => {
    const staffId = "staff-abc-123";
    const history = buildMessages(50);

    useAppStore.setState({
      sessions: [minimalSession(staffId, "Staff Agent")],
      staffSessionId: staffId,
    });
    useChatStore.setState({
      sessions: {
        [staffId]: {
          messages: history,
          streamingText: "",
          streamingThinking: "",
          isStreaming: false,
          sdkReady: false,
          streamStartTime: null,
          activeToolCalls: {},
          contentSoFar: [],
          permissionRequest: null,
          processLog: [],
          subagentTasks: {},
          selectedSubagentTaskId: null,
          compactionPill: null,
        },
      },
    });

    const result = await useAppStore.getState().createWelcomeSession("Alice");

    expect(result?.sessionId).toBe(staffId);
    expect(result?.durationMs).toBe(0);

    // Critical: the 50 existing messages survive untouched. The previous
    // behaviour replaced this array with a single welcome-* message via
    // setMessages(sid, [single]) and triggered the scroll-up loop.
    const after = useChatStore.getState().sessions[staffId]?.messages ?? [];
    expect(after).toHaveLength(50);
    expect(after[0]?.id).toBe("msg-0");
    expect(after[49]?.id).toBe("msg-49");
    expect(after.some((m) => m.id.startsWith("welcome-"))).toBe(false);
  });

  it("also bails when the staff session lives in sessions[] but staffSessionId is null (recovery path)", async () => {
    const staffId = "staff-recovered";
    useAppStore.setState({
      sessions: [minimalSession(staffId, "Staff Agent")],
      staffSessionId: null,
    });
    useChatStore.setState({
      sessions: {
        [staffId]: {
          messages: buildMessages(3),
          streamingText: "",
          streamingThinking: "",
          isStreaming: false,
          sdkReady: false,
          streamStartTime: null,
          activeToolCalls: {},
          contentSoFar: [],
          permissionRequest: null,
          processLog: [],
          subagentTasks: {},
          selectedSubagentTaskId: null,
          compactionPill: null,
        },
      },
    });

    const result = await useAppStore.getState().createWelcomeSession("Bob");

    expect(result?.durationMs).toBe(0);
    const after = useChatStore.getState().sessions[staffId]?.messages ?? [];
    expect(after).toHaveLength(3);
  });
});
