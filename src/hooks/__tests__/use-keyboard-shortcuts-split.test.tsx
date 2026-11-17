import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, fireEvent } from "@testing-library/react";
import { useKeyboardShortcuts } from "../use-keyboard-shortcuts";
import { usePaneEscapeToStop } from "@/components/chat/chat-view";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, type SessionChatState } from "@/stores/chat-store";

// back-to-fleet and Escape-to-stop both listen on window, and the shell's
// listener comes first. If back-to-fleet acts (preventDefault), the focused
// pane's stop skips the Escape. So in a split view it has to look at the
// focused pane, the one Escape-to-stop serves, not at activeSessionId, which
// can name another session: closing the focused last pane leaves it pointing
// at the closed one.

/** One pane as ChatView renders it, registering Escape-to-stop. */
function Pane({ paneIdx, streaming, onStop }: {
  paneIdx: number;
  streaming: boolean;
  onStop: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  usePaneEscapeToStop(surface, paneIdx, streaming, onStop);
  return <div ref={surface}>pane {paneIdx}</div>;
}

/** The shell with a two-pane grid. The shell's listener registers at mount,
 *  before any pane starts streaming, as in the app. */
function Shell({ streaming, stops }: {
  streaming: [boolean, boolean];
  stops: [() => void, () => void];
}) {
  const root = useRef<HTMLDivElement>(null);
  useKeyboardShortcuts(root);
  return (
    <div ref={root}>
      <Pane paneIdx={0} streaming={streaming[0]} onStop={stops[0]} />
      <Pane paneIdx={1} streaming={streaming[1]} onStop={stops[1]} />
    </div>
  );
}

const streamingChat = { isStreaming: true } as unknown as SessionChatState;
const idleChat = { isStreaming: false } as unknown as SessionChatState;

/** The store's state after closing the focused last pane of [A, B, C]:
 *  focus moves to B, activeSessionId still names C. */
function closeFocusedLastPane() {
  useAppStore.setState({
    sessions: [],
    staffSessionId: "staff",
    splitPaneIds: ["agent-a", "agent-b", "agent-c"],
    focusedPaneIdx: 2,
    activeSessionId: "agent-c",
  });
  useAppStore.getState().removePane("agent-c");
}

describe("back-to-fleet in a split view", () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
  });

  afterEach(() => {
    useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 0, activeSessionId: null });
  });

  it("leaves Escape to the focused pane's stop when activeSessionId names a closed, idle session", () => {
    closeFocusedLastPane();
    const state = useAppStore.getState();
    expect({ panes: state.splitPaneIds, focused: state.focusedPaneIdx, active: state.activeSessionId })
      .toEqual({ panes: ["agent-a", "agent-b"], focused: 1, active: "agent-c" });
    useChatStore.setState({ sessions: { "agent-b": streamingChat, "agent-c": idleChat } });

    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    const { rerender } = render(<Shell streaming={[false, false]} stops={stops} />);
    rerender(<Shell streaming={[false, true]} stops={stops} />); // B starts streaming
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(stops[0]).not.toHaveBeenCalled();
    // And it did not navigate.
    expect(useAppStore.getState().activeSessionId).toBe("agent-c");
    expect(useAppStore.getState().splitPaneIds).toEqual(["agent-a", "agent-b"]);
  });

  it("goes back to Fleet from an idle focused pane even while activeSessionId's session streams", () => {
    closeFocusedLastPane();
    useChatStore.setState({ sessions: { "agent-c": streamingChat } });
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    render(<Shell streaming={[false, false]} stops={stops} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBeNull();
    expect(stops[0]).not.toHaveBeenCalled();
    expect(stops[1]).not.toHaveBeenCalled();
  });
});

describe("back-to-fleet with a modal open", () => {
  let modal: HTMLElement;

  beforeEach(() => {
    useChatStore.setState({ sessions: {} });
    modal = document.createElement("div");
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
  });

  afterEach(() => {
    modal.remove();
    useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 0, activeSessionId: null });
  });

  it("does not leave the agent chat in a single view", () => {
    useAppStore.setState({ sessions: [], staffSessionId: "staff", splitPaneIds: [], activeSessionId: "agent-1" });
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    render(<Shell streaming={[false, false]} stops={stops} />);
    // Focus is outside the modal: the modal's own listener may not have run.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBe("agent-1");
  });

  it("does not leave the agent chat in a split view", () => {
    useAppStore.setState({
      sessions: [], staffSessionId: "staff",
      splitPaneIds: ["agent-a", "agent-b"], focusedPaneIdx: 0, activeSessionId: "agent-a",
    });
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    render(<Shell streaming={[false, false]} stops={stops} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBe("agent-a");
  });

  it("goes back to Fleet again once the modal is gone", () => {
    useAppStore.setState({ sessions: [], staffSessionId: "staff", splitPaneIds: [], activeSessionId: "agent-1" });
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    render(<Shell streaming={[false, false]} stops={stops} />);
    modal.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });
});
