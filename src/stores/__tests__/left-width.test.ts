import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import { SIDEBAR_DEFAULT_WIDTH } from "@/components/layout/sidebar-shell";

describe("leftWidth (cross-route sidebar width)", () => {
  beforeEach(() => {
    // Reset to the shared default before each case so order can't leak state.
    useAppStore.getState().setLeftWidth(SIDEBAR_DEFAULT_WIDTH);
  });

  it("defaults to the shared SIDEBAR_DEFAULT_WIDTH (224)", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(224);
    expect(useAppStore.getState().leftWidth).toBe(224);
  });

  it("setLeftWidth updates the shared width", () => {
    useAppStore.getState().setLeftWidth(300);
    expect(useAppStore.getState().leftWidth).toBe(300);
  });
});
