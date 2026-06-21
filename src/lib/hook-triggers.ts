/**
 * Canonical hook triggers and their per-provider native event names — the
 * frontend mirror of the backend `hook_triggers` table. Drives the trigger
 * dropdown: a single provider shows that provider's native events; several
 * providers show the triggers all of them support (intersection). The native
 * name is what the user sees; the canonical `id` is what we send to the backend.
 */
export interface HookTrigger {
  id: string;
  label: string;
  toolScoped: boolean;
  /** provider id → native event name (absent ⇒ unsupported). */
  natives: Record<string, string>;
}

export const HOOK_TRIGGERS: HookTrigger[] = [
  { id: "pre_tool_use", label: "Before tool use", toolScoped: true, natives: {
    "claude-code": "PreToolUse", "codex-cli": "PreToolUse",
    "cursor-cli": "preToolUse", "kimi-code": "PreToolUse", "antigravity-cli": "PreToolUse",
    "github-copilot": "preToolUse" } },
  { id: "post_tool_use", label: "After tool use", toolScoped: true, natives: {
    "claude-code": "PostToolUse", "codex-cli": "PostToolUse",
    "cursor-cli": "postToolUse", "kimi-code": "PostToolUse", "antigravity-cli": "PostToolUse",
    "github-copilot": "postToolUse" } },
  { id: "user_prompt_submit", label: "User prompt submit", toolScoped: false, natives: {
    "claude-code": "UserPromptSubmit", "codex-cli": "UserPromptSubmit",
    "cursor-cli": "beforeSubmitPrompt", "kimi-code": "UserPromptSubmit",
    "github-copilot": "userPromptSubmitted" } },
  { id: "session_start", label: "Session start", toolScoped: false, natives: {
    "claude-code": "SessionStart", "codex-cli": "SessionStart",
    "cursor-cli": "sessionStart", "kimi-code": "SessionStart", "github-copilot": "sessionStart" } },
  { id: "session_end", label: "Session end", toolScoped: false, natives: {
    "claude-code": "SessionEnd", "cursor-cli": "sessionEnd",
    "kimi-code": "SessionEnd", "github-copilot": "sessionEnd" } },
  { id: "stop", label: "Agent stop", toolScoped: false, natives: {
    "claude-code": "Stop", "codex-cli": "Stop", "cursor-cli": "stop",
    "kimi-code": "Stop", "antigravity-cli": "Stop", "github-copilot": "agentStop" } },
  { id: "before_model", label: "Before model call", toolScoped: false, natives: {
    "antigravity-cli": "PreInvocation" } },
  { id: "after_model", label: "After model call", toolScoped: false, natives: {
    "antigravity-cli": "PostInvocation" } },
  { id: "pre_compact", label: "Before compaction", toolScoped: false, natives: {
    "claude-code": "PreCompact", "codex-cli": "PreCompact",
    "cursor-cli": "preCompact", "kimi-code": "PreCompact", "github-copilot": "preCompact" } },
  { id: "notification", label: "Notification", toolScoped: false, natives: {
    "claude-code": "Notification", "kimi-code": "Notification",
    "github-copilot": "notification" } },
];

/** Hermes gateway events offered in the Gateway form. */
export const HERMES_GATEWAY_EVENTS = [
  "agent:start", "agent:step", "agent:end", "session:start", "session:end", "session:reset", "gateway:startup",
];

/** Triggers supported by EVERY provider in `providers` (intersection). Empty
 *  `providers` ⇒ none. */
export function triggersFor(providers: string[]): HookTrigger[] {
  if (providers.length === 0) return [];
  return HOOK_TRIGGERS.filter((t) => providers.every((p) => p in t.natives));
}

/** A display string for a trigger given the selected providers: the native
 *  name when unambiguous, else "label · p1native / p2native". */
export function triggerDisplay(t: HookTrigger, providers: string[]): string {
  const names = Array.from(
    new Set(providers.map((p) => t.natives[p]).filter((x): x is string => !!x)),
  );
  if (names.length === 1 && names[0]) return names[0];
  return `${t.label} · ${names.join(" / ")}`;
}

/** Auto-filled run command for an attached handler filename. */
export function defaultCommandFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "py") return "python3 ${file}";
  if (ext === "sh") return "bash ${file}";
  if (ext === "ts") return "bun ${file}";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "node ${file}";
  return "${file}";
}
