import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { ComposerDropMenu } from "../composer-drop-menu";

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={ref} data-testid="anchor">trigger</button>
      <button data-testid="outside">outside</button>
      <ComposerDropMenu anchorRef={ref} open={open} onClose={onClose}>
        <div data-testid="menu-content">menu</div>
      </ComposerDropMenu>
    </div>
  );
}

describe("ComposerDropMenu", () => {
  it("renders children (portaled to body) only when open", () => {
    const { rerender } = render(<Harness open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("menu-content")).toBeNull();
    rerender(<Harness open onClose={() => {}} />);
    const content = screen.getByTestId("menu-content");
    expect(content).toBeTruthy();
    // portaled out of the harness tree, onto document.body
    expect(content.closest('[role="menu"]')?.parentElement).toBe(document.body);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside click, but NOT on the trigger or the menu itself", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId("menu-content")); // inside menu → stays
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("anchor")); // the trigger → stays (parent toggles)
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("outside")); // elsewhere → closes
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
