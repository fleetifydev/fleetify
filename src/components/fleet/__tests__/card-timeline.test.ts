import { describe, expect, it } from "vitest";
import { turnsOf } from "../card-timeline";
import type { ContentBlock } from "@/types/chat";

const T = (n: number) => `2026-11-27T20:0${n}:00Z`;
const msg = (id: string, role: string, content: ContentBlock[], n = 1) => ({ id, role, content, timestamp: T(n) });
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const use = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: "tool_use", tool_id: id, tool_name: name, input });
const result = (id: string, output: string, err = false): ContentBlock => ({ type: "tool_result", tool_id: id, output, is_error: err });

describe("card timeline", () => {
  it("splits the work into turns, each with its steps and replies", () => {
    const turns = turnsOf([
      msg("u1", "user", [text("Add an RSS feed")], 1),
      msg("a1", "assistant", [text("Looking at posts first."), use("r1", "Read", { file_path: "posts.ts" })], 2),
      msg("u2", "user", [result("r1", "export function getPosts")], 2),
      msg("a2", "assistant", [use("b1", "Bash", { command: "pnpm build" })], 3),
      msg("u3", "user", [result("b1", "3 failing", true)], 3),
      msg("a3", "assistant", [text("The build fails on three tests.")], 4),
      msg("u4", "user", [text("Fix them")], 5),
    ]);
    expect(turns.map(t => t.ask)).toEqual(["Add an RSS feed", "Fix them"]);
    expect(turns[0]!.steps.map(s => [s.id, s.status])).toEqual([["r1", "completed"], ["b1", "errored"]]);
    expect(turns[0]!.steps[1]!.output).toBe("3 failing");
    expect(turns[0]!.replies).toEqual(["a1", "a3"]);
    // in the order it happened: the first reply came before the read
    expect(turns[0]!.items).toEqual([{ kind: "reply", id: "a1" }, { kind: "step", id: "r1" }, { kind: "step", id: "b1" }, { kind: "reply", id: "a3" }]);
    expect(turns[1]!.steps).toEqual([]);
  });

  it("starts a turn without an ask when the work began before one", () => {
    const turns = turnsOf([msg("a1", "assistant", [use("r1", "Read")], 1)]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.ask).toBeNull();
    expect(turns[0]!.steps).toHaveLength(1);
  });

  it("lays the live log over the saved steps, and adds the ones not saved yet to the last turn", () => {
    const turns = turnsOf(
      [msg("u1", "user", [text("Go")], 1), msg("a1", "assistant", [use("r1", "Read")], 2)],
      [
        { id: "r1", tool_id: "r1", name: "Read", input: {}, status: "completed", output: "ok", startedAt: 10, endedAt: 12 },
        { id: "e2", tool_id: "e2", name: "Edit", input: {}, status: "running", startedAt: 20, endedAt: null },
      ],
    );
    expect(turns[0]!.steps.map(s => [s.id, s.status])).toEqual([["r1", "completed"], ["e2", "running"]]);
    expect(turns[0]!.steps[0]!.output).toBe("ok");
  });

  it("shows live steps of a session with no saved messages yet", () => {
    const turns = turnsOf([], [{ id: "e1", tool_id: "e1", name: "Bash", input: {}, status: "running", startedAt: 5, endedAt: null }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.steps[0]!.status).toBe("running");
  });
});
