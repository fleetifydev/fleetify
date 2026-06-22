import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Heavy/irrelevant composer deps stubbed so we can mount ChatInput in jsdom.
vi.mock("@/lib/posthog", () => ({ capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }));

// Stub the two @/lib/api entry points this path touches: enhancePrompt (the
// Fleet refiner — must NOT run for slash commands) and apiFetch (so mounting a
// session doesn't hit the network). Everything else stays real.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    enhancePrompt: vi.fn(async () => ({ no_op: true, enhanced: "", rationale: null })),
    apiFetch: vi.fn(async () => new Response("[]", { status: 200 })),
  };
});

import { ChatInput } from "../chat-input";
import * as api from "@/lib/api";
import { useFleetStore } from "@/stores/fleet-store";

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
    // Dialog opened — its "Keyboard Shortcuts" tab is unique to HelpDialog.
    expect(screen.getByRole("tab", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    // Never forwarded to the agent.
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("claude-code slash command dispatch", () => {
  function renderSession(onSend = vi.fn()) {
    // A non-manual fleet mode + a real sessionId ⇒ fleetActive is true, so the
    // submit() path would otherwise run the refiner. (controlCenter omitted.)
    useFleetStore.getState().setMode("s1", "copilot");
    render(<ChatInput onSend={onSend} sessionId="s1" tool="claude-code" model={null} />);
    return { onSend };
  }

  it("sends a slash command verbatim and never calls enhancePrompt", () => {
    vi.mocked(api.enhancePrompt).mockClear();
    const { onSend } = renderSession();
    const ta = screen.getByRole("textbox");
    // >8 chars + whitespace ⇒ NOT 'trivial' ⇒ without the guard this would be
    // sent to enhancePrompt and rewritten.
    fireEvent.change(ta, { target: { value: "/code-review high --fix" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(api.enhancePrompt).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("/code-review high --fix", undefined);
  });

  it("/diff fetches the diff endpoint and renders a card (not sent to the CLI)", async () => {
    const { onSend } = renderSession();
    const ta = screen.getByRole("textbox");
    // Single-word command ⇒ the slash menu opens; first Enter selects it,
    // second Enter submits (same flow as the /help test).
    fireEvent.change(ta, { target: { value: "/diff" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/sessions/s1/diff"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("/review is a passthrough — reaches onSend verbatim, never intercepted", () => {
    const { onSend } = renderSession();
    const ta = screen.getByRole("textbox");
    // Has an argument ⇒ no autocomplete match ⇒ a single Enter submits.
    fireEvent.change(ta, { target: { value: "/review 42" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/review 42", undefined);
  });
});
