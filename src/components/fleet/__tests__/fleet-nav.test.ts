import { describe, expect, it } from "vitest";
import { navigate, navMap, type NavMap } from "../fleet-nav";

const m: NavMap = {
  hub: "fleet",
  left: ["head:a", "s:1", "s:2", "head:b", "s:3"],
  right: ["head:c", "s:4", "s:5"],
  y: { fleet: 60, "head:a": 20, "s:1": 60, "s:2": 120, "head:b": 200, "s:3": 240, "head:c": 20, "s:4": 70, "s:5": 230 },
};

describe("keyboard walk", () => {
  it("walks a side top to bottom and goes to the hub from its top", () => {
    expect(navigate("s:1", "down", m)).toBe("s:2");
    expect(navigate("s:2", "down", m)).toBe("head:b");
    expect(navigate("s:3", "down", m)).toBeNull();
    expect(navigate("s:1", "up", m)).toBe("head:a");
    expect(navigate("head:a", "up", m)).toBe("fleet");
  });

  it("crosses over the hub to the other side, level with where it was, and never goes outward", () => {
    expect(navigate("s:3", "right", m)).toBe("s:5");
    expect(navigate("s:1", "right", m)).toBe("s:4");
    expect(navigate("s:4", "left", m)).toBe("s:1");
    expect(navigate("s:1", "left", m)).toBeNull();
    expect(navigate("s:4", "right", m)).toBeNull();
  });

  it("enters a side from the hub, or from nothing selected", () => {
    expect(navigate("fleet", "left", m)).toBe("head:a");
    expect(navigate("fleet", "right", m)).toBe("head:c");
    expect(navigate("fleet", "down", m)).toBe("head:a");
    expect(navigate(null, "right", m)).toBe("head:c");
    expect(navigate("fleet", "up", m)).toBeNull();
  });

  it("goes to the hub when the other side is empty", () => {
    expect(navigate("s:1", "right", { ...m, right: [] })).toBe("fleet");
  });

  it("reads the sides off a laid-out tree in screen order, skipping a merged label", () => {
    const P = (y: number, h = 40) => ({ x: 0, y, w: 100, h });
    const map = navMap("fleet", [
      { project: "a", rows: [{ id: "1" }, { id: "2" }], folded: true, merged: false },
      { project: "b", rows: [{ id: "3" }], folded: false, merged: true },
    ], {
      hub: P(0, 80), heads: { a: P(0, 20), b: P(300, 20) }, rows: { "1": P(30), "2": P(80), "3": P(330) }, folds: { a: P(130, 20) },
      sides: { a: "left", b: "left" },
    });
    expect(map.left).toEqual(["head:a", "s:1", "s:2", "fold:a", "s:3"]);
    expect(map.right).toEqual([]);
  });
});
