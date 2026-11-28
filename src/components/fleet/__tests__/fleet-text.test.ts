import { describe, expect, it } from "vitest";
import { modelName, plain } from "../fleet-text";

describe("fleet text", () => {
  it("takes markdown marks out of a line", () => {
    expect(plain("Working in **cryonicx** with `the default model` · [docs](http://x)")).toBe("Working in cryonicx with the default model · docs");
    expect(plain("## Done\n- one")).toBe("Done\none");
  });

  it("says model ids the way people say them", () => {
    expect(modelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelName("claude-opus-5")).toBe("Opus 5");
    expect(modelName("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(modelName(null)).toBe("");
  });
});
