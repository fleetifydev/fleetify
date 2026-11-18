/**
 * Enter in a marketplace dialog submits its form. The window must stay on
 * the app: each form's submit handler cancels the browser's own submission
 * (the page's Content-Security-Policy also has `form-action 'none'`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { PluginInstall, PluginManifest } from "@/types/plugin";

const store = vi.hoisted(() => ({
  addSource: vi.fn(),
  install: vi.fn(),
  setScope: vi.fn(),
  uninstall: vi.fn(),
  uninstallScope: vi.fn(),
  refreshInstalls: vi.fn(),
}));

vi.mock("@/stores/plugin-store", () => ({
  usePluginStore: (select: (state: typeof store) => unknown) => select(store),
}));
vi.mock("@/lib/plugin-api", () => ({ uninstallScope: vi.fn() }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] }),
}));

import { AddSourceDialog } from "../sources/AddSourceDialog";
import { InstallDialog } from "../install/InstallDialog";
import { UninstallDialog } from "../install/UninstallDialog";

const manifest: PluginManifest = {
  name: "alpha",
  version: "1.0.0",
  description: "",
  providers: [],
  tags: [],
  requires_secrets: [],
  declares: { mcp_servers: 1, templates: 0, workflows: 0, prompts: 0, providers: {} },
};

const installed: PluginInstall = {
  id: "alpha",
  plugin_name: "alpha",
  version: "1.0.0",
  source_id: "s",
  commit_sha: "abc",
  install_path: "/tmp/alpha",
  auto_update: true,
  master_enabled: true,
  installed_at: null,
  last_updated_at: null,
  manifest,
  enablements: [{ scope_type: "user", scope_id: null, enabled: true }],
};

/** Submit the dialog's form as Enter in one of its fields does. */
async function submit(container: HTMLElement): Promise<Event> {
  const form = container.querySelector("form");
  if (!form) throw new Error("the dialog has no form");
  const event = new Event("submit", { bubbles: true, cancelable: true });
  await act(async () => {
    form.dispatchEvent(event);
  });
  return event;
}

describe("marketplace dialog forms", () => {
  beforeEach(() => {
    for (const fn of Object.values(store)) fn.mockReset().mockResolvedValue(undefined);
    store.install.mockResolvedValue({ install_id: "alpha" });
  });

  it("Add marketplace cancels the browser's submission", async () => {
    const { container } = render(<AddSourceDialog onClose={() => {}} />);
    expect((await submit(container)).defaultPrevented).toBe(true);
  });

  it("Install cancels the browser's submission", async () => {
    const { container } = render(
      <InstallDialog
        source_id="s"
        source_name="Src"
        source_is_official={false}
        plugin_path="alpha"
        manifest={manifest}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );
    expect((await submit(container)).defaultPrevented).toBe(true);
  });

  it("Uninstall cancels the browser's submission", async () => {
    const { container } = render(
      <UninstallDialog install={installed} onClose={() => {}} onSuccess={() => {}} />,
    );
    expect((await submit(container)).defaultPrevented).toBe(true);
  });
});
