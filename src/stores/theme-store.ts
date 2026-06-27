import { create } from "zustand";
import { getTheme } from "@/lib/themes";

/** Effective light/dark actually applied to the DOM. */
type Theme = "dark" | "light";
/**
 * User-facing theme preference. "system" follows the OS appearance live —
 * resolved through `prefers-color-scheme` and kept in sync by the listener
 * installed at the bottom of this module.
 */
export type ThemeMode = "system" | "dark" | "light";
export type ColorTheme =
  | "pure-black" | "zinc" | "obsidian" | "slate" | "warm"
  | "one-dark" | "dracula" | "catppuccin" | "tokyo-night" | "nord"
  | "vesper" | "viper"
  | "light" | "github-light";

interface ThemeState {
  /** User preference: system / dark / light. */
  mode: ThemeMode;
  /** Effective dark|light after resolving "system". */
  theme: Theme;
  /** Color palette applied — drives CSS variables and the code editor. */
  colorTheme: ColorTheme;
  /** Set the preference; resolves + applies the effective theme immediately. */
  setMode: (m: ThemeMode) => void;
  /** Advance the preference: System → Light → Dark → System. */
  cycleMode: () => void;
  setColorTheme: (t: ColorTheme) => void;
}

const STORAGE_MODE = "fleet-theme-mode";
const STORAGE_THEME = "fleet-theme";
const STORAGE_COLOR = "fleet-color-theme";

/** Order the footer + command palette step through on each click. */
const CYCLE: ThemeMode[] = ["system", "light", "dark"];

function applyColorTheme(ct: ColorTheme) {
  const def = getTheme(ct);
  const root = document.documentElement;

  // Switch dark/light class based on theme type
  root.classList.toggle("dark", def.type === "dark");

  // Set color-theme attribute for CSS selector matching
  root.setAttribute("data-color-theme", ct);
}

/** OS dark-mode preference. Defaults to dark when matchMedia is unavailable. */
function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

/** Resolve a mode to the effective light/dark theme. */
function resolveTheme(mode: ThemeMode): Theme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/** Canonical palette for each effective theme — mirrors the onboarding picker. */
function paletteFor(theme: Theme): ColorTheme {
  return theme === "dark" ? "zinc" : "light";
}

/**
 * Persist a mode, resolve the effective theme + palette, push both to the DOM,
 * and return the new slice. Takes no `set`, so init and the OS-change listener
 * can reuse it.
 */
function applyMode(mode: ThemeMode): Pick<ThemeState, "mode" | "theme" | "colorTheme"> {
  const theme = resolveTheme(mode);
  const colorTheme = paletteFor(theme);
  try {
    localStorage.setItem(STORAGE_MODE, mode);
    localStorage.setItem(STORAGE_THEME, theme);
    localStorage.setItem(STORAGE_COLOR, colorTheme);
  } catch {
    /* private mode / quota — the DOM still updates below */
  }
  applyColorTheme(colorTheme);
  return { mode, theme, colorTheme };
}

/** Saved preference → inferred from the legacy `fleet-theme` → default dark. */
function initialMode(): ThemeMode {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_MODE) ?? localStorage.getItem(STORAGE_THEME);
  } catch {
    /* ignore — fall through to the default */
  }
  return saved === "system" || saved === "dark" || saved === "light" ? saved : "dark";
}

export const useThemeStore = create<ThemeState>((set) => {
  // Apply on init (also normalises legacy state into a persisted `mode`).
  const initial = applyMode(initialMode());

  return {
    ...initial,

    setMode: (mode) => set(applyMode(mode)),

    cycleMode: () =>
      set((s) => {
        const i = CYCLE.indexOf(s.mode);
        const next = CYCLE[(i + 1) % CYCLE.length]!;
        return applyMode(next);
      }),

    setColorTheme: (colorTheme) => {
      try {
        localStorage.setItem(STORAGE_COLOR, colorTheme);
      } catch {
        /* ignore */
      }
      applyColorTheme(colorTheme);
      // Sync the effective dark/light type to the palette's own type.
      const theme = getTheme(colorTheme).type;
      try {
        localStorage.setItem(STORAGE_THEME, theme);
      } catch {
        /* ignore */
      }
      set({ colorTheme, theme });
    },
  };
});

// Live-follow the OS appearance while the user is on "system". Attached once,
// at module load. The guard keeps this safe under happy-dom / SSR where the
// MediaQueryList API may be partial or absent.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (useThemeStore.getState().mode === "system") {
      useThemeStore.setState(applyMode("system"));
    }
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
  }
}
