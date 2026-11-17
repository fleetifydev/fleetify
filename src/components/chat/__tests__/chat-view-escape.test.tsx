import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRef } from "react";
import { render, fireEvent, act } from "@testing-library/react";
import { usePaneEscapeToStop } from "../chat-view";
import { useAppStore } from "@/stores/app-store";

/** One chat as ChatView renders it: a surface with its composer inside,
 *  registering Escape-to-stop exactly once. */
function Chat({ paneIdx, streaming, onStop }: {
  paneIdx?: number;
  streaming: boolean;
  onStop: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  usePaneEscapeToStop(surface, paneIdx, streaming, onStop);
  return (
    <div ref={surface}>
      <textarea aria-label={paneIdx === undefined ? "composer" : `composer ${paneIdx}`} />
    </div>
  );
}

/** A two-pane split view. Both panes are on screen at once. */
function TwoPanes({ streaming, stops }: {
  streaming: [boolean, boolean];
  stops: [() => void, () => void];
}) {
  return (
    <>
      <Chat paneIdx={0} streaming={streaming[0]} onStop={stops[0]} />
      <Chat paneIdx={1} streaming={streaming[1]} onStop={stops[1]} />
    </>
  );
}

describe("Escape-to-stop in a split view", () => {
  beforeEach(() => {
    useAppStore.setState({ splitPaneIds: ["agent-a", "agent-b"], focusedPaneIdx: 1 });
  });

  it("stops only the focused pane's stream, not the one that started first", () => {
    // Regression: listeners fire in registration order, which is the order the
    // streams started. So Escape typed in pane 1 used to stop pane 0.
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    const { rerender, getByLabelText } = render(<TwoPanes streaming={[false, false]} stops={stops} />);
    rerender(<TwoPanes streaming={[true, false]} stops={stops} />); // pane 0 starts first
    rerender(<TwoPanes streaming={[true, true]} stops={stops} />);  // then pane 1
    fireEvent.keyDown(getByLabelText("composer 1"), { key: "Escape" });
    expect(stops[0]).not.toHaveBeenCalled();
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });

  it("hands Escape to the pane that takes focus", () => {
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    const { rerender } = render(<TwoPanes streaming={[false, true]} stops={stops} />); // pane 1 starts first
    rerender(<TwoPanes streaming={[true, true]} stops={stops} />);
    act(() => { useAppStore.setState({ focusedPaneIdx: 0 }); });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
  });

  it("never stops a background pane from an idle focused pane", () => {
    const stops: [() => void, () => void] = [vi.fn(), vi.fn()];
    const { getByLabelText } = render(<TwoPanes streaming={[true, false]} stops={stops} />);
    fireEvent.keyDown(getByLabelText("composer 1"), { key: "Escape" });
    expect(stops[0]).not.toHaveBeenCalled();
    expect(stops[1]).not.toHaveBeenCalled();
  });

  it("still stops the single chat view, which is not a pane", () => {
    const onStop = vi.fn();
    render(<Chat streaming onStop={onStop} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
