import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

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

import { usePaneEscapeToStop, ChatContextMenu, PanelViewMenu } from "../chat-view";
import { UnifiedModelPicker } from "../unified-model-picker";
import { ComposerDropMenu } from "../composer-drop-menu";
import { ToolMatrixEditor } from "../tool-matrix-editor";
import { SessionRulesChip } from "../session-rules-chip";
import { SessionToolbar } from "../session-toolbar";
import { ChatInput } from "../chat-input";
import { MessageContent } from "../message-content";
import { PrChecksPopover } from "@/components/git/pr-checks-popover";
import { AuthChoicePopover } from "@/components/git/auth-choice-popover";
import { BranchPickerMenu } from "@/components/git/branch-picker-menu";
import { useAppStore } from "@/stores/app-store";
import type { PickerGroup } from "@/lib/picker-groups";
import type { ChatMessage } from "@/types/chat";

/** A chat surface with Escape-to-stop registered exactly as ChatView
 *  registers it in the single view (`usePaneEscapeToStop`, no pane index),
 *  plus a composer to hold focus. The popover under test renders inside it,
 *  as popovers do in the app. */
function Stream({ streaming, onStop, children }: {
  streaming: boolean;
  onStop: () => void;
  children?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  usePaneEscapeToStop(surface, undefined, streaming, onStop);
  return (
    <div ref={surface}>
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

async function mountInStream(order: Order, ui: ReactNode, open?: () => void) {
  const onStop = vi.fn();
  const chat = (streaming: boolean, content: ReactNode) => (
    <Stream streaming={streaming} onStop={onStop}>{content}</Stream>
  );
  if (order === "stream first") {
    const view = render(chat(true, null));
    view.rerender(chat(true, ui));
    open?.();
    await settle();
    return { onStop };
  }
  const view = render(chat(false, ui));
  open?.();
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
  open?: () => void;
  isOpen?: () => boolean;
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
];

beforeEach(() => {
  // The single view; the dispatch reply box only shows in the Fleet chat.
  useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 0, activeSessionId: null, staffSessionId: "staff-1" });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("An Escape that closes a chat popover does not stop the stream", () => {
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
      const { onStop } = await mountInStream(order, c.ui(onClose), c.open);
      if (c.isOpen) expect(c.isOpen()).toBe(true);

      fireEvent.keyDown(c.target?.() ?? screen.getByLabelText("composer"), { key: "Escape" });

      if (c.isOpen) expect(c.isOpen()).toBe(false);
      else expect(onClose).toHaveBeenCalledTimes(1);
      expect(onStop).not.toHaveBeenCalled();
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
