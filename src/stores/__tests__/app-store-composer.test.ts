import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useChatStore } from "../chat-store";

const COMPOSER_KEY = "__composer__";
const WELCOME_ID = `welcome-${COMPOSER_KEY}`;
const welcomeText = () => {
  const msgs = useChatStore.getState().sessions[COMPOSER_KEY]?.messages ?? [];
  const w = msgs.find(m => m.id === WELCOME_ID);
  return (w?.content[0] as { text?: string } | undefined)?.text ?? "";
};

// openComposer() schedules a welcome typewriter (setInterval). Fake timers
// keep that off the real event loop so it never ticks during/after the
// test; the `await` on getConfig is a microtask and resolves regardless.
beforeEach(() => {
  vi.useFakeTimers();
  useChatStore.setState({ sessions: {} });
  useAppStore.setState({ composer: { ...useAppStore.getState().composer, open: false, projectPath: "" } });
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("openComposer — default workspace folder seeding", () => {
  it("seeds composer.projectPath from config.defaultFolder", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({ defaultFolder: "/work/default-ws" }) },
    });
    await useAppStore.getState().openComposer();
    const c = useAppStore.getState().composer;
    expect(c.open).toBe(true);
    expect(c.projectPath).toBe("/work/default-ws");
  });

  it("leaves projectPath empty when no default folder is configured", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({}) },
    });
    await useAppStore.getState().openComposer();
    expect(useAppStore.getState().composer.projectPath).toBe("");
  });

  it("re-types the welcome to name the folder when it changes", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({}) }, // start with no default folder
    });
    await useAppStore.getState().openComposer();

    // Change the folder mid-compose (mirrors the toolbar's Pick folder).
    useAppStore.getState().setComposerField({ projectPath: "C:/work/my-project" });
    await vi.advanceTimersByTimeAsync(3000); // let the typewriter finish

    const text = welcomeText();
    expect(text).toContain("I'll take a look at");
    expect(text).toContain("my-project");
    expect(text).not.toContain("Pick a folder above");
  });

  it("reverts the welcome to the pick-a-folder nudge when the folder is cleared", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({ defaultFolder: "C:/work/seed-project" }) },
    });
    await useAppStore.getState().openComposer();

    useAppStore.getState().setComposerField({ projectPath: "" });
    await vi.advanceTimersByTimeAsync(3000);

    expect(welcomeText()).toContain("Pick a folder above");
  });
});
