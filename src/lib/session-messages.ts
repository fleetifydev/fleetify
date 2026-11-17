import type { ChatMessage, ContentBlock } from "@/types/chat";

/** A message row as GET /sessions/:id/messages returns it. The backend keeps
 *  `content` as JSON-encoded text (crates/fleetify-backend/src/models/message.rs),
 *  so it arrives as a string, not as content blocks. */
export type StoredMessageRow = { content: string | ContentBlock[]; [k: string]: unknown };

/** Turn one row from GET /sessions/:id/messages into a chat-store message.
 *  `content` is JSON-parsed. Content that is not valid JSON is kept as a single
 *  text block, content that is already parsed passes through, and every other
 *  field is copied as is.
 *
 *  Anything that stores rows from that endpoint must parse them first:
 *  MessageContent throws on a string `content`, and with no error boundary
 *  that blanks the whole app. Moved verbatim from chat-view, which has always
 *  parsed its rows this way. */
export function parseStoredMessage(m: StoredMessageRow): ChatMessage {
  let content: ContentBlock[];
  try {
    content = typeof m.content === "string" ? JSON.parse(m.content as string) : (m.content as ContentBlock[]);
  } catch {
    content = [{ type: "text" as const, text: typeof m.content === "string" ? m.content : "" }];
  }
  return { ...m, content } as ChatMessage;
}

/** {@link parseStoredMessage} over a whole response. */
export function parseStoredMessages(rows: StoredMessageRow[]): ChatMessage[] {
  return rows.map(parseStoredMessage);
}
