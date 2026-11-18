/**
 * A drop that nothing on the page takes would make the engine load what was
 * dropped (a link, a URL, a file) in place of the app. The guard takes those
 * drops and does nothing with them. "Taken" is what the engine sees: a
 * cancelled dragenter / dragover / drop event. The app's own drags are left
 * to their targets, which decide the cursor themselves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installDropGuard, isTextEntry } from "@/lib/drop-guard";

type DragType = "dragenter" | "dragover" | "drop";
const DRAG_TYPES: DragType[] = ["dragenter", "dragover", "drop"];

/** What a drag from outside the app carries: a file, a link, text, HTML. */
const FILE = ["Files"];
const LINK = ["text/uri-list", "text/plain"];
const TEXT = ["text/plain"];
const HTML = ["text/html", "text/plain"];
/** The app's own drags: a sidebar session, a workspace pane. */
const SESSION = ["application/x-fleet-session-id"];
const PANE = ["application/fleet-pane"];

let uninstall: () => void;
beforeEach(() => {
  uninstall = installDropGuard(window);
});
afterEach(() => {
  uninstall();
  document.body.innerHTML = "";
});

/** Dispatches a drag event of `type` carrying `types` on `target`, as the
 *  engine would. happy-dom's DataTransfer lists a file by its MIME type, not
 *  as "Files", so the drag data is a plain object. */
function drag(type: DragType, target: Element, types: string[], files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files } });
  target.dispatchEvent(event);
  return event;
}

/** A drag that starts in this document carrying `types` (the engine fires
 *  dragstart on its source, after the source's own handler set its data), and
 *  its end. */
function startDrag(source: Element, types: string[] = SESSION) {
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files: [] } });
  source.dispatchEvent(event);
}
function endDrag(source: Element) {
  source.dispatchEvent(new Event("dragend", { bubbles: true }));
}

function add(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const element = holder.firstElementChild as HTMLElement;
  document.body.appendChild(element);
  return element;
}

describe("a drop nothing on the page handles never navigates the window", () => {
  it("takes a file, link, text or HTML drop from outside the app anywhere else", () => {
    const sidebar = add("<nav><a href='https://example.com/'>a link</a></nav>");
    for (const target of [sidebar, sidebar.firstElementChild!, document.body]) {
      for (const types of [FILE, LINK, TEXT, HTML]) {
        for (const type of DRAG_TYPES) {
          expect(drag(type, target, types).defaultPrevented, `${type} ${types} on ${target.tagName}`).toBe(true);
        }
      }
    }
  });

  it("leaves the app's own drags to their targets", () => {
    // The sidebar leaves an illegal drop target uncancelled on purpose, so
    // the cursor says no-drop: the guard must not cancel it either.
    const row = add("<div class='session-row' draggable='true'></div>");
    // One drag per set of types: it starts here, crosses, drops, ends.
    for (const types of [SESSION, PANE, [...SESSION, "text/plain"]]) {
      startDrag(row, types);
      for (const type of DRAG_TYPES) {
        expect(drag(type, row, types).defaultPrevented, `${type} ${types}`).toBe(false);
      }
      endDrag(row);
    }
  });

  it("takes a drag from outside that carries an app type, when nothing handles it", () => {
    // WebView2 carries a web page's custom setData types across processes:
    // a drag from a browser can carry the session type next to a link.
    const panel = add("<div></div>");
    for (const types of [[...SESSION, "text/uri-list"], [...PANE, "text/plain"]]) {
      for (const type of DRAG_TYPES) {
        expect(drag(type, panel, types).defaultPrevented, `${type} ${types}`).toBe(true);
      }
    }
  });

  it("doesn't count a drag the app cancels at its start as the app's own", () => {
    // A workspace pane cancels dragstart while it isn't armed (dragging
    // selected text in it): no drag follows, and no dragend ever comes.
    const pane = add("<div><span>selected text</span></div>");
    pane.addEventListener("dragstart", (event) => event.preventDefault());
    startDrag(pane.firstElementChild!, PANE);
    expect(drag("dragover", pane, [...SESSION, "text/uri-list"]).defaultPrevented).toBe(true);
  });

  it("stops treating app types as the app's own once its drag has ended", () => {
    const row = add("<div draggable='true'></div>");
    startDrag(row);
    endDrag(row);
    expect(drag("drop", row, [...SESSION, "text/uri-list"]).defaultPrevented).toBe(true);
  });

  it("only counts a drag that carries an app type as the app's own", () => {
    // Dragging a link inside the page starts a drag too. Its source can
    // leave the document before it ends, so its dragend never comes: it must
    // not exempt the app types of a drag from outside that follows.
    const link = add("<a href='https://example.com/'>a link</a>");
    startDrag(link, LINK);
    link.remove();
    const panel = add("<div></div>");
    expect(drag("dragover", panel, [...SESSION, "text/uri-list"]).defaultPrevented).toBe(true);
  });

  it("ends the app's drag when it ends at a source that left the document", () => {
    // A session row re-rendered away mid-drag still gets its dragend, but
    // the event no longer reaches the window.
    const row = add("<div draggable='true'></div>");
    startDrag(row);
    row.remove();
    endDrag(row);
    const panel = add("<div></div>");
    expect(drag("dragover", panel, [...SESSION, "text/uri-list"]).defaultPrevented).toBe(true);
  });

  it("ends the app's drag at the next press, should no dragend come at all", () => {
    const row = add("<div draggable='true'></div>");
    startDrag(row);
    row.remove();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    const panel = add("<div></div>");
    expect(drag("dragover", panel, [...SESSION, "text/uri-list"]).defaultPrevented).toBe(true);
  });

  it("leaves a drag of nothing the engine would load alone", () => {
    const panel = add("<div></div>");
    for (const types of [[], ["application/json"]]) {
      expect(drag("drop", panel, types).defaultPrevented, `${types}`).toBe(false);
    }
  });

  it("leaves a drop an element handles to that element", () => {
    // The composer takes dropped files itself.
    const composer = add("<div></div>");
    const received: string[] = [];
    composer.addEventListener("dragover", (event) => event.preventDefault());
    composer.addEventListener("drop", (event) => {
      event.preventDefault();
      const files = (event as DragEvent).dataTransfer?.files ?? [];
      received.push(...Array.from(files, (file) => file.name));
    });
    const notes = new File(["# notes"], "notes.md", { type: "text/markdown" });
    expect(drag("dragover", composer, FILE, [notes]).defaultPrevented).toBe(true);
    expect(drag("drop", composer, FILE, [notes]).defaultPrevented).toBe(true);
    expect(received).toEqual(["notes.md"]);
  });

  it("lets the engine drop text or a link into a field you can type in", () => {
    const fields = [
      add("<textarea></textarea>"),
      add("<input type='text'>"),
      add("<input type='search'>"),
      add("<input>"),
      add("<div contenteditable='true'><p>draft</p></div>").firstElementChild!,
    ];
    for (const field of fields) {
      expect(isTextEntry(field), field.outerHTML).toBe(true);
      for (const types of [TEXT, LINK, HTML]) {
        for (const type of DRAG_TYPES) {
          expect(drag(type, field, types).defaultPrevented, `${type} ${types} on ${field.outerHTML}`).toBe(false);
        }
      }
    }
  });

  it("cancels a file drop nothing handles, even over a text field", () => {
    // A text field can't take a file, and the engine may load it instead.
    for (const field of [add("<textarea></textarea>"), add("<input type='text'>")]) {
      for (const type of DRAG_TYPES) {
        expect(drag(type, field, FILE).defaultPrevented, `${type} on ${field.outerHTML}`).toBe(true);
      }
    }
  });

  it("takes a drop on a field you can't type in", () => {
    // The engine loads what's dropped on these, as on any other element.
    for (const field of [
      add("<textarea readonly></textarea>"),
      add("<input type='text' disabled>"),
      add("<input type='checkbox'>"),
      add("<button>Send</button>"),
    ]) {
      expect(isTextEntry(field), field.outerHTML).toBe(false);
      expect(drag("drop", field, LINK).defaultPrevented, field.outerHTML).toBe(true);
    }
  });

  it("stops when it is uninstalled", () => {
    uninstall();
    const panel = add("<div></div>");
    expect(drag("drop", panel, LINK).defaultPrevented).toBe(false);
  });
});
