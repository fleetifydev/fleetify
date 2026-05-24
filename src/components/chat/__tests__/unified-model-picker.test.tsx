import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UnifiedModelPicker, type Effort } from "../unified-model-picker";
import type { PickerGroup } from "@/lib/picker-groups";

const groups: PickerGroup[] = [
  {
    id: "claude",
    label: "Claude Code",
    models: [
      { id: "claude-opus-4-7", label: "Opus 4.7", ctx: "200K", supports_effort: true },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", ctx: "200K", supports_effort: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", ctx: "400K", supports_effort: true },
      { id: "gpt-4.1", label: "GPT-4.1", ctx: "1M", supports_effort: false },
    ],
  },
  {
    id: "perplexity:claude",
    label: "Claude",
    subtitle: "via Perplexity",
    models: [
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", ctx: "200K", supports_effort: true },
    ],
  },
];

function harness(overrides: Partial<React.ComponentProps<typeof UnifiedModelPicker>> = {}) {
  const onPickModel = vi.fn();
  const onPickEffort = vi.fn();
  const onClose = vi.fn();
  render(
    <UnifiedModelPicker
      tool="claude"
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

  it("disables every effort level when the active model has supports_effort=false", () => {
    harness({ tool: "openai", model: "gpt-4.1" });
    fireEvent.mouseEnter(screen.getByText("OpenAI"));
    const effortRow = screen.getByText("High").closest("button")!;
    expect(effortRow).toBeDisabled();
  });

  it("clicking outside the picker fires onClose", () => {
    const onClose = vi.fn();
    render(
      <div>
        <span data-testid="outside">outside</span>
        <UnifiedModelPicker
          tool="claude"
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
        tool="claude"
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

  it("checkmarks the active model row", () => {
    harness({ tool: "claude", model: "claude-opus-4-7" });
    const row = screen.getByRole("option", { name: /Opus 4.7/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
});
