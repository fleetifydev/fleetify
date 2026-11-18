/**
 * Keeps a drop that nothing on the page handles from navigating the app's
 * window.
 *
 * The main window turns Tauri's own drag-and-drop handler off (lib.rs,
 * `disable_drag_drop_handler`, so HTML5 drag-and-drop works on Windows). That
 * leaves drops to the webview: a file, link, text or HTML dropped where no
 * element takes it makes the engine load it in place of the app. These
 * window listeners take such a drop, and do nothing with it.
 *
 * - An element that handles a drop (the composer's files, the sidebar, split
 *   panes) cancels the event itself, before it reaches the window: the guard
 *   leaves it alone, and the element's handlers run as before.
 * - The app's own drags (sidebar sessions, workspace panes) are left to their
 *   targets. The sidebar leaves an illegal target uncancelled on purpose, so
 *   the cursor says no-drop. Only a drag that started in this document with
 *   an app type counts as the app's own, until it ends: WebView2 carries a
 *   web page's custom types across processes, so a drag from a browser can
 *   carry them too.
 * - Text or a link dropped into a field you can type in is left to the
 *   engine, which inserts it there. A file is cancelled even there: a text
 *   field can't take it, and the engine may load it instead.
 * - The dragover's drop effect is left as it is: setting "none" can make an
 *   engine treat the drop as unhandled again.
 */

/** Types the app sets on its own drags: a sidebar session, a workspace
 *  pane. */
const APP_DRAG_TYPES = ["application/x-fleet-session-id", "application/fleet-pane"];

/** Types of what the engine loads when nothing takes the drop. */
const LOADABLE_TYPES = ["Files", "text/uri-list", "text/plain", "text/html"];

/** Input types the engine drops into itself: text fields, and file pickers. */
const ENGINE_DROP_INPUTS = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "file",
]);

/** True for a field the engine drops into itself: a textarea, a text input
 *  or file picker, or contenteditable content, when it can be edited. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
  if (target instanceof HTMLInputElement) {
    return !target.disabled && !target.readOnly && ENGINE_DROP_INPUTS.has(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Whether the guard takes a drag carrying `types` over `target`, when
 *  nothing on the page has: one the engine would load, unless it is text or
 *  a link over a field you can type in, or the app's own drag (`fromApp`,
 *  started in this document, carrying an app type). */
export function guardTakes(
  types: readonly string[],
  target: EventTarget | null,
  fromApp: boolean,
): boolean {
  if (fromApp && types.some((type) => APP_DRAG_TYPES.includes(type))) return false;
  if (types.includes("Files")) return true;
  return types.some((type) => LOADABLE_TYPES.includes(type)) && !isTextEntry(target);
}

/** The types a drag event carries. */
function dragTypes(event: Event): string[] {
  return Array.from((event as DragEvent).dataTransfer?.types ?? []);
}

/** Installs the guard on `target`'s window events. Returns what removes it. */
export function installDropGuard(target: Window = window): () => void {
  // Whether one of the app's own drags is in flight: the engine fires
  // dragstart on its source, after the source's handler set an app type, and
  // dragend when it ends.
  // - Only a dragstart carrying an app type counts. One the app cancelled
  //   starts no drag (a workspace pane cancels one while it isn't armed), and
  //   no dragend follows it.
  // - A source that left the document mid-drag still gets its dragend, but
  //   the event no longer reaches the window: the source itself is listened
  //   to as well.
  // - A drop ends it, and so does the next press, should no dragend come.
  let dragFromApp = false;
  const ended = () => {
    dragFromApp = false;
  };
  const started = (event: Event) => {
    if (event.defaultPrevented) return;
    if (!dragTypes(event).some((type) => APP_DRAG_TYPES.includes(type))) return;
    dragFromApp = true;
    event.target?.addEventListener("dragend", ended, { once: true });
  };
  const take = (event: Event) => {
    if (event.defaultPrevented) return;
    if (guardTakes(dragTypes(event), event.target, dragFromApp)) event.preventDefault();
  };
  const events = ["dragenter", "dragover", "drop"] as const;
  target.addEventListener("dragstart", started);
  target.addEventListener("dragend", ended);
  target.addEventListener("pointerdown", ended);
  for (const type of events) target.addEventListener(type, take);
  // After `take`, so the drop is judged before the flag clears.
  target.addEventListener("drop", ended);
  return () => {
    target.removeEventListener("dragstart", started);
    target.removeEventListener("dragend", ended);
    target.removeEventListener("pointerdown", ended);
    for (const type of events) target.removeEventListener(type, take);
    target.removeEventListener("drop", ended);
  };
}
