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

/** True when this Escape belongs to something other than the chat underneath:
 *
 *  - `defaultPrevented`: a handler that ran first already acted on it. An
 *    overlay's Escape handler calls preventDefault before it closes. That
 *    matters most when its listener runs ahead of ours: by the time ours runs,
 *    the overlay may already be gone from the DOM.
 *  - The key was pressed inside a dialog or a `data-keep-focus` widget.
 *  - A modal is open, wherever focus is. Any `aria-modal="true"` element
 *    counts, whatever its role (the confirm dialog is an `alertdialog`). This
 *    covers an overlay whose own listener has not run yet. */
export function escapeOwnedElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const target = e.target;
  if (target instanceof Element && target.closest("[role='dialog'], [data-keep-focus='true']")) return true;
  return document.querySelector("[aria-modal='true']") !== null;
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
 *    left alone. That covers an open overlay, or a handler that acted first. */
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
      if (!isOnScreen(surface.current)) return;
      e.preventDefault();
      onStop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface, active, onStop]);
}
