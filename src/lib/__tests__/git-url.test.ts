import { describe, it, expect } from "vitest";
import { normalizeCloneUrl, extractOwnerRepo } from "../git-url";

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

describe("extractOwnerRepo", () => {
  it("strips scheme + host from an https github URL", () => {
    expect(extractOwnerRepo("https://github.com/agentscope-ai/QwenPaw"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("strips the trailing .git suffix", () => {
    expect(extractOwnerRepo("https://github.com/agentscope-ai/QwenPaw.git"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("handles bare host/owner/repo input (no scheme)", () => {
    expect(extractOwnerRepo("github.com/agentscope-ai/QwenPaw"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("returns owner/repo shorthand verbatim", () => {
    expect(extractOwnerRepo("agentscope-ai/QwenPaw"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("extracts owner/repo from a scp-style SSH target", () => {
    expect(extractOwnerRepo("git@github.com:agentscope-ai/QwenPaw.git"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("extracts owner/repo from a ssh:// scheme URL with a user prefix", () => {
    expect(extractOwnerRepo("ssh://git@github.com/agentscope-ai/QwenPaw.git"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("extracts owner/repo from a posix .fleetify clone path", () => {
    expect(extractOwnerRepo("/home/u/.fleetify/clones/github.com/agentscope-ai/QwenPaw"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("extracts owner/repo from a windows .fleetify clone path", () => {
    expect(extractOwnerRepo("C:\\Users\\me\\.fleetify\\clones\\github.com\\agentscope-ai\\QwenPaw"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("strips a trailing slash on a clone path", () => {
    expect(extractOwnerRepo("/home/u/.fleetify/clones/github.com/agentscope-ai/QwenPaw/"))
      .toBe("agentscope-ai/QwenPaw");
  });

  it("returns null for unrelated folder paths", () => {
    expect(extractOwnerRepo("/home/u/projects/foo")).toBeNull();
    expect(extractOwnerRepo("/tmp")).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(extractOwnerRepo("")).toBeNull();
    expect(extractOwnerRepo("   ")).toBeNull();
  });

  it("returns null when no two-segment identifier can be recovered", () => {
    expect(extractOwnerRepo("notavalidthing")).toBeNull();
    expect(extractOwnerRepo("github.com")).toBeNull();
  });
});
