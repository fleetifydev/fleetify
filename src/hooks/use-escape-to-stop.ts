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

/** Escape aborts the in-flight response — but only for a chat surface the user
 *  can actually see. Settings and Library close on Escape too; without the
 *  visibility check that same keypress reached the parked chat underneath and
 *  cut its stream mid-answer. */
export function useEscapeToStop(
  surface: RefObject<Element | null>,
  active: boolean,
  onStop: (() => void) | undefined,
): void {
  useEffect(() => {
    if (!active || !onStop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isOnScreen(surface.current)) return;
      e.preventDefault();
      onStop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface, active, onStop]);
}
