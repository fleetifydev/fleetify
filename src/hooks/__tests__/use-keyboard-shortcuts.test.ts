import { describe, it, expect, vi } from "vitest";

// The hook module imports the ws/api/git singletons at load; stub them so the
// test only exercises the pure binding metadata, no real connections.
vi.mock("@/services/ws-manager", () => ({ wsManager: { abort: vi.fn() } }));
vi.mock("@/lib/api", () => ({ stopSession: vi.fn(), archiveSession: vi.fn() }));
vi.mock("@/lib/git-api", () => ({ git: {} }));

import { SHORTCUT_BINDINGS, HANDLED_SHORTCUT_IDS } from "../use-keyboard-shortcuts";
import { KEYBOARD_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import type { Platform } from "@/lib/utils";

const ev = (init: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: () => {}, ...init }) as unknown as KeyboardEvent;

const find = (id: string) => SHORTCUT_BINDINGS.find((b) => b.id === id)!;

/** Runs a binding's matcher with mod / shift derived the way the hook derives them. */
const hits = (id: string, init: Partial<KeyboardEvent>, platform: Platform = "linux") => {
  const e = ev(init);
  return find(id).matches(e, e.metaKey || e.ctrlKey, e.shiftKey, platform);
};

describe("keyboard-shortcuts drift guard", () => {
  it("hook id-set === registry source:'hook' id-set", () => {
    const hookIds = [...HANDLED_SHORTCUT_IDS].sort();
    const docIds = KEYBOARD_SHORTCUTS.filter((s) => s.source === "hook").map((s) => s.id).sort();
    expect(hookIds).toEqual(docIds);
  });
});

describe("SHORTCUT_BINDINGS matchers (behavior preserved)", () => {
  it("switch-agent matches ⌘1 but not ⌘⇧1", () => {
    expect(find("switch-agent").matches(ev({ key: "1", metaKey: true }), true, false, "mac")).toBe(true);
    expect(find("switch-agent").matches(ev({ key: "1", metaKey: true, shiftKey: true }), true, true, "mac")).toBe(false);
  });

  it("panel-terminal matches Ctrl+` but not ⌘`", () => {
    expect(find("panel-terminal").matches(ev({ key: "`", ctrlKey: true }), true, false, "mac")).toBe(true);
    expect(find("panel-terminal").matches(ev({ key: "`", metaKey: true }), true, false, "mac")).toBe(false);
  });

  it("back-to-fleet matches bare Esc but not ⇧Esc", () => {
    expect(find("back-to-fleet").matches(ev({ key: "Escape" }), false, false, "mac")).toBe(true);
    expect(find("back-to-fleet").matches(ev({ key: "Escape", shiftKey: true }), false, true, "mac")).toBe(false);
  });

  it("new-draft binds Cmd+N on macOS but Ctrl+T on Windows/Linux", () => {
    const b = find("new-draft");
    expect(b.matches(ev({ key: "n", metaKey: true }), true, false, "mac")).toBe(true);
    expect(b.matches(ev({ key: "t", metaKey: true }), true, false, "mac")).toBe(false);
    expect(b.matches(ev({ key: "t", ctrlKey: true }), true, false, "windows")).toBe(true);
    expect(b.matches(ev({ key: "t", ctrlKey: true }), true, false, "linux")).toBe(true);
    expect(b.matches(ev({ key: "n", ctrlKey: true }), true, false, "windows")).toBe(false);
  });

  it("close-session binds Cmd/Ctrl+W on every platform, not with Shift", () => {
    const b = find("close-session");
    expect(b.matches(ev({ key: "w", metaKey: true }), true, false, "mac")).toBe(true);
    expect(b.matches(ev({ key: "w", ctrlKey: true }), true, false, "windows")).toBe(true);
    expect(b.matches(ev({ key: "w", metaKey: true, shiftKey: true }), true, true, "mac")).toBe(false);
  });
});

// With Caps Lock on, Shift types a lowercase letter on Windows and Linux, and
// on macOS Cmd+Shift may leave Shift out of `key` — so Mod+Shift+A can arrive
// as "a". Matching `code` instead would move the shortcut onto another letter
// on non-QWERTY layouts, so the matchers compare `key` case-insensitively.
describe("Mod+Shift letter shortcuts ignore the case of the key", () => {
  it("abort-all matches Mod+Shift+A whether the key arrives as 'a' or 'A'", () => {
    expect(hits("abort-all", { key: "a", metaKey: true, shiftKey: true }, "mac")).toBe(true);
    expect(hits("abort-all", { key: "a", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(hits("abort-all", { key: "A", metaKey: true, shiftKey: true }, "mac")).toBe(true);
    expect(hits("abort-all", { key: "A", ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it("abort-all still needs Shift, so select-all never stops the agents", () => {
    expect(hits("abort-all", { key: "a", metaKey: true }, "mac")).toBe(false);
    expect(hits("abort-all", { key: "a", ctrlKey: true })).toBe(false);
  });

  it("toggle-sidebar matches Mod+Shift+S whether the key arrives as 's' or 'S'", () => {
    expect(hits("toggle-sidebar", { key: "s", metaKey: true, shiftKey: true }, "mac")).toBe(true);
    expect(hits("toggle-sidebar", { key: "s", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(hits("toggle-sidebar", { key: "S", metaKey: true, shiftKey: true }, "mac")).toBe(true);
    expect(hits("toggle-sidebar", { key: "S", ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it("toggle-sidebar still needs Shift, so Mod+S is left alone", () => {
    expect(hits("toggle-sidebar", { key: "s", metaKey: true }, "mac")).toBe(false);
    expect(hits("toggle-sidebar", { key: "s", ctrlKey: true })).toBe(false);
  });
});

// `key` is the character the key types with Shift applied (Ctrl and Meta are
// ignored, Shift is not). So on Windows and Linux, Ctrl+Shift+. reports ">" on
// a US layout and ":" on German, never "." — a plain `key === "."` matcher
// never fires there. Each Ctrl+Shift event below is what the Linux engine
// (WebKitGTK 4.1) reported for a real press on that layout; the macOS one
// follows w3c-keyname's note that Cmd+Shift can leave Shift out of `key`.
describe("toggle-right-panel matches Mod+Shift+.", () => {
  const chord = { ctrlKey: true, shiftKey: true };

  it("matches a US layout, where Shift turns '.' into '>'", () => {
    expect(hits("toggle-right-panel", { ...chord, key: ">", code: "Period" })).toBe(true);
  });

  it("matches macOS, where Cmd+Shift may leave the key as '.'", () => {
    expect(hits("toggle-right-panel", { key: ".", code: "Period", metaKey: true, shiftKey: true }, "mac")).toBe(true);
  });

  it("matches layouts whose Shift+. types ':' through the Period key (German, Turkish F)", () => {
    expect(hits("toggle-right-panel", { ...chord, key: ":", code: "Period" })).toBe(true);
  });

  it("matches French AZERTY, where '.' is Shift+; on the Comma key", () => {
    expect(hits("toggle-right-panel", { ...chord, key: ".", code: "Comma" })).toBe(true);
  });

  it("matches Dvorak, where '.' sits on the E key", () => {
    expect(hits("toggle-right-panel", { ...chord, key: ">", code: "KeyE" })).toBe(true);
  });

  it("leaves alone a letter that sits on the Period key (Dvorak V, Turkish Q Ç, Russian Ю)", () => {
    expect(hits("toggle-right-panel", { ...chord, key: "V", code: "Period" })).toBe(false);
    expect(hits("toggle-right-panel", { ...chord, key: "Ç", code: "Period" })).toBe(false);
    expect(hits("toggle-right-panel", { ...chord, key: "Ю", code: "Period" })).toBe(false);
  });

  it("leaves AZERTY's Ctrl+/ to the Files editor's toggle-comment: '/' is Shift on the Period key there", () => {
    expect(hits("toggle-right-panel", { ...chord, key: "/", code: "Period" })).toBe(false);
  });

  it("matches Turkish Q and Latvian modern, whose '.' key is Slash with ':' on Shift, but not US Ctrl+Shift+;", () => {
    expect(hits("toggle-right-panel", { ...chord, key: ":", code: "Semicolon" })).toBe(false);
    expect(hits("toggle-right-panel", { ...chord, key: ":", code: "Slash" })).toBe(true);
  });

  it("still needs both Mod and Shift", () => {
    expect(hits("toggle-right-panel", { key: ".", code: "Period", ctrlKey: true })).toBe(false);
    expect(hits("toggle-right-panel", { key: ">", code: "Period", shiftKey: true })).toBe(false);
  });
});
