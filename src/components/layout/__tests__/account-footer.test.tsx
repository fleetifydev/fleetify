/**
 * Unit tests for the shared AccountFooter component.
 *
 * Pins that:
 * - Renders the initials avatar from localStorage["fleet:user"] (or "U" fallback)
 * - Renders the displayName
 * - Renders the theme toggle reflecting the current mode (Sun/Moon/Monitor)
 * - Clicking the theme toggle cycles System → Light → Dark without bubbling
 *   to the row's onClickAccount
 * - Clicking the row calls onClickAccount when provided
 * - Clicking the row dispatches fleet:open-settings when no onClickAccount
 *
 * Uses the real theme store (reactive, happy-dom-safe) rather than a mock so
 * the cycle assertions exercise the actual contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountFooter } from "../account-footer";
import { useThemeStore } from "@/stores/theme-store";

describe("AccountFooter", () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.getState().setMode("dark");
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

  it("renders the theme toggle reflecting the current mode", () => {
    useThemeStore.getState().setMode("system");
    render(<AccountFooter />);
    expect(screen.getByLabelText(/^Theme:/).getAttribute("aria-label")).toContain("System");
  });

  it("clicking the theme toggle cycles System → Light → Dark and does NOT bubble", () => {
    useThemeStore.getState().setMode("system");
    const onClickAccount = vi.fn();
    render(<AccountFooter onClickAccount={onClickAccount} />);

    // Re-query each click: the accessible label tracks the mode.
    fireEvent.click(screen.getByLabelText(/^Theme:/));
    expect(useThemeStore.getState().mode).toBe("light");
    // stopPropagation means the row handler must NOT fire.
    expect(onClickAccount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(/^Theme:/));
    expect(useThemeStore.getState().mode).toBe("dark");

    fireEvent.click(screen.getByLabelText(/^Theme:/));
    expect(useThemeStore.getState().mode).toBe("system");
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
