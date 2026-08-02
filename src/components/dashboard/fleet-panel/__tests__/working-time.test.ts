import { describe, it, expect } from "vitest";
import { activeWorkingMs, formatWorkingTime, IDLE_GAP_MS } from "@/components/dashboard/fleet-panel/working-time";

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

describe("activeWorkingMs", () => {
  it("is null with no activity — an unknown duration must not read as zero", () => {
    expect(activeWorkingMs([])).toBeNull();
  });

  it("is null for a single event — one timestamp spans nothing", () => {
    expect(activeWorkingMs([{ ts: at(0) }])).toBeNull();
  });

  it("sums consecutive gaps", () => {
    expect(activeWorkingMs([{ ts: at(0) }, { ts: at(5) }, { ts: at(9) }])).toBe(9 * 60_000);
  });

  it("excludes a gap longer than the idle threshold", () => {
    // 0 → 5 counts (5 min). 5 → 65 is an hour of nothing: excluded. 65 → 70 counts.
    const ms = activeWorkingMs([{ ts: at(0) }, { ts: at(5) }, { ts: at(65) }, { ts: at(70) }]);
    expect(ms).toBe(10 * 60_000);
  });

  it("counts a gap exactly at the threshold", () => {
    const ms = activeWorkingMs([{ ts: at(0) }, { ts: at(IDLE_GAP_MS / 60_000) }]);
    expect(ms).toBe(IDLE_GAP_MS);
  });

  it("tolerates unsorted input", () => {
    expect(activeWorkingMs([{ ts: at(9) }, { ts: at(0) }, { ts: at(5) }])).toBe(9 * 60_000);
  });

  it("ignores unparseable timestamps rather than producing NaN", () => {
    expect(activeWorkingMs([{ ts: "not-a-date" }, { ts: at(0) }, { ts: at(5) }])).toBe(5 * 60_000);
  });

  it("is zero, not null, when every gap is idle", () => {
    expect(activeWorkingMs([{ ts: at(0) }, { ts: at(600) }])).toBe(0);
  });
});

describe("formatWorkingTime", () => {
  it("renders an em dash for unknown", () => {
    expect(formatWorkingTime(null)).toBe("—");
  });
  it("renders sub-minute as <1m", () => {
    expect(formatWorkingTime(30_000)).toBe("<1m");
  });
  it("renders minutes", () => {
    expect(formatWorkingTime(9 * 60_000)).toBe("9m");
  });
  it("renders hours and minutes", () => {
    expect(formatWorkingTime((2 * 60 + 7) * 60_000)).toBe("2h 7m");
  });
  it("drops a zero minute remainder", () => {
    expect(formatWorkingTime(3 * 60 * 60_000)).toBe("3h");
  });
});
