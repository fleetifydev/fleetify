import { describe, it, expect } from "vitest";
import { resolveChipModel } from "../chat-view";

/** Catalog after Opus 4.8 was retired and Opus 5 shipped as the default. */
const LINEUP = {
  "claude-code": [
    { id: "claude-opus-5", default: true },
    { id: "claude-sonnet-5" },
  ],
};

describe("resolveChipModel", () => {
  it("shows the provider default instead of a model the catalog dropped", () => {
    // The Fleet-screen bug: resolveModelChip still found a friendly label for
    // the retired id in the embedded label map, so the chip read "Opus 4.8"
    // as if nothing had changed.
    expect(resolveChipModel("claude-code", "claude-opus-4-8", LINEUP)).toBe("claude-opus-5");
  });

  it("leaves a model the catalog still serves exactly as it is", () => {
    expect(resolveChipModel("claude-code", "claude-sonnet-5", LINEUP)).toBe("claude-sonnet-5");
  });

  it("heals away from a model the catalog retired but still lists", () => {
    const retired = {
      "claude-code": [{ id: "claude-opus-4-8", active: false }, { id: "claude-opus-5", default: true }],
    };
    expect(resolveChipModel("claude-code", "claude-opus-4-8", retired)).toBe("claude-opus-5");
  });

  it("leaves the id alone when the provider was not discovered (fail-open)", () => {
    // "We could not reach the catalog" must never look like "your model is
    // gone" — that would rewrite the chip on every transient outage.
    expect(resolveChipModel("claude-code", "claude-opus-4-8", {})).toBe("claude-opus-4-8");
    expect(resolveChipModel("claude-code", "claude-opus-4-8", { "claude-code": [] })).toBe(
      "claude-opus-4-8",
    );
  });

  it("keeps a null id null so the chip still renders the provider's Default", () => {
    // Substituting a concrete model here is what once put a Codex face on a
    // Gemini session.
    expect(resolveChipModel("claude-code", null, LINEUP)).toBeNull();
    expect(resolveChipModel("claude-code", undefined, LINEUP)).toBeNull();
  });

  it("never touches Fleet's Auto routing sentinel", () => {
    expect(resolveChipModel("auto", "claude-opus-4-8", LINEUP)).toBe("claude-opus-4-8");
  });
});
