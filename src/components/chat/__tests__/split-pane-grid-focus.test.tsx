import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// Each pane renders a full ChatView. A composer textarea is enough here: the
// test is about which pane the grid marks as focused.
vi.mock("../chat-view", () => ({
  ChatView: ({ paneIdx }: { paneIdx?: number }) => <textarea aria-label={`composer ${paneIdx}`} />,
}));
vi.mock("@/components/workspace/workspace-panel", () => ({ WorkspacePanel: () => null }));

import { SplitPaneGrid } from "../split-pane-grid";
import { useAppStore } from "@/stores/app-store";

const renderGrid = () => render(<SplitPaneGrid dragging={false} onPaneDropEdge={vi.fn()} />);

describe("SplitPaneGrid focused pane", () => {
  beforeEach(() => {
    useAppStore.setState({ splitPaneIds: ["agent-a", "agent-b"], focusedPaneIdx: 0, activeSessionId: "agent-a" });
  });

  it("follows keyboard focus into another pane", () => {
    // Escape-to-stop is gated on the focused pane, so Tab-ing into a pane has
    // to make it the focused one. Before this, only a click did.
    const { getByLabelText } = renderGrid();
    act(() => getByLabelText("composer 1").focus());
    expect(useAppStore.getState().focusedPaneIdx).toBe(1);
    expect(useAppStore.getState().activeSessionId).toBe("agent-b");
  });

  it("still follows a click", () => {
    const { getByLabelText } = renderGrid();
    fireEvent.click(getByLabelText("composer 1"));
    expect(useAppStore.getState().focusedPaneIdx).toBe(1);
  });
});
