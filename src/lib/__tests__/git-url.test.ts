import { describe, it, expect } from "vitest";
import { normalizeCloneUrl } from "../git-url";

describe("normalizeCloneUrl", () => {
  it("expands owner/repo shorthand to a github.com https URL", () => {
    expect(normalizeCloneUrl("agentscope-ai/QwenPaw"))
      .toBe("https://github.com/agentscope-ai/QwenPaw");
  });

  it("passes a full https github URL through unchanged", () => {
    expect(normalizeCloneUrl("https://github.com/agentscope-ai/QwenPaw"))
      .toBe("https://github.com/agentscope-ai/QwenPaw");
  });

  it("passes a .git-suffixed https URL through unchanged", () => {
    expect(normalizeCloneUrl("https://github.com/agentscope-ai/QwenPaw.git"))
      .toBe("https://github.com/agentscope-ai/QwenPaw.git");
  });

  it("prepends https:// to a bare host/owner/repo input", () => {
    expect(normalizeCloneUrl("github.com/agentscope-ai/QwenPaw"))
      .toBe("https://github.com/agentscope-ai/QwenPaw");
  });

  it("passes scp-style git@host:owner/repo SSH targets through unchanged", () => {
    expect(normalizeCloneUrl("git@github.com:agentscope-ai/QwenPaw.git"))
      .toBe("git@github.com:agentscope-ai/QwenPaw.git");
  });

  it("passes ssh:// scheme URLs through unchanged", () => {
    expect(normalizeCloneUrl("ssh://git@github.com/owner/repo.git"))
      .toBe("ssh://git@github.com/owner/repo.git");
  });

  it("trims surrounding whitespace before classifying", () => {
    expect(normalizeCloneUrl("  agentscope-ai/QwenPaw  "))
      .toBe("https://github.com/agentscope-ai/QwenPaw");
  });

  it("strips trailing slashes from the input", () => {
    expect(normalizeCloneUrl("agentscope-ai/QwenPaw/"))
      .toBe("https://github.com/agentscope-ai/QwenPaw");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeCloneUrl("")).toBe("");
    expect(normalizeCloneUrl("   ")).toBe("");
  });

  it("leaves owner/repo paths with dots intact (.NET-style names)", () => {
    expect(normalizeCloneUrl("dotnet/aspnetcore.docs"))
      .toBe("https://github.com/dotnet/aspnetcore.docs");
  });

  it("does not mangle a non-shorthand single word — backend will surface the error", () => {
    expect(normalizeCloneUrl("notavalidthing")).toBe("notavalidthing");
  });

  it("does not treat owner/repo/sub as a shorthand (too many segments)", () => {
    expect(normalizeCloneUrl("a/b/c")).toBe("a/b/c");
  });
});
