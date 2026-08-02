import { describe, it, expect } from "vitest";
import { isViewSelectable, hasRealSession } from "@/components/workspace/view-gate";
import type { WorkspaceView } from "@/stores/app-store";

const ALL: WorkspaceView[] = ["preview", "browser", "diff", "terminal", "files", "tasks", "memories"];

describe("hasRealSession", () => {
  it("is false with no active session", () => {
    expect(hasRealSession(null, null)).toBe(false);
    expect(hasRealSession(null, "staff-1")).toBe(false);
  });

  it("is false on the staff session", () => {
    expect(hasRealSession("staff-1", "staff-1")).toBe(false);
  });

  it("is true on an agent session", () => {
    expect(hasRealSession("sess-9", "staff-1")).toBe(true);
  });
});

describe("isViewSelectable", () => {
  it("offers only Browser with no session", () => {
    expect(isViewSelectable("browser", null, null)).toBe(true);
    for (const v of ALL.filter(v => v !== "browser")) {
      expect(isViewSelectable(v, null, null)).toBe(false);
    }
  });

  it("offers only Browser on the staff session", () => {
    expect(isViewSelectable("browser", "staff-1", "staff-1")).toBe(true);
    expect(isViewSelectable("files", "staff-1", "staff-1")).toBe(false);
    expect(isViewSelectable("preview", "staff-1", "staff-1")).toBe(false);
  });

  it("offers everything on a real agent session", () => {
    for (const v of ALL) {
      expect(isViewSelectable(v, "sess-9", "staff-1")).toBe(true);
    }
  });
});
