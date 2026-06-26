import { describe, it, expect } from "vitest";
import { resolveMergeGate } from "../merge-gate";
import type { PRStatus } from "@/lib/git-api";

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/x",
    checks: { passing: 0, failing: 0, pending: 0, total: 0 },
    commentsCount: 0,
    ...overrides,
  };
}

describe("resolveMergeGate", () => {
  it("loading when there is no PR detail yet", () => {
    const g = resolveMergeGate(null);
    expect(g.kind).toBe("loading");
    expect(g.canMerge).toBe(false);
  });

  it("CLEAN / HAS_HOOKS → mergeable", () => {
    expect(resolveMergeGate(pr({ mergeStateStatus: "CLEAN" })).canMerge).toBe(true);
    expect(resolveMergeGate(pr({ mergeStateStatus: "HAS_HOOKS" })).canMerge).toBe(true);
    expect(resolveMergeGate(pr({ mergeStateStatus: "CLEAN" })).kind).toBe("clean");
  });

  it("BLOCKED + pending required checks → disabled, waiting reason", () => {
    const g = resolveMergeGate(
      pr({ mergeStateStatus: "BLOCKED", checks: { passing: 1, failing: 0, pending: 2, total: 3 } }),
    );
    expect(g.kind).toBe("blocked");
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/Waiting on 2 checks/);
  });

  it("BLOCKED + failing → disabled, failing reason", () => {
    const g = resolveMergeGate(
      pr({ mergeStateStatus: "BLOCKED", checks: { passing: 1, failing: 1, pending: 0, total: 2 } }),
    );
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/1 check failing/);
  });

  it("BLOCKED with no failing/pending → review-required reason", () => {
    const g = resolveMergeGate(pr({ mergeStateStatus: "BLOCKED" }));
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/review required/i);
  });

  it("BEHIND → disabled, update reason", () => {
    const g = resolveMergeGate(pr({ mergeStateStatus: "BEHIND" }));
    expect(g.kind).toBe("behind");
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/behind main/);
  });

  it("UNSTABLE merges even with failing NON-required checks (GitHub allows it)", () => {
    const g = resolveMergeGate(
      pr({ mergeStateStatus: "UNSTABLE", checks: { passing: 2, failing: 1, pending: 0, total: 3 } }),
    );
    expect(g.kind).toBe("clean");
    expect(g.canMerge).toBe(true);
  });

  it("DIRTY or CONFLICTING → conflicting, disabled", () => {
    expect(resolveMergeGate(pr({ mergeStateStatus: "DIRTY" })).kind).toBe("conflicting");
    expect(resolveMergeGate(pr({ mergeable: "CONFLICTING" })).kind).toBe("conflicting");
    expect(resolveMergeGate(pr({ mergeable: "CONFLICTING" })).canMerge).toBe(false);
  });

  it("draft with clean checks → mark-ready + merge", () => {
    const g = resolveMergeGate(pr({ isDraft: true, mergeStateStatus: "DRAFT" }));
    expect(g.kind).toBe("draft");
    expect(g.canMerge).toBe(true);
    expect(g.reason).toMatch(/Mark #42 ready/);
  });

  it("draft with failing checks → blocked (don't offer a merge that will fail)", () => {
    const g = resolveMergeGate(
      pr({ isDraft: true, mergeStateStatus: "DRAFT", checks: { passing: 0, failing: 1, pending: 0, total: 1 } }),
    );
    expect(g.kind).toBe("blocked");
    expect(g.canMerge).toBe(false);
  });

  it("UNKNOWN / absent mergeStateStatus → legacy fallback", () => {
    expect(resolveMergeGate(pr({ mergeStateStatus: "UNKNOWN" })).canMerge).toBe(true);
    expect(resolveMergeGate(pr({})).canMerge).toBe(true); // field absent entirely
    expect(
      resolveMergeGate(pr({ checks: { passing: 0, failing: 1, pending: 0, total: 1 } })).canMerge,
    ).toBe(false); // absent + failing → blocked
  });
});
