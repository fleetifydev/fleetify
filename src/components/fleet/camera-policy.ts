/** When Fleet's camera moves on its own, and where to. A pure function of what
 *  happened and what the user is doing, so it can be tested without a screen.
 *
 *  The rules come from how maps, design tools and strategy games treat an
 *  automatic camera (notes: .claude/mockups/refs/camera.md):
 *  - the moment the user steers, the camera is theirs, until they hand it back
 *    (the hub, the Auto button) or leave it alone for a while;
 *  - only a question or a permission request moves the camera; a failure, a new
 *    agent or a finished one is shown in place, or by a chip at the edge of the
 *    view when it is off screen;
 *  - the camera never moves while the user is reading (pointer resting on a
 *    card, scrolling in one, typing, selecting, a card they opened);
 *  - right after the user answers is the moment to show the next question;
 *  - coming back to the window is the moment to show what waited;
 *  - no move to what is already in view, none twice in quick succession, none
 *    to the same card again within a cooldown, and no stale replay: a deferred
 *    move is decided again from scratch when the moment comes. */

/** "overview" frames every agent still at work; "attend" holds a question in
 *  view; "user" means the user has the camera and it never moves on its own. */
export type Base = "overview" | "attend" | "user";

export const CAM = {
  /** no automatic move this soon after the user steered */
  STEER_QUIET: 1500,
  /** a pointer moving over the canvas defers moves this long */
  POINTER_QUIET: 1500,
  /** resting on a card this long counts as reading */
  HOVER_READ: 400,
  /** reading lasts this long after its last sign */
  READ_GRACE: 1500,
  /** idle time after which a camera the user took is handed back */
  RESUME_IDLE: 30000,
  RESUME_MIN: 15000,
  RESUME_MAX: 120000,
  /** an auto move undone this soon by the user counts as rejected */
  REJECT_WINDOW: 3000,
  /** a focused but idle window this long behaves like a wall display */
  AMBIENT_IDLE: 20000,
  /** pause after an answer, so the user sees the result, before moving on */
  AFTER_ANSWER: 1200,
  /** fleet changes are gathered this long into one decision */
  EVENT_BATCH: 400,
  /** the layout must be still this long before the overview reframes */
  LAYOUT_SETTLE: 600,
  /** at least this long between two automatic moves */
  MIN_GAP: 2500,
  /** no automatic return to the same card within this */
  SAME_TARGET_COOLDOWN: 30000,
  /** after the window shows again, before the welcome-back move */
  RETURN_DELAY: 350,
};

export interface PolicyState {
  base: Base;
  /** the question being held in view */
  attendId: string | null;
  lastAutoAt: number;
  lastTargetAt: Record<string, number>;
  /** the idle time before a taken camera is handed back; grows when the user undoes moves */
  resumeIdle: number;
  /** when the question in view was answered, to move on after a pause */
  answeredAt: number | null;
}

export type Frame = "live" | { id: string };
export type Cmd = { kind: "none" } | { kind: "fly"; frame: Frame };

/** What the policy is told about the moment. */
export interface Ctx {
  now: number;
  /** the one gate: not steering, not reading, the pointer not busy (unless ambient) */
  mayMove: boolean;
  /** reading: resting on, scrolling in, typing in, selecting in, or having opened a card */
  reading: boolean;
  /** ms since the user's last input of any kind */
  idleFor: number;
  /** questions and permission requests still open, oldest first */
  waiting: string[];
  /** a card fully in view at a readable zoom */
  inView: (id: string) => boolean;
  /** no agent at work is in view at all */
  liveOutOfView: boolean;
  /** the overview frame no longer fits the agents at work (one is clipped, or they shrank to a corner) */
  overviewStale: boolean;
  /** ms the layout has been still */
  layoutStill: number;
}

export type CamEvent =
  /** what changed in the fleet, gathered over EVENT_BATCH */
  | { type: "changes"; needs: string[]; failed: string[]; fresh: string[]; resolved: string[] }
  /** the user moved the camera themself */
  | { type: "steer" }
  /** the user asked the camera to take over again (the hub, the Auto button) */
  | { type: "recenter" }
  /** the window shows again after being hidden */
  | { type: "return" }
  /** a periodic look at deferred work */
  | { type: "tick" };

export const initialPolicy = (): PolicyState => ({ base: "overview", attendId: null, lastAutoAt: -Infinity, lastTargetAt: {}, resumeIdle: CAM.RESUME_IDLE, answeredAt: null });

const none: Cmd = { kind: "none" };

/** May the camera fly to this card now? Not in view already, not too soon, not again so soon. */
function canFlyTo(s: PolicyState, id: string, ctx: Ctx): boolean {
  if (ctx.inView(id)) return false;
  if (ctx.now - s.lastAutoAt < CAM.MIN_GAP) return false;
  const last = s.lastTargetAt[id];
  return last === undefined || ctx.now - last >= CAM.SAME_TARGET_COOLDOWN;
}

function flyTo(s: PolicyState, id: string, now: number): [PolicyState, Cmd] {
  return [{ ...s, base: "attend", attendId: id, lastAutoAt: now, lastTargetAt: { ...s.lastTargetAt, [id]: now }, answeredAt: null }, { kind: "fly", frame: { id } }];
}

function flyLive(s: PolicyState, now: number): [PolicyState, Cmd] {
  return [{ ...s, base: "overview", attendId: null, lastAutoAt: now, answeredAt: null }, { kind: "fly", frame: "live" }];
}

export function decide(s: PolicyState, ev: CamEvent, ctx: Ctx): [PolicyState, Cmd] {
  const { now } = ctx;
  switch (ev.type) {
    case "steer": {
      // undoing an automatic move right away teaches the camera to wait longer
      const rejected = s.base !== "user" && now - s.lastAutoAt < CAM.REJECT_WINDOW;
      return [{ ...s, base: "user", answeredAt: null, resumeIdle: rejected ? Math.min(CAM.RESUME_MAX, s.resumeIdle * 2) : s.resumeIdle }, none];
    }

    case "recenter": {
      const next = { ...s, base: "overview" as Base, lastAutoAt: -Infinity };
      const first = ctx.waiting[0];
      return first ? flyTo(next, first, now) : flyLive(next, now);
    }

    case "return": {
      const first = ctx.waiting[0];
      if (!first || ctx.reading) return [s, none];
      if (s.base === "user" && ctx.idleFor < s.resumeIdle) return [s, none];
      return ctx.inView(first) ? [s, none] : flyTo({ ...s, lastAutoAt: -Infinity }, first, now);
    }

    case "changes": {
      let st = s;
      // the question in view was answered (or went away): move on after a pause
      if (st.base === "attend" && st.attendId && ev.resolved.includes(st.attendId)) st = { ...st, answeredAt: now };
      if (st.base !== "overview") return [st, none];
      // a new question is the one thing that moves the camera; the oldest open one goes first
      if (ev.needs.length) {
        const first = ctx.waiting[0];
        if (first && ctx.mayMove && canFlyTo(st, first, ctx)) return flyTo(st, first, now);
        return [st, none];
      }
      // a failure or a new agent off screen widens the overview, never a flight to it
      const outside = [...ev.failed, ...ev.fresh].some(id => !ctx.inView(id));
      if (outside && ctx.mayMove && now - st.lastAutoAt >= CAM.MIN_GAP) return flyLive(st, now);
      return [st, none];
    }

    case "tick": {
      let st = s;
      // the question in view went away without being answered here: same as an answer
      if (st.base === "attend" && st.attendId && !ctx.waiting.includes(st.attendId) && st.answeredAt === null) st = { ...st, answeredAt: now };
      // after an answer: the next question, or back to the work
      if (st.answeredAt !== null && now - st.answeredAt >= CAM.AFTER_ANSWER) {
        if (!ctx.mayMove) return [st, none];
        const next = ctx.waiting.find(id => id !== st.attendId);
        const base = { ...st, answeredAt: null, lastAutoAt: -Infinity };
        if (next && !ctx.inView(next)) return flyTo(base, next, now);
        return flyLive(base, now);
      }
      if (st.base === "user") {
        // left alone long enough: hand the camera back, moving only if something needs it
        if (ctx.idleFor < st.resumeIdle || ctx.reading) return [st, none];
        const first = ctx.waiting[0];
        const back = { ...st, base: "overview" as Base };
        if (first && !ctx.inView(first)) return flyTo({ ...back, lastAutoAt: -Infinity }, first, now);
        if (ctx.liveOutOfView) return flyLive(back, now);
        return [back, none];
      }
      if (st.base === "overview" && ctx.mayMove) {
        // a question that waited for a calmer moment
        const first = ctx.waiting[0];
        if (first && canFlyTo(st, first, ctx)) return flyTo(st, first, now);
        // the overview drifted out of true: reframe once the layout is still
        if (ctx.overviewStale && ctx.layoutStill >= CAM.LAYOUT_SETTLE && now - st.lastAutoAt >= CAM.MIN_GAP) return flyLive(st, now);
      }
      return [st, none];
    }
  }
}
