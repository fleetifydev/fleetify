import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const addSession = vi.fn();
const setActiveSession = vi.fn();
const setPendingGeneration = vi.fn();
vi.mock("@/stores/app-store", () => ({
  useAppStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ addSession, setActiveSession, setPendingGeneration, sidebarCollapsed: false, toggleSidebar: () => {} }),
}));
vi.mock("@/lib/studio-api", () => ({
  studioApi: { listModels: vi.fn(), generate: vi.fn(), getModel: vi.fn(), cost: vi.fn(), listMessages: vi.fn(), getTools: vi.fn(), getAccount: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ createSession: vi.fn() }));

import { StudioComposer } from "../StudioComposer";
import { studioApi } from "@/lib/studio-api";
import { createSession } from "@/lib/api";
const m = studioApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockCreate = createSession as unknown as ReturnType<typeof vi.fn>;
// The folder dialog is owned by the window shell (electronAPI), not the api.
const openFolderDialog = vi.fn();

beforeEach(() => {
  addSession.mockReset();
  setActiveSession.mockReset();
  setPendingGeneration.mockReset();
  Object.values(m).forEach(f => f.mockReset());
  mockCreate.mockReset();
  openFolderDialog.mockReset();
  m.listModels.mockResolvedValue([{ display_name: "Nano Banana Pro", job_set_type: "nano_banana_2", type: "image" }]);
  m.getTools.mockResolvedValue([{ id: "higgsfield", display_name: "Higgsfield", install_hint: "npm i -g @higgsfield/cli", installed: true, authenticated: true }]);
  mockCreate.mockResolvedValue({ id: "sess-1", title: "a cat", tool: "higgsfield" });
  openFolderDialog.mockResolvedValue("/home/u/art");
  (window as unknown as { electronAPI?: unknown }).electronAPI = { openFolderDialog };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("StudioComposer", () => {
  it("requires a folder, then creates the session, hands off the first generation, and activates it", async () => {
    render(<StudioComposer />);
    expect(await screen.findByText("Nano Banana Pro")).toBeTruthy();
    // No session created just by opening the composer.
    expect(mockCreate).not.toHaveBeenCalled();

    // Folder is mandatory — the picker drives it via the native dialog.
    fireEvent.click(screen.getByText("Pick folder"));
    await waitFor(() => expect(screen.getByText("art")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("Describe what you want to create…"), { target: { value: "a cat" } });
    fireEvent.click(screen.getByText("Generate"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ tool: "higgsfield", model_name: "nano_banana_2", project_path: "/home/u/art" });
    // The prompt never becomes the session title: titles reach the dashboard
    // when dashboard sync is on.
    expect(mockCreate.mock.calls[0][0].title).toBe("Generation");
    // The composer hands the first generation to the session view instead of
    // calling generate itself, then activates the new session.
    await waitFor(() => expect(setPendingGeneration).toHaveBeenCalled());
    expect(setPendingGeneration.mock.calls[0][0]).toMatchObject({ sessionId: "sess-1", model: "nano_banana_2", prompt: "a cat" });
    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith("sess-1"));
    expect(m.generate).not.toHaveBeenCalled();
    expect(addSession).toHaveBeenCalled();
  });

  it("keeps Generate disabled until a folder is picked", async () => {
    render(<StudioComposer />);
    expect(await screen.findByText("Nano Banana Pro")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Describe what you want to create…"), { target: { value: "a cat" } });
    // No folder yet → Generate is a no-op.
    fireEvent.click(screen.getByText("Generate"));
    await Promise.resolve();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
