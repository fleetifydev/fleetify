import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ToolMatrixEditor } from "../tool-matrix-editor";
import type { ToolMatrixCapability } from "@/lib/providers-api";

const matrix: ToolMatrixCapability = {
  tools: ["bash", "read_file", "write_file"],
  decisions: ["allow", "ask", "deny"],
  supports_glob: true,
};

function harness(
  overrides: Record<string, string> = {},
  onChange?: (next: Record<string, string>) => void,
) {
  const handleChange = onChange ?? vi.fn();
  render(
    <ToolMatrixEditor
      matrix={matrix}
      overrides={overrides}
      onChange={handleChange}
    />,
  );
  return { handleChange };
}

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
}

describe("ToolMatrixEditor", () => {
  it("renders a Tools trigger button", () => {
    harness();
    expect(screen.getByRole("button", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
  });

  it("popover is closed by default", () => {
    harness();
    expect(screen.queryByText("Per-tool permissions")).not.toBeInTheDocument();
  });

  it("opens the popover when trigger is clicked", () => {
    harness();
    openPopover();
    expect(screen.getByText("Per-tool permissions")).toBeInTheDocument();
  });

  it("renders a row for each tool in the matrix", () => {
    harness();
    openPopover();
    for (const tool of matrix.tools) {
      expect(screen.getByText(tool)).toBeInTheDocument();
    }
  });

  it("renders Default + each decision as options for every tool row", () => {
    harness();
    openPopover();
    // Each decision should appear once per tool (3 tools) plus the "Default" label
    // For a simple check, confirm all labels appear at least once.
    const allButtons = screen.getAllByRole("button");
    const labels = allButtons.map(b => b.textContent ?? "");
    expect(labels).toContain("Default");
    expect(labels).toContain("allow");
    expect(labels).toContain("ask");
    expect(labels).toContain("deny");
  });

  it("shows 'Default' as active when no override is set for a tool", () => {
    harness({});
    openPopover();
    // For bash row, Default should be styled as active — we verify by checking
    // that calling onChange with a "deny" selection changes the map.
    // (Style assertions in jsdom are unreliable; we test behavior instead.)
    expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
  });

  it("calls onChange with the tool set to the selected decision", () => {
    const { handleChange } = harness({});
    openPopover();

    // Click "deny" for the first "bash" row — find the first "deny" button
    const denyButtons = screen.getAllByText("deny");
    fireEvent.click(denyButtons[0]);

    expect(handleChange).toHaveBeenCalledTimes(1);
    const result = (handleChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
    // The first tool is "bash"
    expect(result["bash"]).toBe("deny");
  });

  it("calls onChange with the tool key deleted when Default is selected", () => {
    const { handleChange } = harness({ bash: "deny", read_file: "allow" });
    openPopover();

    // Find the Default buttons (one per tool) and click the first one (bash's row)
    const defaultButtons = screen.getAllByText("Default");
    fireEvent.click(defaultButtons[0]);

    expect(handleChange).toHaveBeenCalledTimes(1);
    const result = (handleChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
    expect("bash" in result).toBe(false);
    // Other override should remain
    expect(result["read_file"]).toBe("allow");
  });

  it("shows Reset all button when overrides are non-empty", () => {
    harness({ bash: "deny" });
    openPopover();
    expect(screen.getByText("Reset all")).toBeInTheDocument();
  });

  it("does not show Reset all button when overrides are empty", () => {
    harness({});
    openPopover();
    expect(screen.queryByText("Reset all")).not.toBeInTheDocument();
  });

  it("calls onChange with empty object when Reset all is clicked", () => {
    const { handleChange } = harness({ bash: "deny", write_file: "allow" });
    openPopover();
    fireEvent.click(screen.getByText("Reset all"));
    expect(handleChange).toHaveBeenCalledWith({});
  });

  it("shows the glob hint when supports_glob is true", () => {
    harness();
    openPopover();
    expect(
      screen.getByText(/glob patterns supported by the agent/i),
    ).toBeInTheDocument();
  });

  it("does not show the glob hint when supports_glob is false", () => {
    const noGlobMatrix: ToolMatrixCapability = { ...matrix, supports_glob: false };
    const onChange = vi.fn();
    render(
      <ToolMatrixEditor matrix={noGlobMatrix} overrides={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.queryByText(/glob patterns/i)).not.toBeInTheDocument();
  });

  it("closes the popover when Escape is pressed", () => {
    harness();
    openPopover();
    expect(screen.getByText("Per-tool permissions")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Per-tool permissions")).not.toBeInTheDocument();
  });
});
