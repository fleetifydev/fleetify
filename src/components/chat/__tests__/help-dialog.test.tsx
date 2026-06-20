import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { HelpDialog } from "../help-dialog";

describe("HelpDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<HelpDialog open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows three tabs and opens on the Keyboard Shortcuts tab", () => {
    render(<HelpDialog open onClose={vi.fn()} />);
    // All three tabs are present in the tablist.
    expect(screen.getByRole("tab", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Fleet Commands" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Session Commands" })).toBeInTheDocument();
    // Default tab = Keyboard Shortcuts → a known shortcut shows; commands don't.
    expect(screen.getByText("Abort all running agents")).toBeInTheDocument();
    expect(screen.queryByText("/new")).not.toBeInTheDocument();
    expect(screen.queryByText("/plan")).not.toBeInTheDocument();
  });

  it("switches content when a tab is clicked", () => {
    render(<HelpDialog open onClose={vi.fn()} />);

    // Fleet tab → a fleet-only command appears, the shortcut is gone.
    fireEvent.click(screen.getByRole("tab", { name: "Fleet Commands" }));
    expect(screen.getByText("/new")).toBeInTheDocument();
    expect(screen.queryByText("Abort all running agents")).not.toBeInTheDocument();

    // Session tab → a session-only command appears, the fleet one is gone.
    fireEvent.click(screen.getByRole("tab", { name: "Session Commands" }));
    expect(screen.getByText("/plan")).toBeInTheDocument();
    expect(screen.queryByText("/new")).not.toBeInTheDocument();
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
