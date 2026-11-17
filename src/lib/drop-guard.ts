/**
 * Keeps a drop that nothing on the page handles from navigating the app's
 * window.
 *
 * The main window turns Tauri's own drag-and-drop handler off (lib.rs,
 * `disable_drag_drop_handler`, so HTML5 drag-and-drop works on Windows). That
 * leaves drops to the webview: a link, URL, text or file dropped where no
 * element takes it makes the engine load it in place of the app. These
 * window listeners take every such drop, and do nothing with it.
 *
 * - An element that handles a drop (the composer's files, the sidebar, split
 *   panes) cancels the event itself, before it reaches the window: the guard
 *   leaves it alone, and the element's handlers run as before.
 * - Text dropped into a field you can type in is left to the engine, which
 *   inserts it there; that never loads anything.
 * - The dragover's drop effect is left as it is: setting "none" can make an
 *   engine treat the drop as unhandled again.
 */

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

/** Installs the guard on `target`'s window events. Returns what removes it. */
export function installDropGuard(target: Window = window): () => void {
  const take = (event: Event) => {
    if (event.defaultPrevented || isTextEntry(event.target)) return;
    event.preventDefault();
  };
  const events = ["dragenter", "dragover", "drop"] as const;
  for (const type of events) target.addEventListener(type, take);
  return () => {
    for (const type of events) target.removeEventListener(type, take);
  };
}
