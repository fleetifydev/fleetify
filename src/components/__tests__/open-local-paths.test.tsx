/**
 * Local files and folders the app opens from its own UI go through the
 * local-path bridge (`shell_open_path`), not the link opener, which refuses
 * anything but a web or mail link: Library → "Open raw file" and the "Open
 * in" menu's "Open folder".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RowMenu } from "@/components/library-page";
import { OpenInMenu } from "@/components/layout/open-in-menu";
import type { LibraryItem } from "@/lib/library-api";

const win = window as unknown as { electronAPI?: unknown; fleetify?: unknown };
let openPath: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openPath = vi.fn(() => Promise.resolve({ ok: true }));
  openExternal = vi.fn(() => Promise.resolve({ ok: true }));
  win.electronAPI = {
    openPath,
    openExternal,
    showItemInFolder: vi.fn(() => Promise.resolve(true)),
  };
  win.fleetify = {
    detectEditors: vi.fn(() => Promise.resolve({ editors: [] })),
    openInEditor: vi.fn(() => Promise.resolve({ ok: true })),
  };
});
afterEach(() => {
  delete win.electronAPI;
  delete win.fleetify;
});

const prompt = {
  id: "item-1",
  kind: "prompt",
  name: "Greet",
  slug: "greet",
  providers: [],
  materialized: [],
  created_at: "",
  updated_at: "",
  primary_path: "/home/u/.fleetify/prompts/greet.md",
} as unknown as LibraryItem;

describe("local files and folders open through the local-path bridge", () => {
  it("Library: Open raw file", () => {
    render(<RowMenu item={prompt} onEdit={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Open raw file/ }));
    expect(openPath).toHaveBeenCalledWith("/home/u/.fleetify/prompts/greet.md");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("Open in: Open folder", async () => {
    render(<OpenInMenu projectPath="/home/u/repo" />);
    fireEvent.click(screen.getByRole("button", { name: /Open in/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    expect(openPath).toHaveBeenCalledWith("/home/u/repo");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
