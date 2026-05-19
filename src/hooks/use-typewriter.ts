import { useEffect, useRef, useState } from "react";

/**
 * Smoothly reveals a target string one small chunk at a time, catching up if
 * the target grows faster than the animation. When the target shrinks (a
 * finalized message replaces streaming content), we snap to the new value to
 * avoid a visible rewind.
 *
 * `baseCharsPerFrame` controls the floor speed; the hook also scales up when
 * the backlog is large so the UI never falls visibly behind the stream.
 */
export function useTypewriter(target: string, baseCharsPerFrame = 6): string {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  useEffect(() => {
    // Snap backwards (stream cleared, message replaced) or on initial mount.
    if (target.length < displayedRef.current.length ||
        !target.startsWith(displayedRef.current.slice(0, Math.min(displayedRef.current.length, 16)))) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    if (target === displayedRef.current) return;

    let rafId = 0;
    const step = () => {
      const current = displayedRef.current;
      if (current.length >= target.length) return;
      const backlog = target.length - current.length;
      // Scale speed with backlog so heavy bursts catch up without looking jumpy.
      const charsThisFrame = Math.max(
        baseCharsPerFrame,
        Math.min(64, Math.ceil(backlog / 10)),
      );
      const next = target.slice(0, current.length + charsThisFrame);
      displayedRef.current = next;
      setDisplayed(next);
      if (next.length < target.length) {
        rafId = requestAnimationFrame(step);
      }
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [target, baseCharsPerFrame]);

  return displayed;
}
