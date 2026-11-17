/**
 * A drop that nothing on the page takes would make the engine load what was
 * dropped (a link, a URL, a file) in place of the app. The guard takes those
 * drops and does nothing with them. "Taken" is what the engine sees: a
 * cancelled dragenter / dragover / drop event.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installDropGuard, isTextEntry } from "@/lib/drop-guard";

type DragType = "dragenter" | "dragover" | "drop";
const DRAG_TYPES: DragType[] = ["dragenter", "dragover", "drop"];

let uninstall: () => void;
beforeEach(() => {
  uninstall = installDropGuard(window);
});
afterEach(() => {
  uninstall();
  document.body.innerHTML = "";
});

/** Dispatches a drag event of `type` on `target`, as the engine would. */
function drag(type: DragType, target: Element, dataTransfer?: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}

function add(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const element = holder.firstElementChild as HTMLElement;
  document.body.appendChild(element);
  return element;
}

describe("a drop nothing on the page handles never navigates the window", () => {
  it("is taken anywhere else: a dropped link, URL, text or file goes nowhere", () => {
    const sidebar = add("<nav><a href='https://example.com/'>a link</a></nav>");
    for (const target of [sidebar, sidebar.firstElementChild!, document.body]) {
      for (const type of DRAG_TYPES) {
        expect(drag(type, target).defaultPrevented, `${type} on ${target.tagName}`).toBe(true);
      }
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
    const files = new DataTransfer();
    files.items.add(new File(["# notes"], "notes.md", { type: "text/markdown" }));
    expect(drag("dragover", composer, files).defaultPrevented).toBe(true);
    expect(drag("drop", composer, files).defaultPrevented).toBe(true);
    expect(received).toEqual(["notes.md"]);
  });

  it("lets the engine drop text into a field you can type in", () => {
    const fields = [
      add("<textarea></textarea>"),
      add("<input type='text'>"),
      add("<input type='search'>"),
      add("<input>"),
      add("<div contenteditable='true'><p>draft</p></div>").firstElementChild!,
    ];
    for (const field of fields) {
      expect(isTextEntry(field), field.outerHTML).toBe(true);
      for (const type of DRAG_TYPES) {
        expect(drag(type, field).defaultPrevented, `${type} on ${field.outerHTML}`).toBe(false);
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
      expect(drag("drop", field).defaultPrevented, field.outerHTML).toBe(true);
    }
  });

  it("stops when it is uninstalled", () => {
    uninstall();
    const panel = add("<div></div>");
    expect(drag("drop", panel).defaultPrevented).toBe(false);
  });
});
