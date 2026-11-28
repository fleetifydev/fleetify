/** How Fleet's camera travels from one view to another.
 *
 *  A view is (cx, cy, w): the world point at the centre of the safe view and the
 *  world width visible. Long moves follow van Wijk & Nuij's smooth zoom path
 *  ("Smooth and efficient zooming and panning", 2003): zoom out a little, pan,
 *  zoom back in, so the user keeps their bearings. This is d3-interpolate's
 *  interpolateZoom, ported. Short moves ("nudges") interpolate straight, in log
 *  width. Durations follow the path length, within bounds. */

export type View = [cx: number, cy: number, w: number];

const RHO = Math.SQRT2;
const cosh = (x: number) => { const e = Math.exp(x); return (e + 1 / e) / 2; };
const sinh = (x: number) => { const e = Math.exp(x); return (e - 1 / e) / 2; };
const tanh = (x: number) => { const e = Math.exp(2 * x); return (e - 1) / (e + 1); };

/** The van Wijk–Nuij path from a to b, and its natural duration in ms. */
export function zoomPath(a: View, b: View): { at: (t: number) => View; duration: number } {
  const [ux0, uy0, w0] = a, [ux1, uy1, w1] = b;
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  const rho2 = RHO * RHO, rho4 = rho2 * rho2;
  if (d2 < 1e-12) {
    const S = Math.log(w1 / w0) / RHO;
    return { at: t => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * S)], duration: Math.abs(S) * 1000 };
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  return {
    at: t => {
      const s = t * S, c0 = cosh(r0);
      const u = (w0 / (rho2 * d1)) * (c0 * tanh(RHO * s + r0) - sinh(r0));
      return [ux0 + u * dx, uy0 + u * dy, (w0 * c0) / cosh(RHO * s + r0)];
    },
    duration: (S * 1000 * RHO) / Math.SQRT2,
  };
}

export const FLIGHT = { SHORT: 260, MIN: 420, MAX: 1100, SPEED: 0.6 };

export interface Flight { t0: number; dur: number; at: (t: number) => View; ease: (u: number) => number }

const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/** Plan a flight. A move under a quarter of the view with little zoom is a nudge.
 *  The user's own requests answer at once (ease-out); automatic moves start
 *  gently (ease-in-out), so one beginning at the edge of sight is no jolt. */
export function planFlight(from: View, to: View, who: "user" | "auto", t0: number, reduced = false): Flight {
  const ease = who === "user" ? easeOut : easeInOut;
  if (reduced) return { t0, dur: 0, at: () => to, ease };
  const moved = Math.hypot(to[0] - from[0], to[1] - from[1]) / from[2];
  const ratio = Math.max(to[2] / from[2], from[2] / to[2]);
  if (moved < 0.25 && ratio < 1.15) {
    const lw0 = Math.log(from[2]), lw1 = Math.log(to[2]);
    return { t0, dur: FLIGHT.SHORT, ease, at: t => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, Math.exp(lw0 + (lw1 - lw0) * t)] };
  }
  const path = zoomPath(from, to);
  return { t0, dur: Math.min(FLIGHT.MAX, Math.max(FLIGHT.MIN, path.duration * FLIGHT.SPEED)), at: path.at, ease };
}

/** Where a flight is at `now`, and whether it has landed. */
export function stepFlight(f: Flight, now: number): { view: View; done: boolean } {
  const u = f.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - f.t0) / f.dur));
  return { view: f.at(f.ease(u)), done: u >= 1 };
}
