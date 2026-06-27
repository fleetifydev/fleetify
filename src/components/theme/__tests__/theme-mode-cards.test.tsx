import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeModeCards } from "../theme-mode-cards";
import { useThemeStore } from "@/stores/theme-store";

beforeEach(() => {
  useThemeStore.getState().setMode("dark");
});

describe("ThemeModeCards", () => {
  it("renders System, Dark, and Light cards", () => {
    render(<ThemeModeCards />);
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Dark")).toBeInTheDocument();
    expect(screen.getByText("Light")).toBeInTheDocument();
  });

  it("marks the active mode with aria-pressed", () => {
    useThemeStore.getState().setMode("system");
    render(<ThemeModeCards />);
    expect(screen.getByRole("button", { name: /System/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Dark/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a card switches the mode in the store", () => {
    render(<ThemeModeCards />);
    fireEvent.click(screen.getByText("Light"));
    expect(useThemeStore.getState().mode).toBe("light");
    fireEvent.click(screen.getByText("System"));
    expect(useThemeStore.getState().mode).toBe("system");
  });
});
