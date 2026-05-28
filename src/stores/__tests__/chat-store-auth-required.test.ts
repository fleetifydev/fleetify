import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, pushChatAuthRequired } from "../chat-store";

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
});

describe("pushChatAuthRequired", () => {
  it("appends a system message containing an auth_required ContentBlock", () => {
    pushChatAuthRequired("sess-1", {
      provider: "antigravity",
      url: "https://accounts.google.com/o/oauth2/auth?x=1",
      openedInBrowser: true,
    });
    const session = useChatStore.getState().sessions["sess-1"];
    expect(session).toBeDefined();
    const messages = session.messages;
    expect(messages).toHaveLength(1);
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("system");
    expect(lastMsg.content[0]).toMatchObject({
      type: "auth_required",
      provider: "antigravity",
      url: "https://accounts.google.com/o/oauth2/auth?x=1",
      opened_in_browser: true,
    });
  });

  it("preserves the opened_in_browser=false case", () => {
    pushChatAuthRequired("sess-2", {
      provider: "antigravity",
      url: "https://example/",
      openedInBrowser: false,
    });
    const session = useChatStore.getState().sessions["sess-2"];
    const messages = session.messages;
    const block = messages[messages.length - 1].content[0] as { opened_in_browser: boolean };
    expect(block.opened_in_browser).toBe(false);
  });
});
