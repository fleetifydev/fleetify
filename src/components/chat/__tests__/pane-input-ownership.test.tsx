import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";

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
// A pane's right panel shows its browser, which is all of the workspace these
// tests need. It renders only where paneRightOpen says so.
vi.mock("@/components/workspace/workspace-panel", async () => {
  const { BrowserView } = await import("@/components/workspace/views/browser-view");
  return { WorkspacePanel: () => <div data-testid="pane browser"><BrowserView /></div> };
});

import { ChatInput } from "../chat-input";
import { PermissionDialog } from "../permission-dialog";
import { SplitPaneGrid } from "../split-pane-grid";
import { BrowserView } from "@/components/workspace/views/browser-view";
import { useEscapeToStop, claimEscape } from "@/hooks/use-escape-to-stop";
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

/** Each pane's composer with an inline permission card pending. */
function renderInlineCards() {
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
}

/** Each pane's AskUserQuestion card (PermissionDialog) pending. */
function renderQuestionCards() {
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
}

describe("Permission cards answer keys only in the pane that owns input", () => {
  describe("the composer's inline card", () => {
    const renderPanes = renderInlineCards;

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
    const renderPanes = renderQuestionCards;

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

/** Presses Escape on the page while a popover's document listener claims it,
 *  as the app's popovers do with the Escape that closes them. */
function escapeClaimedByPopover() {
  const popover = (e: KeyboardEvent) => { if (e.key === "Escape") claimEscape(e); };
  document.addEventListener("keydown", popover);
  try {
    fireEvent.keyDown(document.body, { key: "Escape" });
  } finally {
    document.removeEventListener("keydown", popover);
  }
}

/** A chat that is streaming. Its stop listener registers when the stream
 *  starts, so before a permission card that arrives during it. */
function StreamingChat({ onStop, children }: { onStop: () => void; children?: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  useEscapeToStop(surface, true, onStop);
  return <div ref={surface}>{children}</div>;
}

describe("A claimed Escape does not answer the focused pane's permission card", () => {
  it.each([
    ["the composer's inline card", renderInlineCards],
    ["the AskUserQuestion card (PermissionDialog)", renderQuestionCards],
  ] as const)("%s: the Escape that closed a popover leaves it pending", (_label, renderCards) => {
    splitView(1);
    const { deny } = renderCards();
    escapeClaimedByPopover();
    expect(deny[0]).not.toHaveBeenCalled();
    expect(deny[1]).not.toHaveBeenCalled();
    // Control: the next Escape, unclaimed, answers the focused pane's card.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(deny[0]).not.toHaveBeenCalled();
    expect(deny[1]).toHaveBeenCalledTimes(1);
  });

  it.each(["the composer's inline card", "the AskUserQuestion card (PermissionDialog)"])(
    "%s: the Escape that stops the stream still answers it",
    (label) => {
      // Escape-to-stop calls preventDefault but never claims. Stopping the
      // stream leaves the card in place, so if that preventDefault kept the
      // card from answering, a stale card would stay on screen.
      splitView(1);
      const onStop = vi.fn();
      const deny = vi.fn();
      const card = label === "the composer's inline card"
        ? <ChatInput onSend={vi.fn()} sessionId="agent-b" paneIdx={1} locked permissionRequest={bash("req-1")} onPermissionDeny={deny} />
        : <PermissionDialog request={question("req-1")} paneIdx={1} onAllow={vi.fn()} onAllowAlways={vi.fn()} onDeny={deny} />;
      const view = render(<StreamingChat onStop={onStop} />);
      view.rerender(<StreamingChat onStop={onStop}>{card}</StreamingChat>);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(deny).toHaveBeenCalledTimes(1);
    },
  );
});

type CardKind = "the composer's inline card" | "the AskUserQuestion card (PermissionDialog)";
const CARD_KINDS: CardKind[] = ["the composer's inline card", "the AskUserQuestion card (PermissionDialog)"];

/** The focused pane's card pending inside its chat surface, as ChatView
 *  marks it (data-chat-surface). The chat also holds a field of its own
 *  outside the card (its header's title rename), and beside the chat is a
 *  field from outside it (the sidebar search). */
function renderCardInChat(kind: CardKind) {
  const answer = { deny: vi.fn(), allow: vi.fn(), allowAlways: vi.fn() };
  render(
    <>
      <div data-chat-surface="">
        <input aria-label="chat title" />
        {kind === "the composer's inline card" ? (
          <ChatInput
            onSend={vi.fn()} sessionId="agent-b" paneIdx={1} locked permissionRequest={bash("req-1")}
            onPermissionDeny={answer.deny} onPermissionAllow={answer.allow} onPermissionAllowAlways={answer.allowAlways}
          />
        ) : (
          <PermissionDialog
            request={question("req-1")} paneIdx={1}
            onAllow={answer.allow} onAllowAlways={answer.allowAlways} onDeny={answer.deny}
          />
        )}
      </div>
      <input aria-label="sidebar search" />
    </>,
  );
  return answer;
}

/** Every key a card answers: Escape, ⌘↵ and ⌘⇧↵. */
function pressCardKeys(target: Element) {
  fireEvent.keyDown(target, { key: "Escape" });
  fireEvent.keyDown(target, { key: "Enter", metaKey: true });
  fireEvent.keyDown(target, { key: "Enter", metaKey: true, shiftKey: true });
}

function expectPending(answer: ReturnType<typeof renderCardInChat>) {
  expect(answer.deny).not.toHaveBeenCalled();
  expect(answer.allow).not.toHaveBeenCalled();
  expect(answer.allowAlways).not.toHaveBeenCalled();
}

describe("A key typed in a field outside the chat does not answer its permission card", () => {
  // A pending card is exactly when focus is somewhere else: the composer is
  // locked while it waits.
  it.each(CARD_KINDS)("%s: Escape, ⌘↵ and ⌘⇧↵ typed in the sidebar search leave it pending", (kind) => {
    splitView(1);
    const answer = renderCardInChat(kind);
    pressCardKeys(screen.getByLabelText("sidebar search"));
    expectPending(answer);
  });

  it.each(CARD_KINDS)("%s: Escape typed in a field inside the chat, outside the card, still answers it", (kind) => {
    // The rule is about fields outside the chat, found through the surface,
    // not through the card's own root. (In the app the title rename claims
    // its Escape; this field doesn't.)
    splitView(1);
    const answer = renderCardInChat(kind);
    fireEvent.keyDown(screen.getByLabelText("chat title"), { key: "Escape" });
    expect(answer.deny).toHaveBeenCalledTimes(1);
  });

  it.each(CARD_KINDS)("%s: Escape pressed on the page still answers it", (kind) => {
    splitView(1);
    const answer = renderCardInChat(kind);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(answer.deny).toHaveBeenCalledTimes(1);
  });
});

describe("While a modal is open, the permission card answers no key", () => {
  it.each(CARD_KINDS)("%s: Escape, ⌘↵ and ⌘⇧↵ leave it pending, and it answers again once the modal is gone", (kind) => {
    // A modal whose Escape listener registered after the card's: the card's
    // handler runs while the modal is still open. (The other order is the
    // modal's claim, tested with each modal.)
    splitView(1);
    const answer = renderCardInChat(kind);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    try {
      pressCardKeys(document.body);
      expectPending(answer);
    } finally {
      modal.remove();
    }
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(answer.deny).toHaveBeenCalledTimes(1);
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

  it("drops an event that names a session with no mounted composer", async () => {
    // The named chat is not on screen. The focused pane is a different
    // chat, so handing it the text would put it in the wrong place.
    splitView(1);
    renderGrid();
    send("fleet:focus-input", { text: "Explain this", sessionId: "agent-z" });
    send("fleet:add-element-ref", { ...PICK, sessionId: "agent-z" });
    await nextFrames();
    expect(composer(0).value).toBe("");
    expect(composer(1).value).toBe("");
    expect(screen.queryByTitle(CHIP_TITLE)).toBeNull();
  });
});

/* ── Browser element picks ── */

describe("A browser pick goes to the composer of the pane whose browser made it", () => {
  /** The browser views' `browser-embed:pick` listeners, one per mounted view. */
  const pickListeners = new Set<(e: { payload: unknown }) => void>();

  beforeEach(() => {
    pickListeners.clear();
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn(async () => ({ ok: true })) },
      event: {
        listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
          if (name !== "browser-embed:pick") return () => {};
          pickListeners.add(cb);
          return () => { pickListeners.delete(cb); };
        }),
      },
    };
    // The browser view mirrors the agent's browser over a WebSocket.
    vi.stubGlobal("WebSocket", class {
      readyState = 3;
      onmessage: unknown = null;
      onclose: unknown = null;
      send() {}
      close() {}
    });
  });

  afterEach(() => {
    // Unmount while Tauri is still stubbed: the view closes its webview then.
    cleanup();
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    vi.unstubAllGlobals();
    useAppStore.setState({ paneRightOpen: {} });
  });

  /** The in-page picker posting a pick, as the native webview does. Tauri
   *  broadcasts it to every browser view that listens. */
  const pick = () => act(() => {
    for (const listener of pickListeners) listener({ payload: encodeURIComponent(JSON.stringify(PICK)) });
  });

  /** Loads a page in a browser view, which enables Select, then arms it. */
  async function armSelect(view: Pick<typeof screen, "getByPlaceholderText" | "getByTitle">) {
    const url = view.getByPlaceholderText("Search or enter URL");
    fireEvent.change(url, { target: { value: "localhost:3000" } });
    fireEvent.keyDown(url, { key: "Enter" });
    await act(async () => {});
    fireEvent.click(view.getByTitle("Select an element → composer"));
  }

  it("lands in pane 0 from pane 0's browser, while pane 1 is focused", async () => {
    // Select was armed in pane 0's browser, then the user moved to pane 1.
    splitView(1);
    useAppStore.setState({ paneRightOpen: { "agent-a": true } });
    renderGrid();
    await armSelect(within(screen.getByTestId("pane browser")));
    act(() => { useAppStore.setState({ focusedPaneIdx: 1 }); });
    pick();
    await nextFrames();
    expect(within(surfaceOf(0)).getByTitle(CHIP_TITLE)).toBeInTheDocument();
    expect(within(surfaceOf(1)).queryByTitle(CHIP_TITLE)).toBeNull();
    expect(composer(0).value).toBe("Fix this button");
    expect(composer(1).value).toBe("");
  });

  it("single view: the pick names no session, so the one composer takes it", async () => {
    // Only a pane's browser names its session. Outside a pane the pick
    // names none, and the one composer takes it, as before. activeSessionId
    // is deliberately not the composer's session: naming it would drop the
    // pick, so the test also fails if the view named the store's session.
    useAppStore.setState({ splitPaneIds: [], focusedPaneIdx: 1, activeSessionId: "agent-z" });
    render(
      <>
        <ChatInput onSend={vi.fn()} sessionId="agent-a" placeholder="composer" />
        <BrowserView />
      </>,
    );
    await armSelect(screen);
    pick();
    await nextFrames();
    expect(screen.getByTitle(CHIP_TITLE)).toBeInTheDocument();
    expect((screen.getByPlaceholderText("composer") as HTMLTextAreaElement).value).toBe("Fix this button");
  });

  it("an unarmed browser view ignores the pick, so only the armed pane takes it", async () => {
    // The global right panel stays mounted at width 0 when closed, so a
    // browser opened there in the single view keeps listening after the user
    // splits the view. It names no session, so the focused pane would take
    // the pick too, and with Send its agent would get a turn.
    splitView(1);
    useAppStore.setState({ paneRightOpen: { "agent-a": true } });
    render(
      <>
        <SplitPaneGrid dragging={false} onPaneDropEdge={vi.fn()} />
        <div data-testid="hidden global panel"><BrowserView /></div>
      </>,
    );
    await armSelect(within(screen.getByTestId("pane browser")));
    act(() => { useAppStore.setState({ focusedPaneIdx: 1 }); });
    pick();
    await nextFrames();
    expect(within(surfaceOf(0)).getAllByTitle(CHIP_TITLE)).toHaveLength(1);
    expect(within(surfaceOf(1)).queryByTitle(CHIP_TITLE)).toBeNull();
    expect(composer(1).value).toBe("");
  });
});
