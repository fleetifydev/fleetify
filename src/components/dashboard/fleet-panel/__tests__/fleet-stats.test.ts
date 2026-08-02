import { describe, it, expect } from "vitest";
import { countActive, countIdle } from "@/components/dashboard/fleet-panel/fleet-stats";

const s = (...statuses: string[]) => statuses.map((status, i) => ({ id: `s${i}`, status }));

describe("fleet stat counts", () => {
  it("counts running and starting as active", () => {
    expect(countActive(s("running", "starting"))).toBe(2);
  });

  it("counts everything else as idle", () => {
    expect(countIdle(s("stopped", "error", "waiting", "paused"))).toBe(4);
  });

  it("treats a missing status as idle, never active", () => {
    expect(countActive(s(...[undefined as unknown as string]))).toBe(0);
    expect(countIdle(s(...[undefined as unknown as string]))).toBe(1);
  });

  it("active and idle are exact complements — they must sum to the total", () => {
    const fleet = s("running", "stopped", "starting", "error", "waiting");
    expect(countActive(fleet) + countIdle(fleet)).toBe(fleet.length);
  });

  it("is zero on an empty fleet", () => {
    expect(countActive([])).toBe(0);
    expect(countIdle([])).toBe(0);
  });
});
