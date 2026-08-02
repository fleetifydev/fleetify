import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../chat-store";
import { COMPOSER_CHAT_KEY } from "../composer-chat-key";

const msg = (id: string) => ({
  id,
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "hi" }],
  timestamp: new Date(0).toISOString(),
});

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
});

describe("evictInactive", () => {
  it("drops the transcript of a session that isn't kept", () => {
    useChatStore.getState().addMessage("sess-1", msg("m-1"));
    useChatStore.getState().evictInactive([]);
    expect(useChatStore.getState().sessions["sess-1"].messages).toHaveLength(0);
  });

  it("keeps the transcript of a session in the keep list", () => {
    useChatStore.getState().addMessage("sess-1", msg("m-1"));
    useChatStore.getState().evictInactive(["sess-1"]);
    expect(useChatStore.getState().sessions["sess-1"].messages).toHaveLength(1);
  });

  it("NEVER evicts the compose surface, which the caller can't put in keepIds", () => {
    // Compose mode has no session id, so the app-shell sweep's keep list
    // ([activeSessionId, ...panes]) can never name it. Its messages are
    // renderer-only — unlike a real session there is nothing to re-fetch, so
    // a sweep used to silently empty the compose surface mid-use.
    useChatStore.getState().addMessage(COMPOSER_CHAT_KEY, msg("welcome-__composer__"));
    useChatStore.getState().addMessage(COMPOSER_CHAT_KEY, msg("warn-folder-1"));
    useChatStore.getState().evictInactive([]);
    expect(useChatStore.getState().sessions[COMPOSER_CHAT_KEY].messages).toHaveLength(2);
  });
});
