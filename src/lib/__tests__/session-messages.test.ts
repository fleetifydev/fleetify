import { describe, it, expect } from "vitest";
import { parseStoredMessage, parseStoredMessages } from "../session-messages";
import type { ContentBlock } from "@/types/chat";

/** A row exactly as GET /sessions/:id/messages returns it: the backend's
 *  `messages` table (crates/fleetify-backend/src/models/message.rs) keeps
 *  `content` as the JSON-encoded block array, stored as TEXT. */
const row = (content: string | ContentBlock[], role = "assistant", id = "m-1") => ({
  id,
  session_id: "s-1",
  role,
  content,
  model: "claude-sonnet",
  usage_json: null,
  cost_usd: 0.25,
  timestamp: "2026-11-17T06:00:00.000Z",
});
const json = (t: string) => JSON.stringify([{ type: "text", text: t }]);

describe("parseStoredMessage", () => {
  it("parses the JSON content into blocks and keeps every other field as is", () => {
    expect(parseStoredMessage(row(json("hello")))).toEqual({
      ...row(json("hello")),
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("keeps content that is not valid JSON as one text block, as chat-view always has", () => {
    expect(parseStoredMessage(row("plain text, not JSON")).content)
      .toEqual([{ type: "text", text: "plain text, not JSON" }]);
    expect(parseStoredMessage(row("")).content).toEqual([{ type: "text", text: "" }]);
  });

  it("passes content that is already parsed through untouched", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "already parsed" }];
    expect(parseStoredMessage(row(blocks)).content).toBe(blocks);
  });
});

describe("parseStoredMessages", () => {
  it("parses user, assistant and system rows alike and keeps each role", () => {
    const parsed = parseStoredMessages([
      row(json("do it"), "user", "u"),
      row(json("done"), "assistant", "a"),
      row(json("dispatched"), "system", "s"),
    ]);
    expect(parsed.map(m => [m.id, m.role])).toEqual([["u", "user"], ["a", "assistant"], ["s", "system"]]);
    expect(parsed.map(m => m.content)).toEqual([
      [{ type: "text", text: "do it" }],
      [{ type: "text", text: "done" }],
      [{ type: "text", text: "dispatched" }],
    ]);
  });
});
