import { describe, it, expect } from "vitest";
import {
  permissionCapabilityFor,
  permissionModesFor,
  defaultPermissionMode,
  isLoudMode,
  toolMatrixFor,
  parseToolOverrides,
  sandboxOptionsFor,
} from "@/lib/capabilities";
import type { PermissionCapability, ProviderTile, ToolMatrixCapability } from "@/lib/providers-api";

function makeTile(id: string, cap: PermissionCapability): ProviderTile {
  return {
    spec: {
      id,
      display_name: id,
      kind: "cli",
      default_base_url: "",
      auth: { kind: "none" },
      default_models: [],
      extras: {},
      bin: "",
      auth_indicators: [],
      install_hint: "",
      login_hint: "",
    },
    connected: true,
    has_key: false,
    enabled_models: [],
    is_default: false,
    capabilities: {
      permission: cap,
      tool_matrix: null,
      timing: { permission: "spawn", effort: "spawn" },
      model_efforts: [],
    },
  };
}

describe("permissionModesFor", () => {
  it("returns modes for a modes capability", () => {
    const cap: PermissionCapability = {
      kind: "modes",
      modes: [
        { id: "default", label: "Ask permissions" },
        { id: "acceptEdits", label: "Accept edits" },
        { id: "bypassPermissions", label: "Bypass permissions" },
      ],
      sandbox: null,
    };
    const modes = permissionModesFor(cap);
    expect(modes).toHaveLength(3);
    expect(modes[0].id).toBe("default");
    expect(modes[2].id).toBe("bypassPermissions");
  });

  it("maps approval_sandbox approvals to modes with pretty labels", () => {
    const cap: PermissionCapability = {
      kind: "approval_sandbox",
      approvals: ["untrusted", "on-request", "never"],
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    };
    const modes = permissionModesFor(cap);
    expect(modes).toHaveLength(3);
    expect(modes[0]).toEqual({ id: "untrusted", label: "Ask every time" });
    expect(modes[1]).toEqual({ id: "on-request", label: "Ask on request" });
    expect(modes[2]).toEqual({ id: "never", label: "Never ask" });
  });

  it("returns empty array for none capability", () => {
    const cap: PermissionCapability = { kind: "none" };
    expect(permissionModesFor(cap)).toEqual([]);
  });
});

describe("permissionCapabilityFor", () => {
  const tiles = [
    makeTile("claude-code", {
      kind: "modes",
      modes: [
        { id: "default", label: "Ask permissions" },
        { id: "acceptEdits", label: "Accept edits" },
        { id: "plan", label: "Plan mode" },
        { id: "bypassPermissions", label: "Bypass permissions" },
      ],
      sandbox: null,
    }),
    makeTile("perplexity", { kind: "none" }),
  ];

  it("returns the tile's capability for a known provider id", () => {
    const cap = permissionCapabilityFor(tiles, "claude-code");
    expect(cap.kind).toBe("modes");
    if (cap.kind === "modes") {
      expect(cap.modes).toHaveLength(4);
      expect(cap.modes.some((m) => m.id === "plan")).toBe(true);
    }
  });

  it("falls back to HTTP modes for an unknown provider id", () => {
    const cap = permissionCapabilityFor(tiles, "unknown-provider");
    expect(cap.kind).toBe("modes");
    if (cap.kind === "modes") {
      expect(cap.modes.some((m) => m.id === "default")).toBe(true);
      expect(cap.modes.some((m) => m.id === "acceptEdits")).toBe(true);
      expect(cap.modes.some((m) => m.id === "bypassPermissions")).toBe(true);
      expect(cap.modes.some((m) => m.id === "plan")).toBe(false);
    }
  });

  it("falls back to HTTP modes when providerId is null", () => {
    const cap = permissionCapabilityFor(tiles, null);
    expect(cap.kind).toBe("modes");
  });

  it("falls back to HTTP modes when providerId is undefined", () => {
    const cap = permissionCapabilityFor(tiles, undefined);
    expect(cap.kind).toBe("modes");
  });
});

describe("isLoudMode", () => {
  it("returns true for loud modes", () => {
    expect(isLoudMode("bypassPermissions")).toBe(true);
    expect(isLoudMode("dangerouslySkipPermissions")).toBe(true);
    expect(isLoudMode("yolo")).toBe(true);
    expect(isLoudMode("autopilot")).toBe(true);
    expect(isLoudMode("always-proceed")).toBe(true);
    expect(isLoudMode("never")).toBe(true);
    expect(isLoudMode("danger-full-access")).toBe(true);
  });

  it("returns false for quiet modes", () => {
    expect(isLoudMode("default")).toBe(false);
    expect(isLoudMode("acceptEdits")).toBe(false);
    expect(isLoudMode("plan")).toBe(false);
    expect(isLoudMode("ask")).toBe(false);
    expect(isLoudMode("agent")).toBe(false);
  });
});

function makeTileWithMatrix(id: string, matrix: ToolMatrixCapability | null): ProviderTile {
  return {
    spec: {
      id,
      display_name: id,
      kind: "cli",
      default_base_url: "",
      auth: { kind: "none" },
      default_models: [],
      extras: {},
      bin: "",
      auth_indicators: [],
      install_hint: "",
      login_hint: "",
    },
    connected: true,
    has_key: false,
    enabled_models: [],
    is_default: false,
    capabilities: {
      permission: { kind: "none" },
      tool_matrix: matrix,
      timing: { permission: "spawn", effort: "spawn" },
      model_efforts: [],
    },
  };
}

describe("toolMatrixFor", () => {
  const matrix: ToolMatrixCapability = {
    tools: ["bash", "read_file", "write_file"],
    decisions: ["allow", "ask", "deny"],
    supports_glob: true,
  };
  const tiles = [
    makeTileWithMatrix("opencode", matrix),
    makeTileWithMatrix("cursor", null),
  ];

  it("returns the matrix for a provider that has one", () => {
    expect(toolMatrixFor(tiles, "opencode")).toEqual(matrix);
  });

  it("returns null for a provider with no matrix", () => {
    expect(toolMatrixFor(tiles, "cursor")).toBeNull();
  });

  it("returns null for an unknown provider id", () => {
    expect(toolMatrixFor(tiles, "x")).toBeNull();
  });

  it("returns null when providerId is null", () => {
    expect(toolMatrixFor(tiles, null)).toBeNull();
  });

  it("returns null when providerId is undefined", () => {
    expect(toolMatrixFor(tiles, undefined)).toBeNull();
  });

  it("returns null for empty tiles array", () => {
    expect(toolMatrixFor([], "x")).toBeNull();
  });
});

describe("sandboxOptionsFor", () => {
  const codexTile = makeTile("codex", {
    kind: "approval_sandbox",
    approvals: ["untrusted", "on-request", "never"],
    sandboxes: ["read-only", "workspace-write", "danger-full-access"],
  });
  const geminiTile = makeTile("gemini", {
    kind: "modes",
    modes: [{ id: "default", label: "Ask permissions" }],
    sandbox: ["off", "on"],
  });
  const claudeTile = makeTile("claude-code", {
    kind: "modes",
    modes: [{ id: "default", label: "Ask permissions" }],
    sandbox: null,
  });

  it("returns the sandboxes array for an approval_sandbox provider (codex)", () => {
    const opts = sandboxOptionsFor([codexTile], "codex");
    expect(opts).toEqual(["read-only", "workspace-write", "danger-full-access"]);
  });

  it("returns sandbox options for a modes provider with a sandbox toggle (gemini)", () => {
    const opts = sandboxOptionsFor([geminiTile], "gemini");
    expect(opts).toEqual(["off", "on"]);
  });

  it("returns null for a modes provider without sandbox (claude)", () => {
    const opts = sandboxOptionsFor([claudeTile], "claude-code");
    expect(opts).toBeNull();
  });

  it("returns null for an unknown provider id", () => {
    // Falls back to HTTP tiers which have no sandbox axis.
    const opts = sandboxOptionsFor([claudeTile], "unknown-provider");
    expect(opts).toBeNull();
  });

  it("returns null when providerId is null", () => {
    const opts = sandboxOptionsFor([codexTile], null);
    expect(opts).toBeNull();
  });
});

describe("parseToolOverrides", () => {
  it("parses a valid JSON string into a record", () => {
    expect(parseToolOverrides('{"bash":"deny"}')).toEqual({ bash: "deny" });
  });

  it("parses multiple entries", () => {
    expect(parseToolOverrides('{"bash":"deny","read_file":"allow"}')).toEqual({
      bash: "deny",
      read_file: "allow",
    });
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseToolOverrides("bad")).toEqual({});
  });

  it("returns empty object for null", () => {
    expect(parseToolOverrides(null)).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(parseToolOverrides(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseToolOverrides("")).toEqual({});
  });

  it("returns empty object when JSON is not an object", () => {
    expect(parseToolOverrides('"string"')).toEqual({});
    expect(parseToolOverrides("42")).toEqual({});
  });
});

describe("defaultPermissionMode", () => {
  const claudeTiles = [
    makeTile("claude-code", {
      kind: "modes",
      modes: [
        { id: "default", label: "Ask permissions" },
        { id: "acceptEdits", label: "Accept edits" },
        { id: "bypassPermissions", label: "Bypass permissions" },
      ],
      sandbox: null,
    }),
  ];

  it("returns 'default' for claude (HTTP-fallback-like modes capability with a 'default' mode)", () => {
    const cap = permissionCapabilityFor(claudeTiles, "claude-code");
    expect(defaultPermissionMode(cap)).toBe("default");
  });

  it("returns 'default' for an unknown provider (HTTP fallback also has a 'default' mode)", () => {
    const cap = permissionCapabilityFor(claudeTiles, "unknown-provider");
    expect(defaultPermissionMode(cap)).toBe("default");
  });

  it("returns the first approval for an approval_sandbox capability (e.g. Codex → 'untrusted')", () => {
    const cap: PermissionCapability = {
      kind: "approval_sandbox",
      approvals: ["untrusted", "never"],
      sandboxes: [],
    };
    expect(defaultPermissionMode(cap)).toBe("untrusted");
  });

  it("returns '' for a none capability (e.g. Perplexity)", () => {
    const cap: PermissionCapability = { kind: "none" };
    expect(defaultPermissionMode(cap)).toBe("");
  });
});
