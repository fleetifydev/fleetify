import { describe, it, expect } from "vitest";
import { planModelHeal, type HealTarget } from "../model-heal";

/** Catalog BEFORE: Opus 5 is the provider default. */
const BEFORE = {
  "claude-code": [
    { id: "claude-opus-5", label: "Opus 5", default: true },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
  ],
};

/** Catalog AFTER: Opus 5 retired, Opus 6 shipped and flagged default. */
const AFTER = {
  "claude-code": [
    { id: "claude-opus-6", label: "Opus 6", default: true },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
  ],
};

const session = (id: string, tool: string, model: string | null): HealTarget =>
  ({ kind: "session", id, tool, model });
const composer = (tool: string, model: string | null): HealTarget =>
  ({ kind: "composer", tool, model });

describe("planModelHeal", () => {
  it("moves a session off a removed model onto the provider default", () => {
    const plan = planModelHeal([session("s1", "claude-code", "claude-opus-5")], AFTER);
    expect(plan).toEqual([
      { target: session("s1", "claude-code", "claude-opus-5"), nextModel: "claude-opus-6" },
    ]);
  });

  it("heals the composer (new-session screen) the same way", () => {
    const plan = planModelHeal([composer("claude-code", "claude-opus-5")], AFTER);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.nextModel).toBe("claude-opus-6");
    expect(plan[0]!.target.kind).toBe("composer");
  });

  it("heals every affected surface at once and leaves the untouched ones alone", () => {
    const plan = planModelHeal(
      [
        session("fleet-staff", "claude-code", "claude-opus-5"), // the Fleet screen
        session("s1", "claude-code", "claude-sonnet-5"), // still in the catalog
        session("s2", "claude-code", "claude-opus-5"),
        composer("claude-code", "claude-opus-5"),
      ],
      AFTER,
    );
    expect(plan.map((p) => p.target.id ?? p.target.kind)).toEqual([
      "fleet-staff",
      "s2",
      "composer",
    ]);
    expect(plan.every((p) => p.nextModel === "claude-opus-6")).toBe(true);
  });

  it("is a no-op while the model is still in the catalog", () => {
    expect(planModelHeal([session("s1", "claude-code", "claude-opus-5")], BEFORE)).toEqual([]);
  });

  it("heals away from a model the catalog retired but still lists (active:false)", () => {
    const retired = {
      "claude-code": [
        { id: "claude-opus-5", label: "Opus 5", active: false },
        { id: "claude-opus-6", label: "Opus 6", default: true },
      ],
    };
    const plan = planModelHeal([session("s1", "claude-code", "claude-opus-5")], retired);
    expect(plan[0]!.nextModel).toBe("claude-opus-6");
  });

  it("falls back to the first model when the provider flags no default", () => {
    const noDefault = { "claude-code": [{ id: "claude-opus-6" }, { id: "claude-sonnet-5" }] };
    const plan = planModelHeal([session("s1", "claude-code", "claude-opus-5")], noDefault);
    expect(plan[0]!.nextModel).toBe("claude-opus-6");
  });

  it("NEVER touches a surface whose provider we couldn't discover (fail-open)", () => {
    // An unreachable catalog for that provider must not rewrite the user's
    // pick — that's how a transient outage would silently reset everyone.
    expect(planModelHeal([session("s1", "claude-code", "claude-opus-5")], {})).toEqual([]);
    expect(
      planModelHeal([session("s1", "claude-code", "claude-opus-5")], { "claude-code": [] }),
    ).toEqual([]);
  });

  it("leaves 'auto' sessions alone — the router picks the model, not the user", () => {
    const plan = planModelHeal([session("s1", "auto", "claude-opus-5")], AFTER);
    expect(plan).toEqual([]);
  });

  it("fills in a surface that has no model yet", () => {
    const plan = planModelHeal([session("s1", "claude-code", null)], AFTER);
    expect(plan[0]!.nextModel).toBe("claude-opus-6");
  });
});
