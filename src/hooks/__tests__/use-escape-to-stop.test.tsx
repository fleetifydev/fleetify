import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { useEscapeToStop, isOnScreen, claimEscape, escapeWasClaimed } from "../use-escape-to-stop";

/** Mirrors App.tsx: the shell is parked under `display: none` while Settings
 *  or Library is open, and restored with `display: contents`. The chat surface
 *  inside stays MOUNTED the whole time, so its global key listeners stay live. */
function Harness({ parked, active, onStop }: { parked: boolean; active: boolean; onStop: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  useEscapeToStop(surface, active, onStop);
  return (
    <div style={{ display: parked ? "none" : "contents" }}>
      <div ref={surface}>chat</div>
    </div>
  );
}

const pressEscape = () => fireEvent.keyDown(window, { key: "Escape" });

describe("useEscapeToStop", () => {
  it("stops the stream on Escape while the chat surface is on screen", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active onStop={onStop} />);
    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while the surface is parked under another route", () => {
    // Regression: Library and Settings close on Escape. The same keypress used
    // to reach the hidden chat's listener and abort the in-flight response.
    const onStop = vi.fn();
    render(<Harness parked active onStop={onStop} />);
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("works again once the surface is back on screen", () => {
    const onStop = vi.fn();
    const { rerender } = render(<Harness parked active onStop={onStop} />);
    pressEscape();
    rerender(<Harness parked={false} active onStop={onStop} />);
    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no stream is running", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active={false} onStop={onStop} />);
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active onStop={onStop} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onStop).not.toHaveBeenCalled();
  });
});

/** One stream, two registrations on one surface. The app registers once per
 *  chat view (ChatView, through usePaneEscapeToStop); ChatInput no longer
 *  registers. So this does not mirror the app: it guards against a stray
 *  duplicate registration. Both listeners see the same keypress, and the
 *  stream must still stop only once. */
function TwoRegistrations({ onStopA, onStopB }: { onStopA: () => void; onStopB: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  useEscapeToStop(surface, true, onStopA);
  useEscapeToStop(surface, true, onStopB);
  return <div ref={surface}>chat</div>;
}

describe("useEscapeToStop stops a stream once", () => {
  it("runs the stop callbacks once in total for two registrations on one surface", () => {
    // Regression: both listeners used to abort, so one Escape stopped the
    // stream twice.
    const onStopA = vi.fn();
    const onStopB = vi.fn();
    render(<TwoRegistrations onStopA={onStopA} onStopB={onStopB} />);
    pressEscape();
    expect(onStopA.mock.calls.length + onStopB.mock.calls.length).toBe(1);
  });
});

describe("useEscapeToStop leaves Escape to an overlay", () => {
  // Any aria-modal surface counts, whatever its role: Help is a dialog, while
  // the confirm dialog is an alertdialog.
  it.each(["dialog", "alertdialog"])("does not stop while a modal %s is open", (role) => {
    const onStop = vi.fn();
    render(
      <>
        <Harness parked={false} active onStop={onStop} />
        <div role={role} aria-modal="true">Modal</div>
      </>,
    );
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("still stops while a non-modal popover is open", () => {
    // Like the Create PR auth picker (role="dialog" aria-modal="false"). Being
    // open, with focus outside it, does not claim Escape. A popover that closes
    // on Escape claims that key itself with preventDefault (popover-escape
    // tests); this one has no handler.
    const onStop = vi.fn();
    render(
      <>
        <Harness parked={false} active onStop={onStop} />
        <div role="dialog" aria-modal="false">Popover</div>
      </>,
    );
    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does not stop when Escape is pressed inside a dialog", () => {
    const onStop = vi.fn();
    const { getByText } = render(
      <>
        <Harness parked={false} active onStop={onStop} />
        <div role="dialog"><button>Close</button></div>
      </>,
    );
    fireEvent.keyDown(getByText("Close"), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("does not stop when Escape is pressed inside a widget that keeps focus", () => {
    const onStop = vi.fn();
    const { getByText } = render(
      <>
        <Harness parked={false} active onStop={onStop} />
        <div data-keep-focus="true"><button>Pick</button></div>
      </>,
    );
    fireEvent.keyDown(getByText("Pick"), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("does not stop when an overlay already handled the Escape", () => {
    // Help and the confirm dialog close on a document-level Escape and call
    // preventDefault, which runs before the window-level listener here.
    const onStop = vi.fn();
    render(<Harness parked={false} active onStop={onStop} />);
    const overlay = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener("keydown", overlay);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", overlay);
    }
    expect(onStop).not.toHaveBeenCalled();
  });

  it("still stops when Escape is pressed inside the chat itself", () => {
    const onStop = vi.fn();
    const { getByText } = render(<Harness parked={false} active onStop={onStop} />);
    fireEvent.keyDown(getByText("chat"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

/** A chat surface with its composer, beside fields that are not part of it.
 *  In the app those are the sidebar search, the workspace panel's inputs, the
 *  Fleet panel's memory editor and the browser's address bar. */
function PageWithFields({ onStop }: { onStop: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  useEscapeToStop(surface, true, onStop);
  return (
    <>
      <div ref={surface}>
        <textarea aria-label="composer" />
      </div>
      <input aria-label="search" />
      <textarea aria-label="notes" />
      <select aria-label="mode"><option>one</option></select>
      <div role="textbox" aria-label="editor" contentEditable suppressContentEditableWarning />
      <button>Refresh</button>
    </>
  );
}

describe("useEscapeToStop leaves an Escape typed in a field outside the chat to that field", () => {
  it.each(["search", "notes", "mode", "editor"])("does not stop on Escape typed in a field outside the chat (%s)", (label) => {
    const onStop = vi.fn();
    render(<PageWithFields onStop={onStop} />);
    fireEvent.keyDown(screen.getByLabelText(label), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("still stops on Escape typed in the composer, a field inside the chat", () => {
    const onStop = vi.fn();
    render(<PageWithFields onStop={onStop} />);
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does not stop for a field that its own handler removed before the stop listener ran", () => {
    // CodeMirror's find panel closes, taking its input out of the DOM, inside
    // its own keydown listener. The target is detached by the time ours runs.
    const onStop = vi.fn();
    render(<PageWithFields onStop={onStop} />);
    const field = document.createElement("input");
    field.addEventListener("keydown", () => field.remove());
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.isConnected).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("still stops on Escape pressed on a button outside the chat", () => {
    // Only a field owns the Escape typed in it. A button that kept focus
    // after a click does not.
    const onStop = vi.fn();
    render(<PageWithFields onStop={onStop} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Refresh" }), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("claimEscape", () => {
  it("marks the Escape handled, and escapeWasClaimed recognises it", () => {
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    claimEscape(e);
    expect(e.defaultPrevented).toBe(true);
    expect(escapeWasClaimed(e)).toBe(true);
  });

  it("does not count a plain preventDefault as a claim", () => {
    // Escape-to-stop calls preventDefault on the Escape it acts on. That
    // Escape must still answer a pending permission card.
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    e.preventDefault();
    expect(escapeWasClaimed(e)).toBe(false);
  });

  it("keeps the stream running when a document listener claims the Escape", () => {
    const onStop = vi.fn();
    render(<Harness parked={false} active onStop={onStop} />);
    const popover = (e: KeyboardEvent) => { if (e.key === "Escape") claimEscape(e); };
    document.addEventListener("keydown", popover);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", popover);
    }
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("isOnScreen", () => {
  // Shared by every global key handler a chat surface registers — Escape-to-stop
  // above, and chat-input's permission shortcuts (Esc = deny, \u2318\u21b5 = allow).
  const mount = (parked: boolean) => {
    const shell = document.createElement("div");
    shell.style.display = parked ? "none" : "contents";
    const surface = document.createElement("div");
    shell.appendChild(surface);
    document.body.appendChild(shell);
    return { shell, surface };
  };

  it("is true for a surface the user can see", () => {
    expect(isOnScreen(mount(false).surface)).toBe(true);
  });

  it("is false under a display:none ancestor, however deep", () => {
    const { surface } = mount(true);
    const deep = document.createElement("span");
    surface.appendChild(deep);
    expect(isOnScreen(surface)).toBe(false);
    expect(isOnScreen(deep)).toBe(false);
  });

  it("is false for a missing or detached element", () => {
    expect(isOnScreen(null)).toBe(false);
    expect(isOnScreen(document.createElement("div"))).toBe(false);
  });
});
