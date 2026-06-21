import { describe, it, expect } from "vitest";
import { resolveSemanticMode, decideModeCommand } from "@/lib/permission-modes";
import type { PermissionCapability } from "@/lib/providers-api";

const claudeCap: PermissionCapability = {
  kind: "modes",
  modes: [
    { id: "default", label: "Ask permissions" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan mode" },
    { id: "bypassPermissions", label: "Bypass permissions" },
  ],
  sandbox: null,
};
const codexCap: PermissionCapability = {
  kind: "approval_sandbox",
  approvals: ["untrusted", "on-request", "never"],
  sandboxes: ["read-only", "workspace-write", "danger-full-access"],
};
const antigravityCap: PermissionCapability = {
  kind: "modes",
  modes: [
    { id: "request-review", label: "Request review" },
    { id: "proceed-in-sandbox", label: "Proceed in sandbox" },
    { id: "always-proceed", label: "Always proceed (YOLO)" },
  ],
  sandbox: ["off", "on"],
};
const noneCap: PermissionCapability = { kind: "none" };

describe("resolveSemanticMode", () => {
  it("maps plan to the native plan mode", () => {
    expect(resolveSemanticMode(claudeCap, "plan")).toEqual({ permission_mode: "plan" });
  });
  it("maps yolo to the loud mode", () => {
    expect(resolveSemanticMode(claudeCap, "yolo")).toEqual({ permission_mode: "bypassPermissions" });
  });
  it("maps codex plan to (never, read-only)", () => {
    expect(resolveSemanticMode(codexCap, "plan")).toEqual({ permission_mode: "never", sandbox: "read-only" });
  });
  it("maps codex yolo to (never, danger-full-access)", () => {
    expect(resolveSemanticMode(codexCap, "yolo")).toEqual({ permission_mode: "never", sandbox: "danger-full-access" });
  });
  it("returns null when the provider has no plan mode (antigravity)", () => {
    expect(resolveSemanticMode(antigravityCap, "plan")).toBeNull();
  });
  it("maps antigravity yolo to always-proceed", () => {
    expect(resolveSemanticMode(antigravityCap, "yolo")).toEqual({ permission_mode: "always-proceed" });
  });
  it("returns null for a capability with no modes", () => {
    expect(resolveSemanticMode(noneCap, "plan")).toBeNull();
  });
});

describe("decideModeCommand", () => {
  it("returns an apply outcome for a supported plan switch", () => {
    const out = decideModeCommand("plan", claudeCap, "claude-code");
    // The notice ("Session mode switched to <b>Plan</b> mode.") is built by
    // ModeNoticeCard from `mode`; claude-code needs no respawn note.
    expect(out).toEqual({
      kind: "apply",
      patch: { permission_mode: "plan" },
      mode: "Plan",
      note: "",
      tone: "info",
    });
  });

  it("warns (no apply) when the provider lacks the mode", () => {
    const out = decideModeCommand("plan", antigravityCap, "antigravity-cli");
    expect(out.kind).toBe("info");
    expect(out.tone).toBe("warn");
  });

  it("adds the respawn hint for codex/gemini and keeps the sandbox in the patch", () => {
    const out = decideModeCommand("yolo", codexCap, "codex-cli");
    expect(out).toMatchObject({
      kind: "apply",
      patch: { permission_mode: "never", sandbox: "danger-full-access" },
      mode: "YOLO",
      tone: "warn",
    });
    if (out.kind !== "apply") throw new Error("expected apply outcome");
    expect(out.note).toContain("next spawn");
  });
});
