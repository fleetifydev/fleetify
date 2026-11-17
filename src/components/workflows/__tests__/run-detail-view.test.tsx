import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The run's transcript comes from GET /sessions/:id/messages. The provider
// catalogue would otherwise go out over IPC on mount; the view only needs
// it for a model label.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchMessages: vi.fn(),
}));
vi.mock("@/hooks/use-providers-config", () => ({ useProvidersConfig: () => ({ tiles: [] }) }));

import { fetchMessages } from "@/lib/api";
import { RunDetailView } from "@/components/workflows/WorkflowsPage";
import { useChatStore } from "@/stores/chat-store";
import type { Routine, RoutineRun } from "@/services/routines-runtime";

const routine: Routine = {
  id: "r-1",
  name: "Morning briefing",
  description: "",
  instructions: "Give me a concise morning briefing",
  target: "new",
  permissionMode: "default",
  projectPath: "/work/project",
  provider: "claude-code",
  modelId: "sonnet",
  useWorktree: false,
  agentTemplate: null,
  resumeSessionId: null,
  schedule: "manual",
  scheduleTime: "09:00",
  createdAt: new Date(0).toISOString(),
};
const run: RoutineRun = {
  id: "run-1",
  routineId: "r-1",
  startedAt: new Date(0).toISOString(),
  finishedAt: new Date(60_000).toISOString(),
  status: "ok",
  sessionId: "run-session",
};

/** A row exactly as GET /sessions/:id/messages returns it. The backend keeps
 *  `content` as JSON-encoded text (crates/fleetify-backend/src/models/message.rs). */
const row = (id: string, role: string, text: string) => ({
  id, session_id: "run-session", role, content: JSON.stringify([{ type: "text", text }]),
  model: null, usage_json: null, cost_usd: 0, timestamp: new Date(0).toISOString(),
});

beforeEach(() => {
  // routines-runtime reads routines and runs from localStorage.
  localStorage.setItem("fleet:routines:v2", JSON.stringify([routine]));
  localStorage.setItem("fleet:routines:runs:v1", JSON.stringify([run]));
  useChatStore.setState({ sessions: {} });
  vi.mocked(fetchMessages).mockReset();
});
afterEach(() => localStorage.clear());

describe("RunDetailView", () => {
  it("shows a run's transcript fetched after it left memory", async () => {
    // Regression: the fetched rows were stored raw, with content still a JSON
    // string, so the Activity panel looped over its characters and showed
    // nothing at all.
    vi.mocked(fetchMessages).mockResolvedValue([
      row("m-1", "user", "Give me a concise morning briefing"),
      row("m-2", "assistant", "Three meetings today; the 10:00 moved to 11:00."),
    ]);

    render(<RunDetailView routineId="r-1" runId="run-1" onBack={() => {}} />);

    expect(await screen.findByText("Three meetings today; the 10:00 moved to 11:00.")).toBeInTheDocument();
    expect(fetchMessages).toHaveBeenCalledWith("run-session");
  });
});
