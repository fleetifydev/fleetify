import { describe, expect, test } from "vitest";
import { canDropOn, planSessionDrop, type DndSession } from "../sidebar-dnd";

/** Shorthand session factory. */
const s = (id: string, group: string, pinned = false): DndSession => ({ id, group, pinned });

// Two workspace groups: alpha (a1, a2, a3) and beta (b1, b2).
// a1 is pinned; the rest are not.
const list: DndSession[] = [
  s("a1", "alpha", true),
  s("a2", "alpha"),
  s("a3", "alpha"),
  s("b1", "beta"),
  s("b2", "beta"),
];

describe("planSessionDrop", () => {
  test("reorders within the same workspace group", () => {
    const plan = planSessionDrop(list, "a3", "a2");
    expect(plan).toEqual({ kind: "reorder", ids: ["a1", "a3", "a2", "b1", "b2"] });
  });

  test("rejects drops onto a session from another workspace", () => {
    expect(planSessionDrop(list, "a2", "b1")).toEqual({ kind: "reject" });
    expect(planSessionDrop(list, "b2", "a3")).toEqual({ kind: "reject" });
  });

  test("rejects cross-workspace drops even across the pin boundary", () => {
    // a1 is pinned; b1 is unpinned but in another workspace — the workspace
    // rule dominates the pin transition.
    expect(planSessionDrop(list, "a1", "b1")).toEqual({ kind: "reject" });
    expect(planSessionDrop(list, "b1", "a1")).toEqual({ kind: "reject" });
  });

  test("dropping a pinned session onto an unpinned same-workspace session unpins it", () => {
    const plan = planSessionDrop(list, "a1", "a2");
    expect(plan).toEqual({
      kind: "unpin",
      id: "a1",
      ids: ["a1", "a2", "a3", "b1", "b2"],
    });
  });

  test("dropping an unpinned session onto a pinned same-workspace session pins it", () => {
    const plan = planSessionDrop(list, "a3", "a1");
    expect(plan).toEqual({
      kind: "pin",
      id: "a3",
      ids: ["a3", "a1", "a2", "b1", "b2"],
    });
  });

  test("dropping a session onto itself is a no-op", () => {
    expect(planSessionDrop(list, "a2", "a2")).toEqual({ kind: "noop" });
  });

  test("unknown drag or target ids are a no-op", () => {
    expect(planSessionDrop(list, "nope", "a2")).toEqual({ kind: "noop" });
    expect(planSessionDrop(list, "a2", "nope")).toEqual({ kind: "noop" });
  });
});

describe("canDropOn", () => {
  test("allows same-workspace targets, including pin transitions", () => {
    expect(canDropOn(list, "a3", "a2")).toBe(true);
    expect(canDropOn(list, "a3", "a1")).toBe(true);
    expect(canDropOn(list, "a1", "a2")).toBe(true);
  });

  test("blocks cross-workspace targets", () => {
    expect(canDropOn(list, "a2", "b1")).toBe(false);
    expect(canDropOn(list, "b1", "a2")).toBe(false);
  });
});
