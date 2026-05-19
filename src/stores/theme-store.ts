import { create } from "zustand";
import { getTheme } from "@/lib/themes";

type Theme = "dark" | "light";
export type ColorTheme =
  | "pure-black" | "zinc" | "obsidian" | "slate" | "warm"
  | "one-dark" | "dracula" | "catppuccin" | "tokyo-night" | "nord"
  | "vesper" | "viper"
  | "light" | "github-light";

interface ThemeState {
  theme: Theme;
  colorTheme: ColorTheme;
  setTheme: (t: Theme) => void;
  setColorTheme: (t: ColorTheme) => void;
  toggle: () => void;
}

function applyColorTheme(ct: ColorTheme) {
  const def = getTheme(ct);
  const root = document.documentElement;

  // Switch dark/light class based on theme type
  root.classList.toggle("dark", def.type === "dark");

  // Set color-theme attribute for CSS selector matching
  root.setAttribute("data-color-theme", ct);
}

export const useThemeStore = create<ThemeState>((set) => {
  const savedTheme = (localStorage.getItem("fleet-theme") as Theme) || "dark";
  const savedColor = (localStorage.getItem("fleet-color-theme") as ColorTheme) || "zinc";

  // Apply on init
  applyColorTheme(savedColor);

  return {
    theme: savedTheme,
    colorTheme: savedColor,

    setTheme: (theme) => {
      localStorage.setItem("fleet-theme", theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
      set({ theme });
    },

    setColorTheme: (colorTheme) => {
      localStorage.setItem("fleet-color-theme", colorTheme);
      applyColorTheme(colorTheme);
      // Sync the theme type (dark/light)
      const def = getTheme(colorTheme);
      const theme = def.type;
      localStorage.setItem("fleet-theme", theme);
      set({ colorTheme, theme });
    },

    toggle: () =>
      set((s) => {
        const next = s.theme === "dark" ? "light" : "dark";
        localStorage.setItem("fleet-theme", next);
        document.documentElement.classList.toggle("dark", next === "dark");
        return { theme: next };
      }),
  };
});
