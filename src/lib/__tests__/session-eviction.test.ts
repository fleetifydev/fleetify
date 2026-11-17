import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { sweepInactiveSessions, visibleSessionIds } from "../session-eviction";
import { pinSession } from "../session-pins";

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

describe("sweepInactiveSessions — pinned sessions", () => {
  // Pins are module state: release every one a test takes, even after a
  // failed assertion, so none leaks into the next test.
  const held: Array<() => void> = [];
  const pin = (id: string) => {
    const release = pinSession(id);
    held.push(release);
    return release;
  };
  afterEach(() => {
    for (const release of held.splice(0)) release();
  });

  it("keeps a pinned session that no chat view shows, alongside the visible one", () => {
    // Regression: a Workflows run detail went blank about 20s after it opened.
    // It fetches the run's transcript once, and the sweep emptied it because
    // only chat views counted as "on screen".
    pin("run-1");
    useChatStore.getState().addMessage("staff", msg("m-1"));
    useChatStore.getState().addMessage("run-1", msg("m-2"));
    useChatStore.getState().addMessage("agent-1", msg("m-3"));

    sweepInactiveSessions();

    expect(transcript("staff")).toHaveLength(1);   // visible
    expect(transcript("run-1")).toHaveLength(1);   // pinned
    expect(transcript("agent-1")).toHaveLength(0); // neither: still reclaimed
  });

  it("evicts the session on the next sweep once its pin is released", () => {
    const release = pin("run-1");
    useChatStore.getState().addMessage("run-1", msg("m-1"));
    sweepInactiveSessions();
    expect(transcript("run-1")).toHaveLength(1);

    release();
    sweepInactiveSessions();

    expect(transcript("run-1")).toHaveLength(0);
  });

  it("keeps a session pinned twice and released once", () => {
    const first = pin("run-1");
    pin("run-1");
    useChatStore.getState().addMessage("run-1", msg("m-1"));

    first();
    sweepInactiveSessions();

    expect(transcript("run-1")).toHaveLength(1);
  });
});
