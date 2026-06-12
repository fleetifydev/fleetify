import { describe, it, expect } from "vitest";
import { commandsForContext } from "../slash-commands";

const promptsHits = (ctx: "fleet" | "session-chat", tool: string | null) =>
  commandsForContext(ctx, tool).filter((c) => c.cmd === "/prompts");

describe("/prompts in commandsForContext", () => {
  it("appears exactly once for codex (no dup with the legacy alias)", () => {
    const hits = promptsHits("session-chat", "codex");
    expect(hits).toHaveLength(1);
    expect(hits[0].intent).toBe("session.prompts");
  });
  it("is present for claude and gemini sessions", () => {
    expect(promptsHits("session-chat", "claude")).toHaveLength(1);
    expect(promptsHits("session-chat", "gemini")).toHaveLength(1);
  });
  it("is present in the fleet command center", () => {
    const hits = promptsHits("fleet", null);
    expect(hits).toHaveLength(1);
    expect(hits[0].intent).toBe("fleet.prompts");
  });
  it("leaves /commands for claude untouched", () => {
    const all = commandsForContext("session-chat", "claude").map((c) => c.cmd);
    expect(all).toContain("/commands");
  });
});
