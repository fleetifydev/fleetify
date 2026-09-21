import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { sweepInactiveSessions, visibleSessionIds } from "../session-eviction";

const msg = (id: string) => ({
  id,
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "hi" }],
  timestamp: new Date(0).toISOString(),
});

const transcript = (sid: string) => useChatStore.getState().sessions[sid]?.messages ?? [];

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
  useAppStore.setState({ activeSessionId: null, staffSessionId: "staff", splitPaneIds: [] });
});

describe("visibleSessionIds", () => {
  it("is the staff session on the Fleet hub, where no agent is active", () => {
    // chat-view renders `activeSessionId || staffSessionId`, so on the hub the
    // conversation on screen IS the staff session.
    expect(visibleSessionIds({ activeSessionId: null, staffSessionId: "staff" })).toEqual(["staff"]);
  });

  it("is the active agent — not the staff session behind it — inside an agent chat", () => {
    expect(visibleSessionIds({ activeSessionId: "agent-1", staffSessionId: "staff" })).toEqual(["agent-1"]);
  });

  it("includes every split pane, without duplicates", () => {
    expect(
      visibleSessionIds({ activeSessionId: "a", staffSessionId: "staff", splitPaneIds: ["a", "b"] }),
    ).toEqual(["a", "b"]);
  });

  it("is empty before the staff session is known", () => {
    expect(visibleSessionIds({ activeSessionId: null, staffSessionId: null })).toEqual([]);
  });
});

describe("sweepInactiveSessions", () => {
  it("keeps the Fleet hub conversation while the hub is on screen", () => {
    // Regression: the hub went blank ("Talk to Fleetify") on its own. The 20s
    // sweep emptied the staff transcript because the hub has no activeSessionId,
    // and chat-view only refetches history when the session id changes.
    useChatStore.getState().addMessage("staff", msg("m-1"));
    useChatStore.getState().addMessage("agent-1", msg("m-2"));

    sweepInactiveSessions();

    expect(transcript("staff")).toHaveLength(1);
    expect(transcript("agent-1")).toHaveLength(0); // still reclaims what isn't visible
  });

  it("releases the hub conversation once the user is inside an agent chat", () => {
    useAppStore.setState({ activeSessionId: "agent-1" });
    useChatStore.getState().addMessage("staff", msg("m-1"));
    useChatStore.getState().addMessage("agent-1", msg("m-2"));

    sweepInactiveSessions();

    expect(transcript("staff")).toHaveLength(0);
    expect(transcript("agent-1")).toHaveLength(1);
  });
});
