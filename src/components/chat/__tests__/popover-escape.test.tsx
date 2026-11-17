import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// The composer (MoreActionsMenu lives inside it) needs these stubbed to mount
// in happy-dom; SessionRulesChip loads its rules when it opens.
vi.mock("@/lib/posthog", () => ({ capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    enhancePrompt: vi.fn(async () => ({ no_op: true, enhanced: "", rationale: null })),
    apiFetch: vi.fn(async () => new Response("[]", { status: 200 })),
    getSessionRules: vi.fn(async () => ""),
  };
});
// The terminal view mounts a live xterm shell per terminal; its picker is
// what's under test.
vi.mock("@/components/workspace/xterm-shell", () => ({ XtermShell: () => null }));

import { usePaneEscapeToStop, ChatContextMenu, ChatDecisionCard, PanelViewMenu, SessionBreadcrumb } from "../chat-view";
import { UnifiedModelPicker } from "../unified-model-picker";
import { ComposerDropMenu } from "../composer-drop-menu";
import { ToolMatrixEditor } from "../tool-matrix-editor";
import { SessionRulesChip } from "../session-rules-chip";
import { SessionToolbar } from "../session-toolbar";
import { ChatInput } from "../chat-input";
import { MessageContent } from "../message-content";
import { PermissionDialog } from "../permission-dialog";
import { PrChecksPopover } from "@/components/git/pr-checks-popover";
import { AuthChoicePopover } from "@/components/git/auth-choice-popover";
import { BranchPickerMenu } from "@/components/git/branch-picker-menu";
import { FileTree, TerminalView } from "@/components/workspace/workspace-panel";
import { BrowserView } from "@/components/workspace/views/browser-view";
import { SessionRow } from "@/components/dashboard/fleet-panel";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, type PermissionRequest } from "@/stores/chat-store";
import { useFleetStore } from "@/stores/fleet-store";
import { selectModeMenuLabel } from "@/lib/element-ref";
import type { PickerGroup } from "@/lib/picker-groups";
import type { ChatMessage } from "@/types/chat";
import type { Session } from "@/types/session";

/** A chat surface with Escape-to-stop registered exactly as ChatView
 *  registers it in the single view (`usePaneEscapeToStop`, no pane index),
 *  marked as ChatView marks it (data-chat-surface), plus a composer to hold
 *  focus. A chat popover renders inside it; a menu from outside the chat
 *  renders beside it (`outside`), as each does in the app. */
function Stream({ streaming, onStop, children }: {
  streaming: boolean;
  onStop: () => void;
  children?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  usePaneEscapeToStop(surface, undefined, streaming, onStop);
  return (
    <div ref={surface} data-chat-surface="">
      <textarea aria-label="composer" />
      {children}
    </div>
  );
}

/** Which Escape listener registers first. The stop listener sits on
 *  `window`; it registers when a stream starts, and a popover registers when
 *  it opens. Both orders happen in the app, and a popover must own its
 *  closing Escape in both. */
type Order = "stream first" | "popover first";
const ORDERS: Order[] = ["stream first", "popover first"];

/** Lets pending promise callbacks (lazy loads, probes) settle inside act. */
const settle = () => act(async () => {});

/** Mounts the popover in a chat, or beside it when it lives `outside` the
 *  chat (the workspace panel, the Fleet panel, the browser view). */
async function mountInStream(order: Order, ui: ReactNode, open?: () => unknown, outside = false) {
  const onStop = vi.fn();
  const chat = (streaming: boolean, content: ReactNode) => outside
    ? <><Stream streaming={streaming} onStop={onStop} />{content}</>
    : <Stream streaming={streaming} onStop={onStop}>{content}</Stream>;
  if (order === "stream first") {
    const view = render(chat(true, null));
    view.rerender(chat(true, ui));
    await open?.();
    await settle();
    return { onStop };
  }
  const view = render(chat(false, ui));
  await open?.();
  await settle();
  view.rerender(chat(true, ui));
  return { onStop };
}

interface PopoverCase {
  name: string;
  /** Stubs the popover needs before it mounts. */
  setup?: () => void;
  /** The popover. `onClose` is wired where the parent owns `open`. */
  ui: (onClose: () => void) => ReactNode;
  /** Opens a popover that opens on a click (or event). Absent: open while
   *  mounted, and closing is the parent's job, so the test checks onClose. */
  open?: () => unknown;
  isOpen?: () => boolean;
  /** Renders beside the chat rather than inside it, as menus outside the
   *  chat surface do in the app. */
  outside?: boolean;
  /** Where focus is when Escape is pressed. Default: the composer, i.e.
   *  outside the popover. That is the hard case: no target check can see the
   *  popover, so only the popover's own handler can claim the key. */
  target?: () => Element;
}

function PermissionMenu({ onClose }: { onClose: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor}>Ask</button>
      <ComposerDropMenu anchorRef={anchor} open onClose={onClose} ariaLabel="Permission mode">
        <button>Bypass permissions</button>
      </ComposerDropMenu>
    </>
  );
}

const PICKER_GROUPS: PickerGroup[] = [{
  id: "claude-code",
  label: "Claude Code",
  models: [{ id: "model-a", label: "Model A", ctx: "200K", effort: { kind: "none" }, supports_effort: false }],
}];

const DISPATCH_RESULT: ChatMessage = {
  id: "m-1",
  role: "system",
  timestamp: "2026-11-17T00:00:00Z",
  content: [{
    type: "dispatch_result",
    agent_id: "agent-x",
    agent_name: "Worker",
    task: "Run the tests",
    success: true,
    summary: "All green.",
  }],
};

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

/** Loads a page, which enables the browser's page controls (Select mode). */
async function openBrowserPage() {
  const url = screen.getByPlaceholderText("Search or enter URL");
  fireEvent.change(url, { target: { value: "example.com" } });
  fireEvent.keyDown(url, { key: "Enter" });
  await settle();
}

const WORKER = { id: "agent-9", title: "Worker", status: "idle", created_at: "2026-11-17T00:00:00Z" } as Session;

const CASES: PopoverCase[] = [
  {
    name: "UnifiedModelPicker",
    ui: (onClose) => (
      <UnifiedModelPicker
        tool="claude-code" model="model-a" effort="high" groups={PICKER_GROUPS}
        onPickModel={vi.fn()} onPickEffort={vi.fn()} onClose={onClose} anchor="bottom"
      />
    ),
  },
  {
    // Shared by the permission, sandbox and fleet-mode composer menus.
    name: "ComposerDropMenu",
    ui: (onClose) => <PermissionMenu onClose={onClose} />,
  },
  {
    name: "ToolMatrixEditor",
    ui: () => (
      <ToolMatrixEditor
        matrix={{ tools: ["bash"], decisions: ["allow", "ask", "deny"], supports_glob: false }}
        overrides={{}} onChange={vi.fn()}
      />
    ),
    open: () => fireEvent.click(screen.getByRole("button", { name: "Tools" })),
    isOpen: () => screen.queryByText("Per-tool permissions") !== null,
  },
  {
    name: "SessionRulesChip",
    ui: () => <SessionRulesChip sessionId="agent-1" />,
    open: () => fireEvent.click(screen.getByTitle("Session rules — instructions for this session only")),
    isOpen: () => screen.queryByText("Session rules") !== null,
  },
  {
    name: "SessionToolbar menu",
    ui: () => (
      <SessionToolbar
        sessionId="agent-1" projectPath={null} tool="claude-code" model={null}
        permissionMode="default" claudeSessionId={null} useWorktree
      />
    ),
    open: () => act(() => {
      window.dispatchEvent(new CustomEvent("fleet:open-source-tab", { detail: { tab: "local" } }));
    }),
    isOpen: () => screen.queryByText("Browse local folder") !== null,
  },
  {
    name: "MoreActionsMenu (composer)",
    ui: () => <ChatInput onSend={vi.fn()} controlCenter sessionId={null} tool={null} model={null} />,
    open: () => fireEvent.click(screen.getByTitle("More actions")),
    isOpen: () => screen.queryByText("Transcript view") !== null,
  },
  {
    name: "PanelViewMenu",
    ui: () => <PanelViewMenu open={false} activeViews={[]} onSelectView={vi.fn()} onRemoveView={vi.fn()} />,
    open: () => fireEvent.click(screen.getByTitle("Open panel section")),
    isOpen: () => screen.queryByRole("menu") !== null,
  },
  {
    name: "ChatContextMenu (transcript)",
    ui: (onClose) => <ChatContextMenu x={10} y={10} text="selected words" onClose={onClose} />,
  },
  {
    // Not a popover, but it closes on Escape the same way: the inline reply
    // box under a dispatched agent's result in the Fleet chat.
    name: "dispatch reply box",
    ui: () => <MessageContent message={DISPATCH_RESULT} />,
    open: () => fireEvent.click(screen.getByTitle("Reply to this agent without leaving Fleetify")),
    isOpen: () => screen.queryByPlaceholderText("Follow-up to Worker…") !== null,
    target: () => screen.getByPlaceholderText("Follow-up to Worker…"),
  },
  {
    // Not a popover either: the chat header's inline title rename.
    name: "session title rename (chat header)",
    ui: () => <SessionBreadcrumb projectPath="/repo" title="Fix the outbox" onRename={vi.fn()} />,
    open: () => fireEvent.click(screen.getByTitle("Rename session")),
    isOpen: () => screen.queryByDisplayValue("Fix the outbox") !== null,
    target: () => screen.getByDisplayValue("Fix the outbox"),
  },
  {
    name: "PrChecksPopover",
    ui: (onClose) => (
      <PrChecksPopover
        runs={[{ name: "build", status: "COMPLETED", conclusion: "FAILURE", bucket: "failing", url: null }]}
        summary={{ passing: 0, failing: 1, pending: 0, total: 1 }}
        onOpenCheck={vi.fn()} onDismiss={onClose}
      />
    ),
  },
  {
    name: "AuthChoicePopover",
    ui: (onClose) => <AuthChoicePopover onChoose={vi.fn()} onDismiss={onClose} />,
  },
  {
    name: "BranchPickerMenu",
    // It lists branches through the shell bridge.
    setup: () => {
      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        listGitBranches: async () => ({ current: "main", local: ["main"], remote: [] }),
        listPRs: async () => ({ ok: true, prs: [] }),
      };
    },
    ui: (onClose) => (
      <BranchPickerMenu
        folder="/repo" mode="working" currentBranch="main" baseBranch="main"
        newBranchTopic="topic" onPick={vi.fn()} onCreateNew={vi.fn()} onDismiss={onClose}
      />
    ),
  },
  // ── Outside the chat surface ──
  {
    // Shelved with the file tree (QuadrantWorkspace is unrouted), but it
    // closes on Escape like the rest.
    name: "File-tree context menu (workspace)",
    outside: true,
    setup: stubFsApi,
    ui: () => <FileTree root="/repo" selectedPath="" onSelect={vi.fn()} />,
    open: async () => { fireEvent.contextMenu(await screen.findByText("a.ts")); },
    isOpen: () => screen.queryByText("Copy Path") !== null,
  },
  {
    name: "Terminal picker (workspace)",
    outside: true,
    ui: () => <TerminalView />,
    open: () => fireEvent.click(screen.getByText("Terminal")),
    isOpen: () => screen.queryByText("Rename terminal") !== null,
  },
  {
    name: "Session row menu (Fleet panel)",
    outside: true,
    ui: () => <SessionRow session={WORKER} detail={undefined} onOpen={vi.fn()} onOpenChat={vi.fn()} />,
    open: () => fireEvent.contextMenu(screen.getByText("Worker")),
    isOpen: () => screen.queryByText("Open chat") !== null,
  },
  {
    name: "History popover (browser)",
    outside: true,
    setup: stubBrowserShell,
    ui: () => <BrowserView />,
    open: () => fireEvent.click(screen.getByTitle("History & bookmarks")),
    isOpen: () => screen.queryByPlaceholderText("Search") !== null,
  },
  {
    name: "Overflow menu (browser)",
    outside: true,
    setup: stubBrowserShell,
    ui: () => <BrowserView />,
    open: () => fireEvent.click(screen.getByTitle("More")),
    isOpen: () => screen.queryByText("Hard Reload") !== null,
  },
  {
    name: "Select-mode popover (browser)",
    outside: true,
    setup: stubBrowserShell,
    ui: () => <BrowserView />,
    open: async () => {
      await openBrowserPage();
      fireEvent.click(screen.getByTitle("Select mode"));
    },
    isOpen: () => screen.queryByText(selectModeMenuLabel("copy:css")) !== null,
  },
  {
    // Not a popover: Escape leaves the browser's full screen the same way.
    name: "Full screen (browser)",
    outside: true,
    setup: stubBrowserShell,
    ui: () => <BrowserView />,
    open: () => act(() => { useAppStore.getState().setRightPanelFullscreen(true); }),
    isOpen: () => useAppStore.getState().rightPanelFullscreen,
  },
];

beforeEach(() => {
  // The single view; the dispatch reply box only shows in the Fleet chat.
  useAppStore.setState({
    splitPaneIds: [], focusedPaneIdx: 0, activeSessionId: null, staffSessionId: "staff-1",
    rightPanelFullscreen: false,
  });
});

afterEach(() => {
  // Unmount while the stubs are still in place: the browser view closes its
  // native webview through Tauri as it unmounts.
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  vi.unstubAllGlobals();
});

describe("An Escape that closes a popover does not stop the chat's stream", () => {
  it("control: with no popover open, Escape stops the stream", async () => {
    // Proves the harness's stop listener is live, so every "not called"
    // below means the popover claimed the key.
    const { onStop } = await mountInStream("stream first", null);
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  describe.each(CASES)("$name", (c) => {
    it.each(ORDERS)("closes it and leaves the stream running (%s)", async (order) => {
      c.setup?.();
      const onClose = vi.fn();
      const { onStop } = await mountInStream(order, c.ui(onClose), c.open, c.outside);
      if (c.isOpen) expect(c.isOpen()).toBe(true);

      fireEvent.keyDown(c.target?.() ?? screen.getByLabelText("composer"), { key: "Escape" });

      if (c.isOpen) expect(c.isOpen()).toBe(false);
      else expect(onClose).toHaveBeenCalledTimes(1);
      expect(onStop).not.toHaveBeenCalled();
    });
  });
});

/** The app shell's global shortcuts, registered as AppShell registers them. */
function Shell({ children }: { children?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useKeyboardShortcuts(root);
  return <div ref={root}>{children}</div>;
}

const QUESTION: PermissionRequest = { id: "req-1", tool_name: "AskUserQuestion", command: "Which database?" };

/** An agent chat with nothing streaming, so Escape on the page goes back to
 *  Fleet, and a pending AskUserQuestion card in it, which Escape skips.
 *  Listeners register in app order: the shell's at mount, the card's when it
 *  arrives, the popover's when it opens. Popovers listen on `document` or in
 *  React, so their handler runs before both of those `window` listeners. A
 *  chat popover renders inside the chat surface, a menu from outside the
 *  chat beside it, so a field in a chat popover counts as inside the chat. */
async function mountInShell(ui: ReactNode, open?: () => unknown, outside = false) {
  const onDeny = vi.fn();
  const view = render(<Shell />);
  view.rerender(
    <Shell>
      <div data-chat-surface="">
        <PermissionDialog request={QUESTION} onAllow={vi.fn()} onAllowAlways={vi.fn()} onDeny={onDeny} />
        {outside ? null : ui}
      </div>
      {outside ? ui : null}
    </Shell>,
  );
  await open?.();
  await settle();
  return { onDeny };
}

describe("An Escape that closes a popover does nothing else", () => {
  beforeEach(() => {
    useAppStore.setState({ activeSessionId: "agent-1" });
    useChatStore.setState({ sessions: {} });
  });

  it("control: with no popover open, Escape goes back to Fleet and skips the pending question", async () => {
    // Proves both window listeners are live, so every "stayed" and "not
    // called" below means the popover claimed the key.
    const { onDeny } = await mountInShell(null);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAppStore.getState().activeSessionId).toBeNull();
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  describe.each(CASES)("$name", (c) => {
    it("closes it, stays in the agent chat and leaves the pending question alone", async () => {
      c.setup?.();
      const onClose = vi.fn();
      const { onDeny } = await mountInShell(c.ui(onClose), c.open, c.outside);
      if (c.isOpen) expect(c.isOpen()).toBe(true);

      // On the page, not in a field: back-to-Fleet leaves fields alone anyway.
      fireEvent.keyDown(c.target?.() ?? document.body, { key: "Escape" });

      if (c.isOpen) expect(c.isOpen()).toBe(false);
      else expect(onClose).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().activeSessionId).toBe("agent-1");
      expect(onDeny).not.toHaveBeenCalled();
    });
  });
});

describe("The transcript menu writes into its own chat's composer", () => {
  it("names its session on the fleet:focus-input it sends", () => {
    // In a split view the menu's pane may not be the focused one yet: the
    // click that picks an item reaches the pane's focus handler only after
    // the item has sent its event.
    const seen: unknown[] = [];
    const onFocusInput = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("fleet:focus-input", onFocusInput);
    try {
      render(<ChatContextMenu x={10} y={10} text="selected words" sessionId="agent-a" onClose={vi.fn()} />);
      fireEvent.click(screen.getByText("Explain this"));
    } finally {
      window.removeEventListener("fleet:focus-input", onFocusInput);
    }
    expect(seen).toEqual([{ text: "Explain the following:\n\n> selected words", sessionId: "agent-a" }]);
  });
});

describe("The decision card writes into its own chat's composer", () => {
  it("names its session on the fleet:focus-input that \"Answer below\" sends", () => {
    // Same reason as the transcript menu: its pane may not be focused yet.
    useFleetStore.getState().setMode("agent-a", "copilot");
    useFleetStore.getState().pushDecision({
      id: "d-1", sessionId: "agent-a", kind: "ask", reasoning: "The schema is undecided.",
      question: "Which database should I use?", createdAt: 0,
    });
    const seen: unknown[] = [];
    const onFocusInput = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("fleet:focus-input", onFocusInput);
    try {
      render(<ChatDecisionCard sessionId="agent-a" onSend={vi.fn()} />);
      fireEvent.click(screen.getByText("Answer below"));
    } finally {
      window.removeEventListener("fleet:focus-input", onFocusInput);
    }
    expect(seen).toEqual([{ text: "Which database should I use?", sessionId: "agent-a" }]);
  });
});
