// First-launch tour. Spotlights real DOM elements (looked up by
// `data-tour="..."` attribute) with a dimmed-overlay cutout and a
// pointer-anchored tooltip. The tour fires once per machine —
// completion / skip both flip `fleet:tour-done` so it never reappears.
//
// Why DOM-anchored instead of "ref-passed"? The targets live in three
// different component trees (sidebar, chat-input, app-shell footer)
// that don't share a render boundary, so threading refs would mean
// touching every one. A `data-tour` attribute + querySelector keeps
// the tour decoupled — adding a new step is one selector and one
// copy block, no wiring changes.

import { useEffect, useState, useLayoutEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X, ArrowRight, ArrowLeft } from "lucide-react";

interface TourStep {
  /** data-tour attribute value of the target element. Every step is
   *  anchored to a real UI element — no floating intro / outro
   *  slides, since those left the user staring at a centered card
   *  with no context for what it was about to teach them. */
  target: string;
  title: string;
  body: string;
  /** Tooltip placement relative to the spotlight. Auto-flips off
   *  the screen edge if needed. */
  placement?: "right" | "left" | "top" | "bottom";
}

const STEPS: TourStep[] = [
  {
    target: "sidebar-rail",
    title: "Your fleet of agents.",
    body: "Every chat in Fleet is its own agent — running in parallel, with its own folder, model, and permissions. New agents land here.",
    placement: "right",
  },
  {
    target: "new-agent",
    title: "Spawn a new agent.",
    body: "Hit New session (or ⌘N) to start a fresh chat. Mix providers freely — one agent on Claude, another on Codex, side by side.",
    placement: "right",
  },
  {
    target: "chat-input",
    title: "Where you talk to Fleet.",
    body:
      "Type or paste your task. Use @ to drop in files, agents, or folders. Drag screenshots straight in.\n\n" +
      "Bottom-left has permissions (Ask / Auto / Plan / Bypass), + for attachments, and ⌘I to enhance a rough prompt. Bottom-right picks the provider, model, and reasoning effort. Enter sends, Esc aborts mid-response.",
    placement: "top",
  },
  {
    target: "settings",
    title: "Providers, keys, and budget.",
    body: "Your API keys, default provider, and monthly cost cap all live in Settings. Nothing leaves your machine that you didn't put there.",
    placement: "right",
  },
];

const PADDING = 2;        // breathing room around the spotlight
const TIP_GAP = 14;       // distance from spotlight to tooltip
const TIP_W = 320;
// Bumped to v2 because v1's "auto-skip on unrendered target also calls
// finish() which sets the flag" bug poisoned localStorage on every
// failed test — users saw nothing yet ended up flagged as "done", and
// the tour silently refused to fire again. v2 only flags after a
// real render (see `seenAtLeastOne`).
const TOUR_FLAG = "fleet:tour-done-v2";

interface Rect { x: number; y: number; w: number; h: number; }

/** Locate the target element by data-tour. Returns null until the
 *  element is in the DOM (the rail slides in via a 900ms transition,
 *  so first paint may not have it yet). */
function findRect(target: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function FirstLaunchTour({ onDone }: { onDone: () => void }) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [mounted, setMounted] = useState(false);
  const rafRef = useRef<number | null>(null);
  // True once at least ONE step has actually rendered to the user.
  // Gates the tour-done flag — if the tour fell through every step's
  // auto-skip (target never appeared), we exit without flagging so
  // the next launch gets another shot rather than being permanently
  // marked "seen".
  const seenAtLeastOne = useRef(false);

  const step = STEPS[stepIdx]!;
  const isLast = stepIdx === STEPS.length - 1;

  const finish = useCallback(() => {
    if (seenAtLeastOne.current) {
      try { localStorage.setItem(TOUR_FLAG, "1"); } catch { /* noop */ }
    }
    onDone();
  }, [onDone]);

  const next = useCallback(() => {
    if (isLast) finish();
    else setStepIdx(i => i + 1);
  }, [isLast, finish]);

  const back = useCallback(() => {
    setStepIdx(i => Math.max(0, i - 1));
  }, []);
  const isFirst = stepIdx === 0;

  // Locate the current target. Polls once per animation frame for
  // up to ~1.5s — covers the case where the sidebar is still sliding
  // in from the intro reveal when the tour mounts. If the target
  // never materialises (component conditionally rendered), advance
  // to the next step rather than freezing on a floating tooltip.
  useLayoutEffect(() => {
    let attempts = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const r = findRect(step.target);
      if (r) {
        setRect(r);
        seenAtLeastOne.current = true;
        return;
      }
      attempts += 1;
      if (attempts >= 90) {
        // Target never appeared — skip this step.
        if (isLast) finish();
        else setStepIdx(i => i + 1);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [step.target, isLast, finish]);

  // Track viewport + scroll/resize so the spotlight follows its
  // target. Cheap — just re-reads the rect, no React re-render
  // unless the rect actually changed.
  useEffect(() => {
    const onResize = () => {
      setWinSize({ w: window.innerWidth, h: window.innerHeight });
      setRect(findRect(step.target));
    };
    const onScroll = () => setRect(findRect(step.target));
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    const iv = setInterval(onScroll, 200);  // catches CSS transitions
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      clearInterval(iv);
    };
  }, [step.target]);

  // Esc closes the tour entirely (treat as skip).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault(); next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault(); back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, next, back]);

  // Fade-in mount tick.
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);

  // Don't paint anything until we've located the target. Without
  // this guard the overlay rendered briefly with a centered, anchorless
  // tooltip — which is exactly the "ortada ne alaka" complaint.
  if (!rect) return null;

  // ── Tooltip placement ──
  // Default to the step's preferred side; flip if it would land off-screen.
  let tipX = rect.x + rect.w + PADDING + TIP_GAP;
  let tipY = rect.y + rect.h / 2 - 80;
  let arrowSide: "left" | "right" | "top" | "bottom" = "left";
  const place = step.placement ?? "right";
  if (place === "right") {
    tipX = rect.x + rect.w + PADDING + TIP_GAP;
    tipY = rect.y + rect.h / 2 - 80;
    arrowSide = "left";
    if (tipX + TIP_W > winSize.w - 16) {
      tipX = rect.x - PADDING - TIP_GAP - TIP_W;
      arrowSide = "right";
    }
  } else if (place === "left") {
    tipX = rect.x - PADDING - TIP_GAP - TIP_W;
    tipY = rect.y + rect.h / 2 - 80;
    arrowSide = "right";
  } else if (place === "top") {
    tipX = rect.x + rect.w / 2 - TIP_W / 2;
    tipY = rect.y - PADDING - TIP_GAP - 160;
    arrowSide = "bottom";
    if (tipY < 16) {
      tipY = rect.y + rect.h + PADDING + TIP_GAP;
      arrowSide = "top";
    }
  } else if (place === "bottom") {
    tipX = rect.x + rect.w / 2 - TIP_W / 2;
    tipY = rect.y + rect.h + PADDING + TIP_GAP;
    arrowSide = "top";
  }
  // Clamp to viewport.
  tipX = Math.max(16, Math.min(tipX, winSize.w - TIP_W - 16));
  tipY = Math.max(16, Math.min(tipY, winSize.h - 200));

  // SVG path with rounded rectangular cutout. We draw the entire
  // viewport rect, then a counter-clockwise rounded rect for the
  // hole, and use evenodd fill so the dim only paints the donut.
  const cutout = {
    x: rect.x - PADDING,
    y: rect.y - PADDING,
    w: rect.w + PADDING * 2,
    h: rect.h + PADDING * 2,
    // 7px corner — close to the SideRow / chip element radii (5–6px)
    // so the spotlight reads as a tight outline of the actual element
    // rather than a generic rounded rectangle floating around it.
    r: 7,
  };

  const overlayD =
    `M0 0H${winSize.w}V${winSize.h}H0Z ` +
    `M${cutout.x + cutout.r} ${cutout.y} ` +
    `H${cutout.x + cutout.w - cutout.r} ` +
    `A${cutout.r} ${cutout.r} 0 0 1 ${cutout.x + cutout.w} ${cutout.y + cutout.r} ` +
    `V${cutout.y + cutout.h - cutout.r} ` +
    `A${cutout.r} ${cutout.r} 0 0 1 ${cutout.x + cutout.w - cutout.r} ${cutout.y + cutout.h} ` +
    `H${cutout.x + cutout.r} ` +
    `A${cutout.r} ${cutout.r} 0 0 1 ${cutout.x} ${cutout.y + cutout.h - cutout.r} ` +
    `V${cutout.y + cutout.r} ` +
    `A${cutout.r} ${cutout.r} 0 0 1 ${cutout.x + cutout.r} ${cutout.y} Z`;

  return createPortal(
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9500,
        opacity: mounted ? 1 : 0,
        transition: "opacity 0.25s ease",
        pointerEvents: "auto",
      }}
    >
      {/* Dim layer with rounded cutout */}
      <svg
        width={winSize.w}
        height={winSize.h}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <path d={overlayD} fillRule="evenodd" fill="rgba(8, 8, 8, 0.62)" />
      </svg>

      {/* Spotlight ring — soft brand-white outline so the user's eye
          lands on the target, not on us. */}
      <div
        style={{
          position: "absolute",
          left: cutout.x, top: cutout.y,
          width: cutout.w, height: cutout.h,
          borderRadius: cutout.r,
          border: "1px solid rgba(255,255,255,0.25)",
          boxShadow: "0 0 0 1px var(--secondary), 0 12px 36px rgba(0,0,0,0.5)",
          pointerEvents: "none",
          transition: "left 0.28s cubic-bezier(0.22,1,0.36,1), top 0.28s cubic-bezier(0.22,1,0.36,1), width 0.28s cubic-bezier(0.22,1,0.36,1), height 0.28s cubic-bezier(0.22,1,0.36,1)",
        }}
      />


      {/* Tooltip card */}
      <div
        role="dialog"
        aria-label={step.title}
        style={{
          position: "absolute",
          left: tipX, top: tipY,
          width: TIP_W,
          background: "var(--card)",
          border: "1px solid var(--c-brd)",
          borderRadius: 12,
          boxShadow: "0 18px 48px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35)",
          padding: 16,
          fontFamily: "inherit",
          color: "var(--c-high)",
          transition: "left 0.28s cubic-bezier(0.22,1,0.36,1), top 0.28s cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        {/* Step counter + skip */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 10,
        }}>
          <span style={{
            fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4,
            textTransform: "uppercase", color: "var(--c-low)",
            fontVariantNumeric: "tabular-nums",
          }}>
            {stepIdx + 1} / {STEPS.length}
          </span>
          <button
            onClick={finish}
            title="Skip tour"
            style={{
              width: 22, height: 22, borderRadius: 6,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--c-low)", transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "var(--secondary)";
              e.currentTarget.style.color = "var(--c-high)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--c-low)";
            }}
          >
            <X size={13} />
          </button>
        </div>

        <div style={{
          fontSize: 14.5, fontWeight: 600, lineHeight: 1.35,
          color: "var(--c-high)", marginBottom: 6,
        }}>
          {step.title}
        </div>
        <div style={{
          fontSize: 12.5, lineHeight: 1.55, color: "var(--c-med)",
          marginBottom: 14,
        }}>
          {step.body}
        </div>

        {/* Progress dots + Back / Next */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 8,
        }}>
          <div style={{ display: "flex", gap: 4 }}>
            {STEPS.map((_, i) => (
              <span key={i} style={{
                width: i === stepIdx ? 16 : 5, height: 5, borderRadius: 3,
                background: i === stepIdx ? "var(--c-high)" : "var(--c-brd)",
                transition: "width 0.18s, background 0.18s",
              }} />
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={back}
              disabled={isFirst}
              title="Back (←)"
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "6px 10px",
                borderRadius: 7,
                background: "transparent",
                border: "1px solid var(--c-brd)",
                cursor: isFirst ? "default" : "pointer", outline: "none",
                color: isFirst ? "var(--c-dim)" : "var(--c-med)",
                fontSize: 12.5, fontWeight: 500, fontFamily: "inherit",
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={e => {
                if (isFirst) return;
                e.currentTarget.style.background = "var(--secondary)";
                e.currentTarget.style.borderColor = "var(--c-brd)";
                e.currentTarget.style.color = "var(--c-high)";
              }}
              onMouseLeave={e => {
                if (isFirst) return;
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "var(--c-brd)";
                e.currentTarget.style.color = "var(--c-med)";
              }}
            >
              <ArrowLeft size={12} />
              Back
            </button>
            <button
              onClick={next}
              title={isLast ? "Finish (Enter)" : "Next (Enter / →)"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px",
                borderRadius: 7,
                background: "#52525b",
                border: "none", cursor: "pointer", outline: "none",
                color: "#ffffff",
                fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
                transition: "background 0.12s, transform 0.08s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "#3f3f46"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "#52525b"; }}
              onMouseDown={e => { e.currentTarget.style.transform = "translateY(0.5px)"; }}
              onMouseUp={e => { e.currentTarget.style.transform = "none"; }}
            >
              {isLast ? "Got it" : "Next"}
              {!isLast && <ArrowRight size={12} />}
            </button>
          </div>
        </div>

        {/* Arrow tip — small triangle pointing at the spotlight */}
        {(() => {
          const size = 8;
          const baseStyle: React.CSSProperties = {
            position: "absolute",
            width: 0, height: 0,
            borderStyle: "solid",
          };
          if (arrowSide === "left") {
            const ay = Math.max(14, Math.min(rect.y + rect.h / 2 - tipY, 130));
            return <span style={{
              ...baseStyle, top: ay - size, left: -size,
              borderWidth: `${size}px ${size}px ${size}px 0`,
              borderColor: `transparent var(--card) transparent transparent`,
            }} />;
          }
          if (arrowSide === "right") {
            const ay = Math.max(14, Math.min(rect.y + rect.h / 2 - tipY, 130));
            return <span style={{
              ...baseStyle, top: ay - size, right: -size,
              borderWidth: `${size}px 0 ${size}px ${size}px`,
              borderColor: `transparent transparent transparent var(--card)`,
            }} />;
          }
          if (arrowSide === "top") {
            const ax = Math.max(20, Math.min(rect.x + rect.w / 2 - tipX, TIP_W - 20));
            return <span style={{
              ...baseStyle, top: -size, left: ax - size,
              borderWidth: `0 ${size}px ${size}px ${size}px`,
              borderColor: `transparent transparent var(--card) transparent`,
            }} />;
          }
          if (arrowSide === "bottom") {
            const ax = Math.max(20, Math.min(rect.x + rect.w / 2 - tipX, TIP_W - 20));
            return <span style={{
              ...baseStyle, bottom: -size, left: ax - size,
              borderWidth: `${size}px ${size}px 0 ${size}px`,
              borderColor: `var(--card) transparent transparent transparent`,
            }} />;
          }
          return null;
        })()}
      </div>
    </div>,
    document.body,
  );
}
