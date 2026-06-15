import { describe, it, expect } from "vitest";
import { commandsForContext } from "../slash-commands";

const promptsHits = (ctx: "fleet" | "session-chat", tool: string | null) =>
  commandsForContext(ctx, tool).filter((c) => c.cmd === "/prompts");

describe("/prompts in commandsForContext", () => {
  it("appears exactly once for codex (no dup with the legacy alias)", () => {
    const hits = promptsHits("session-chat", "codex-cli");
    expect(hits).toHaveLength(1);
    expect(hits[0].intent).toBe("session.prompts");
  });
  it("is present for claude and gemini sessions", () => {
    expect(promptsHits("session-chat", "claude")).toHaveLength(1);
    expect(promptsHits("session-chat", "gemini-cli")).toHaveLength(1);
  });
  it("is present in the fleet command center", () => {
    const hits = promptsHits("fleet", null);
    expect(hits).toHaveLength(1);
    expect(hits[0].intent).toBe("fleet.prompts");
  });
  it("leaves /commands for claude untouched", () => {
    const all = commandsForContext("session-chat", "claude-code").map((c) => c.cmd);
    expect(all).toContain("/commands");
  });
});

describe("commandsForContext — mode commands", () => {
  it("offers /plan and /yolo with mechanism 'mode' for a known tool", () => {
    const cmds = commandsForContext("session-chat", "claude-code");
    const plan = cmds.find((c) => c.cmd === "/plan");
    const yolo = cmds.find((c) => c.cmd === "/yolo");
    expect(plan?.mechanism).toBe("mode");
    expect(plan?.semantic).toBe("plan");
    expect(yolo?.mechanism).toBe("mode");
    expect(yolo?.semantic).toBe("yolo");
  });

  it("offers /plan and /yolo even for an unknown/new tool", () => {
    const cmds = commandsForContext("session-chat", "cursor-cli");
    expect(cmds.some((c) => c.cmd === "/plan")).toBe(true);
    expect(cmds.some((c) => c.cmd === "/yolo")).toBe(true);
  });

  it("does not offer session commands in the fleet context", () => {
    const cmds = commandsForContext("fleet");
    expect(cmds.some((c) => c.cmd === "/plan")).toBe(false);
    expect(cmds.some((c) => c.cmd === "/yolo")).toBe(false);
    expect(cmds.some((c) => c.cmd === "/init")).toBe(false);
    expect(cmds.some((c) => c.cmd === "/review")).toBe(false);
  });

  it("no longer exposes the old codex /approvals entry", () => {
    const cmds = commandsForContext("session-chat", "codex-cli");
    expect(cmds.some((c) => c.cmd === "/approvals")).toBe(false);
  });

  it("surfaces universal LOCAL commands for any provider, not supportedTools-restricted ones", () => {
    const cmds = commandsForContext("session-chat", "cursor-cli").map((c) => c.cmd);
    expect(cmds).toContain("/skills");
    expect(cmds).toContain("/usage");
    expect(cmds).toContain("/init");
    expect(cmds).toContain("/prompts");
    expect(cmds).not.toContain("/effort"); // supportedTools: claude-code + codex-cli only
  });
});
