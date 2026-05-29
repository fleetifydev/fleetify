/**
 * Regression test for the Windows title-bar "dead buttons" bug.
 *
 * On non-macOS the window is frameless (`decorations(false)`), so the
 * renderer paints its own title bar (`WindowsTitleBar`) and the ONLY
 * working window-drag mechanism is the manual `mousedown` listener that
 * `src-tauri/src/preload.js` installs — `-webkit-app-region: drag/no-drag`
 * (the `.drag-region` / `.no-drag` CSS) is an Electron-only feature that
 * WebView2 ignores.
 *
 * The bug: that listener fired `window_start_dragging` for ANY press
 * inside a `.drag-region` ancestor, including on the title-bar buttons
 * (toggle-sidebar / search / sort / minimize / maximize / close), which
 * are wrapped in `.no-drag` but were never honoured. On Windows
 * `start_dragging()` enters the OS modal move-loop and swallows the
 * `mouseup`/`click`, so every title-bar button looked completely dead.
 *
 * This test loads the REAL injected preload script (no logic
 * duplication → no drift) and asserts that a press inside a `.no-drag`
 * zone does NOT start a drag, while a press on the bare drag surface
 * still does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs from the project root, so resolve the injected preload
// relative to cwd (happy-dom's import.meta.url isn't a file: URL).
const PRELOAD_SRC = readFileSync(
  resolve(process.cwd(), "src-tauri/src/preload.js"),
  "utf8",
);

// Minimal __TAURI__ surface the preload reads. The drag handler re-reads
// `window.__TAURI__.core.invoke` on every mousedown, so a stable spy here
// captures every drag attempt.
const invoke = vi.fn(() => Promise.resolve());
(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke },
  event: { listen: () => Promise.resolve(() => {}) },
};

// Evaluate the script exactly once — a second eval would attach a second
// document-level listener and double-count invoke calls.
new Function(PRELOAD_SRC)();

function pressDown(target: Element, button = 0) {
  target.dispatchEvent(
    new MouseEvent("mousedown", { button, bubbles: true, cancelable: true }),
  );
}

describe("preload window-drag handler", () => {
  beforeEach(() => {
    invoke.mockClear();
    // drag-region bar holding a .no-drag button (with an inner <svg> icon,
    // as lucide renders) plus a bare drag surface in the middle.
    document.body.innerHTML = `
      <div class="drag-region" data-testid="bar">
        <div class="no-drag">
          <button data-testid="btn"><svg data-testid="icon"></svg></button>
        </div>
        <div data-testid="empty" style="flex:1"></div>
      </div>
    `;
  });

  const $ = (id: string) =>
    document.querySelector(`[data-testid="${id}"]`) as Element;

  it("starts a window drag when the bare drag-region surface is pressed", () => {
    pressDown($("empty"));
    expect(invoke).toHaveBeenCalledWith("window_start_dragging");
  });

  it("does NOT start a drag when a .no-drag button is pressed", () => {
    pressDown($("btn"));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does NOT start a drag when an icon inside a .no-drag button is pressed", () => {
    pressDown($("icon"));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores non-left mouse buttons on the drag surface", () => {
    pressDown($("empty"), 2);
    expect(invoke).not.toHaveBeenCalled();
  });
});
