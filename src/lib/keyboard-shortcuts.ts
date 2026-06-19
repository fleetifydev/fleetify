/**
 * Canonical keyboard-shortcut registry — the SINGLE source the /help dialog
 * renders from. The runtime bindings in `use-keyboard-shortcuts.ts` share this
 * id namespace and are kept in lockstep by an exhaustiveness test
 * (keyboard-shortcuts.test.ts / use-keyboard-shortcuts behavior). `source`
 * distinguishes hook-owned bindings from the command palette's own ⌘K binding
 * (registered in command-palette.tsx), so the drift test scopes correctly.
 *
 * `keys` are stored as platform-neutral tokens (`Mod`, `Shift`, literals). The
 * dialog resolves them per-platform via renderKey() — ⌘ on macOS, Ctrl else —
 * because the app also runs on Windows where a hardcoded ⌘ would be wrong.
 */
export type ShortcutGroup = "Navigation" | "Layout & panels" | "Git & PRs" | "Agents";

export interface ShortcutDoc {
  /** Stable id — shared with the runtime binding in use-keyboard-shortcuts.ts. */
  id: string;
  /** Key tokens: "Mod" | "Shift" | "Ctrl" | literal ("Y", "1–9", "`", "Esc", "."). */
  keys: string[];
  /** One-line description. */
  label: string;
  group: ShortcutGroup;
  /** Where the binding is actually registered. */
  source: "hook" | "palette";
}

export const KEYBOARD_SHORTCUTS: ShortcutDoc[] = [
  // Navigation
  { id: "switch-agent",     keys: ["Mod", "1–9"], label: "Switch to agent 1–9",                          group: "Navigation", source: "hook" },
  { id: "new-draft",        keys: ["Mod", "N"],   label: "New draft session",                            group: "Navigation", source: "hook" },
  { id: "back-to-fleet",    keys: ["Esc"],        label: "Back to Fleet (when not typing or streaming)", group: "Navigation", source: "hook" },
  { id: "command-palette",  keys: ["Mod", "K"],   label: "Open the command palette",                     group: "Navigation", source: "palette" },
  // Layout & panels
  { id: "toggle-sidebar",     keys: ["Mod", "Shift", "S"], label: "Toggle sidebar",      group: "Layout & panels", source: "hook" },
  { id: "toggle-right-panel", keys: ["Mod", "Shift", "."], label: "Toggle right panel",  group: "Layout & panels", source: "hook" },
  { id: "panel-preview",      keys: ["Mod", "Shift", "P"], label: "Preview panel",       group: "Layout & panels", source: "hook" },
  { id: "panel-diff",         keys: ["Mod", "Shift", "D"], label: "Diff panel",          group: "Layout & panels", source: "hook" },
  { id: "panel-files",        keys: ["Mod", "Shift", "F"], label: "Files panel",         group: "Layout & panels", source: "hook" },
  { id: "panel-terminal",     keys: ["Ctrl", "`"],         label: "Terminal panel",      group: "Layout & panels", source: "hook" },
  // Git & PRs
  { id: "commit-push", keys: ["Mod", "Shift", "Y"], label: "Commit & push",      group: "Git & PRs", source: "hook" },
  { id: "merge-pr",    keys: ["Mod", "Shift", "M"], label: "Merge PR (squash)",  group: "Git & PRs", source: "hook" },
  { id: "pull-latest", keys: ["Mod", "Shift", "L"], label: "Pull latest",        group: "Git & PRs", source: "hook" },
  { id: "open-pr",     keys: ["Mod", "Shift", "G"], label: "Open PR in GitHub",  group: "Git & PRs", source: "hook" },
  // Agents
  { id: "abort-all", keys: ["Mod", "Shift", "A"], label: "Abort all running agents", group: "Agents", source: "hook" },
];

/** macOS detection for key glyphs. navigator.platform is deprecated but the
 *  most reliable synchronous signal in the webview; userAgent is the fallback. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`);
}

/** Resolve a single key token to its display glyph for the current platform. */
export function renderKey(token: string, mac: boolean): string {
  if (token === "Mod") return mac ? "⌘" : "Ctrl";
  if (token === "Shift") return mac ? "⇧" : "Shift";
  return token;
}
