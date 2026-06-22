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

  it("refreshes the welcome to name the folder INSTANTLY on change — no typewriter replay", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({}) }, // start with no default folder
    });
    await useAppStore.getState().openComposer();

    // Change the folder mid-compose (mirrors the toolbar's Pick folder).
    useAppStore.getState().setComposerField({ projectPath: "C:/work/my-project" });

    // Deliberately do NOT advance timers: the refresh now drops the full
    // text in one shot, so it's already complete. With the old
    // replay-from-zero typewriter the text would still be empty here — this
    // is the regression guard for "don't re-type from scratch every change".
    const text = welcomeText();
    expect(text).toContain("I'll take a look at");
    expect(text).toContain("my-project");
    expect(text).not.toContain("Pick a folder above");
  });

  it("reverts the welcome to the pick-a-folder nudge instantly when the folder is cleared", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({ defaultFolder: "C:/work/seed-project" }) },
    });
    await useAppStore.getState().openComposer();

    useAppStore.getState().setComposerField({ projectPath: "" });
    // Instant — no timer advance needed.
    expect(welcomeText()).toContain("Pick a folder above");
  });
});

describe("openComposer — provider/model default precedence", () => {
  it("prefers the Sessions Default pair over the Fleet default", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getConfig: async () => ({
          defaultProvider: "claude-code",
          defaultModel: "claude-opus-4-8",
          sessionDefaultProvider: "openai",
          sessionDefaultModel: "gpt-5.5",
        }),
      },
    });
    await useAppStore.getState().openComposer();
    const c = useAppStore.getState().composer;
    expect(c.tool).toBe("openai");
    expect(c.modelName).toBe("gpt-5.5");
  });

  it("falls back to the Fleet default when no Sessions Default is set", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getConfig: async () => ({ defaultProvider: "codex-cli", defaultModel: "gpt-5.5" }),
      },
    });
    await useAppStore.getState().openComposer();
    const c = useAppStore.getState().composer;
    expect(c.tool).toBe("codex-cli");
    expect(c.modelName).toBe("gpt-5.5");
  });

  it("uses the hardcoded baseline when neither default is configured", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({}) },
    });
    await useAppStore.getState().openComposer();
    const c = useAppStore.getState().composer;
    expect(c.tool).toBe("claude-code");
    expect(c.modelName).toBe("claude-sonnet-4-6");
  });

  it("seeds composer.effort from the Sessions Default effort when set", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getConfig: async () => ({
          sessionDefaultProvider: "openai",
          sessionDefaultModel: "gpt-5.5",
          sessionDefaultEffort: "low",
        }),
      },
    });
    await useAppStore.getState().openComposer();
    expect(useAppStore.getState().composer.effort).toBe("low");
  });

  it("defaults composer.effort to high when no Sessions Default effort is set", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getConfig: async () => ({
          sessionDefaultProvider: "openai",
          sessionDefaultModel: "gpt-5.5",
        }),
      },
    });
    await useAppStore.getState().openComposer();
    expect(useAppStore.getState().composer.effort).toBe("high");
  });
});
