/**
 * Regression test for the Diagnostics-section button styling.
 *
 * Previously the "Export logs" button rendered with `primary`, which
 * set `background: var(--c-fg)` + `color: var(--c-bg, #0c0c0c)`. In
 * some dark themes the fallback `#0c0c0c` text reads as near-black on
 * a near-black `--c-fg`, making the button label nearly invisible. We
 * dropped the `primary` variant entirely so all three Diagnostics
 * buttons share the proven ghost style.
 *
 * This test pins that fix: none of the Diagnostics buttons should
 * carry the `var(--c-fg)` background that the primary variant used.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub out the two zustand stores SettingsPage pulls. The Diagnostics
// path itself doesn't touch either, but the surrounding shell does
// (SettingsAccountFooter → useThemeStore; AccountSection elsewhere →
// useAppStore). Keeping the mocks minimal avoids dragging the real
// store init (which writes to localStorage + DOM classes) into every
// test run.
vi.mock("@/stores/app-store", () => ({
  useAppStore: (selector?: (s: unknown) => unknown) => {
    const state = { setMainView: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/stores/theme-store", () => ({
  useThemeStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      mode: "dark" as const,
      theme: "dark" as const,
      colorTheme: "zinc" as const,
      setMode: vi.fn(),
      cycleMode: vi.fn(),
      setColorTheme: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

import { SettingsPage } from "../settings-page";

describe("Diagnostics section buttons", () => {
  it("renders all three buttons with the ghost (non-primary) style", () => {
    render(<SettingsPage initialTab="Diagnostics" onClose={() => {}} />);

    const exportBtn = screen.getByRole("button", { name: /Export logs/i });
    const openBtn   = screen.getByRole("button", { name: /Open log folder/i });
    const copyBtn   = screen.getByRole("button", { name: /Copy diagnostic info/i });

    for (const btn of [exportBtn, openBtn, copyBtn]) {
      // Primary variant used `background: var(--c-fg)` + dark text
      // (`var(--c-bg, #0c0c0c)`). Asserting the background is NOT
      // `var(--c-fg)` is the cheapest signal that the primary branch
      // is gone — the ghost-style `rgba(var(--fg-rgb), 0.04)` token is
      // dropped by happy-dom's CSSOM (custom-property fallback isn't
      // recognised as a colour), so we can't assert on the new value
      // directly. We also check the text colour: the primary variant
      // set `color: var(--c-bg, #0c0c0c)`; the ghost style uses
      // `var(--c-high)`.
      expect(btn.style.background).not.toBe("var(--c-fg)");
      expect(btn.style.color).toBe("var(--c-high)");
    }
  });
});
