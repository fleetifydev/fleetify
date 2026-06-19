import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { HelpDialog } from "../help-dialog";

describe("HelpDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<HelpDialog open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the three section headers + known command/shortcut when open", () => {
    render(<HelpDialog open onClose={vi.fn()} />);
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Fleet commands")).toBeInTheDocument();
    expect(screen.getByText("Session commands")).toBeInTheDocument();
    // A known shortcut label and a known command surface.
    expect(screen.getByText("Abort all running agents")).toBeInTheDocument();
    expect(screen.getAllByText("/prompts").length).toBeGreaterThan(0);
  });

  it("closes on Escape and on overlay click", () => {
    const onClose = vi.fn();
    const { container } = render(<HelpDialog open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Overlay is the outermost element; clicking it (not the card) closes.
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
