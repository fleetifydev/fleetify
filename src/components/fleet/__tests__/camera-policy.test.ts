import { describe, expect, it } from "vitest";
import { CAM, decide, initialPolicy, type Ctx, type PolicyState } from "../camera-policy";
import { planFlight, stepFlight, zoomPath } from "../camera-flight";

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  now: 100_000, mayMove: true, reading: false, idleFor: 0, waiting: [], inView: () => false,
  liveOutOfView: false, overviewStale: false, layoutStill: 10_000, ...over,
});
const changes = (over: Partial<{ needs: string[]; failed: string[]; fresh: string[]; resolved: string[] }> = {}) =>
  ({ type: "changes" as const, needs: [], failed: [], fresh: [], resolved: [], ...over });

describe("camera policy", () => {
  it("flies to a new question when the user is not busy", () => {
    const [s, cmd] = decide(initialPolicy(), changes({ needs: ["a"] }), ctx({ waiting: ["a"] }));
    expect(cmd).toEqual({ kind: "fly", frame: { id: "a" } });
    expect(s.base).toBe("attend");
  });

  it("waits while the user reads, then flies once they stop", () => {
    const busy = ctx({ waiting: ["a"], mayMove: false, reading: true });
    const [s1, c1] = decide(initialPolicy(), changes({ needs: ["a"] }), busy);
    expect(c1.kind).toBe("none");
    const [, c2] = decide(s1, { type: "tick" }, ctx({ waiting: ["a"], now: busy.now + 2000 }));
    expect(c2).toEqual({ kind: "fly", frame: { id: "a" } });
  });

  it("never moves for a failure, a new or a finished agent that is in view", () => {
    const [, c] = decide(initialPolicy(), changes({ failed: ["f"], fresh: ["n"] }), ctx({ inView: () => true }));
    expect(c.kind).toBe("none");
  });

  it("widens the overview for a new agent off screen, instead of flying to it", () => {
    const [, c] = decide(initialPolicy(), changes({ fresh: ["n"] }), ctx());
    expect(c).toEqual({ kind: "fly", frame: "live" });
  });

  it("does not fly to a question already in view", () => {
    const [, c] = decide(initialPolicy(), changes({ needs: ["a"] }), ctx({ waiting: ["a"], inView: id => id === "a" }));
    expect(c.kind).toBe("none");
  });

  it("never moves on its own once the user has steered, until they are idle", () => {
    const [s1] = decide(initialPolicy(), { type: "steer" }, ctx());
    const [s2, c2] = decide(s1, changes({ needs: ["a"] }), ctx({ waiting: ["a"] }));
    expect(c2.kind).toBe("none");
    const [, c3] = decide(s2, { type: "tick" }, ctx({ waiting: ["a"], idleFor: CAM.RESUME_IDLE - 1 }));
    expect(c3.kind).toBe("none");
    const [s4, c4] = decide(s2, { type: "tick" }, ctx({ waiting: ["a"], idleFor: CAM.RESUME_IDLE }));
    expect(c4).toEqual({ kind: "fly", frame: { id: "a" } });
    expect(s4.base).toBe("attend");
  });

  it("goes to the next question after an answer, with a pause", () => {
    const [s1] = decide(initialPolicy(), changes({ needs: ["a"] }), ctx({ waiting: ["a", "b"] }));
    const t = 200_000;
    const [s2, c2] = decide(s1, changes({ resolved: ["a"] }), ctx({ now: t, waiting: ["b"] }));
    expect(c2.kind).toBe("none");
    const [, early] = decide(s2, { type: "tick" }, ctx({ now: t + CAM.AFTER_ANSWER - 1, waiting: ["b"] }));
    expect(early.kind).toBe("none");
    const [, c3] = decide(s2, { type: "tick" }, ctx({ now: t + CAM.AFTER_ANSWER, waiting: ["b"] }));
    expect(c3).toEqual({ kind: "fly", frame: { id: "b" } });
  });

  it("returns to the work when the last question is answered", () => {
    const [s1] = decide(initialPolicy(), changes({ needs: ["a"] }), ctx({ waiting: ["a"] }));
    const [s2] = decide(s1, changes({ resolved: ["a"] }), ctx({ now: 300_000 }));
    const [, c] = decide(s2, { type: "tick" }, ctx({ now: 300_000 + CAM.AFTER_ANSWER }));
    expect(c).toEqual({ kind: "fly", frame: "live" });
  });

  it("learns to wait longer when the user undoes its moves", () => {
    const [s1] = decide(initialPolicy(), changes({ needs: ["a"] }), ctx({ waiting: ["a"] }));
    const [s2] = decide(s1, { type: "steer" }, ctx({ now: 100_000 + 1000 }));
    expect(s2.resumeIdle).toBe(CAM.RESUME_IDLE * 2);
  });

  it("does not fly to the same card twice within the cooldown", () => {
    const s: PolicyState = { ...initialPolicy(), lastTargetAt: { a: 100_000 - 1000 } };
    const [, c] = decide(s, changes({ needs: ["a"] }), ctx({ waiting: ["a"] }));
    expect(c.kind).toBe("none");
  });

  it("shows what waited when the window comes back", () => {
    const [, c] = decide(initialPolicy(), { type: "return" }, ctx({ waiting: ["a"] }));
    expect(c).toEqual({ kind: "fly", frame: { id: "a" } });
  });
});

describe("camera flight", () => {
  it("zooms out on the way between two far points and lands exactly", () => {
    const p = zoomPath([0, 0, 1000], [5000, 0, 1000]);
    const mid = p.at(0.5);
    expect(mid[2]).toBeGreaterThan(1000);
    const end = p.at(1);
    expect(end[0]).toBeCloseTo(5000, 3);
    expect(end[2]).toBeCloseTo(1000, 3);
  });

  it("keeps a nudge short and long moves within bounds", () => {
    const nudge = planFlight([0, 0, 1000], [100, 0, 1000], "auto", 0);
    expect(nudge.dur).toBe(260);
    const far = planFlight([0, 0, 1000], [20000, 0, 1000], "auto", 0);
    expect(far.dur).toBeGreaterThanOrEqual(420);
    expect(far.dur).toBeLessThanOrEqual(1100);
    expect(stepFlight(far, far.dur).done).toBe(true);
  });
});
