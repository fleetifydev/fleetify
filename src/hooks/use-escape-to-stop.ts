import { useEffect, type RefObject } from "react";

/** False when `el` or any ancestor is `display: none`.
 *
 *  App.tsx keeps AppShell MOUNTED under `display: none` while Settings or
 *  Library is open, so the chat's window-level listeners outlive its
 *  visibility. Anything global a chat surface listens for has to check this. */
export function isOnScreen(el: Element | null): boolean {
  if (!el || !el.isConnected) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** Escapes claimed with `claimEscape`. A WeakSet, so an event is forgotten
 *  once nothing else holds it. */
const claimed = new WeakSet<KeyboardEvent>();

/** Claims the Escape that closes a popover, menu or similar, so that Escape
 *  does nothing else. It marks the event handled (`preventDefault`), which
 *  Escape-to-stop and the back-to-Fleet shortcut honour, and it records the
 *  event, which the permission cards check (`escapeWasClaimed`).
 *
 *  Call it from a `document` listener or a React handler (pass
 *  `e.nativeEvent`). Both run before every `window` listener, whatever order
 *  they registered in. */
export function claimEscape(e: KeyboardEvent): void {
  e.preventDefault();
  claimed.add(e);
}

/** True when a handler claimed this Escape with `claimEscape`.
 *
 *  The permission cards check this rather than `defaultPrevented`.
 *  Escape-to-stop also calls preventDefault, but it never claims: the Escape
 *  that stops a stream must still answer a pending card. Stopping leaves the
 *  card in place, so skipping it would leave a stale card on screen. */
export function escapeWasClaimed(e: KeyboardEvent): boolean {
  return claimed.has(e);
}

/** True when this Escape belongs to something other than the chat underneath:
 *
 *  - `defaultPrevented`: a handler that ran first already acted on it. A
 *    popover or menu claims the Escape that closes it (`claimEscape`) from a
 *    `document` listener or a React handler, and both always run ahead of
 *    this `window` listener. The claim is a flag on the event, so it holds
 *    even when the popover is already gone from the DOM by the time this
 *    runs. A handler on `window` can register after this one and run too
 *    late, so a popover must not close on Escape from there.
 *  - The key was pressed inside a dialog or a `data-keep-focus` widget.
 *  - A modal is open, wherever focus is. Any `aria-modal="true"` element
 *    counts, whatever its role (the confirm dialog is an `alertdialog`). This
 *    covers an overlay whose own listener has not run yet. */
export function escapeOwnedElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const target = e.target;
  if (target instanceof Element && target.closest("[role='dialog'], [data-keep-focus='true']")) return true;
  return modalOpen();
}

/** True while a modal is open: any `aria-modal="true"` element, whatever its
 *  role. Every key is the modal's then, not the chat's underneath. */
export function modalOpen(): boolean {
  return document.querySelector("[aria-modal='true']") !== null;
}

/** Elements that take typing. */
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** True when a key was typed in a field outside `surface`: an input,
 *  textarea, select or contenteditable element (CodeMirror's editor is one)
 *  that is not part of this chat. Examples are the sidebar search, the
 *  workspace panel's inputs and the browser's address bar. That key belongs
 *  to the field: it neither stops the stream nor answers a permission card.
 *
 *  The composer is inside the surface, so Escape typed there still stops the
 *  stream. The check reads the event's target, so it holds even when the
 *  field's own handler has already removed it: a detached field is not in
 *  the surface. */
export function typedInFieldOutside(target: EventTarget | null, surface: Element | null): boolean {
  if (!(target instanceof Element) || !target.closest(FIELD)) return false;
  return !surface?.contains(target);
}

/** True when a permission card must leave this key (Escape, ⌘↵ or ⌘⇧↵)
 *  alone. `card` is the card's root element.
 *
 *  - A popover or modal claimed it to close itself (`escapeWasClaimed`).
 *  - It was typed in a field outside the card's chat (`typedInFieldOutside`).
 *    The chat is the card's nearest `[data-chat-surface]` (ChatView's root),
 *    or the card itself outside one. While a card waits, the composer is
 *    locked, so focus is usually somewhere else.
 *  - A modal is open (`modalOpen`), wherever focus is. That covers a modal
 *    whose own listener has not run yet; its claim covers the other order.
 *
 *  Escape-to-stop's own preventDefault does not count, so the Escape that
 *  stops a stream still answers its card. */
export function cardKeyOwnedElsewhere(e: KeyboardEvent, card: Element | null): boolean {
  if (escapeWasClaimed(e)) return true;
  if (typedInFieldOutside(e.target, card?.closest("[data-chat-surface]") ?? card)) return true;
  return modalOpen();
}

/** Escape aborts the in-flight response of one chat surface. The model:
 *
 *  - One registration per chat view. ChatView registers. ChatInput, which sits
 *    inside it, does not.
 *  - The caller passes `active` only while that chat is streaming and owns the
 *    key. In a split view, that means the focused pane. Every pane is on screen,
 *    so visibility alone cannot pick one (see `usePaneEscapeToStop` in
 *    chat-view.tsx).
 *  - The chat must be on screen. Settings and Library park the shell under
 *    `display: none`, and the Escape that closes them must not reach the chat.
 *  - An Escape that something else already owns (`escapeOwnedElsewhere`) is
 *    left alone. That covers an open overlay, or a handler that acted first.
 *  - So is an Escape typed in a field outside the chat (`typedInFieldOutside`). */
export function useEscapeToStop(
  surface: RefObject<Element | null>,
  active: boolean,
  onStop: (() => void) | undefined,
): void {
  useEffect(() => {
    if (!active || !onStop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeOwnedElsewhere(e)) return;
      if (typedInFieldOutside(e.target, surface.current)) return;
      if (!isOnScreen(surface.current)) return;
      e.preventDefault();
      onStop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface, active, onStop]);
}
