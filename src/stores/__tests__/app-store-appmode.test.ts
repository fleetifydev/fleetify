import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";

describe("appMode", () => {
  beforeEach(() => {
    useAppStore.getState().setAppMode("workspace");
  });

  it("defaults to workspace", () => {
    expect(useAppStore.getState().appMode).toBe("workspace");
  });

  it("setAppMode updates state and persists to localStorage", () => {
    useAppStore.getState().setAppMode("studio");
    expect(useAppStore.getState().appMode).toBe("studio");
    expect(localStorage.getItem("fleet:appMode")).toBe("studio");

    useAppStore.getState().setAppMode("workspace");
    expect(useAppStore.getState().appMode).toBe("workspace");
    expect(localStorage.getItem("fleet:appMode")).toBe("workspace");
  });
});
