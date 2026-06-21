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

  it("lists EVERY provider's native commands (not just the active agent)", () => {
    // Session-agnostic: all provider groups + their commands show with no
    // active session at all. Provider headers carry their brand mark.
    render(<HelpDialog open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Session Commands" }));
    expect(screen.getByText("Works in every agent")).toBeInTheDocument();
    // Provider group headers (label + icon) for the advertised/wired agents.
    expect(screen.getByText("Grok Build")).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByAltText("Grok")).toBeInTheDocument();
    // A representative native command from a couple of providers.
    expect(screen.getByText("/security-review")).toBeInTheDocument(); // Copilot
    expect(screen.getByText("/dream")).toBeInTheDocument();           // Grok
  });

  it("merges the active session's LIVE commands into that provider's group", () => {
    // The active provider additionally gets its live-advertised set (skills +
    // version extras) on top of its static core, deduped.
    useChatStore.setState({
      dynamicCommands: { "s-grok": [{ name: "my-custom-skill", description: "A user skill" }] },
    });
    render(<HelpDialog open onClose={vi.fn()} tool="grok-build" sessionId="s-grok" />);
    fireEvent.click(screen.getByRole("tab", { name: "Session Commands" }));
    // Static core still there (/dream is grok-only)...
    expect(screen.getByText("/dream")).toBeInTheDocument();
    // ...plus the live skill merged into the Grok group.
    expect(screen.getByText("/my-custom-skill")).toBeInTheDocument();
    expect(screen.getByText("A user skill")).toBeInTheDocument();
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
