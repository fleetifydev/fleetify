import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useChatStore } from "../chat-store";
import { useDiscoveredModelsStore } from "../discovered-models-store";
import { providers } from "@/lib/providers-api";
import type { ProviderTile } from "@/lib/providers-api";

const COMPOSER_KEY = "__composer__";
const WELCOME_ID = `welcome-${COMPOSER_KEY}`;
const welcomeText = () => {
  const msgs = useChatStore.getState().sessions[COMPOSER_KEY]?.messages ?? [];
  const w = msgs.find(m => m.id === WELCOME_ID);
  return (w?.content[0] as { text?: string } | undefined)?.text ?? "";
};

// Minimal `ProviderTile` factory (mirrors src/lib/__tests__/picker-groups.test.ts).
// CLI tiles default to disconnected; pass `{ connected: true }` to surface them
// in the composer's coherence guard. API/local_http tiles default to connected.
const baseTile = (
  id: string,
  display_name: string,
  kind: "cli" | "api" | "local_http",
  modelIds: string[] = [],
  opts: Partial<ProviderTile> = {},
): ProviderTile => ({
  spec: {
    id,
    display_name,
    kind,
    default_base_url: "",
    auth: { kind: "none" },
    default_models: modelIds.map((mid) => ({ id: mid, label: mid, supports_effort: false })),
    extras: {},
    bin: "",
    auth_indicators: [],
    install_hint: "",
    login_hint: "",
  },
  connected: kind !== "cli",
  has_key: kind !== "cli",
  enabled_models: [],
  is_default: false,
  capabilities: {
    permission: { kind: "none" },
    tool_matrix: null,
    timing: { permission: "spawn", effort: "spawn" },
    model_efforts: [],
  },
  ...opts,
});

// Drive openComposer's coherence guard deterministically: it calls
// providers.listCatalog() to learn which tiles are connected. Stub it per-test
// instead of leaning on the no-op "electron unavailable" fallback (empty tiles),
// which left the guard a no-op and made the suite's model assertions vacuous.
const mockCatalog = (tiles: ProviderTile[]) => {
  vi.spyOn(providers, "listCatalog").mockResolvedValue({ ok: true, tiles });
};

// openComposer() schedules a welcome typewriter (setInterval). Fake timers
// keep that off the real event loop so it never ticks during/after the
// test; the `await` on getConfig is a microtask and resolves regardless.
beforeEach(() => {
  vi.useFakeTimers();
  useChatStore.setState({ sessions: {} });
  useDiscoveredModelsStore.setState({ models: {} });
  useAppStore.setState({ composer: { ...useAppStore.getState().composer, open: false, projectPath: "" } });
  // Default: no connected tiles (the folder-seeding tests don't care which
  // provider resolves; this keeps the guard a deterministic no-op for them).
  mockCatalog([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useDiscoveredModelsStore.setState({ models: {} });
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

  it("shows the welcome instantly on a re-open — the typewriter doesn't replay on every New session", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getConfig: async () => ({ defaultFolder: "C:/work/proj" }) },
    });
    // First open may animate (module-scoped once-per-run flag); close it…
    await useAppStore.getState().openComposer();
    useAppStore.getState().closeComposer();
    // …then re-open. This time the welcome must be set in one shot: the full
    // text is present WITHOUT advancing the fake timers. Under the old
    // always-animate behaviour it would still be empty here (regression guard
    // for "don't re-type the welcome from scratch on every New session press").
    await useAppStore.getState().openComposer();
    expect(welcomeText()).toContain("proj");
    expect(welcomeText()).toContain("I'll take a look at");
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
    // openai (HTTP) carries gpt-5.5 in its catalog, so the picker group
    // contains it and resolveSessionModel returns "ok" (no heal): the chosen
    // pair is honored verbatim.
    mockCatalog([
      baseTile("openai", "OpenAI", "api", ["gpt-5.4", "gpt-5.5"]),
      baseTile("claude-code", "Claude Code", "cli", [], { connected: true }),
    ]);
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
    // codex-cli is a CLI agent; its CLI_MODELS fallback list contains gpt-5.5,
    // so the chosen model validates against the group (resolveSessionModel = ok).
    mockCatalog([baseTile("codex-cli", "Codex CLI", "cli", [], { connected: true })]);
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

  it("heals to claude-code's flagged default (claude-opus-4-8) when the Fleet provider has no/stale model", async () => {
    // Was "uses the hardcoded baseline …": openComposer never swaps the "auto"
    // pseudo-provider for a concrete tile, so the previous "empty config ⇒
    // claude-code" assertion could never hold (and was already RED). This
    // instead exercises C5's real contract: a configured Fleet provider whose
    // model is unset/stale heals to the provider's FLAGGED default — for
    // claude-code that's claude-opus-4-8 via the CLI_MODELS `default` flag
    // (not the first model, claude-fable-5).
    useDiscoveredModelsStore.setState({
      models: {
        "claude-code": [
          { id: "claude-sonnet-4-6", label: "Sonnet 4.6", effort: { kind: "none" }, supports_effort: false },
          { id: "claude-opus-4-8", label: "Opus 4.8", effort: { kind: "none" }, supports_effort: false, default: true },
        ],
      },
    });
    mockCatalog([baseTile("claude-code", "Claude Code", "cli", [], { connected: true })]);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      // Fleet default provider set, model omitted → starts as "auto" → heals.
      value: { getConfig: async () => ({ defaultProvider: "claude-code" }) },
    });
    await useAppStore.getState().openComposer();
    const c = useAppStore.getState().composer;
    expect(c.tool).toBe("claude-code");
    expect(c.modelName).toBe("claude-opus-4-8");
  });

  it("seeds composer.effort from the Sessions Default effort when set", async () => {
    mockCatalog([baseTile("openai", "OpenAI", "api", ["gpt-5.5"])]);
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
    mockCatalog([baseTile("openai", "OpenAI", "api", ["gpt-5.5"])]);
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
