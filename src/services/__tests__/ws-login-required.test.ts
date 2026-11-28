import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/posthog", () => ({ capture: vi.fn() }));

import { wsManager } from "@/services/ws-manager";
import { useChatStore } from "@/stores/chat-store";
import type { CliLoginBlock } from "@/types/chat";

type Internals = {
  ensureConnected: (sid: string) => Promise<unknown>;
  _sendOrQueue: (payload: Record<string, unknown>) => void;
  handleEvent: (sid: string, evt: { data: string }) => void;
};
const m = wsManager as unknown as Internals;

const event = (sid: string, data: Record<string, unknown>) =>
  m.handleEvent(sid, { data: JSON.stringify({ session_id: sid, ...data }) });

const cards = (sid: string) =>
  (useChatStore.getState().sessions[sid]?.messages ?? [])
    .flatMap((x) => x.content)
    .filter((c): c is CliLoginBlock => c.type === "cli_login");

let sent: Record<string, unknown>[] = [];

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
  sent = [];
  vi.spyOn(m, "ensureConnected").mockResolvedValue(undefined);
  vi.spyOn(m, "_sendOrQueue").mockImplementation((p) => {
    sent.push(p);
  });
});

describe("login_required", () => {
  it("shows a sign-in card for whichever CLI agent asked", () => {
    event("s-a", {
      type: "login_required",
      provider: "claude-code",
      detail: "Not logged in · Please run /login",
      login_kind: "browser",
      account_id: "acc-9",
    });
    expect(cards("s-a")).toEqual([
      expect.objectContaining({
        provider: "claude-code",
        login_kind: "browser",
        account_id: "acc-9",
        detail: "Not logged in · Please run /login",
      }),
    ]);
    expect(useChatStore.getState().sessions["s-a"]!.isStreaming).toBeFalsy();
  });

  it("re-sends the stopped prompt once, marked so the backend doesn't save it twice", async () => {
    await wsManager.send("s-b", "fix the bug");
    event("s-b", { type: "login_required", provider: "codex-cli" });
    event("s-b", { type: "status", status: "done" });

    expect(await wsManager.resumeAfterLogin("s-b")).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "send", session_id: "s-b", message: "[fleet:resume]\nfix the bug" });
    // Nothing left to resume: a second card success doesn't resend.
    expect(await wsManager.resumeAfterLogin("s-b")).toBe(false);
  });

  it("gives up with an error when the resumed turn asks to sign in again", async () => {
    await wsManager.send("s-c", "hello");
    event("s-c", { type: "login_required", provider: "grok-build" });
    event("s-c", { type: "status", status: "done" });
    await wsManager.resumeAfterLogin("s-c");
    event("s-c", { type: "login_required", provider: "grok-build" });
    expect(cards("s-c")).toHaveLength(1);
    const texts = useChatStore
      .getState()
      .sessions["s-c"]!.messages.flatMap((x) => x.content)
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text);
    expect(texts.some((t) => t.includes("Signing in didn't fix it"))).toBe(true);
  });

  it("remembers a Fleet message sent through sendInternal for the resume", async () => {
    await wsManager.sendInternal("s-d", "dispatch this");
    event("s-d", { type: "login_required", provider: "claude-code" });
    event("s-d", { type: "status", status: "done" });
    expect(await wsManager.resumeAfterLogin("s-d")).toBe(true);
    expect(sent.at(-1)).toMatchObject({ message: "[fleet:resume]\ndispatch this" });
  });
});
