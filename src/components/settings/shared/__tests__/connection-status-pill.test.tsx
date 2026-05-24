import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionStatusPill } from "../connection-status-pill";

describe("ConnectionStatusPill", () => {
  it("renders default label for 'connected'", () => {
    render(<ConnectionStatusPill status="connected" />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("renders default label 'Not connected' for 'needs_setup'", () => {
    render(<ConnectionStatusPill status="needs_setup" />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("renders default label 'Error' for 'error'", () => {
    render(<ConnectionStatusPill status="error" />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("renders default label 'Testing…' for 'testing'", () => {
    render(<ConnectionStatusPill status="testing" />);
    expect(screen.getByText("Testing…")).toBeInTheDocument();
  });

  it("renders default label 'Activated' for 'activated'", () => {
    render(<ConnectionStatusPill status="activated" />);
    expect(screen.getByText("Activated")).toBeInTheDocument();
  });

  it("renders custom label when provided", () => {
    render(<ConnectionStatusPill status="needs_setup" label="Needs setup" />);
    expect(screen.getByText("Needs setup")).toBeInTheDocument();
  });
});
