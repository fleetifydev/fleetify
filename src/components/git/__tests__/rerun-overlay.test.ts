import { describe, it, expect } from "vitest";
import { applyRerunOverlay, type ChecksWithRuns } from "@/components/git/rerun-overlay";

const base = (): ChecksWithRuns => ({
  passing: 1,
  failing: 2,
  pending: 0,
  total: 3,
  runs: [
    { name: "lint", status: "COMPLETED", conclusion: "FAILURE", bucket: "failing", url: null, jobId: 1, rerunnable: true },
    { name: "test", status: "COMPLETED", conclusion: "FAILURE", bucket: "failing", url: null, jobId: 2, rerunnable: true },
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", bucket: "passing", url: null },
  ],
});

describe("applyRerunOverlay", () => {
  it("flips named failing checks to pending and moves the counts", () => {
    const out = applyRerunOverlay(base(), new Set(["lint"]));
    expect(out.failing).toBe(1);
    expect(out.pending).toBe(1);
    expect(out.runs?.find((r) => r.name === "lint")?.bucket).toBe("pending");
    expect(out.runs?.find((r) => r.name === "test")?.bucket).toBe("failing");
  });

  it("leaves non-matching and non-failing checks untouched", () => {
    const out = applyRerunOverlay(base(), new Set(["build", "nope"]));
    expect(out.failing).toBe(2);
    expect(out.pending).toBe(0);
  });

  it("is idempotent — a second apply is a no-op (already pending)", () => {
    const once = applyRerunOverlay(base(), new Set(["lint", "test"]));
    const twice = applyRerunOverlay(once, new Set(["lint", "test"]));
    expect(twice.failing).toBe(0);
    expect(twice.pending).toBe(2);
  });

  it("returns the same object when the set is empty", () => {
    const input = base();
    expect(applyRerunOverlay(input, new Set())).toBe(input);
  });
});
