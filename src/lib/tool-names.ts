/** Friendly display names for tool calls. Raw MCP tool ids look like
 *  `mcp__fleet_browser__read_page`; users should just see "Browser read page".
 *  Shared by the tool-call summary line, the live activity verb, and the
 *  permission card so every surface reads the same. */

const MCP_SERVER_LABELS: Record<string, string> = {
  fleet_browser: "Browser",
  fleet_memory: "Memory",
  fleet_dispatch: "Dispatch",
  fleet_reveng: "Reverse-eng",
  fleet_permission: "Permission",
};

/** Turn a raw tool name into a human-readable label.
 *  `mcp__fleet_browser__read_page` → "Browser read page".
 *  Non-MCP tools (Read, Bash, …) are returned unchanged. */
export function humanizeToolName(name: string): string {
  if (!name) return "tool";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "";
    const action = parts.slice(2).join("__").replace(/_/g, " ").trim();
    const label = MCP_SERVER_LABELS[server] ?? server.replace(/^fleet_/, "").replace(/_/g, " ");
    return action ? `${label} ${action}` : label;
  }
  return name;
}
