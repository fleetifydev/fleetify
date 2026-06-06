import type { PermissionCapability, PermMode, ProviderTile, ToolMatrixCapability } from "@/lib/providers-api";

const HTTP_FALLBACK_MODES: PermMode[] = [
  { id: "default", label: "Ask permissions" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];

/** The active provider's native permission capability, from the cached tiles.
 *  Falls back to the HTTP agentic tiers for unknown / auto-routing providers. */
export function permissionCapabilityFor(
  tiles: ProviderTile[],
  providerId: string | null | undefined,
): PermissionCapability {
  const tile = providerId ? tiles.find((t) => t.spec.id === providerId) : undefined;
  return tile?.capabilities.permission ?? { kind: "modes", modes: HTTP_FALLBACK_MODES, sandbox: null };
}

/** Selectable modes to render for a capability. Modes → its modes;
 *  ApprovalSandbox → the approval axis as modes (the sandbox axis is a separate
 *  control, deferred to structured config); None → empty (caller hides picker). */
export function permissionModesFor(cap: PermissionCapability): PermMode[] {
  if (cap.kind === "modes") return cap.modes;
  if (cap.kind === "approval_sandbox")
    return cap.approvals.map((a) => ({ id: a, label: prettyApproval(a) }));
  return [];
}

function prettyApproval(a: string): string {
  switch (a) {
    case "untrusted": return "Ask every time";
    case "on-request": return "Ask on request";
    case "never": return "Never ask";
    default: return a;
  }
}

/** The active provider's per-tool matrix, or null if it has none. */
export function toolMatrixFor(
  tiles: ProviderTile[],
  providerId: string | null | undefined,
): ToolMatrixCapability | null {
  const tile = providerId ? tiles.find((t) => t.spec.id === providerId) : undefined;
  return tile?.capabilities.tool_matrix ?? null;
}

/** Parse a session's tool_overrides JSON string into a map (safe). */
export function parseToolOverrides(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The sandbox axis options for a provider, or null if it has none.
 *  ApprovalSandbox → its sandboxes; Modes with a sandbox toggle → those
 *  values; otherwise null. */
export function sandboxOptionsFor(
  tiles: ProviderTile[],
  providerId: string | null | undefined,
): string[] | null {
  const cap = permissionCapabilityFor(tiles, providerId);
  if (cap.kind === "approval_sandbox") return [...cap.sandboxes];
  if (cap.kind === "modes" && cap.sandbox && cap.sandbox.length > 0) return [...cap.sandbox];
  return null;
}

/** The provider's default permission mode id for a fresh session: a "default"
 *  mode if the capability has one, else its first mode (e.g. Codex → "untrusted",
 *  OpenCode → "build"). "" when the provider has no modes (None — Perplexity). */
export function defaultPermissionMode(cap: PermissionCapability): string {
  const modes = permissionModesFor(cap);
  if (modes.length === 0) return "";
  const defaultMode = modes.find((m) => m.id === "default");
  if (defaultMode) return defaultMode.id;
  // modes is non-empty — first element is guaranteed.
  return modes[0]!.id;
}

/** Autonomous/loud modes across providers — for the amber trigger styling. */
export function isLoudMode(id: string): boolean {
  return [
    "bypassPermissions", "dangerouslySkipPermissions", "yolo", "autopilot",
    "always-proceed", "never", "danger-full-access",
  ].includes(id);
}
