import { describe, it, expect } from "vitest";
import { STUDIO_TOOLS, isStudioTool } from "../studio-tools";

describe("studio-tools registry", () => {
  it("includes Higgsfield with the expected metadata", () => {
    const hf = STUDIO_TOOLS.find((t) => t.id === "higgsfield");
    expect(hf).toBeTruthy();
    expect(hf!.name).toBe("Higgsfield");
    expect(hf!.bin).toBe("hf");
    expect(hf!.installHint).toContain("@higgsfield/cli");
    expect(hf!.media).toEqual(["image", "video"]);
  });

  it("isStudioTool is true only for registered tool ids", () => {
    expect(isStudioTool("higgsfield")).toBe(true);
    expect(isStudioTool("claude")).toBe(false);
    expect(isStudioTool("")).toBe(false);
    expect(isStudioTool(null)).toBe(false);
    expect(isStudioTool(undefined)).toBe(false);
  });
});
