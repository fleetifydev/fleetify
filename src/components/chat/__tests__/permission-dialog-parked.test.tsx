import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PermissionDialog } from "../permission-dialog";
import type { PermissionRequest } from "@/stores/chat-store";

const request: PermissionRequest = {
  id: "req-1",
  tool_name: "AskUserQuestion",
  command: "Which database should I use?",
};

/** Mirrors App.tsx: while Settings or Library is open, the shell is parked
 *  under `display: none` but stays MOUNTED, and so does this dialog's
 *  window-level key listener. */
function Shell({ parked, onAllow = vi.fn(), onDeny = vi.fn() }: {
  parked: boolean;
  onAllow?: (id: string, toolName: string) => void;
  onDeny?: (id: string, toolName: string) => void;
}) {
  return (
    <div style={{ display: parked ? "none" : "contents" }}>
      <PermissionDialog
        request={request}
        onAllow={onAllow}
        onAllowAlways={vi.fn()}
        onDeny={onDeny}
      />
    </div>
  );
}

describe("PermissionDialog while the shell is parked", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not deny the request on the Escape that closes Settings / Library", () => {
    const onDeny = vi.fn();
    render(<Shell parked onDeny={onDeny} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("denies the request once on Escape while it is visible", () => {
    const onDeny = vi.fn();
    render(<Shell parked={false} onDeny={onDeny} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith("req-1", "AskUserQuestion");
  });

  it("does not answer the request on Meta+Enter while parked", () => {
    const onAllow = vi.fn();
    render(<Shell parked onAllow={onAllow} />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onAllow).not.toHaveBeenCalled();
  });

  it("does not compute styles for keys it does not handle", () => {
    render(<Shell parked={false} />);
    const spy = vi.spyOn(window, "getComputedStyle");
    fireEvent.keyDown(window, { key: "a" });
    expect(spy).not.toHaveBeenCalled();
    // Control: the visibility walk does run for a key the card acts on.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(spy).toHaveBeenCalled();
  });
});
