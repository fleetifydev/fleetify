import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OpenInMenu } from "../open-in-menu";

const detectEditors = vi.fn();
const openInEditor = vi.fn();
const openExternal = vi.fn();

beforeEach(() => {
  detectEditors.mockReset(); openInEditor.mockReset(); openExternal.mockReset();
  detectEditors.mockResolvedValue({ editors: [{ id: "vscode", label: "VS Code" }] });
  openInEditor.mockResolvedValue({ ok: true });
  openExternal.mockResolvedValue({ ok: true });
  (window as unknown as { fleetify: unknown }).fleetify = { detectEditors, openInEditor, openExternal };
});

describe("OpenInMenu", () => {
  it("renders nothing without a project path", () => {
    const { container } = render(<OpenInMenu projectPath={null} />);
    expect(container.firstChild).toBeNull();
    expect(detectEditors).not.toHaveBeenCalled();
  });

  it("launches the chosen editor with the project path", async () => {
    render(<OpenInMenu projectPath="/proj" />);
    await waitFor(() => expect(detectEditors).toHaveBeenCalled());
    fireEvent.click(screen.getByText(/open in/i));      // open the menu
    fireEvent.click(await screen.findByText("VS Code")); // pick the editor
    expect(openInEditor).toHaveBeenCalledWith("vscode", "/proj");
  });

  it("falls back to Open folder when no editors are detected", async () => {
    detectEditors.mockResolvedValue({ editors: [] });
    render(<OpenInMenu projectPath="/proj" />);
    await waitFor(() => expect(detectEditors).toHaveBeenCalled());
    fireEvent.click(screen.getByText(/open in/i));
    fireEvent.click(await screen.findByText(/open folder/i));
    expect(openExternal).toHaveBeenCalledWith("/proj");
  });

  it("shows a detecting state (not the Open folder fallback) while detection is in-flight", async () => {
    // Hold detectEditors open so the component stays in its loading state.
    let resolveDetect!: (v: { editors: { id: string; label: string }[] }) => void;
    detectEditors.mockReturnValue(new Promise((res) => { resolveDetect = res; }));

    render(<OpenInMenu projectPath="/proj" />);
    await waitFor(() => expect(detectEditors).toHaveBeenCalled());
    fireEvent.click(screen.getByText(/open in/i));

    // While in-flight: a muted "Detecting" item, never the Open folder fallback.
    expect(screen.getByText(/detecting/i)).toBeTruthy();
    expect(screen.queryByText(/open folder/i)).toBeNull();
    fireEvent.click(screen.getByText(/detecting/i));
    expect(openExternal).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();

    // Once detection resolves empty, the fallback appears.
    resolveDetect({ editors: [] });
    fireEvent.click(await screen.findByText(/open folder/i));
    expect(openExternal).toHaveBeenCalledWith("/proj");
  });
});
