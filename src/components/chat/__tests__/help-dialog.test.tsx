import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { HelpDialog } from "../help-dialog";
import { useChatStore } from "@/stores/chat-store";

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

  it("Session tab shows only the universal group when the agent advertises no commands", () => {
    // Claude drives non-interactively and advertises no ACP commands, so the
    // Session tab carries just the universal group — no provider sub-group/icon.
    render(<HelpDialog open onClose={vi.fn()} tool="claude-code" sessionId="s-none" />);
    fireEvent.click(screen.getByRole("tab", { name: "Session Commands" }));
    expect(screen.getByText("Works in every agent")).toBeInTheDocument();
    expect(screen.getByText("/plan")).toBeInTheDocument();
    expect(screen.queryByAltText("Claude Code")).not.toBeInTheDocument();
  });

  it("shows the active agent's LIVE ACP-advertised commands with its brand mark", () => {
    // Agents that push `available_commands_update` (Grok/OpenCode/Hermes/Cursor/
    // Copilot) get a live, brand-marked group of their real command set.
    useChatStore.setState({
      dynamicCommands: { "s-grok": [{ name: "rewind", description: "Rewind the session" }] },
    });
    render(<HelpDialog open onClose={vi.fn()} tool="grok-build" sessionId="s-grok" />);
    fireEvent.click(screen.getByRole("tab", { name: "Session Commands" }));
    expect(screen.getByText("/rewind")).toBeInTheDocument();
    expect(screen.getByText("Rewind the session")).toBeInTheDocument();
    expect(screen.getByAltText("Grok")).toBeInTheDocument();
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
