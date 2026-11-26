import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accentFor, buildScene, coreOf, createSceneBatcher, diffScene, type SceneSession, type SceneState } from "../scene-model";

const session = (id: string, over: Partial<SceneSession> = {}): SceneSession => ({
  id, phase: "working", ring: "working", slotAngle: 233, activity: 0, accent: "#d97757", ...over,
});
const scene = (sessions: SceneSession[], over: Partial<SceneState> = {}): SceneState => ({
  core: coreOf(sessions), motionLevel: "full", sessions, ...over,
});

describe("coreOf", () => {
  it("asks for attention while any session needs the user", () => {
    expect(coreOf([{ ring: "working" }, { ring: "needs" }])).toBe("attention");
  });
  it("is busy while any session works, idle otherwise", () => {
    expect(coreOf([{ ring: "done" }, { ring: "working" }])).toBe("busy");
    expect(coreOf([{ ring: "done" }])).toBe("idle");
    expect(coreOf([])).toBe("idle");
  });
});

describe("buildScene", () => {
  it("maps the orbit layout to scene sessions and clamps activity", () => {
    const s = buildScene(
      [{ id: "a", ring: "needs", angle: 180 }, { id: "b", ring: "done", angle: 250 }],
      id => ({ activity: id === "a" ? 3 : -1, accent: "#000000" }),
      "reduced",
    );
    expect(s.core).toBe("attention");
    expect(s.motionLevel).toBe("reduced");
    expect(s.sessions).toEqual([
      { id: "a", phase: "needs", ring: "needs", slotAngle: 180, activity: 1, accent: "#000000" },
      { id: "b", phase: "done", ring: "done", slotAngle: 250, activity: 0, accent: "#000000" },
    ]);
  });
});

describe("diffScene", () => {
  it("writes the whole scene, with an arrive for each session, from nothing", () => {
    const next = scene([session("a")]);
    expect(diffScene(null, next)).toEqual([
      { op: "motion", value: "full" },
      { op: "core", value: "busy" },
      { op: "append", session: next.sessions[0] },
      { op: "fire", id: "a", trigger: "arrive" },
    ]);
  });

  it("writes nothing when nothing changed", () => {
    const s = scene([session("a")]);
    expect(diffScene(s, scene([session("a")]))).toEqual([]);
  });

  it("removes sessions that left the map", () => {
    expect(diffScene(scene([session("a"), session("b")]), scene([session("a")]))).toEqual([{ op: "remove", id: "b" }]);
  });

  it("nudges a session that moves to the inner ring", () => {
    const ops = diffScene(
      scene([session("a")]),
      scene([session("a", { ring: "needs", phase: "needs", slotAngle: 180 })]),
    );
    expect(ops).toEqual([
      { op: "core", value: "attention" },
      { op: "set", id: "a", field: "phase", value: "needs" },
      { op: "set", id: "a", field: "ring", value: "needs" },
      { op: "set", id: "a", field: "slotAngle", value: 180 },
      { op: "fire", id: "a", trigger: "nudge" },
    ]);
  });

  it("completes a session that finishes", () => {
    const ops = diffScene(scene([session("a")]), scene([session("a", { ring: "done", phase: "done" })]));
    expect(ops).toContainEqual({ op: "fire", id: "a", trigger: "complete" });
    expect(ops).toContainEqual({ op: "core", value: "idle" });
  });

  it("sends only the field that changed while a session keeps working", () => {
    expect(diffScene(scene([session("a")]), scene([session("a", { activity: 0.4 })]))).toEqual([
      { op: "set", id: "a", field: "activity", value: 0.4 },
    ]);
  });

  it("passes a switch to static motion through", () => {
    expect(diffScene(scene([]), scene([], { motionLevel: "static" }))).toEqual([{ op: "motion", value: "static" }]);
  });
});

describe("createSceneBatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("merges a burst of updates into one diff against what was last applied", () => {
    const apply = vi.fn();
    const b = createSceneBatcher(apply, 150);
    b.push(scene([session("a")]));
    b.push(scene([session("a", { activity: 0.2 })]));
    b.push(scene([session("a", { activity: 0.6 })]));
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(apply).toHaveBeenCalledTimes(1);
    const ops = apply.mock.calls[0]![0];
    expect(ops).toContainEqual({ op: "append", session: session("a", { activity: 0.6 }) });

    b.push(scene([session("a", { activity: 0.6 })]));
    vi.advanceTimersByTime(150);
    expect(apply).toHaveBeenCalledTimes(1); // nothing changed, nothing written
  });

  it("flushes on demand and drops pending work on dispose", () => {
    const apply = vi.fn();
    const b = createSceneBatcher(apply, 150);
    b.push(scene([session("a")]));
    b.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    b.push(scene([session("a", { activity: 1 })]));
    b.dispose();
    vi.advanceTimersByTime(500);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("accentFor", () => {
  it("knows the agents and falls back to grey", () => {
    expect(accentFor("claude-code")).toBe("#d97757");
    expect(accentFor("something-new")).toBe("#9ca3af");
    expect(accentFor(undefined)).toBe("#9ca3af");
  });
});
