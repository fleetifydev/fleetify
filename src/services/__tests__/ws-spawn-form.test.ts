import { describe, it, expect, beforeEach } from "vitest";
import { wsManager } from "@/services/ws-manager";
import { useChatStore } from "@/stores/chat-store";

describe("spawn_form ws event", () => {
  beforeEach(() => useChatStore.setState({ sessions: {} } as never));

  it("appends a spawn_form system message to the transcript", () => {
    const sid = "staff-1";
    // Drive the private incoming-event handler the same way the socket does.
    (
      wsManager as unknown as {
        handleEvent: (s: string, e: MessageEvent) => void;
      }
    ).handleEvent(sid, {
      data: JSON.stringify({
        type: "spawn_form",
        session_id: sid,
        request_id: "r1",
        status: "pending",
        draft: { title: "x", tool: "claude-code" },
        gaps: [],
      }),
    } as MessageEvent);

    const msgs = useChatStore.getState().sessions[sid]?.messages ?? [];
    const block = msgs.flatMap((m) => m.content).find((b) => b.type === "spawn_form");
    expect(block).toBeTruthy();
  });
});
