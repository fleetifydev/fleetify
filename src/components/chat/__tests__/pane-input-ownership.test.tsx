import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

// The composer needs these stubbed to mount in happy-dom.
vi.mock("@/lib/posthog", () => ({ capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    enhancePrompt: vi.fn(async () => ({ no_op: true, enhanced: "", rationale: null })),
    apiFetch: vi.fn(async () => new Response("[]", { status: 200 })),
  };
});
// Each pane of the real grid renders a real composer, as ChatView does (the
// whole ChatView is too heavy to mount here). The grid's pane wrapper is what
// moves focusedPaneIdx when focus lands inside a pane.
vi.mock("../chat-view", async () => {
  const { ChatInput } = await import("../chat-input");
  return {
    ChatView: ({ paneSessionId, paneIdx }: { paneSessionId?: string | null; paneIdx?: number }) => (
      <ChatInput onSend={() => {}} sessionId={paneSessionId} paneIdx={paneIdx} placeholder={`composer ${paneIdx}`} />
    ),
  };
});
vi.mock("@/components/workspace/workspace-panel", () => ({ WorkspacePanel: () => null }));

import { ChatInput } from "../chat-input";
import { PermissionDialog } from "../permission-dialog";
import { SplitPaneGrid } from "../split-pane-grid";
import { useAppStore } from "@/stores/app-store";
import type { PermissionRequest } from "@/stores/chat-store";

const PANES = ["agent-a", "agent-b"];

/** A two-pane split view with pane `focused` focused. `activeSessionId`
 *  defaults to the focused pane's session, but it can drift: adding a third
 *  pane, or removing or moving one, leaves it pointing elsewhere. */
function splitView(focused: number, activeSessionId: string | null = PANES[focused]!) {
  useAppStore.setState({ splitPaneIds: PANES, focusedPaneIdx: focused, activeSessionId });
}

// activeSessionId values to test against focusedPaneIdx = 1. Only the last
// agrees with it.
const ACTIVE_SESSIONS: Array<[string, string | null]> = [
  ["still pane 0's session", "agent-a"],
  ["a session in no pane", "agent-z"],
  ["unset", null],
  ["pane 1's session", "agent-b"],
];

const bash = (id: string): PermissionRequest => ({ id, tool_name: "Bash", command: "ls" });
const question = (id: string): PermissionRequest => ({ id, tool_name: "AskUserQuestion", command: "Which database?" });

describe("Permission cards answer keys only in the pane that owns input", () => {
  describe("the composer's inline card", () => {
    const renderPanes = () => {
      const deny = [vi.fn(), vi.fn()];
      const allow = [vi.fn(), vi.fn()];
      render(
        <>
          {PANES.map((sid, idx) => (
            <ChatInput
              key={sid} onSend={vi.fn()} sessionId={sid} paneIdx={idx} locked
              permissionRequest={bash(`req-${idx}`)}
              onPermissionDeny={deny[idx]} onPermissionAllow={allow[idx]}
            />
          ))}
        </>,
      );
      return { deny, allow };
    };

    it.each(ACTIVE_SESSIONS)("Escape denies only the focused pane's card (activeSessionId %s)", (_label, active) => {
      splitView(1, active);
      const { deny } = renderPanes();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deny[0]).not.toHaveBeenCalled();
      expect(deny[1]).toHaveBeenCalledTimes(1);
      expect(deny[1]).toHaveBeenCalledWith("req-1", "Bash");
    });

    it("Meta+Enter allows only the focused pane's card", () => {
      splitView(1, "agent-a");
      const { allow } = renderPanes();
      fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
      expect(allow[0]).not.toHaveBeenCalled();
      expect(allow[1]).toHaveBeenCalledTimes(1);
    });

    it("follows the focus to the other pane", () => {
      splitView(1);
      const { deny } = renderPanes();
      act(() => { useAppStore.setState({ focusedPaneIdx: 0 }); });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deny[0]).toHaveBeenCalledTimes(1);
      expect(deny[1]).not.toHaveBeenCalled();
    });

    it("single view: the card always answers, whatever focusedPaneIdx says", () => {
      useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 1, activeSessionId: "agent-a" });
      const deny = vi.fn();
      render(<ChatInput onSend={vi.fn()} sessionId="agent-a" locked permissionRequest={bash("req-a")} onPermissionDeny={deny} />);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deny).toHaveBeenCalledTimes(1);
    });
  });

  describe("the AskUserQuestion card (PermissionDialog)", () => {
    const renderPanes = () => {
      const deny = [vi.fn(), vi.fn()];
      render(
        <>
          {PANES.map((sid, idx) => (
            <PermissionDialog
              key={sid} request={question(`req-${idx}`)} paneIdx={idx}
              onAllow={vi.fn()} onAllowAlways={vi.fn()} onDeny={deny[idx]!}
            />
          ))}
        </>,
      );
      return { deny };
    };

    it.each(ACTIVE_SESSIONS)("Escape skips only the focused pane's question (activeSessionId %s)", (_label, active) => {
      splitView(1, active);
      const { deny } = renderPanes();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deny[0]).not.toHaveBeenCalled();
      expect(deny[1]).toHaveBeenCalledTimes(1);
      expect(deny[1]).toHaveBeenCalledWith("req-1", "AskUserQuestion");
    });

    it("single view: the card always answers, whatever focusedPaneIdx says", () => {
      useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 1, activeSessionId: "agent-a" });
      const deny = vi.fn();
      render(<PermissionDialog request={question("req-a")} onAllow={vi.fn()} onAllowAlways={vi.fn()} onDeny={deny} />);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(deny).toHaveBeenCalledTimes(1);
    });
  });
});

/* ── Broadcast composer events ── */

const renderGrid = () => render(<SplitPaneGrid dragging={false} onPaneDropEdge={vi.fn()} />);
const composer = (idx: number) => screen.getByPlaceholderText(`composer ${idx}`) as HTMLTextAreaElement;
const surfaceOf = (idx: number) => composer(idx).closest("[data-composer-surface]") as HTMLElement;
const send = (name: string, detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent(name, { detail })); });

/** The composer focuses itself on the next animation frame. Wait two. */
const nextFrames = () => act(async () => {
  for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
});

const PICK = { selector: "button.save", text: "Save", url: "http://localhost:3000/", prompt: "Fix this button" };
const CHIP_TITLE = "button.save · http://localhost:3000/";

describe("Broadcast composer events reach only the composer that owns input", () => {
  beforeEach(() => splitView(0));

  it.each([0, 1])("fleet:focus-input fills and focuses only the focused pane's composer (pane %i focused)", async (focused) => {
    // Regression: every pane took the text and focused itself, and the last
    // one to focus moved focusedPaneIdx to itself.
    splitView(focused);
    renderGrid();
    send("fleet:focus-input", { text: "Explain this" });
    await nextFrames();
    expect(composer(focused).value).toBe("Explain this");
    expect(composer(1 - focused).value).toBe("");
    expect(document.activeElement).toBe(composer(focused));
    expect(useAppStore.getState().focusedPaneIdx).toBe(focused);
  });

  it("fleet:focus-input that names a session goes to that session's composer", async () => {
    splitView(1);
    renderGrid();
    send("fleet:focus-input", { text: "Answer the question", sessionId: "agent-a" });
    await nextFrames();
    expect(composer(0).value).toBe("Answer the question");
    expect(composer(1).value).toBe("");
  });

  it.each([0, 1])("fleet:add-element-ref inserts only into the focused pane's composer (pane %i focused)", async (focused) => {
    splitView(focused);
    renderGrid();
    send("fleet:add-element-ref", PICK);
    await nextFrames();
    expect(within(surfaceOf(focused)).getByTitle(CHIP_TITLE)).toBeInTheDocument();
    expect(within(surfaceOf(1 - focused)).queryByTitle(CHIP_TITLE)).toBeNull();
    expect(composer(focused).value).toBe("Fix this button");
    expect(composer(1 - focused).value).toBe("");
    expect(useAppStore.getState().focusedPaneIdx).toBe(focused);
  });

  it("fleet:add-element-ref that names a session goes to that session's composer", async () => {
    splitView(1);
    renderGrid();
    send("fleet:add-element-ref", { ...PICK, sessionId: "agent-a" });
    await nextFrames();
    expect(within(surfaceOf(0)).getByTitle(CHIP_TITLE)).toBeInTheDocument();
    expect(within(surfaceOf(1)).queryByTitle(CHIP_TITLE)).toBeNull();
  });

  it("single view: the one composer takes both events, whatever focusedPaneIdx says", async () => {
    useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 1, activeSessionId: "agent-a" });
    render(<ChatInput onSend={vi.fn()} sessionId="agent-a" placeholder="composer" />);
    send("fleet:focus-input", { text: "Explain this" });
    send("fleet:add-element-ref", PICK);
    await nextFrames();
    const box = screen.getByPlaceholderText("composer") as HTMLTextAreaElement;
    expect(box.value).toContain("Explain this");
    expect(screen.getByTitle(CHIP_TITLE)).toBeInTheDocument();
  });
});
