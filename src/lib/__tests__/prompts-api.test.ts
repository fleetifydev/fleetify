import { describe, it, expect } from "vitest";
import { filterPrompts, resolvePromptArg, type PromptSummary } from "../prompts-api";

const P = (over: Partial<PromptSummary>): PromptSummary => ({
  id: "prompt:x", name: "X", slug: "x", description: null, source: "user", body: "b", ...over,
});

describe("filterPrompts", () => {
  const list = [P({ slug: "deploy", name: "Deploy" }), P({ slug: "review", name: "Review PR" })];
  it("returns all on an empty query", () => {
    expect(filterPrompts(list, "  ")).toHaveLength(2);
  });
  it("matches name case-insensitively", () => {
    expect(filterPrompts(list, "REVIEW").map((p) => p.slug)).toEqual(["review"]);
  });
  it("matches slug", () => {
    expect(filterPrompts(list, "dep").map((p) => p.slug)).toEqual(["deploy"]);
  });
});

describe("resolvePromptArg", () => {
  const list = [P({ id: "prompt:deploy", slug: "deploy" }), P({ id: "plugin:a:review", slug: "review" })];
  it("resolves by slug, case-insensitive", () => {
    expect(resolvePromptArg(list, "Deploy")?.slug).toBe("deploy");
  });
  it("uses only the first token", () => {
    expect(resolvePromptArg(list, "review extra words")?.slug).toBe("review");
  });
  it("falls back to id", () => {
    expect(resolvePromptArg(list, "plugin:a:review")?.slug).toBe("review");
  });
  it("returns null on a miss", () => {
    expect(resolvePromptArg(list, "nope")).toBeNull();
  });
});
