/**
 * The screens before the main shell (splash, sign-in, setup, the onboarding
 * chat) fill a window with no title bar to grab, so their background is the
 * only place to move the window from. The window drags only where the
 * preload's mousedown handler (`src-tauri/src/preload.js`) sees a
 * `.drag-region` that no `.no-drag` sits under; these screens used the
 * Electron build's `app-drag` / `app-no-drag` classes, which nothing reads,
 * so the window couldn't be moved at all.
 *
 * This loads the real preload, as `src/__tests__/preload-window-drag.test.ts`
 * does, and presses the rendered screens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { SplashScreen } from "@/components/onboarding/splash-screen";
import { WelcomeScreen } from "@/components/onboarding/welcome-screen";

const PRELOAD_SRC = readFileSync(resolve(process.cwd(), "src-tauri/src/preload.js"), "utf8");

const invoke = vi.fn(() => Promise.resolve());
(window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke },
  event: { listen: () => Promise.resolve(() => {}) },
};
// Once: a second run would add a second document-level listener.
new Function(PRELOAD_SRC)();

function pressDown(target: Element) {
  target.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
}

const dragCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "window_start_dragging");

beforeEach(() => invoke.mockClear());
afterEach(cleanup);

describe("moving the window from the screens before the main shell", () => {
  it("drags the window from the splash screen's background", () => {
    const { container } = render(<SplashScreen onDone={vi.fn()} />);
    pressDown(container.firstElementChild as Element);
    expect(dragCalls()).toHaveLength(1);
  });

  it("drags the window from the sign-in screen's background", () => {
    const { container } = render(<WelcomeScreen onAuth={vi.fn()} />);
    pressDown(container.firstElementChild as Element);
    expect(dragCalls()).toHaveLength(1);
  });

  it("leaves the sign-in button and the legal links clickable", () => {
    render(<WelcomeScreen onAuth={vi.fn()} />);
    pressDown(screen.getByRole("button", { name: /sign in/i }));
    pressDown(screen.getByRole("link", { name: "Terms of Service" }));
    pressDown(screen.getByRole("link", { name: "Privacy Policy" }));
    expect(dragCalls()).toHaveLength(0);
  });
});

describe("drag classes in the renderer", () => {
  // The preload knows `drag-region` and `no-drag` only (see globals.css).
  it("uses no class the preload doesn't read", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__") walk(path);
        } else if (/\.(tsx?|css)$/.test(name) && /\bapp-(no-)?drag\b/.test(readFileSync(path, "utf8"))) {
          offenders.push(path);
        }
      }
    };
    walk(resolve(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
