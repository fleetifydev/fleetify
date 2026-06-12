import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UnifiedModelPicker, type Effort } from "../unified-model-picker";
import type { PickerGroup } from "@/lib/picker-groups";

const LEVELS_EFFORT = { kind: "levels" as const, levels: ["low", "medium", "high", "xhigh", "max"], default: "high" };
const NONE_EFFORT = { kind: "none" as const };

const groups: PickerGroup[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    models: [
      { id: "claude-opus-4-7", label: "Opus 4.7", ctx: "200K", effort: LEVELS_EFFORT, supports_effort: true },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", ctx: "200K", effort: LEVELS_EFFORT, supports_effort: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", ctx: "400K", effort: { kind: "levels" as const, levels: ["low", "medium", "high"], default: "medium" }, supports_effort: true },
      { id: "gpt-4.1", label: "GPT-4.1", ctx: "1M", effort: NONE_EFFORT, supports_effort: false },
    ],
  },
  {
    id: "perplexity:claude",
    label: "Claude",
    subtitle: "via Perplexity",
    models: [
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", ctx: "200K", effort: LEVELS_EFFORT, supports_effort: true },
    ],
  },
];

function harness(overrides: Partial<React.ComponentProps<typeof UnifiedModelPicker>> = {}) {
  const onPickModel = vi.fn();
  const onPickEffort = vi.fn();
  const onClose = vi.fn();
  render(
    <UnifiedModelPicker
      tool="claude-code"
      model="claude-opus-4-7"
      effort="high"
      groups={groups}
      onPickModel={onPickModel}
      onPickEffort={onPickEffort}
      onClose={onClose}
      anchor="bottom"
      {...overrides}
    />,
  );
  return { onPickModel, onPickEffort, onClose };
}

describe("UnifiedModelPicker", () => {
  it("renders three columns labeled Providers, Models, Effort", () => {
    harness();
    expect(screen.getByText("Providers")).toBeInTheDocument();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByText("Effort")).toBeInTheDocument();
  });

  it("shows CLI label 'Claude Code' and split brand label 'Claude'", () => {
    harness();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    const claudeRows = screen.getAllByText("Claude");
    expect(claudeRows.length).toBeGreaterThan(0);
    expect(screen.getByText("via Perplexity")).toBeInTheDocument();
  });

  it("hovering a provider row shows its models", () => {
    harness();
    fireEvent.mouseEnter(screen.getByText("OpenAI"));
    expect(screen.getByText("GPT-5.5")).toBeInTheDocument();
    expect(screen.getByText("GPT-4.1")).toBeInTheDocument();
  });

  it("clicking a model fires onPickModel without closing", () => {
    const { onPickModel, onClose } = harness();
    fireEvent.mouseEnter(screen.getByText("OpenAI"));
    fireEvent.click(screen.getByText("GPT-5.5"));
    expect(onPickModel).toHaveBeenCalledWith("openai", "gpt-5.5");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking an effort level fires onPickEffort without closing", () => {
    const { onPickEffort, onClose } = harness();
    fireEvent.click(screen.getByText("Medium"));
    expect(onPickEffort).toHaveBeenCalledWith("medium" as Effort);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders no effort buttons when the active model has effort kind=none", () => {
    const { container } = render(
      <UnifiedModelPicker
        tool="openai"
        model="gpt-4.1"
        effort="high"
        groups={groups}
        onPickModel={vi.fn()}
        onPickEffort={vi.fn()}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    // The effort column is greyed out and has no clickable level buttons.
    const effortCol = container.querySelector<HTMLDivElement>('[title="This model has no reasoning effort control"]');
    expect(effortCol).not.toBeNull();
    const buttons = effortCol?.querySelectorAll("button");
    expect(buttons?.length ?? 0).toBe(0);
  });

  it("clicking outside the picker fires onClose", () => {
    const onClose = vi.fn();
    render(
      <div>
        <span data-testid="outside">outside</span>
        <UnifiedModelPicker
          tool="claude-code"
          model="claude-opus-4-7"
          effort="high"
          groups={groups}
          onPickModel={vi.fn()}
          onPickEffort={vi.fn()}
          onClose={onClose}
          anchor="bottom"
        />
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalled();
  });

  it("pressing Escape fires onClose", () => {
    const { onClose } = harness();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders dividers between CLI / HTTP / Perplexity-Agent sections", () => {
    const { container } = render(
      <UnifiedModelPicker
        tool="claude-code"
        model="claude-opus-4-7"
        effort="high"
        groups={groups}
        onPickModel={vi.fn()}
        onPickEffort={vi.fn()}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    const dividers = container.querySelectorAll('[data-rail-divider="true"]');
    expect(dividers.length).toBe(2);
  });

  it("keeps all CLI agents in one block — no divider splits opencode / github-copilot / agy off", () => {
    // Mirrors buildPickerGroups' output order: every `kind: cli` agent is
    // emitted contiguously, THEN the HTTP rail. The only divider should
    // fall between the CLI block and OpenAI — not between the four classic
    // CLIs and the newer ones (the bug this guards against).
    const cliGroups: PickerGroup[] = [
      { id: "claude-code", label: "Claude Code", models: [{ id: "claude-opus-4-7", label: "Opus 4.7", effort: LEVELS_EFFORT, supports_effort: true }] },
      { id: "codex", label: "Codex CLI", models: [{ id: "gpt-5.5", label: "GPT-5.5", effort: LEVELS_EFFORT, supports_effort: true }] },
      { id: "gemini", label: "Gemini CLI", models: [{ id: "gemini-3.1-pro-preview", label: "3.1 Pro", effort: LEVELS_EFFORT, supports_effort: true }] },
      { id: "kimi", label: "Kimi Code CLI", models: [{ id: "kimi-k2.6", label: "Kimi K2.6", effort: NONE_EFFORT, supports_effort: false }] },
      { id: "opencode", label: "OpenCode", models: [{ id: "oc-1", label: "OC", effort: NONE_EFFORT, supports_effort: false }] },
      { id: "github-copilot", label: "GitHub Copilot CLI", models: [{ id: "gh-1", label: "GH", effort: NONE_EFFORT, supports_effort: false }] },
      { id: "agy", label: "Antigravity CLI", models: [{ id: "agy-default", label: "Auto", effort: NONE_EFFORT, supports_effort: false }] },
      { id: "openai", label: "OpenAI", models: [{ id: "gpt-4.1", label: "GPT-4.1", effort: NONE_EFFORT, supports_effort: false }] },
    ];
    const { container } = render(
      <UnifiedModelPicker
        tool="claude-code"
        model="claude-opus-4-7"
        effort="high"
        groups={cliGroups}
        onPickModel={vi.fn()}
        onPickEffort={vi.fn()}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    // 7 CLI agents + 1 HTTP provider → exactly ONE divider (CLI | HTTP).
    const dividers = container.querySelectorAll('[data-rail-divider="true"]');
    expect(dividers.length).toBe(1);
  });

  it("checkmarks the active model row", () => {
    harness({ tool: "claude-code", model: "claude-opus-4-7" });
    const row = screen.getByRole("option", { name: /Opus 4.7/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("selecting the Auto rail row picks the auto sentinel in one click", () => {
    const autoGroups: PickerGroup[] = [{ id: "auto", label: "Auto", models: [] }, ...groups];
    const { onPickModel } = harness({ groups: autoGroups });
    fireEvent.click(screen.getByText("Auto"));
    expect(onPickModel).toHaveBeenCalledWith("auto", "auto");
  });

  it("renders exactly the model's level buttons for a levels-effort model (opus = 5 buttons incl Max)", () => {
    const opusGroups: PickerGroup[] = [
      {
        id: "claude-code",
        label: "Claude Code",
        models: [
          {
            id: "claude-opus-4-8",
            label: "Opus 4.8",
            ctx: "200K",
            effort: { kind: "levels", levels: ["low", "medium", "high", "xhigh", "max"], default: "high" },
            supports_effort: true,
          },
        ],
      },
    ];
    render(
      <UnifiedModelPicker
        tool="claude-code"
        model="claude-opus-4-8"
        effort="high"
        groups={opusGroups}
        onPickModel={vi.fn()}
        onPickEffort={vi.fn()}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    // Should render Low, Medium, High, Extra high, Max — exactly 5 levels.
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Extra high")).toBeInTheDocument();
    expect(screen.getByText("Max")).toBeInTheDocument();
  });

  it("clicking Extra high calls onPickEffort with 'extra_high'", () => {
    const opusGroups: PickerGroup[] = [
      {
        id: "claude-code",
        label: "Claude Code",
        models: [
          {
            id: "claude-opus-4-8",
            label: "Opus 4.8",
            ctx: "200K",
            effort: { kind: "levels", levels: ["low", "medium", "high", "xhigh", "max"], default: "high" },
            supports_effort: true,
          },
        ],
      },
    ];
    const onPickEffort = vi.fn();
    render(
      <UnifiedModelPicker
        tool="claude-code"
        model="claude-opus-4-8"
        effort="high"
        groups={opusGroups}
        onPickModel={vi.fn()}
        onPickEffort={onPickEffort}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    fireEvent.click(screen.getByText("Extra high"));
    expect(onPickEffort).toHaveBeenCalledWith("extra_high");
  });

  it("renders no effort buttons for a none-effort model", () => {
    const noneGroups: PickerGroup[] = [
      {
        id: "gemini",
        label: "Gemini CLI",
        models: [
          {
            id: "gemini-3.1-flash-lite-preview",
            label: "3.1 Lite",
            ctx: "1M",
            effort: { kind: "none" },
            supports_effort: false,
          },
        ],
      },
    ];
    const { container } = render(
      <UnifiedModelPicker
        tool="gemini"
        model="gemini-3.1-flash-lite-preview"
        effort="medium"
        groups={noneGroups}
        onPickModel={vi.fn()}
        onPickEffort={vi.fn()}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    const effortCol = container.querySelector<HTMLDivElement>('[title="This model has no reasoning effort control"]');
    expect(effortCol).not.toBeNull();
    const buttons = effortCol?.querySelectorAll("button");
    expect(buttons?.length ?? 0).toBe(0);
  });

  it("renders thinking_level effort buttons (low, high) for a gemini thinking model", () => {
    const geminiGroups: PickerGroup[] = [
      {
        id: "gemini",
        label: "Gemini CLI",
        models: [
          {
            id: "gemini-3.1-pro-preview",
            label: "3.1 Pro",
            ctx: "1M",
            effort: { kind: "thinking_level", levels: ["low", "high"], default: "high" },
            supports_effort: true,
          },
        ],
      },
    ];
    render(
      <UnifiedModelPicker
        tool="gemini"
        model="gemini-3.1-pro-preview"
        effort="high"
        groups={geminiGroups}
        onPickModel={vi.fn()}
        onPickEffort={vi.fn()}
        onClose={vi.fn()}
        anchor="bottom"
      />,
    );
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    // xhigh/max/medium must NOT be rendered for this model
    expect(screen.queryByText("Medium")).toBeNull();
    expect(screen.queryByText("Extra high")).toBeNull();
    expect(screen.queryByText("Max")).toBeNull();
  });
});
