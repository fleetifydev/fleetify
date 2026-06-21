/**
 * Slash-command registry.
 *
 * Two domains:
 *   - fleet    : Fleetify command-center commands, provider-agnostic. Always
 *                handled by Fleetify itself (DB/UI side-effects), never sent
 *                to the underlying CLI.
 *   - session  : Commands meaningful inside a running agent session. The set
 *                surfaced to the user depends on the provider (`Session.tool`),
 *                because Claude and Codex each have their own slash
 *                vocabularies (e.g. Codex adds `/clear` + `/status`).
 *
 * The session-chat input surfaces BOTH domains (fleet commands stay useful
 * while inside a session — e.g. /new, /status). The dedicated fleet command
 * center surfaces ONLY fleet commands. When a fleet command's literal cmd
 * collides with a session command's cmd (today: `/mcp`, `/compact`), the
 * session-domain entry wins inside session-chat so the user gets the more
 * specific behaviour.
 *
 * Plugin-contributed commands (fetched at runtime from
 * `/api/runtime/commands`) are appended as scope="session" entries with a
 * `body` template; they take precedence over builtins on `cmd` collisions
 * (see chat-input's slashAll merge).
 */

import type { SemanticMode } from "@/lib/permission-modes";

/** How a command is executed. Omitted = legacy behaviour (local handler or raw
 *  text). See docs/superpowers/specs/2026-06-15-slash-commands-design.md §3. */
export type SlashMechanism = "local" | "mode" | "passthrough" | "inject" | "picker";

export type SessionTool = "claude-code" | "codex-cli";

export type SlashIntent =
  | "fleet.new"
  | "fleet.stop"
  | "fleet.restart"
  | "fleet.status"
  | "fleet.help"
  | "fleet.compaction"
  | "fleet.mcp"
  | "fleet.prompts"
  | "fleet.context"
  | "session.compaction"
  | "session.clear"
  | "session.context"
  | "session.plan"
  | "session.yolo"
  | "session.model"
  | "session.review"
  | "session.hooks"
  | "session.skills"
  | "session.effort"
  | "session.usage"
  | "session.permissions"
  | "session.commands"
  | "session.prompts"
  | "session.mcp";

export type SlashScope = "fleet" | "session";

export type SlashCmdDef = {
  /** Stable semantic id, independent of which provider serves it. */
  intent: SlashIntent;
  /** Command text shown in autocomplete and inserted into the input. */
  cmd: string;
  /** One-line description in the autocomplete popup. */
  desc: string;
  /** What actually gets sent to the CLI when the user submits this command.
   * Defaults to `cmd` when omitted. Diverges from `cmd` only when the visible
   * name and the underlying provider command differ (today: none). Kept as an
   * explicit field so a future "translate intent → provider cmd" rewrite has a
   * single source. */
  providerCmd?: string;
  scope: SlashScope;
  /** Restricts the command to a subset of providers. When omitted, the
   * command is available for all known tools. Used for session-domain
   * entries that don't make sense in every CLI — e.g. the `/commands` vs
   * `/prompts` split between Claude and Codex. */
  supportedTools?: SessionTool[];
  /** Execution mechanism. Omitted → legacy (local handler or raw-text send). */
  mechanism?: SlashMechanism;
  /** For mechanism:"mode" — the provider-neutral mode this command requests. */
  semantic?: SemanticMode;
};

export const FLEET_CMDS: SlashCmdDef[] = [
  { intent: "fleet.new",        cmd: "/new",     desc: "Launch a new agent",                              scope: "fleet" },
  { intent: "fleet.stop",       cmd: "/stop",    desc: "Stop an agent — /stop @name or /stop all",        scope: "fleet" },
  { intent: "fleet.restart",    cmd: "/restart", desc: "Restart an agent — /restart @name",               scope: "fleet" },
  { intent: "fleet.status",     cmd: "/status",  desc: "Show fleet status in chat",                       scope: "fleet" },
  { intent: "fleet.compaction", cmd: "/compact", desc: "Summarize the fleet conversation with the fleet model", scope: "fleet" },
  { intent: "fleet.mcp",        cmd: "/mcp",     desc: "Show MCP server status across the fleet",         scope: "fleet" },
  { intent: "fleet.help",       cmd: "/help",    desc: "Show tips and keyboard shortcuts",                scope: "fleet" },
  { intent: "fleet.prompts",    cmd: "/prompts", desc: "Browse & send a saved prompt",                    scope: "fleet" },
  // /context — provider-agnostic. A single fleet-domain entry makes it available
  // everywhere: the fleet command center shows it directly, and (via the
  // fleet→session merge in commandsForContext) every session chat surfaces it
  // too. Handled Fleetify-side in chat-input's slash pipeline (renders the
  // context-window card); never forwarded to the CLI.
  { intent: "fleet.context",    cmd: "/context", desc: "Show context window usage",                       scope: "fleet" },
  // /model — surfaced in the fleet command center so it autocompletes there too
  // (the control-center passes ctx "fleet", not "session-chat"). The handler in
  // chat-input opens the UnifiedModelPicker; works with no active session.
  { intent: "session.model",    cmd: "/model",   desc: "Switch model — opens the model picker",           scope: "fleet" },
];

// Provider-specific session commands that Fleetify actually executes (the
// compaction command routes through the app-owned compactor; /context renders
// the context card). Native TUI commands that DON'T run over the agent's
// non-interactive transport are intentionally omitted — Claude's /review and
// Codex's /clear, /status are TUI-only, and Codex's /review is now surfaced
// dynamically by its bridge (mapped to the `review/start` app-server method).
export const SESSION_CMDS_BY_TOOL: Record<SessionTool, SlashCmdDef[]> = {
  "claude-code": [
    { intent: "session.compaction", cmd: "/compact", desc: "Summarize conversation to free context", scope: "session" },
    { intent: "session.context",    cmd: "/context", desc: "Show context window usage",              scope: "session" },
  ],
  "codex-cli": [
    { intent: "session.compaction", cmd: "/compact", desc: "Summarize visible conversation (auto-confirmed)", scope: "session" },
  ],
};

/**
 * Provider-aware commands that share a single intent across the CLIs.
 * Filtered by `supportedTools` in commandsForContext for entries that only
 * make sense for a subset of providers.
 *
 * Each entry routes to a Fleetify-side handler — none of these are forwarded
 * to the underlying CLI as raw text (skills/hooks/usage/etc. would just open
 * a TUI panel inside the subprocess, which isn't useful in an embedded
 * session). The handlers live in chat-view's slash submit pipeline.
 */
export const SESSION_CMDS_COMMON: SlashCmdDef[] = [
  { intent: "session.hooks",       cmd: "/hooks",       desc: "Show configured lifecycle hooks for this session",                              scope: "session" },
  { intent: "session.skills",      cmd: "/skills",      desc: "Show installed skills available to this session",                               scope: "session" },
  { intent: "session.usage",       cmd: "/usage",       desc: "Show token usage and cost for this session",                                    scope: "session" },
  { intent: "session.permissions", cmd: "/permissions", desc: "Change the session's permission mode",                                          scope: "session" },
  { intent: "session.mcp",         cmd: "/mcp",         desc: "Show MCP server status for this session",                                       scope: "session" },
  // /model re-enabled — opens the existing UnifiedModelPicker (Providers | Models
  // | Effort). Tool-agnostic; the handler in chat-input opens the picker rather
  // than forwarding "/model" to the CLI.
  { intent: "session.model",       cmd: "/model",       desc: "Switch model — opens the model picker",                                         scope: "session" },
  // /effort commented out per request — reasoning effort now lives in the model
  // picker (Providers | Models | Effort), so the slash command is redundant.
  // { intent: "session.effort",      cmd: "/effort",      desc: "Change reasoning effort (low/medium/high/extra_high/max)", scope: "session", supportedTools: ["claude-code", "codex-cli"] },
  // /prompts surfaces the user's reusable prompts (Library + plugins) in a
  // searchable picker; the handler lives in chat-input. Tool-agnostic.
  { intent: "session.prompts",     cmd: "/prompts",     desc: "Browse & send a saved prompt",                             scope: "session" },
  // /commands (the "session.commands" feature — browse custom slash commands)
  // commented out per request. The Codex variant aliased the same intent to
  // /prompts; Codex still gets /prompts from the session.prompts entry above.
  // { intent: "session.commands",    cmd: "/commands",    desc: "Browse custom slash commands",                             scope: "session", supportedTools: ["claude-code"] },
  // { intent: "session.commands",    cmd: "/prompts",     desc: "Browse custom prompts",                                    scope: "session", supportedTools: ["codex-cli"] },
];

/**
 * Provider-agnostic session commands surfaced for EVERY tool (known or not).
 * Their effect resolves per-provider at run time (mechanism:"mode" → the
 * provider's native permission mode). See the design spec §5.2.
 */
export const SESSION_CMDS_BASE: SlashCmdDef[] = [
  { intent: "session.plan", cmd: "/plan", desc: "Switch to plan mode (read-only)", scope: "session", mechanism: "mode", semantic: "plan" },
  { intent: "session.yolo", cmd: "/yolo", desc: "Bypass approvals (YOLO)",          scope: "session", mechanism: "mode", semantic: "yolo" },
];

/**
 * Native commands each agent ACTUALLY runs, grouped by provider for the /help
 * "Session Commands" tab. Every entry is a command the agent recognises over
 * its real transport — verified by live-probing each agent's wire protocol:
 *
 *   - ACP agents (Grok / Copilot / OpenCode / Hermes / Cursor) advertise these
 *     over `available_commands_update`; sending the `/cmd` text runs it.
 *   - Codex (app-server) has no prompt-text commands — `/review` is wired to
 *     the `review/start` method by the bridge.
 *
 * Builtin core only: per-user **skills** (which also surface as `/<name>`) are
 * dynamic, so they're NOT hard-coded here — the help dialog merges the active
 * session's live-advertised set on top. Agents driven non-interactively that
 * advertise nothing (Claude Code `claude -p`, Antigravity print mode) have NO
 * entry: their only working commands are the universal set, shown separately.
 *
 * Keyed by Fleetify provider id (see providerName() for the display label).
 */
export const PROVIDER_NATIVE_CMDS: Record<string, { cmd: string; desc: string }[]> = {
  "grok-build": [
    { cmd: "/compact",        desc: "Compact the conversation history" },
    { cmd: "/context",        desc: "View context-window usage" },
    { cmd: "/memory",         desc: "Search and edit persistent memory" },
    { cmd: "/flush",          desc: "Flush conversation memory to disk now" },
    { cmd: "/dream",          desc: "Trigger an offline memory-consolidation pass" },
    { cmd: "/hooks",          desc: "Manage lifecycle hooks" },
    { cmd: "/plugins",        desc: "Manage plugins" },
    { cmd: "/session-info",   desc: "Show session info" },
    { cmd: "/imagine",        desc: "Generate an image from text" },
    { cmd: "/always-approve", desc: "Toggle always-approve mode" },
    { cmd: "/feedback",       desc: "Send feedback about the session" },
  ],
  "github-copilot": [
    { cmd: "/compact",         desc: "Summarize history to reduce context" },
    { cmd: "/context",         desc: "Show context-window usage" },
    { cmd: "/init",            desc: "Initialize Copilot custom instructions" },
    { cmd: "/model",           desc: "Select the AI model" },
    { cmd: "/plan",            desc: "Create an implementation plan" },
    { cmd: "/mcp",             desc: "Manage MCP servers" },
    { cmd: "/memory",          desc: "Configure memory use" },
    { cmd: "/research",        desc: "Deep-research investigation" },
    { cmd: "/review",          desc: "Run the code-review agent" },
    { cmd: "/security-review", desc: "Analyze pending changes for vulnerabilities" },
    { cmd: "/sandbox",         desc: "Configure shell-command sandboxing" },
    { cmd: "/session",         desc: "Show / manage sessions" },
    { cmd: "/skills",          desc: "Manage skills" },
    { cmd: "/usage",           desc: "Display session usage metrics" },
    { cmd: "/add-dir",         desc: "Add a directory to the file-access allowlist" },
  ],
  "opencode": [
    { cmd: "/init",    desc: "Create or update AGENTS.md" },
    { cmd: "/review",  desc: "Review changes" },
    { cmd: "/compact", desc: "Compact the current session" },
  ],
  "hermes-agent": [
    { cmd: "/model",   desc: "Switch the active model" },
    { cmd: "/tools",   desc: "List available tools" },
    { cmd: "/context", desc: "Show context usage" },
    { cmd: "/compact", desc: "Compress the conversation context" },
    { cmd: "/steer",   desc: "Steer the running agent" },
    { cmd: "/queue",   desc: "Queue a follow-up message" },
    { cmd: "/reset",   desc: "Start a new session" },
    { cmd: "/version", desc: "Show version info" },
  ],
  "cursor-cli": [
    { cmd: "/model",     desc: "Select a model" },
    { cmd: "/plan",      desc: "Switch to Plan mode" },
    { cmd: "/ask",       desc: "Toggle Ask mode (read-only questions)" },
    { cmd: "/summarize", desc: "Summarize the conversation to reduce context" },
    { cmd: "/context",   desc: "Show what's consuming the context window" },
    { cmd: "/rewind",    desc: "Jump back to a previous message" },
  ],
  "codex-cli": [
    { cmd: "/review", desc: "Review your uncommitted changes" },
  ],
};

function isKnownTool(t: unknown): t is SessionTool {
  return t === "claude-code" || t === "codex-cli";
}

/**
 * Returns the builtin slash commands appropriate for a given UI surface.
 *
 *   - "fleet"        : fleet command center — only fleet-domain commands.
 *   - "session-chat" : chat input inside a session — fleet commands PLUS the
 *                       provider's session-domain commands. Unknown providers
 *                       (e.g. "custom"/"aider") fall back to fleet-only.
 *
 * When a session-domain command shares its literal `cmd` with a fleet-domain
 * command (today: `/mcp`, `/compact`), the session entry wins — the user
 * gets the session-scoped handler. The fleet entry is dropped to avoid a
 * duplicate row in the autocomplete popup.
 *
 * Plugin commands are NOT included here; the caller merges them separately
 * via the `/api/runtime/commands` endpoint.
 */
export function commandsForContext(
  ctx: "fleet" | "session-chat",
  tool?: string | null,
): SlashCmdDef[] {
  if (ctx === "fleet") return FLEET_CMDS;

  // Known tools get their bespoke vocab + the shared commons; unknown/new
  // tools still get the base session set (mode commands resolve per-provider).
  const perTool = isKnownTool(tool) ? SESSION_CMDS_BY_TOOL[tool] : [];
  // Common commands are Fleetify-side (LOCAL) and provider-agnostic, so they
  // surface for EVERY tool; supportedTools-restricted ones (e.g. /effort) still
  // only show for the tools that list them.
  const common = SESSION_CMDS_COMMON.filter(
    (c) => !c.supportedTools || (isKnownTool(tool) && c.supportedTools.includes(tool)),
  );
  const sessionCmds = new Set([...SESSION_CMDS_BASE, ...perTool, ...common].map((c) => c.cmd));
  const fleetSurfaced = FLEET_CMDS.filter((c) => !sessionCmds.has(c.cmd));
  const merged = [...fleetSurfaced, ...SESSION_CMDS_BASE, ...perTool, ...common];
  // Dedup by literal cmd, keeping the first occurrence. `/prompts` (session) is
  // ordered before the Codex `session.commands` `/prompts` alias so it wins;
  // all other builtins are already cmd-unique.
  const seen = new Set<string>();
  return merged.filter((c) => {
    if (seen.has(c.cmd)) return false;
    seen.add(c.cmd);
    return true;
  });
}
