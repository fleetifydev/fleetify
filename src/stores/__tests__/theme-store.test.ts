import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Controllable `matchMedia` stub. `_fire(next)` flips `matches` and notifies
 * the registered "change" listeners — i.e. simulates the user changing their
 * OS appearance while the app is running.
 */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: () => void) => { listeners.delete(cb); },
    _fire(next: boolean) {
      mql.matches = next;
      listeners.forEach((l) => l());
    },
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mql));
  return mql;
}

/** Import a fresh store module against a known OS preference. */
async function loadStore(osDark: boolean) {
  const mql = stubMatchMedia(osDark);
  const mod = await import("../theme-store");
  return { store: mod.useThemeStore, mql };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-color-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme-store", () => {
  it("setMode('light') applies the light palette and removes .dark", async () => {
    const { store } = await loadStore(true);
    store.getState().setMode("light");
    const s = store.getState();
    expect(s.mode).toBe("light");
    expect(s.theme).toBe("light");
    expect(s.colorTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("fleet-theme-mode")).toBe("light");
  });

  it("setMode('dark') applies the zinc palette and adds .dark", async () => {
    const { store } = await loadStore(false);
    store.getState().setMode("dark");
    const s = store.getState();
    expect(s.mode).toBe("dark");
    expect(s.theme).toBe("dark");
    expect(s.colorTheme).toBe("zinc");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("setMode('system') resolves dark when the OS prefers dark", async () => {
    const { store } = await loadStore(true);
    store.getState().setMode("system");
    expect(store.getState().theme).toBe("dark");
    expect(store.getState().colorTheme).toBe("zinc");
  });

  it("setMode('system') resolves light when the OS prefers light", async () => {
    const { store } = await loadStore(false);
    store.getState().setMode("system");
    expect(store.getState().theme).toBe("light");
    expect(store.getState().colorTheme).toBe("light");
  });

  it("cycleMode steps System → Light → Dark → System", async () => {
    const { store } = await loadStore(true);
    store.getState().setMode("system");
    store.getState().cycleMode();
    expect(store.getState().mode).toBe("light");
    store.getState().cycleMode();
    expect(store.getState().mode).toBe("dark");
    store.getState().cycleMode();
    expect(store.getState().mode).toBe("system");
  });

  it("follows live OS changes only while in system mode", async () => {
    const { store, mql } = await loadStore(true);
    store.getState().setMode("system");
    expect(store.getState().theme).toBe("dark");

    mql._fire(false); // OS flips to light
    expect(store.getState().theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // Leaving system mode freezes the theme against OS changes.
    store.getState().setMode("dark");
    mql._fire(false);
    expect(store.getState().theme).toBe("dark");
  });

  it("initialises from a saved mode (overriding the OS)", async () => {
    localStorage.setItem("fleet-theme-mode", "light");
    const { store } = await loadStore(true); // OS dark, but the saved mode wins
    expect(store.getState().mode).toBe("light");
    expect(store.getState().theme).toBe("light");
  });

  it("infers the mode from the legacy fleet-theme key", async () => {
    localStorage.setItem("fleet-theme", "light");
    const { store } = await loadStore(true);
    expect(store.getState().mode).toBe("light");
  });
});
