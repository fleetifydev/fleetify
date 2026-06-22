import { describe, it, expect, vi } from "vitest";

// The hook module imports the ws/api/git singletons at load; stub them so the
// test only exercises the pure binding metadata, no real connections.
vi.mock("@/services/ws-manager", () => ({ wsManager: { abort: vi.fn() } }));
vi.mock("@/lib/api", () => ({ stopSession: vi.fn(), archiveSession: vi.fn() }));
vi.mock("@/lib/git-api", () => ({ git: {} }));

import { SHORTCUT_BINDINGS, HANDLED_SHORTCUT_IDS } from "../use-keyboard-shortcuts";
import { KEYBOARD_SHORTCUTS } from "@/lib/keyboard-shortcuts";

const ev = (init: Partial<KeyboardEvent>) =>
  ({ key: "", metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: () => {}, ...init }) as unknown as KeyboardEvent;

describe("keyboard-shortcuts drift guard", () => {
  it("hook id-set === registry source:'hook' id-set", () => {
    const hookIds = [...HANDLED_SHORTCUT_IDS].sort();
    const docIds = KEYBOARD_SHORTCUTS.filter((s) => s.source === "hook").map((s) => s.id).sort();
    expect(hookIds).toEqual(docIds);
  });
});

describe("SHORTCUT_BINDINGS matchers (behavior preserved)", () => {
  const find = (id: string) => SHORTCUT_BINDINGS.find((b) => b.id === id)!;

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
