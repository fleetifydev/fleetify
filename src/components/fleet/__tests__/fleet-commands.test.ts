import { describe, expect, it } from "vitest";
import { activityOf, matchCommands, matchSessions, score, type Command, type Findable } from "../fleet-commands";

const cmd = (id: string, label: string, keywords?: string): Command => ({ id, group: "go", label, keywords });

describe("palette matching", () => {
  it("ranks a prefix over a word start over a substring over letters in order", () => {
    expect(score("next", "Next waiting")).toBeGreaterThan(score("wait", "Next waiting"));
    expect(score("wait", "Next waiting")).toBeGreaterThan(score("ait", "Next waiting"));
    expect(score("ait", "Next waiting")).toBeGreaterThan(score("nw", "Next waiting"));
    expect(score("nw", "Next waiting")).toBeGreaterThan(0);
    expect(score("zz", "Next waiting")).toBe(0);
  });

  it("finds a command by its keywords and keeps the given order on a tie", () => {
    const list = [cmd("a", "Close every card", "collapse fold"), cmd("b", "Fit everything", "zoom out overview"), cmd("c", "Full size", "actual zoom 100")];
    expect(matchCommands("collapse", list).map(c => c.id)).toEqual(["a"]);
    expect(matchCommands("zoom", list).map(c => c.id)).toEqual(["b", "c"]);
    expect(matchCommands("", list).map(c => c.id)).toEqual(["a", "b", "c"]);
  });

  it("lists the sessions that need the user first, and matches by project and branch", () => {
    const ss: Findable[] = [
      { id: "1", title: "Typed errors", project: "pay-sdk", branch: "typed-errors", state: "working" },
      { id: "2", title: "Refund webhook", project: "client-api", branch: "refund-webhook", state: "needs" },
      { id: "3", title: "RSS feed", project: "blog", state: "done" },
    ];
    expect(matchSessions("", ss).map(s => s.id)).toEqual(["2", "1", "3"]);
    expect(matchSessions("blog", ss).map(s => s.id)).toEqual(["3"]);
    expect(matchSessions("refund-web", ss).map(s => s.id)).toEqual(["2"]);
  });
});

describe("activity feed", () => {
  it("lists what happened newest first, with questions, failures and finished runs", () => {
    const feed = activityOf([
      { id: "a", createdAt: 100, state: "needs", needSince: 500, steps: [{ id: "e1", startedAt: 200, endedAt: 210, status: "completed", text: "Reading x" }] },
      { id: "b", createdAt: 150, state: "failed", steps: [{ id: "e2", startedAt: 300, endedAt: 320, status: "errored", text: "Running tests" }] },
      { id: "c", createdAt: 50, state: "done", lastAt: 400, steps: [] },
    ]);
    expect(feed.map(e => `${e.sessionId}:${e.kind}`)).toEqual(["a:needs", "c:done", "b:failed", "a:step", "b:started", "a:started", "c:started"]);
  });

  it("keeps only a few steps of each agent, so a busy one does not crowd out the rest", () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, startedAt: 1000 + i, endedAt: 1000 + i, status: "completed" as const, text: `step ${i}` }));
    const feed = activityOf([{ id: "busy", createdAt: 0, state: "working", steps }, { id: "calm", createdAt: 1, state: "working", steps: [] }], 60, 4);
    expect(feed.filter(e => e.kind === "step")).toHaveLength(4);
    expect(feed.some(e => e.sessionId === "calm")).toBe(true);
  });
});
