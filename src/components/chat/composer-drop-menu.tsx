/**
 * ComposerDropMenu — a toolbar dropdown that opens ABOVE its trigger and floats
 * clear of the composer.
 *
 * The composer's control row lives inside the input card, which has
 * `overflow: hidden` (rounded corners + focus ring). An absolutely-positioned
 * dropdown inside it gets cropped at the card's top edge — which is why the
 * model picker is deliberately rendered up at the compose-wrapper level instead.
 * This helper achieves the same "opens above the chat" result for in-toolbar
 * pickers (permission, sandbox, fleet-mode) without restructuring the composer:
 * it portals the menu to <body> and positions it `fixed` just above the whole
 * composer surface — the nearest `[data-composer-surface]` ancestor, i.e. the
 * same box the model picker anchors to — so the menu floats over the chat
 * rather than hugging the button. Falls back to the trigger if no surface
 * marker is found, and `fixed` + the portal mean no ancestor's overflow can
 * clip it.
 *
 * Dismiss: outside-click (ignoring BOTH the trigger and the portaled menu) and
 * Esc. The parent owns `open`; this only renders + positions + dismisses.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

interface Props {
  /** The trigger element the menu anchors above. */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Horizontal anchor: menu's left edge to the trigger's left ("left") or its
   *  right edge to the trigger's right ("right"). */
  align?: "left" | "right";
  /** Visual styles for the menu surface (background, border, padding, …). */
  style?: CSSProperties;
  /** ARIA role for the surface (default "menu"; the fleet chip uses "listbox"). */
  role?: string;
  ariaLabel?: string;
  children: ReactNode;
}

type Pos = { bottom: number; left?: number; right?: number };

export function ComposerDropMenu({ anchorRef, open, onClose, align = "left", style, role = "menu", ariaLabel, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  // Position the menu just above the trigger, in viewport (fixed) coordinates
  // so it escapes the input card's clip. Recompute on scroll/resize.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      // Anchor to the WHOLE composer surface (the box the model picker uses) on
      // BOTH axes: float above it AND align to its left edge, so every toolbar
      // menu opens at the same far-left spot regardless of which chip (ask,
      // sandbox, fleet) was clicked. Fall back to the trigger if no surface
      // marker exists.
      const surface = el.closest("[data-composer-surface]");
      const rect = (surface ?? el).getBoundingClientRect();
      const bottom = window.innerHeight - rect.top + 6; // 6px gap above the surface
      setPos(
        align === "right"
          ? { bottom, right: window.innerWidth - rect.right }
          : { bottom, left: rect.left },
      );
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true); // capture: any scrolling ancestor
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, anchorRef, align]);

  // Outside-click (excluding the trigger AND the portaled menu) + Esc.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claim the key so the chat's Escape-to-stop leaves the stream
      // running. This document listener always runs before that window one.
      e.preventDefault();
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: "fixed",
        bottom: pos.bottom,
        ...(pos.left != null ? { left: pos.left } : { right: pos.right }),
        zIndex: 1000,
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
