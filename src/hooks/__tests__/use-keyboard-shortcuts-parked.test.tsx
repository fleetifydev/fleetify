import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, fireEvent } from "@testing-library/react";

// abort-all calls these singletons; stub them so the shortcut never opens a
// socket or hits the backend. They resolve like the real ones because the
// binding chains `.catch()` onto each call.
vi.mock("@/services/ws-manager", () => ({
  wsManager: { abort: vi.fn(() => Promise.resolve()) },
}));
vi.mock("@/lib/api", () => ({
  stopSession: vi.fn(() => Promise.resolve()),
  archiveSession: vi.fn(() => Promise.resolve()),
}));

import { useKeyboardShortcuts, SHORTCUT_BINDINGS } from "../use-keyboard-shortcuts";
import { useAppStore } from "@/stores/app-store";
import { wsManager } from "@/services/ws-manager";
import type { Session } from "@/types/session";

/** Mirrors App.tsx, which parks AppShell under `display: none` while Settings
 *  or Library is open. The shell — and this hook — stay mounted throughout. */
function Shell({ parked }: { parked: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useKeyboardShortcuts(root);
  return (
    <div style={{ display: parked ? "none" : "contents" }}>
      <div ref={root}>shell</div>
    </div>
  );
}

/** An agent mid-stream. abort-all picks agents by their app-store status. */
const streaming = (id: string) => ({ id, status: "running" }) as unknown as Session;

describe("useKeyboardShortcuts while the shell is parked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessions: [], activeSessionId: "agent-1", staffSessionId: "staff" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Escape still goes back to Fleet from a visible agent chat", () => {
    render(<Shell parked={false} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  it("Escape that closes Settings / Library does not also leave the chat underneath", () => {
    render(<Shell parked />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBe("agent-1");
  });

  it("still aborts every streaming agent with Cmd+Shift+A while the shell is parked", () => {
    // shell under display:none, two streaming agents
    render(<Shell parked />);
    useAppStore.setState({ sessions: [streaming("agent-1"), streaming("agent-2")] });
    fireEvent.keyDown(window, { key: "A", metaKey: true, shiftKey: true });
    expect(wsManager.abort).toHaveBeenCalledTimes(2);
  });

  it("does not compute styles for keys no binding handles", () => {
    render(<Shell parked />);
    const spy = vi.spyOn(window, "getComputedStyle");
    fireEvent.keyDown(window, { key: "a" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("lets only abort-all through a parked shell", () => {
    const parkedIds = SHORTCUT_BINDINGS.filter(b => b.worksWhileParked).map(b => b.id);
    expect(parkedIds).toEqual(["abort-all"]);
  });
});
