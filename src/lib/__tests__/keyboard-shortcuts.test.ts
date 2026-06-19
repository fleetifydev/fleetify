import { describe, it, expect } from "vitest";
import { KEYBOARD_SHORTCUTS, renderKey } from "../keyboard-shortcuts";

describe("renderKey", () => {
  it("maps Mod/Shift per platform and passes literals through", () => {
    expect(renderKey("Mod", true)).toBe("⌘");
    expect(renderKey("Mod", false)).toBe("Ctrl");
    expect(renderKey("Shift", true)).toBe("⇧");
    expect(renderKey("Shift", false)).toBe("Shift");
    expect(renderKey("Y", true)).toBe("Y");
    expect(renderKey("1–9", false)).toBe("1–9");
    expect(renderKey("`", true)).toBe("`");
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
