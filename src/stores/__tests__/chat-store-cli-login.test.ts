import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, pushCliLogin, updateCliLogin } from "../chat-store";
import type { CliLoginBlock } from "@/types/chat";

const blocks = (sid: string) =>
  (useChatStore.getState().sessions[sid]?.messages ?? [])
    .flatMap((m) => m.content)
    .filter((c): c is CliLoginBlock => c.type === "cli_login");

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
});

describe("pushCliLogin", () => {
  it("adds a sign-in card carrying what the backend sent", () => {
    pushCliLogin("s1", {
      provider: "claude-code",
      detail: "Not logged in · Please run /login",
      accountId: "acc-1",
      loginKind: "browser",
    });
    expect(blocks("s1")).toEqual([
      {
        type: "cli_login",
        provider: "claude-code",
        session_id: "s1",
        account_id: "acc-1",
        detail: "Not logged in · Please run /login",
        login_kind: "browser",
      },
    ]);
  });

  it("doesn't stack a second card while one for the same agent is waiting", () => {
    pushCliLogin("s1", { provider: "grok-build" });
    pushCliLogin("s1", { provider: "grok-build" });
    expect(blocks("s1")).toHaveLength(1);
    // A different agent in the same session gets its own card.
    pushCliLogin("s1", { provider: "codex-cli" });
    expect(blocks("s1")).toHaveLength(2);
  });

  it("adds a new card once the earlier sign-in finished (the login lapsed again)", () => {
    pushCliLogin("s1", { provider: "grok-build" });
    updateCliLogin("s1", "grok-build", { signed_in: true });
    pushCliLogin("s1", { provider: "grok-build" });
    expect(blocks("s1")).toHaveLength(2);
    expect(blocks("s1")[1]!.signed_in).toBeUndefined();
  });
});

describe("updateCliLogin", () => {
  it("records progress on the newest card for that agent", () => {
    pushCliLogin("s1", { provider: "grok-build" });
    updateCliLogin("s1", "grok-build", { signed_in: true });
    pushCliLogin("s1", { provider: "grok-build" });
    updateCliLogin("s1", "grok-build", { pty_id: "p2" });
    const [first, second] = blocks("s1");
    expect(first!.pty_id).toBeUndefined();
    expect(second!.pty_id).toBe("p2");
  });
});
