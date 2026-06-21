import { describe, it, expect } from "vitest";
import { triggersFor, triggerDisplay, defaultCommandFor, HOOK_TRIGGERS } from "@/lib/hook-triggers";

describe("hook-triggers", () => {
  it("intersection: one provider gets its full set", () => {
    const claude = triggersFor(["claude-code"]).map((t) => t.id);
    expect(claude).toContain("pre_tool_use");
    expect(claude).toContain("notification");
    expect(claude).not.toContain("before_model"); // claude has no before_model
  });

  it("intersection: multi-provider keeps only shared triggers", () => {
    const both = triggersFor(["claude-code", "antigravity-cli"]).map((t) => t.id);
    expect(both).toContain("pre_tool_use");
    expect(both).toContain("stop");
    expect(both).not.toContain("session_start"); // antigravity lacks it
  });

  it("empty selection ⇒ no triggers", () => {
    expect(triggersFor([])).toEqual([]);
  });

  it("triggerDisplay shows native name when unambiguous", () => {
    const pre = HOOK_TRIGGERS.find((t) => t.id === "pre_tool_use")!;
    expect(triggerDisplay(pre, ["claude-code"])).toBe("PreToolUse");
    expect(triggerDisplay(pre, ["claude-code", "cursor-cli"])).toContain("Before tool use");
  });

  it("defaultCommandFor maps extensions to interpreters", () => {
    expect(defaultCommandFor("x.py")).toBe("python3 ${file}");
    expect(defaultCommandFor("x.ts")).toBe("bun ${file}");
    expect(defaultCommandFor("x.bin")).toBe("${file}");
  });
});
