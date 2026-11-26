import { describe, expect, it } from "vitest";
import { layoutOrbits, pointOn, ringFor, RING_LIMIT, type OrbitItem } from "../orbit-layout";

describe("ringFor", () => {
  it("puts a waiting session on the inner ring", () => {
    expect(ringFor("waiting", false, false)).toBe("needs");
  });
  it("treats a pending permission or question as waiting, whatever the status says", () => {
    expect(ringFor("running", true, true)).toBe("needs");
    expect(ringFor("idle", true, false)).toBe("needs");
  });
  it("puts running, starting and streaming sessions on the working ring", () => {
    expect(ringFor("running", false, false)).toBe("working");
    expect(ringFor("starting", false, false)).toBe("working");
    expect(ringFor("idle", false, true)).toBe("working");
  });
  it("puts idle, stopped and errored sessions on the outer ring", () => {
    expect(ringFor("idle", false, false)).toBe("done");
    expect(ringFor("stopped", false, false)).toBe("done");
    expect(ringFor("error", false, false)).toBe("done");
  });
});

describe("layoutOrbits", () => {
  const item = (id: string, ring: OrbitItem["ring"], lastActive: number): OrbitItem => ({ id, ring, lastActive });

  it("opens the inner ring on the left and spreads its sessions evenly", () => {
    const { placed } = layoutOrbits([item("a", "needs", 2), item("b", "needs", 1)]);
    expect(placed).toEqual([
      { id: "a", ring: "needs", angle: 180 },
      { id: "b", ring: "needs", angle: 0 },
    ]);
  });

  it("orders each ring by most recent activity", () => {
    const { placed } = layoutOrbits([item("old", "working", 1), item("new", "working", 9)]);
    expect(placed.map(p => p.id)).toEqual(["new", "old"]);
  });

  it("caps each ring and counts the rest", () => {
    const many = Array.from({ length: RING_LIMIT.done + 3 }, (_, i) => item(`d${i}`, "done", i));
    const { placed, hidden } = layoutOrbits(many);
    expect(placed).toHaveLength(RING_LIMIT.done);
    expect(hidden).toBe(3);
    // the most recent ones stay on the map
    expect(placed.map(p => p.id)).toContain(`d${RING_LIMIT.done + 2}`);
  });

  it("keeps the working and done rings clear of the question cards beside the core", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item(`w${i}`, "working", i)),
      ...Array.from({ length: 5 }, (_, i) => item(`d${i}`, "done", i)),
    ];
    for (const p of layoutOrbits(items).placed) {
      const onTop = p.angle >= 200 && p.angle <= 340;
      const onBottom = p.angle >= 60 && p.angle <= 120;
      expect(onTop || onBottom).toBe(true);
    }
  });

  it("keeps every angle within 0 to 360", () => {
    const { placed } = layoutOrbits(Array.from({ length: 6 }, (_, i) => item(`w${i}`, "working", i)));
    for (const p of placed) {
      expect(p.angle).toBeGreaterThanOrEqual(0);
      expect(p.angle).toBeLessThan(360);
    }
  });
});

describe("pointOn", () => {
  it("finds the right, bottom and left of an ellipse", () => {
    expect(pointOn(0, 0, 10, 5, 0)).toEqual([10, 0]);
    const [bx, by] = pointOn(0, 0, 10, 5, 90);
    expect(bx).toBeCloseTo(0);
    expect(by).toBeCloseTo(5);
    const [lx] = pointOn(0, 0, 10, 5, 180);
    expect(lx).toBeCloseTo(-10);
  });
});
