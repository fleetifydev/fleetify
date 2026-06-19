import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Heavy/irrelevant composer deps stubbed so we can mount ChatInput in jsdom.
vi.mock("@/lib/posthog", () => ({ capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }));

import { ChatInput } from "../chat-input";

/**
 * Minimal props to render the composer in Fleet (control-center) mode.
 * `onSend` is the only required prop on ChatInput; the rest are optional but
 * pinned here so the composer mounts deterministically (no session ⇒ no plugin
 * fetch, no provider tiles needed — they're derived from the store). Extend if
 * ChatInput's required props change.
 */
function renderComposer(onSend = vi.fn()) {
  render(
    <ChatInput
      onSend={onSend}
      controlCenter
      sessionId={null}
      tool={null}
      model={null}
    />,
  );
  return { onSend };
}

describe("/help command", () => {
  it("typing /help and submitting opens the help dialog and does NOT send to the agent", () => {
    const { onSend } = renderComposer();
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/help" } });
    // `/help` is a registered fleet command, so typing it opens the slash
    // autocomplete dropdown — exactly the real user flow. The first Enter
    // *selects* the command from the dropdown (inserting "/help "); the second
    // Enter actually submits, hitting ChatInput's `submit` interception.
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.keyDown(ta, { key: "Enter" });
    // Dialog opened (its header is unique to HelpDialog).
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    // Never forwarded to the agent.
    expect(onSend).not.toHaveBeenCalled();
  });
});
