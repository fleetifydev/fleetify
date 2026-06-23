import { describe, it, expect } from "vitest";
import { resolveSessionModel, sendBlockMessage } from "@/lib/model-resolution";

const M = (id: string, def = false) => ({ id, default: def });

describe("resolveSessionModel", () => {
  it("ok when persisted exists", () => {
    expect(resolveSessionModel("a", [M("a"), M("b")])).toEqual({ status: "ok", model: "a" });
  });
  it("heals to flagged default when persisted is gone", () => {
    expect(resolveSessionModel("x", [M("a"), M("b", true)])).toEqual({ status: "healed", model: "b" });
  });
  it("heals to first model when no flag", () => {
    expect(resolveSessionModel("x", [M("a"), M("b")])).toEqual({ status: "healed", model: "a" });
  });
  it("unverified (fail-open) when list empty/unknown", () => {
    expect(resolveSessionModel("x", [])).toEqual({ status: "unverified", model: "x" });
  });
  it("missing when provider is known-empty", () => {
    expect(resolveSessionModel("x", [], { providerKnownEmpty: true })).toEqual({ status: "missing", model: "x" });
  });
  it("heals empty/null persisted to default", () => {
    expect(resolveSessionModel(null, [M("a"), M("b", true)])).toEqual({ status: "healed", model: "b" });
  });

  // Catalog-retired models (active: false) are not selectable.
  it("heals a session pinned to a retired (active:false) model away to the default", () => {
    const avail = [{ id: "fable", active: false }, { id: "opus", default: true }];
    expect(resolveSessionModel("fable", avail)).toEqual({ status: "healed", model: "opus" });
  });
  it("never heals TO a retired model (skips it when picking the default)", () => {
    const avail = [{ id: "fable", active: false }, { id: "opus" }];
    expect(resolveSessionModel("gone", avail)).toEqual({ status: "healed", model: "opus" });
  });
  it("unverified when every model is retired", () => {
    expect(resolveSessionModel("fable", [{ id: "fable", active: false }])).toEqual({
      status: "unverified",
      model: "fable",
    });
  });
});

describe("sendBlockMessage", () => {
  it("blocks only on 'missing'", () => {
    expect(sendBlockMessage({ status: "missing", model: "x" })).toMatch(/no longer available/i);
    expect(sendBlockMessage({ status: "ok", model: "a" })).toBeNull();
    expect(sendBlockMessage({ status: "healed", model: "b" })).toBeNull();
    expect(sendBlockMessage({ status: "unverified", model: "x" })).toBeNull();
  });
});
