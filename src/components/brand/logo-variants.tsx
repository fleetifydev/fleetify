/**
 * Fleetify logo mark — 8 variants for YC-application brand selection.
 *
 * Each variant is a single SVG primitive that:
 *   • renders crisply at 14px (favicon) AND 96px (splash)
 *   • uses currentColor so it themes to wherever it's dropped
 *   • is monochrome flat 2D — no gradients, no 3D, no organic curves
 *   • carries ONE concept (no decorated mash-ups)
 *
 * Drop one into `logo-mark.tsx` after picking via the gallery (see
 * logo-gallery.tsx — navigate to <app>/#logos).
 *
 * Concepts and what each says:
 *
 *   Trio   — three stacked tilted bars. Says "fleet in formation,
 *            moving forward". Most directly on-theme for the product.
 *   Asterisk — four-arm radiating burst. Says "central orchestrator
 *            broadcasting commands". Anthropic-adjacent but distinct.
 *   Wedge  — two chevrons pointing right. Says "motion, throughput".
 *   Sonar  — three nested semicircle arcs. Says "dispatch radiating".
 *   FBars  — lettermark F constructed from rounded bars. Says
 *            "brand name + multiplicity in one glyph".
 *   Compass — diamond needle inside thin ring. Says "command + direction".
 *   TriCells — outer triangle subdivided into 4 small triangles.
 *            Says "fleet = composition of agents".
 *   Wake   — swooping curve to a dot. Says "motion + arrival".
 */
import type { CSSProperties, ReactElement } from "react";

export interface LogoMarkProps {
  size?: number;
  /** Stroke / fill colour. Defaults to currentColor for theming. */
  color?: string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

type VariantComponent = (p: LogoMarkProps) => ReactElement;

const baseSvgProps = (size: number, label: string, className?: string, style?: CSSProperties) => ({
  role: "img" as const,
  "aria-label": label,
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  className,
  style: { display: "block" as const, ...style },
});

/* ─── 1. Trio — three stacked tilted bars (fleet formation) ──────── */
export const LogoTrio: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g transform="rotate(-6 12 12)">
      <rect x="2"  y="6"  width="20" height="2.4" rx="1.2" fill={color}/>
      <rect x="4"  y="11" width="16" height="2.4" rx="1.2" fill={color}/>
      <rect x="6"  y="16" width="12" height="2.4" rx="1.2" fill={color}/>
    </g>
  </svg>
);

/* ─── 2. Asterisk — four-arm radiating burst ─────────────────────── */
export const LogoAsterisk: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g stroke={color} strokeWidth="2.4" strokeLinecap="round">
      <line x1="12" y1="3"  x2="12" y2="21"/>
      <line x1="3"  y1="12" x2="21" y2="12"/>
      <line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/>
      <line x1="18.5" y1="5.5" x2="5.5"  y2="18.5"/>
    </g>
  </svg>
);

/* ─── 3. Wedge — two chevrons pointing right (motion / throughput) ─ */
export const LogoWedge: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <polyline points="5,5 13,12 5,19"/>
      <polyline points="11,5 19,12 11,19"/>
    </g>
  </svg>
);

/* ─── 4. Sonar — three nested arcs broadcasting from a point ─────── */
export const LogoSonar: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g stroke={color} strokeWidth="1.8" fill="none" strokeLinecap="round">
      <path d="M3 17 A9 9 0 0 1 21 17"/>
      <path d="M6.5 17 A5.5 5.5 0 0 1 17.5 17"/>
      <path d="M9.5 17 A2.5 2.5 0 0 1 14.5 17"/>
    </g>
    <circle cx="12" cy="17" r="1.2" fill={color}/>
  </svg>
);

/* ─── 5. FBars — lettermark F from rounded bars ─────────────────── */
export const LogoFBars: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g fill={color}>
      <rect x="5"  y="3"  width="3"  height="18" rx="1.5"/>
      <rect x="5"  y="3"  width="14" height="3"  rx="1.5"/>
      <rect x="5"  y="10" width="10" height="3"  rx="1.5"/>
    </g>
  </svg>
);

/* ─── 6. Compass — diamond needle inside ring ───────────────────── */
export const LogoCompass: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="1.6" fill="none"/>
    <path d="M12 4 L16 12 L12 20 L8 12 Z" fill={color}/>
  </svg>
);

/* ─── 7. TriCells — triangle subdivided into 4 (composition) ────── */
export const LogoTriCells: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g stroke={color} strokeWidth="1.8" strokeLinejoin="round" fill="none">
      <path d="M12 3 L21 19 L3 19 Z"/>
      <path d="M7.5 19 L12 11 L16.5 19"/>
    </g>
    <path d="M12 11 L16.5 19 L7.5 19 Z" fill={color}/>
  </svg>
);

/* ─── 8. Wake — sweeping curve to a dot (motion + arrival) ──────── */
export const LogoWake: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <path
      d="M3 19 Q11 19 14 13 T20 5"
      stroke={color}
      strokeWidth="2.6"
      strokeLinecap="round"
      fill="none"
    />
    <circle cx="20" cy="5" r="1.8" fill={color}/>
  </svg>
);


/* ═════════════════════════════════════════════════════════════════
   BATCH 2 — bolder visual language. Less safe-geometric, more
   distinctive: maritime metaphors, custom letterforms, negative
   space, off-kilter angles. Single bold idea each.
   ═════════════════════════════════════════════════════════════════ */

/* ─── 9. Sail — tilted parallelogram, single shape (Vercel-minimal) ─ */
export const LogoSail: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <path d="M5 19 L11 4 L19 19 Z" fill={color}/>
  </svg>
);

/* ─── 10. Mast — vertical line + 3 graduated flag bars ─────────── */
export const LogoMast: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g fill={color}>
      <rect x="6" y="3"  width="2.4" height="18" rx="1.2"/>
      <rect x="9" y="5"  width="11" height="2.4" rx="1.2"/>
      <rect x="9" y="10" width="8"  height="2.4" rx="1.2"/>
      <rect x="9" y="15" width="5"  height="2.4" rx="1.2"/>
    </g>
  </svg>
);

/* ─── 11. F-Cantilever — F where top bar floats past the stem ──── */
export const LogoFCantilever: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g fill={color}>
      {/* vertical stem */}
      <rect x="6" y="6" width="3" height="15" rx="1.4"/>
      {/* top bar — extends LEFT of the stem too, creating a cantilever */}
      <rect x="3" y="3" width="16" height="3" rx="1.4"/>
      {/* mid bar — short, no left extension */}
      <rect x="6" y="11" width="9" height="3" rx="1.4"/>
    </g>
  </svg>
);

/* ─── 12. Phase — disc with chord cut (moon phase / control state) ─ */
export const LogoPhase: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Solid disc with a smaller circle subtracted on the right —
        creates a crescent + dot pair. mask: the right disc cuts out
        the centre. */}
    <defs>
      <mask id="phase-mask">
        <rect x="0" y="0" width="24" height="24" fill="#fff"/>
        <circle cx="16" cy="12" r="6" fill="#000"/>
      </mask>
    </defs>
    <circle cx="12" cy="12" r="10" fill={color} mask="url(#phase-mask)"/>
    <circle cx="18" cy="12" r="2.2" fill={color}/>
  </svg>
);

/* ─── 13. Beacon — solid centre + 4 fan rays (premium control feel) ─ */
export const LogoBeacon: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* 4 wedge-shaped fan rays, slightly rotated — feels like a
        radiating beacon rather than a stiff cross. */}
    <g fill={color}>
      <path d="M12 2  L13.2 9 L10.8 9 Z"/>
      <path d="M12 22 L10.8 15 L13.2 15 Z"/>
      <path d="M2 12  L9 10.8 L9 13.2 Z"/>
      <path d="M22 12 L15 13.2 L15 10.8 Z"/>
      <circle cx="12" cy="12" r="2.6"/>
    </g>
  </svg>
);

/* ─── 14. Constellation — 4 dots + 3 connecting lines (network) ──── */
export const LogoConstellation: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Four nodes — top-left, mid-right, bottom-left + a smaller
        accent — connected by thin lines. Reads as "agents
        coordinating in formation". */}
    <g stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round">
      <line x1="6"  y1="6"  x2="18" y2="11"/>
      <line x1="18" y1="11" x2="7"  y2="18"/>
      <line x1="6"  y1="6"  x2="7"  y2="18"/>
    </g>
    <g fill={color}>
      <circle cx="6"  cy="6"  r="2.2"/>
      <circle cx="18" cy="11" r="2.2"/>
      <circle cx="7"  cy="18" r="2.2"/>
    </g>
  </svg>
);

/* ─── 15. Aperture — 3 angled blades meeting at centre ──────────── */
export const LogoAperture: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Three triangular blades rotated 120° apart — a camera
        aperture / iris. Premium tech feel. */}
    <g fill={color}>
      <path d="M12 12 L12 3  L19.8 7.5 Z"/>
      <path d="M12 12 L19.8 16.5 L4.2 16.5 Z"/>
      <path d="M12 12 L4.2 7.5  L12 3 Z" opacity="0.5"/>
    </g>
  </svg>
);

/* ─── 16. Trail — solid arrow + 2 trailing dashes (motion) ──────── */
export const LogoTrail: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    <g fill={color}>
      {/* trailing dashes — fading-back motion ticks */}
      <rect x="2"  y="11" width="3" height="2.5" rx="1.2" opacity="0.4"/>
      <rect x="6.5" y="11" width="4" height="2.5" rx="1.2" opacity="0.7"/>
      {/* main arrowhead */}
      <path d="M12 6 L21 12 L12 18 Z"/>
    </g>
  </svg>
);


/* ═════════════════════════════════════════════════════════════════
   BATCH 3 — sophistication. Multi-layer, organic curves, custom
   typography. Each is the most complex composition the visual
   language can support without losing favicon-readability.
   ═════════════════════════════════════════════════════════════════ */

/* ─── 17. Pulse Burst — 8 curved tapered rays (Anthropic-adjacent) ── */
export const LogoPulseBurst: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* 8 tapered teardrops radiating from centre. Drawn as paths
        so the tips are sharp + bases rounded — gives an organic
        "broadcasting" feel different from rigid lines. Inner +
        outer ring of 4 each, alternating long/short. */}
    <g fill={color}>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
        const longRay = i % 2 === 0;
        const len = longRay ? 9 : 6.5;
        return (
          <path
            key={deg}
            d={`M12 12 L13 ${12 - len + 1} Q12 ${12 - len} 11 ${12 - len + 1} Z`}
            transform={`rotate(${deg} 12 12)`}
          />
        );
      })}
      <circle cx="12" cy="12" r="2" fill={color}/>
    </g>
  </svg>
);

/* ─── 18. F Monogram — serif F with calligraphic flag terminal ──── */
export const LogoFMonogram: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* A custom-drawn F: serif terminal on the bottom of the stem,
        the top horizontal extends + curves up into a flag. Reads as
        a typographic mark, not a bar arrangement. */}
    <g fill={color}>
      {/* Stem with serif foot */}
      <path d="M5 3 L9.4 3 L9.4 21 L7.2 21.6 L5 21 Z"/>
      {/* Top horizontal that extends + has a flag terminal curving up */}
      <path d="M9.4 3 L18 3 Q21 3 20 7 L19 7 Q19 5 17.5 5 L9.4 5.5 Z"/>
      {/* Mid bar — short, classic F position */}
      <path d="M9.4 11 L15 11 L15 13 L9.4 13.5 Z"/>
    </g>
  </svg>
);

/* ─── 19. Iso Cluster — 3 isometric cubes stacked (3D fleet) ────── */
export const LogoIsoCluster: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Three isometric cubes — bottom-left, bottom-right, top.
        Each cube drawn as a flat 2D approximation: a hexagonal
        outline split into 3 rhombi (top face + two side faces).
        One face per cube highlighted (top), the rest at lower
        opacity — creates dimensional read at flat fill. */}
    <g stroke={color} strokeWidth="1.2" strokeLinejoin="round" fill="none">
      {/* Bottom-left cube */}
      <g transform="translate(0 8)">
        <path d="M3 4 L7 2 L11 4 L11 8 L7 10 L3 8 Z"/>
        <path d="M3 4 L7 6 L11 4"/>
        <path d="M7 6 L7 10"/>
      </g>
      {/* Bottom-right cube */}
      <g transform="translate(10 8)">
        <path d="M3 4 L7 2 L11 4 L11 8 L7 10 L3 8 Z"/>
        <path d="M3 4 L7 6 L11 4"/>
        <path d="M7 6 L7 10"/>
      </g>
      {/* Top cube — highlighted (filled top face) */}
      <g transform="translate(5 -1)">
        <path d="M3 4 L7 2 L11 4 L11 8 L7 10 L3 8 Z" fill={color} fillOpacity="0.15"/>
        <path d="M3 4 L7 6 L11 4 L7 2 Z" fill={color}/>
        <path d="M7 6 L7 10"/>
      </g>
    </g>
  </svg>
);

/* ─── 20. Wave Stack — 5 stacked waveform lines + focal dot ──────── */
export const LogoWaveStack: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Five horizontal sine fragments of varying length and opacity
        — agent activity over time. A solid focal dot at one peak
        anchors the composition. */}
    <g stroke={color} fill="none" strokeLinecap="round" strokeWidth="1.6">
      <path d="M3 6  Q7 3 11 6 T19 6"  opacity="0.35"/>
      <path d="M3 10 Q7 7 11 10 T21 10" opacity="0.65"/>
      <path d="M3 14 Q7 11 11 14 T19 14"/>
      <path d="M3 18 Q7 15 11 18 T17 18" opacity="0.65"/>
    </g>
    <circle cx="11" cy="14" r="1.8" fill={color}/>
  </svg>
);

/* ─── 21. Knot — two interlocking arcs (binding/coordination) ───── */
export const LogoKnot: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Two arcs that visually interlock — one ring "passes through"
        the other via stroke-dasharray gap. Pure 2D but reads as
        woven. Premium "infinite coordination" vibe. */}
    <g stroke={color} fill="none" strokeWidth="2.2" strokeLinecap="round">
      {/* Left ring */}
      <circle cx="9" cy="12" r="6"/>
      {/* Right ring with a calculated gap so the left ring appears
          to pass through it */}
      <path d="M21 12 A6 6 0 1 1 15.4 7.2"/>
      <path d="M9 12 m6 0 a6 6 0 0 0 5 -3" opacity="0.001"/>
      <path d="M19 17 A6 6 0 0 1 14.6 17"/>
    </g>
  </svg>
);

/* ─── 22. Crown Spike — vertical asymmetric spires (premium signal) ─ */
export const LogoCrownSpike: VariantComponent = ({
  size = 24, color = "currentColor", className, style, ariaLabel = "Fleetify",
}) => (
  <svg {...baseSvgProps(size, ariaLabel, className, style)}>
    {/* Three vertical spires of decreasing height, base anchored
        on a horizontal rail. Asymmetric arrangement — the eye
        catches the rhythm. Crown / signal-tower / fleet-of-masts
        feel, but abstracted enough to not be literal. */}
    <g fill={color}>
      <path d="M5 21 L5 8 L7 6 L7 21 Z"/>
      <path d="M10 21 L10 4 L12 2 L12 21 Z"/>
      <path d="M15 21 L15 11 L17 9 L17 21 Z"/>
      <rect x="3" y="20" width="16" height="2" rx="1"/>
    </g>
  </svg>
);


/** Registry — drives the gallery + lets the user pick by id.
 *  Listed Batch 3 → Batch 2 → Batch 1 so the most sophisticated
 *  appears first. */
export const LOGO_VARIANTS: Array<{
  id: string;
  name: string;
  concept: string;
  Component: VariantComponent;
}> = [
  // Batch 3 — sophistication: multi-layer, organic, custom typography
  { id: "pulseBurst",  name: "Pulse Burst",  concept: "Eight tapered rays of alternating length radiating from centre — organic broadcast, Anthropic-adjacent.", Component: LogoPulseBurst },
  { id: "fMonogram",   name: "F Monogram",   concept: "Custom serif F with calligraphic flag terminal — typographic mark, brand-letter forward.", Component: LogoFMonogram },
  { id: "isoCluster",  name: "Iso Cluster",  concept: "Three isometric cubes stacked, top one highlighted — fleet of agents, dimensional read.", Component: LogoIsoCluster },
  { id: "waveStack",   name: "Wave Stack",   concept: "Five sine fragments of varying length + focal dot — agent activity over time.", Component: LogoWaveStack },
  { id: "knot",        name: "Knot",         concept: "Two interlocking rings — coordination, infinite binding, premium signal.", Component: LogoKnot },
  { id: "crownSpike",  name: "Crown Spike",  concept: "Three vertical spires on a rail — asymmetric crown / signal-tower fleet.", Component: LogoCrownSpike },

  // Batch 2 — bolder, more distinctive
  { id: "sail",          name: "Sail",          concept: "Bold solid triangle (sail silhouette) — direct fleet metaphor, Vercel-minimal.", Component: LogoSail },
  { id: "mast",          name: "Mast",          concept: "Vertical mast with three graduated flag bars — maritime, multiplicity, hierarchy.", Component: LogoMast },
  { id: "fCantilever",   name: "F Cantilever",  concept: "Custom F where the top bar overhangs the stem — implies motion + brand letter.", Component: LogoFCantilever },
  { id: "phase",         name: "Phase",         concept: "Crescent disc + accent dot — control phase, partnership, premium minimal.", Component: LogoPhase },
  { id: "beacon",        name: "Beacon",        concept: "Solid centre + four wedge rays — premium control-tower / radiating dispatch.", Component: LogoBeacon },
  { id: "constellation", name: "Constellation", concept: "Three nodes connected by thin lines — agents coordinating in a network.", Component: LogoConstellation },
  { id: "aperture",      name: "Aperture",      concept: "Three triangular blades meeting at centre — camera-iris precision, premium tech.", Component: LogoAperture },
  { id: "trail",         name: "Trail",         concept: "Solid arrow with two fading trailing ticks — motion, throughput, command-flow.", Component: LogoTrail },

  // Batch 1 — earlier, safer-geometric set
  { id: "trio",     name: "Trio",      concept: "Three stacked tilted bars — fleet in formation, moving forward.",            Component: LogoTrio },
  { id: "asterisk", name: "Asterisk",  concept: "Four-arm radiating burst — central orchestrator broadcasting commands.",     Component: LogoAsterisk },
  { id: "wedge",    name: "Wedge",     concept: "Two chevrons pointing right — motion, throughput, forward propulsion.",       Component: LogoWedge },
  { id: "sonar",    name: "Sonar",     concept: "Three nested arcs from a point — dispatch radiating to the fleet.",           Component: LogoSonar },
  { id: "fbars",    name: "F-Bars",    concept: "Lettermark F from rounded bars — brand name + multiplicity in one glyph.",   Component: LogoFBars },
  { id: "compass",  name: "Compass",   concept: "Diamond needle inside thin ring — command + direction.",                       Component: LogoCompass },
  { id: "tricells", name: "Tri-Cells", concept: "Outer triangle subdivided — fleet as composition of cooperating cells.",      Component: LogoTriCells },
  { id: "wake",     name: "Wake",      concept: "Sweeping curve to a dot — motion + arrival, trail-of-action.",                 Component: LogoWake },
];
