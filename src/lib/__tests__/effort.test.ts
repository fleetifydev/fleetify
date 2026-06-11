import { describe, it, expect } from "vitest";
import { effortLabel } from "../effort";

describe("effortLabel", () => {
  it("returns the full, unabbreviated label for every effort level", () => {
    // Regression: the model chips used to abbreviate ("Med", "X-Hi"), which
    // read as truncated. They must now show the full effort name.
    expect(effortLabel("low")).toBe("Low");
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("extra_high")).toBe("Extra high");
    expect(effortLabel("max")).toBe("Max");
  });
});
