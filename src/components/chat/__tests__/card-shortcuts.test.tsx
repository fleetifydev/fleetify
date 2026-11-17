import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Platform } from "@/lib/utils";

// Permission cards answer Mod+Enter (allow) and Mod+Shift+Enter (always
// allow), where Mod is the key their labels show: ⌘ on macOS, Ctrl on
// Windows and Linux (`formatShortcut`, from `getPlatform`). They leave the
// key alone when another handler already acted on it, or when it was typed
// in any field: while a card waits the composer is locked and the card has
// no fields, so a field with focus is another box whose own Mod+Enter sends,
// such as the Fleet dispatch reply box.

const platform = vi.hoisted(() => ({ current: "linux" as Platform }));
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  getPlatform: () => platform.current,
}));
// The composer needs these stubbed to mount in happy-dom; the dispatch
// reply box sends through dispatchFollowUp.
vi.mock("@/lib/posthog", () => ({ capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }));
const api = vi.hoisted(() => ({ dispatchFollowUp: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  enhancePrompt: vi.fn(async () => ({ no_op: true, enhanced: "", rationale: null })),
  apiFetch: vi.fn(async () => new Response("[]", { status: 200 })),
  dispatchFollowUp: api.dispatchFollowUp,
}));

import { ChatInput } from "../chat-input";
import { PermissionDialog } from "../permission-dialog";
import { MessageContent } from "../message-content";
import { useAppStore } from "@/stores/app-store";
import type { PermissionRequest } from "@/stores/chat-store";
import type { ChatMessage } from "@/types/chat";

const bash: PermissionRequest = { id: "req-1", tool_name: "Bash", command: "ls" };

type Card = "the composer's inline card" | "the permission dialog";
const CARDS: Card[] = ["the composer's inline card", "the permission dialog"];

const DISPATCH_RESULT: ChatMessage = {
  id: "m-1",
  role: "system",
  timestamp: "2026-11-17T00:00:00Z",
  content: [{
    type: "dispatch_result",
    agent_id: "agent-x",
    agent_name: "Worker",
    task: "Run the tests",
    success: true,
    summary: "All green.",
  }],
};

/** A pending card inside its chat, as ChatView renders it: the chat also
 *  holds a dispatch result with its reply box, a field of its own (the
 *  title rename) and a button whose own handler acts on Mod+Enter. */
function renderCard(card: Card) {
  const answer = { deny: vi.fn(), allow: vi.fn(), allowAlways: vi.fn() };
  render(
    <div data-chat-surface="">
      <input aria-label="chat title" />
      <button
        type="button"
        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
      >
        acts on Enter
      </button>
      <MessageContent message={DISPATCH_RESULT} />
      {card === "the composer's inline card" ? (
        <ChatInput
          onSend={vi.fn()} sessionId="agent-a" locked permissionRequest={bash}
          onPermissionDeny={answer.deny} onPermissionAllow={answer.allow}
          onPermissionAllowAlways={answer.allowAlways}
        />
      ) : (
        <PermissionDialog
          request={bash}
          onAllow={answer.allow} onAllowAlways={answer.allowAlways} onDeny={answer.deny}
        />
      )}
    </div>,
  );
  return answer;
}

function expectPending(answer: ReturnType<typeof renderCard>) {
  expect(answer.allow).not.toHaveBeenCalled();
  expect(answer.allowAlways).not.toHaveBeenCalled();
  expect(answer.deny).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    splitPaneIds: [], focusedPaneIdx: 0, activeSessionId: "agent-a", staffSessionId: "staff-1",
  });
});

describe.each(CARDS)("%s", (card) => {
  describe.each(["windows", "linux"] as const)("on %s", (os) => {
    beforeEach(() => { platform.current = os; });

    it("Ctrl+Enter allows and Ctrl+Shift+Enter always allows", () => {
      const answer = renderCard(card);
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
      expect(answer.allow).toHaveBeenCalledTimes(1);
      expect(answer.allow).toHaveBeenCalledWith("req-1", "Bash");
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, shiftKey: true });
      expect(answer.allowAlways).toHaveBeenCalledTimes(1);
      expect(answer.allow).toHaveBeenCalledTimes(1);
    });

    it("the Windows/Super key with Enter answers nothing", () => {
      const answer = renderCard(card);
      fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
      fireEvent.keyDown(document.body, { key: "Enter", metaKey: true, shiftKey: true });
      expectPending(answer);
    });
  });

  describe("on macOS", () => {
    beforeEach(() => { platform.current = "mac"; });

    it("⌘↵ allows and ⌘⇧↵ always allows", () => {
      const answer = renderCard(card);
      fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
      expect(answer.allow).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document.body, { key: "Enter", metaKey: true, shiftKey: true });
      expect(answer.allowAlways).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+Enter and Ctrl+Shift+Enter do nothing", () => {
      const answer = renderCard(card);
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, shiftKey: true });
      expectPending(answer);
    });
  });

  describe.each([
    ["mac", { metaKey: true }],
    ["linux", { ctrlKey: true }],
  ] as const)("on %s, the card's own shortcut", (os, mod) => {
    beforeEach(() => { platform.current = os; });

    it("typed in the Fleet dispatch reply box sends the reply and leaves the card pending", async () => {
      const answer = renderCard(card);
      fireEvent.click(screen.getByTitle("Reply to this agent without leaving Fleetify"));
      const reply = screen.getByPlaceholderText("Follow-up to Worker…");
      // Nothing typed yet: the box keeps the key and sends nothing.
      fireEvent.keyDown(reply, { key: "Enter", ...mod });
      fireEvent.keyDown(reply, { key: "Enter", shiftKey: true, ...mod });
      expectPending(answer);

      fireEvent.change(reply, { target: { value: "rerun with --verbose" } });
      fireEvent.keyDown(reply, { key: "Enter", ...mod });
      await waitFor(() =>
        expect(api.dispatchFollowUp).toHaveBeenCalledWith("agent-x", "rerun with --verbose", "staff-1"),
      );
      expectPending(answer);
    });

    it("typed in a field inside the chat leaves the card pending, while Escape there still denies", () => {
      const answer = renderCard(card);
      const title = screen.getByLabelText("chat title");
      fireEvent.keyDown(title, { key: "Enter", ...mod });
      fireEvent.keyDown(title, { key: "Enter", shiftKey: true, ...mod });
      expectPending(answer);
      // Escape keeps its own rules: a field inside the chat doesn't own it.
      fireEvent.keyDown(title, { key: "Escape" });
      expect(answer.deny).toHaveBeenCalledTimes(1);
    });

    it("that another handler already acted on leaves the card pending", () => {
      const answer = renderCard(card);
      const button = screen.getByRole("button", { name: "acts on Enter" });
      fireEvent.keyDown(button, { key: "Enter", ...mod });
      fireEvent.keyDown(button, { key: "Enter", shiftKey: true, ...mod });
      expectPending(answer);
      // Control: pressed on the page, it answers.
      fireEvent.keyDown(document.body, { key: "Enter", ...mod });
      expect(answer.allow).toHaveBeenCalledTimes(1);
    });
  });
});
