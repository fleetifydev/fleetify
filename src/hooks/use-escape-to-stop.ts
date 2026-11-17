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
 *  - `defaultPrevented`: a handler that ran first already acted on it. Help and
 *    the confirm dialog do this from `document`, ahead of any window listener.
 *    So does the first of two Escape-to-stop registrations for one stream, so
 *    the second one skips.
 *  - The key was pressed inside a dialog or a `data-keep-focus` widget.
 *  - A modal dialog is open, wherever focus is. */
export function escapeOwnedElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const target = e.target;
  if (target instanceof Element && target.closest("[role='dialog'], [data-keep-focus='true']")) return true;
  return document.querySelector("[role='dialog'][aria-modal='true']") !== null;
}

/** Escape aborts the in-flight response — but only for a chat surface the user
 *  can actually see. Settings and Library close on Escape too; without the
 *  visibility check that same keypress reached the parked chat underneath and
 *  cut its stream mid-answer.
 *
 *  It also leaves alone an Escape that something else owns
 *  (`escapeOwnedElsewhere`). That covers an open overlay. It also covers the
 *  second registration for the same stream: ChatView and ChatInput both
 *  register, and both are on screen. */
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
