/**
 * Smoke test for LibrarySidebar rendered via SidebarShell.
 *
 * Pins that:
 * - The "Library" caption renders (SidebarShell chrome)
 * - All 8 NAV section rows render with their real labels
 * - The footer "Get Help" and "Give Feedback" rows render
 *
 * We mock the stores the Library page pulls (plugin-store,
 * library-store, app-store, theme-store) to keep the test
 * free from network calls and localStorage side effects.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/stores/app-store", () => ({
  useAppStore: (selector?: (s: unknown) => unknown) => {
    const state = { setMainView: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/stores/theme-store", () => ({
  useThemeStore: () => ({
    theme: "dark" as const,
    colorTheme: "zinc" as const,
    setTheme: vi.fn(),
    setColorTheme: vi.fn(),
    toggle: vi.fn(),
  }),
}));

vi.mock("@/stores/plugin-store", () => ({
  usePluginStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      installs: [],
      loadingInstalls: false,
      refreshInstalls: vi.fn().mockResolvedValue(undefined),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/stores/library-store", () => ({
  useLibraryStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      items: [],
      refresh: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

import { LibrarySidebar } from "../library-page";

describe("LibrarySidebar", () => {
  it("renders the Library caption and all category rows via SidebarShell", () => {
    render(
      <LibrarySidebar
        active="Prompts"
        setActive={vi.fn()}
        onClose={vi.fn()}
        setFeedbackOpen={vi.fn()}
        totals={{
          Prompts: 0, Skills: 0, Subagents: 0, Hooks: 0,
          Rules: 0, Workflows: 0, Templates: 0, MCP: 0,
        }}
      />,
    );

    // Caption rendered by SidebarShell
    expect(screen.getByText("Library")).toBeTruthy();

    // All 8 NAV section rows
    expect(screen.getByText("Prompts")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("Hooks")).toBeTruthy();
    expect(screen.getByText("Rules")).toBeTruthy();
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Templates")).toBeTruthy();
    expect(screen.getByText("MCP")).toBeTruthy();

    // Footer rows
    expect(screen.getByText("Get Help")).toBeTruthy();
    expect(screen.getByText("Give Feedback")).toBeTruthy();
  });
});
