import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

// The sidebar polls session stats, and the Fleet panel's memory card loads
// the user's memories, through the API.
vi.mock("@/lib/posthog", () => ({ capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchBulkStats: vi.fn(async () => ({})),
    listUserMemory: vi.fn(async () => [{
      id: "mem-1", user_id: "user-1", kind: "fact", title: "Editor", content: "Uses vim",
      importance: 3, source: "explicit", created_at: "2026-11-17T00:00:00Z", updated_at: null,
    }]),
  };
});
// The terminal view mounts a live xterm shell per terminal; its rename field
// is what's under test.
vi.mock("@/components/workspace/xterm-shell", () => ({ XtermShell: () => null }));

import { usePaneEscapeToStop } from "../chat-view";
import { PermissionDialog } from "../permission-dialog";
import { Sidebar } from "@/components/layout/sidebar";
import { FleetMemoryCard } from "@/components/dashboard/fleet-panel";
import { BrowserView } from "@/components/workspace/views/browser-view";
import { FileTree, TerminalView, buildEditorExtensions } from "@/components/workspace/workspace-panel";
import { useAppStore } from "@/stores/app-store";
import type { PermissionRequest } from "@/stores/chat-store";

/** A streaming chat that registers Escape-to-stop as ChatView does in the
 *  single view, marked as ChatView marks it (data-chat-surface), with its
 *  composer and any pending permission card inside. The field under test
 *  renders beside it, outside the chat surface, as it does in the app. */
function Page({ onStop, card, children }: { onStop: () => void; card?: ReactNode; children?: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  usePaneEscapeToStop(surface, undefined, true, onStop);
  return (
    <>
      <div ref={surface} data-chat-surface="">
        <textarea aria-label="composer" />
        {card}
      </div>
      <div data-testid="outside">{children}</div>
    </>
  );
}

const QUESTION: PermissionRequest = { id: "req-1", tool_name: "AskUserQuestion", command: "Which database?" };

/** Mounts the page with its stream running, then a pending AskUserQuestion
 *  card, in the order they arrive in the app: the stop listener registers
 *  when the stream starts, the card's when the card arrives. */
function renderPage(ui: ReactNode) {
  const onStop = vi.fn();
  const onDeny = vi.fn();
  const page = (withCard: boolean) => (
    <Page
      onStop={onStop}
      card={withCard ? <PermissionDialog request={QUESTION} onAllow={vi.fn()} onAllowAlways={vi.fn()} onDeny={onDeny} /> : null}
    >
      {ui}
    </Page>
  );
  const view = render(page(false));
  view.rerender(page(true));
  return { onStop, onDeny };
}

/** Lets pending promise callbacks (loads, lazy imports) settle inside act. */
const settle = () => act(async () => {});
const outside = () => within(screen.getByTestId("outside"));

/** The file tree reads its folder through the fs API: one file. */
function stubFsApi() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
    String(url).startsWith("/api/fs/dir") ? JSON.stringify([{ name: "a.ts", path: "/repo/a.ts", type: "file" }]) : "{}",
    { status: 200 },
  )));
}

/** The browser view drives a native webview through Tauri and mirrors the
 *  agent's browser over a WebSocket. Stub both, off the network. */
function stubBrowserShell() {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke: vi.fn(async () => ({ ok: true })) },
    event: { listen: vi.fn(async () => () => {}) },
  };
  vi.stubGlobal("WebSocket", class {
    readyState = 3;
    onmessage: unknown = null;
    onclose: unknown = null;
    send() {}
    close() {}
  });
}

/** CodeMirror views built by a test, destroyed after it. */
const editors: Array<{ destroy(): void }> = [];

interface FieldCase {
  name: string;
  setup?: () => void;
  ui: () => ReactNode;
  /** Opens the field where it needs opening, and returns it. */
  field: () => Promise<HTMLElement>;
  /** The field's own Escape action ran: it closed, cancelled or blurred. */
  handled: (field: HTMLElement) => boolean;
}

const FIELDS: FieldCase[] = [
  {
    name: "sidebar search (layout/sidebar.tsx)",
    setup: () => useAppStore.setState({ sidebarSearchOpen: true, sidebarSearchVal: "worker" }),
    ui: () => <Sidebar />,
    field: async () => outside().getByPlaceholderText("Search…"),
    handled: () => !useAppStore.getState().sidebarSearchOpen,
  },
  {
    name: "memory editor (Fleet panel)",
    ui: () => <FleetMemoryCard />,
    field: async () => {
      fireEvent.click(screen.getByText("What Fleet knows about you"));
      fireEvent.click(await screen.findByTitle("Correct this"));
      return screen.getByLabelText("Memory detail");
    },
    handled: () => screen.queryByLabelText("Memory detail") === null,
  },
  {
    name: "address bar (browser view)",
    setup: stubBrowserShell,
    ui: () => <BrowserView />,
    field: async () => {
      const url = screen.getByPlaceholderText("Search or enter URL");
      act(() => url.focus());
      return url;
    },
    handled: (field) => document.activeElement !== field,
  },
  {
    // The file view's editor. Its find panel closes inside its own keydown
    // listener, so the field is already out of the DOM when the stop
    // listener sees the Escape.
    name: "find field (file view, CodeMirror)",
    ui: () => <div data-testid="editor" />,
    field: async () => {
      const { extensions, EditorView, EditorState } = await buildEditorExtensions("default", true, "ts", () => {});
      const view = new EditorView({
        state: EditorState.create({ doc: "const answer = 42;", extensions }),
        parent: screen.getByTestId("editor"),
      });
      editors.push(view);
      const { openSearchPanel } = await import("@codemirror/search");
      openSearchPanel(view);
      return screen.getByPlaceholderText("Find in file...");
    },
    handled: (field) => !field.isConnected,
  },
  {
    // Shelved with the file tree (QuadrantWorkspace is unrouted).
    name: "file filter (workspace file tree)",
    setup: stubFsApi,
    ui: () => <FileTree root="/repo" selectedPath="" onSelect={vi.fn()} />,
    field: async () => {
      fireEvent.click(screen.getByTitle("Search"));
      return outside().getByPlaceholderText("Filter files…");
    },
    handled: () => screen.queryByPlaceholderText("Filter files…") === null,
  },
  {
    name: "rename field (workspace terminal)",
    ui: () => <TerminalView />,
    field: async () => {
      fireEvent.click(screen.getByText("Terminal"));
      fireEvent.click(screen.getByText("Rename terminal"));
      return outside().getByDisplayValue("Terminal 1");
    },
    handled: () => screen.queryByDisplayValue("Terminal 1") === null,
  },
  {
    // Shelved with the file tree, like the filter.
    name: "rename field (workspace file tree)",
    setup: stubFsApi,
    ui: () => <FileTree root="/repo" selectedPath="" onSelect={vi.fn()} />,
    field: async () => {
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      fireEvent.click(screen.getByText("Rename"));
      return outside().getByDisplayValue("a.ts");
    },
    handled: () => screen.queryByDisplayValue("a.ts") === null,
  },
];

beforeEach(() => {
  useAppStore.setState({
    splitPaneIds: [], focusedPaneIdx: 0, sessions: [], activeSessionId: null,
    sidebarSearchOpen: false, sidebarSearchVal: "",
  });
});

afterEach(() => {
  // Unmount while the stubs are still in place: the browser view closes its
  // native webview through Tauri as it unmounts.
  cleanup();
  for (const view of editors.splice(0)) view.destroy();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  vi.unstubAllGlobals();
});

describe("Escape typed in a field outside the chat leaves the chat alone", () => {
  it("control: Escape typed in the composer, inside the chat, still stops it and answers the card", async () => {
    // With the sidebar search open beside it: what counts is where the
    // Escape was typed, not what else is on screen.
    useAppStore.setState({ sidebarSearchOpen: true });
    const { onStop, onDeny } = renderPage(<Sidebar />);
    await settle();
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  describe.each(FIELDS)("$name", (c) => {
    it("the field handles the Escape; the stream keeps running and the card stays pending", async () => {
      c.setup?.();
      const { onStop, onDeny } = renderPage(c.ui());
      await settle();
      const field = await c.field();

      fireEvent.keyDown(field, { key: "Escape" });

      expect(c.handled(field)).toBe(true);
      expect(onStop).not.toHaveBeenCalled();
      expect(onDeny).not.toHaveBeenCalled();
    });
  });
});
