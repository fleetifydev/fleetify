import type { PermissionCapability } from "@/lib/providers-api";
import { isLoudMode } from "@/lib/capabilities";

/** A provider-neutral mode intent a slash command can request. */
export type SemanticMode = "plan" | "yolo" | "default";

/** The session-config fields a mode switch writes. `sandbox` is set only for
 *  two-axis providers (Codex). */
export type ModePatch = { permission_mode: string; sandbox?: string };

/** Codex (approval × sandbox) presets per semantic intent. */
const CODEX_PRESETS: Record<SemanticMode, ModePatch> = {
  plan: { permission_mode: "never", sandbox: "read-only" },
  yolo: { permission_mode: "never", sandbox: "danger-full-access" },
  default: { permission_mode: "on-request", sandbox: "workspace-write" },
};

/**
 * Resolve a semantic mode intent to the active provider's native permission
 * patch, or `null` when the provider exposes no such mode (caller informs the
 * user instead of silently no-op'ing).
 */
export function resolveSemanticMode(
  cap: PermissionCapability,
  semantic: SemanticMode,
): ModePatch | null {
  if (cap.kind === "approval_sandbox") {
    const preset = CODEX_PRESETS[semantic];
    if (!cap.approvals.includes(preset.permission_mode)) return null;
    if (preset.sandbox && !cap.sandboxes.includes(preset.sandbox)) return null;
    return preset;
  }
  if (cap.kind === "modes") {
    if (semantic === "plan") {
      const m = cap.modes.find((x) => x.id === "plan");
      return m ? { permission_mode: m.id } : null;
    }
    if (semantic === "yolo") {
      const m = cap.modes.find((x) => isLoudMode(x.id));
      return m ? { permission_mode: m.id } : null;
    }
    const def = cap.modes.find((x) => x.id === "default") ?? cap.modes[0];
    return def ? { permission_mode: def.id } : null;
  }
  return null; // kind === "none"
}

/** Outcome of a `/plan` or `/yolo` command — apply a patch, or inform the user
 *  the mode isn't available. */
export type ModeCommandOutcome =
  | { kind: "apply"; patch: ModePatch; title: string; message: string; tone: "info" | "warn" }
  | { kind: "info"; title: string; message: string; tone: "warn" };

/** Tools whose permission change only takes effect on the next process spawn. */
const SPAWN_HINT_TOOLS = new Set(["codex-cli", "gemini-cli"]);

/**
 * Decide what a `/plan` or `/yolo` command should do for the active provider.
 * Pure — the caller performs the persistence + the chat notice.
 */
export function decideModeCommand(
  semantic: SemanticMode,
  cap: PermissionCapability,
  tool: string | null,
): ModeCommandOutcome {
  const patch = resolveSemanticMode(cap, semantic);
  if (!patch) {
    return {
      kind: "info",
      title: semantic === "plan" ? "No plan mode" : "No YOLO mode",
      message: `${tool ?? "This provider"} doesn't expose a ${semantic} mode.`,
      tone: "warn",
    };
  }
  const spawnHint = tool && SPAWN_HINT_TOOLS.has(tool)
    ? " Applies on the next spawn — restart the session to apply now."
    : "";
  const label = semantic === "plan" ? "Plan mode" : "YOLO mode";
  const blurb = semantic === "plan"
    ? "The agent plans first and won't make changes until you approve."
    : "Tool approvals are bypassed — the agent runs without asking.";
  return {
    kind: "apply",
    patch,
    title: label,
    message: `Session mode switched to ${label}. ${blurb}${spawnHint}`,
    tone: semantic === "plan" ? "info" : "warn",
  };
}
