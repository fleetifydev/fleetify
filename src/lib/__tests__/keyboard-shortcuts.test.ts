import { describe, it, expect } from "vitest";
import {
  KEYBOARD_SHORTCUTS,
  formatShortcut,
  keyLabel,
  shortcutLabel,
  shortcutKeysForDoc,
} from "../keyboard-shortcuts";

describe("formatShortcut", () => {
  it("renders adjacent symbol keycaps on macOS", () => {
    expect(formatShortcut(["Mod", "N"], "mac")).toBe("⌘N");
    expect(formatShortcut(["Shift", "Mod", "P"], "mac")).toBe("⇧⌘P");
    expect(formatShortcut(["Ctrl", "`"], "mac")).toBe("⌃`");
    expect(formatShortcut(["Mod", "Enter"], "mac")).toBe("⌘↵");
  });

  it("plus-joins spelled-out modifiers on Windows and Linux", () => {
    expect(formatShortcut(["Mod", "N"], "windows")).toBe("Ctrl+N");
    expect(formatShortcut(["Shift", "Mod", "P"], "windows")).toBe("Shift+Ctrl+P");
    expect(formatShortcut(["Ctrl", "`"], "linux")).toBe("Ctrl+`");
    expect(formatShortcut(["Mod", "Enter"], "linux")).toBe("Ctrl+Enter");
  });
});

describe("keyLabel", () => {
  it("passes literals (letters, digits, ranges, punctuation) through unchanged", () => {
    expect(keyLabel("Y", "mac")).toBe("Y");
    expect(keyLabel("1–9", "windows")).toBe("1–9");
    expect(keyLabel("`", "linux")).toBe("`");
  });

  it("differentiates all three platforms on the OS / Meta key", () => {
    expect(keyLabel("Meta", "mac")).toBe("⌘");
    expect(keyLabel("Meta", "windows")).toBe("Win");
    expect(keyLabel("Meta", "linux")).toBe("Super");
  });
});

describe("per-platform key overrides", () => {
  it("new session is Cmd+N on macOS but Ctrl+T (new-tab convention) on Windows/Linux", () => {
    expect(shortcutLabel("new-draft", "mac")).toBe("⌘N");
    expect(shortcutLabel("new-draft", "windows")).toBe("Ctrl+T");
    expect(shortcutLabel("new-draft", "linux")).toBe("Ctrl+T");
  });

  it("close session is Cmd+W / Ctrl+W on every platform", () => {
    expect(shortcutLabel("close-session", "mac")).toBe("⌘W");
    expect(shortcutLabel("close-session", "windows")).toBe("Ctrl+W");
    expect(shortcutLabel("close-session", "linux")).toBe("Ctrl+W");
  });

  it("falls back to base keys when a platform has no override", () => {
    const doc = KEYBOARD_SHORTCUTS.find((s) => s.id === "new-draft")!;
    expect(shortcutKeysForDoc(doc, "mac")).toEqual(["Mod", "N"]);
    expect(shortcutKeysForDoc(doc, "windows")).toEqual(["Mod", "T"]);
  });

  it("returns empty string for an unknown id", () => {
    expect(shortcutLabel("does-not-exist", "mac")).toBe("");
  });
});

describe("KEYBOARD_SHORTCUTS", () => {
  it("has unique ids and every entry is grouped + sourced", () => {
    const ids = KEYBOARD_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of KEYBOARD_SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(["hook", "palette"]).toContain(s.source);
    }
  });

  it("documents the command palette as a palette-sourced shortcut", () => {
    const k = KEYBOARD_SHORTCUTS.find((s) => s.id === "command-palette");
    expect(k?.source).toBe("palette");
  });
});
