/**
 * Unit tests for the shared AccountFooter component.
 *
 * Pins that:
 * - Renders the initials avatar from localStorage["fleet:user"] (or "U" fallback)
 * - Renders the displayName
 * - Renders the theme-toggle (Sun icon, title="Toggle theme")
 * - Clicking the theme toggle calls useThemeStore().toggle
 * - Clicking the row calls onClickAccount when provided
 * - Clicking the row dispatches fleet:open-settings when no onClickAccount
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Stub the theme store — only toggle matters here
vi.mock("@/stores/theme-store", () => ({
  useThemeStore: () => ({
    theme: "dark" as const,
    colorTheme: "zinc" as const,
    setTheme: vi.fn(),
    setColorTheme: vi.fn(),
    toggle: mockToggle,
  }),
}));

const mockToggle = vi.fn();

import { AccountFooter } from "../account-footer";

describe("AccountFooter", () => {
  beforeEach(() => {
    mockToggle.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders "U" initials and "User" name when localStorage is empty', () => {
    render(<AccountFooter />);
    expect(screen.getByText("U")).toBeTruthy();
    expect(screen.getByText("User")).toBeTruthy();
  });

  it("renders initials + name from fleet:user", () => {
    localStorage.setItem("fleet:user", JSON.stringify({ name: "Jane Doe" }));
    render(<AccountFooter />);
    expect(screen.getByText("JD")).toBeTruthy();
    expect(screen.getByText("Jane Doe")).toBeTruthy();
  });

  it("derives displayName from email when name is absent", () => {
    localStorage.setItem("fleet:user", JSON.stringify({ email: "alice@example.com" }));
    render(<AccountFooter />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
  });

  it("renders the theme toggle button", () => {
    render(<AccountFooter />);
    expect(screen.getByTitle("Toggle theme")).toBeTruthy();
  });

  it("clicking theme toggle calls store toggle and does NOT bubble", () => {
    const onClickAccount = vi.fn();
    render(<AccountFooter onClickAccount={onClickAccount} />);
    const toggleBtn = screen.getByTitle("Toggle theme");
    fireEvent.click(toggleBtn);
    expect(mockToggle).toHaveBeenCalledOnce();
    // stopPropagation means the row click handler should NOT fire
    expect(onClickAccount).not.toHaveBeenCalled();
  });

  it("calls onClickAccount when row is clicked", () => {
    const onClickAccount = vi.fn();
    localStorage.setItem("fleet:user", JSON.stringify({ name: "Jane Doe" }));
    render(<AccountFooter onClickAccount={onClickAccount} />);
    // Click the display name text (inside the button)
    fireEvent.click(screen.getByText("Jane Doe"));
    expect(onClickAccount).toHaveBeenCalledOnce();
  });

  it("dispatches fleet:open-settings with Account tab when no onClickAccount", () => {
    localStorage.setItem("fleet:user", JSON.stringify({ name: "Jane Doe" }));
    const dispatched: CustomEvent[] = [];
    const handler = (e: Event) => dispatched.push(e as CustomEvent);
    window.addEventListener("fleet:open-settings", handler);
    render(<AccountFooter />);
    fireEvent.click(screen.getByText("Jane Doe"));
    window.removeEventListener("fleet:open-settings", handler);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].detail).toEqual({ tab: "Account" });
  });
});
