import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SandboxControl } from "../sandbox-control";

describe("SandboxControl — toggle variant", () => {
  const toggleOptions = ["off", "on"];

  it("renders a toggle button showing Off when value is null", () => {
    render(
      <SandboxControl
        options={toggleOptions}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Sandbox: Off");
  });

  it("renders a toggle button showing On when value is 'on'", () => {
    render(
      <SandboxControl
        options={toggleOptions}
        value="on"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Sandbox: On");
  });

  it("calls onChange with 'on' when toggled from Off", () => {
    const onChange = vi.fn();
    render(
      <SandboxControl
        options={toggleOptions}
        value="off"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith("on");
  });

  it("calls onChange with 'off' when toggled from On", () => {
    const onChange = vi.fn();
    render(
      <SandboxControl
        options={toggleOptions}
        value="on"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith("off");
  });
});

describe("SandboxControl — select variant (3 options)", () => {
  const selectOptions = ["read-only", "workspace-write", "danger-full-access"];

  it("renders a trigger button showing the friendly label of the active option", () => {
    render(
      <SandboxControl
        options={selectOptions}
        value="workspace-write"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Sandbox: Workspace write");
  });

  it("falls back to options[0] when value is null", () => {
    render(
      <SandboxControl
        options={selectOptions}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Sandbox: Read-only");
  });

  it("opens the popover and renders all options on click", () => {
    render(
      <SandboxControl
        options={selectOptions}
        value="read-only"
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sandbox/i }));
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("Workspace write")).toBeInTheDocument();
    expect(screen.getByText("Full access")).toBeInTheDocument();
  });

  it("calls onChange with the selected option value", () => {
    const onChange = vi.fn();
    render(
      <SandboxControl
        options={selectOptions}
        value="read-only"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sandbox/i }));
    fireEvent.click(screen.getByText("Full access"));
    expect(onChange).toHaveBeenCalledWith("danger-full-access");
  });
});
