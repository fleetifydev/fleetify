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
import { claimEscape } from "../use-escape-to-stop";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, type SessionChatState } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";
import { stopSession } from "@/lib/api";
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

/** An app-store session with the given status. */
const session = (id: string, status: Session["status"]) => ({ id, status }) as unknown as Session;
const running = (id: string) => session(id, "running");

/** Chat-store state of an agent whose reply is still streaming in. */
const chatStreaming = { isStreaming: true } as unknown as SessionChatState;

describe("useKeyboardShortcuts while the shell is parked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessions: [], activeSessionId: "agent-1", staffSessionId: "staff" });
    useChatStore.setState({ sessions: {} });
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
    useAppStore.setState({ sessions: [running("agent-1"), running("agent-2")] });
    fireEvent.keyDown(window, { key: "A", metaKey: true, shiftKey: true });
    expect(wsManager.abort).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledTimes(2);
  });

  it("aborts on the event Caps Lock produces, where Ctrl+Shift+A reports key 'a'", () => {
    render(<Shell parked />);
    useAppStore.setState({ sessions: [running("agent-1"), running("agent-2")] });
    fireEvent.keyDown(window, { key: "a", code: "KeyA", ctrlKey: true, shiftKey: true });
    expect(wsManager.abort).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledTimes(2);
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

// A popover, menu or overlay that closes on Escape claims it (claimEscape)
// from a document listener or a React handler, which run before this hook's
// window listener. That Escape closed something; it must not also leave the
// agent chat.
describe("back-to-fleet leaves a claimed Escape alone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessions: [], activeSessionId: "agent-1", staffSessionId: "staff" });
    useChatStore.setState({ sessions: {} });
  });

  /** Presses Escape on the page while a popover's document listener claims it. */
  const escapeClaimedByPopover = () => {
    const popover = (e: KeyboardEvent) => { if (e.key === "Escape") claimEscape(e); };
    document.addEventListener("keydown", popover);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", popover);
    }
  };

  it("stays in the agent chat when a popover claimed the Escape to close itself", () => {
    render(<Shell parked={false} />);
    escapeClaimedByPopover();
    expect(useAppStore.getState().activeSessionId).toBe("agent-1");
  });

  it("still goes back to Fleet on the next, unclaimed Escape", () => {
    render(<Shell parked={false} />);
    escapeClaimedByPopover();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });
});

// The Fleet panel shows an agent as running — with a Stop button — when its
// app-store status says so OR its chat is still streaming. Abort-all has to
// stop everything that panel would let you stop.
describe("abort-all picks every agent the UI shows as running", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ sessions: [], activeSessionId: null, staffSessionId: "staff" });
    useChatStore.setState({ sessions: {} });
  });

  const abortAll = () => fireEvent.keyDown(window, { key: "A", metaKey: true, shiftKey: true });

  it("aborts an agent that is idle in the app store but still streaming in its chat", () => {
    render(<Shell parked={false} />);
    useAppStore.setState({ sessions: [session("agent-1", "idle")] });
    useChatStore.setState({ sessions: { "agent-1": chatStreaming } });
    abortAll();
    expect(wsManager.abort).toHaveBeenCalledTimes(1);
    expect(wsManager.abort).toHaveBeenCalledWith("agent-1");
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith("agent-1");
  });

  it("aborts an agent that is running and streaming exactly once", () => {
    render(<Shell parked={false} />);
    useAppStore.setState({ sessions: [running("agent-1")] });
    useChatStore.setState({ sessions: { "agent-1": chatStreaming } });
    abortAll();
    expect(wsManager.abort).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it("never aborts the staff session, even while it runs and streams", () => {
    render(<Shell parked={false} />);
    useAppStore.setState({ sessions: [running("staff"), session("agent-1", "idle")] });
    useChatStore.setState({ sessions: { staff: chatStreaming, "agent-1": chatStreaming } });
    abortAll();
    expect(wsManager.abort).toHaveBeenCalledTimes(1);
    expect(wsManager.abort).toHaveBeenCalledWith("agent-1");
    expect(wsManager.abort).not.toHaveBeenCalledWith("staff");
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).not.toHaveBeenCalledWith("staff");
  });
});
