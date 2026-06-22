/**
 * Canonical keyboard-shortcut registry — the SINGLE source the /help dialog
 * renders from. The runtime bindings in `use-keyboard-shortcuts.ts` share this
 * id namespace and are kept in lockstep by an exhaustiveness test
 * (keyboard-shortcuts.test.ts / use-keyboard-shortcuts behavior). `source`
 * distinguishes hook-owned bindings from the command palette's own ⌘K binding
 * (registered in command-palette.tsx), so the drift test scopes correctly.
 *
 * `keys` are stored as platform-neutral tokens (`Mod`, `Shift`, literals).
 * `formatShortcut()` resolves a token array to the host platform's convention —
 * adjacent glyphs on macOS (`⇧⌘P`), `+`-joined words on Windows / Linux
 * (`Ctrl+Shift+P`) — because the app ships to all three and a hardcoded ⌘ would
 * be wrong off macOS. This is the SINGLE renderer every shortcut hint in the UI
 * should route through; never hardcode a ⌘/⌥/⌃ glyph in a component.
 */
import { getPlatform, type Platform } from "@/lib/utils";

export type ShortcutGroup = "Navigation" | "Layout & panels" | "Git & PRs" | "Agents";

export interface ShortcutDoc {
  /** Stable id — shared with the runtime binding in use-keyboard-shortcuts.ts. */
  id: string;
  /** Key tokens: "Mod" | "Shift" | "Ctrl" | literal ("Y", "1–9", "`", "Esc", "."). */
  keys: string[];
  /**
   * Per-OS key overrides for bindings whose NATIVE convention diverges from the
   * macOS one — e.g. a new session is `Cmd+N` on macOS but `Ctrl+T` (new-tab
   * convention) on Windows / Linux. When a platform is absent here, `keys` is
   * used. Both the /help dialog and the runtime matcher resolve through this.
   */
  keysByPlatform?: Partial<Record<Platform, string[]>>;
  /** One-line description. */
  label: string;
  group: ShortcutGroup;
  /** Where the binding is actually registered. */
  source: "hook" | "palette";
}

export const KEYBOARD_SHORTCUTS: ShortcutDoc[] = [
  // Navigation
  { id: "switch-agent",     keys: ["Mod", "1–9"], label: "Switch to agent 1–9",                          group: "Navigation", source: "hook" },
  { id: "new-draft",        keys: ["Mod", "N"], keysByPlatform: { windows: ["Mod", "T"], linux: ["Mod", "T"] }, label: "New draft session", group: "Navigation", source: "hook" },
  { id: "close-session",    keys: ["Mod", "W"],   label: "Close session (archive)",                      group: "Navigation", source: "hook" },
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

/**
 * Per-platform display glyph for each modifier/named token. macOS uses the
 * conventional symbol keycaps (⌘⇧⌥⌃↵); Windows and Linux spell the modifiers
 * out (Ctrl / Shift / Alt / Enter), which is the native convention on both.
 * The two differ only on the OS key (Win vs Super) — not used by any current
 * binding, but mapped so a future shortcut renders correctly on each.
 *
 * Any token NOT in the map (letters, digits, `1–9`, "`", ",", ".") is a literal
 * and passes through unchanged.
 */
const KEY_GLYPHS: Record<Platform, Record<string, string>> = {
  mac: {
    Mod: "⌘", Shift: "⇧", Alt: "⌥", Option: "⌥", Ctrl: "⌃", Meta: "⌘",
    Enter: "↵", Return: "↵", Esc: "Esc", Tab: "⇥", Backspace: "⌫", Del: "⌦",
  },
  windows: {
    Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Option: "Alt", Ctrl: "Ctrl", Meta: "Win",
    Enter: "Enter", Return: "Enter", Esc: "Esc", Tab: "Tab", Backspace: "Backspace", Del: "Del",
  },
  linux: {
    Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Option: "Alt", Ctrl: "Ctrl", Meta: "Super",
    Enter: "Enter", Return: "Enter", Esc: "Esc", Tab: "Tab", Backspace: "Backspace", Del: "Del",
  },
};

/** Resolve a single key token to its display glyph for the given platform
 *  (defaults to the host). Literals pass through unchanged. */
export function keyLabel(token: string, platform: Platform = getPlatform()): string {
  return KEY_GLYPHS[platform][token] ?? token;
}

/**
 * Render a token array to a single display string for the platform: adjacent
 * glyphs on macOS (`["Shift","Mod","P"]` → `⇧⌘P`), `+`-joined words elsewhere
 * (`Ctrl+Shift+P`). This is what every shortcut hint in the UI renders from.
 */
export function formatShortcut(keys: string[], platform: Platform = getPlatform()): string {
  const sep = platform === "mac" ? "" : "+";
  return keys.map((k) => keyLabel(k, platform)).join(sep);
}

/** The display key tokens for a doc on a platform, honouring per-OS overrides. */
export function shortcutKeysForDoc(doc: ShortcutDoc, platform: Platform = getPlatform()): string[] {
  return doc.keysByPlatform?.[platform] ?? doc.keys;
}

/**
 * Look up a registered shortcut by id and render its platform-resolved hint
 * (e.g. `shortcutLabel("new-draft")` → `⌘N` on macOS, `Ctrl+T` on Windows).
 * Empty string for an unknown id. Use this for any in-UI hint that must track
 * a binding whose key diverges per-OS — never hardcode the key.
 */
export function shortcutLabel(id: string, platform: Platform = getPlatform()): string {
  const doc = KEYBOARD_SHORTCUTS.find((s) => s.id === id);
  if (!doc) return "";
  return formatShortcut(shortcutKeysForDoc(doc, platform), platform);
}
