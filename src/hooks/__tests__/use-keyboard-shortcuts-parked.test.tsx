import { describe, it, expect, beforeEach } from "vitest";
import { useRef } from "react";
import { render, fireEvent } from "@testing-library/react";
import { useKeyboardShortcuts } from "../use-keyboard-shortcuts";
import { useAppStore } from "@/stores/app-store";

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

describe("useKeyboardShortcuts while the shell is parked", () => {
  beforeEach(() => {
    useAppStore.setState({ activeSessionId: "agent-1", staffSessionId: "staff" });
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
});
