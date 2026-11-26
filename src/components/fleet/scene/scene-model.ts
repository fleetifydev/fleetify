/**
 * The Fleet scene's data side: what the app writes into the Rive file.
 *
 * docs/FLEET_SCENE.md is the contract with the motion designer; the names and
 * enum values here mirror its view models one to one. The app decides where a
 * session rests (ring and angle, from orbit-layout.ts) and sends only state
 * changes, as a diff, never frames: the renderer animates between them on its
 * own clock and settles to zero frames when nothing moves.
 */
import type { OrbitPlacement, OrbitRing } from "../orbit-layout";

export type ScenePhase = "spawning" | "working" | "needs" | "done" | "leaving";
export type CoreState = "idle" | "busy" | "attention";
export type MotionLevel = "full" | "reduced" | "static";
export type SceneTrigger = "arrive" | "nudge" | "complete";

/** One item of the `sessions` list (the `Session` view model). */
export interface SceneSession {
  id: string;
  phase: ScenePhase;
  ring: OrbitRing;
  /** Degrees, 0 = right, clockwise. */
  slotAngle: number;
  /** 0 to 1: how much the agent is producing right now. */
  activity: number;
  /** The agent's brand colour, as #rrggbb. */
  accent: string;
}

/** The `FleetScene` view model. */
export interface SceneState {
  core: CoreState;
  motionLevel: MotionLevel;
  sessions: SceneSession[];
}

type SessionField = Exclude<keyof SceneSession, "id">;

/** One write into the scene. A renderer applies them in order. */
export type SceneOp =
  | { op: "append"; session: SceneSession }
  | { op: "remove"; id: string }
  | { op: "set"; id: string; field: SessionField; value: SceneSession[SessionField] }
  | { op: "fire"; id: string; trigger: SceneTrigger }
  | { op: "core"; value: CoreState }
  | { op: "motion"; value: MotionLevel };

const PHASE_OF_RING: Record<OrbitRing, ScenePhase> = { needs: "needs", working: "working", done: "done" };

/** Agent brand colours for the session mark. Unknown agents get a neutral grey. */
const ACCENT: Record<string, string> = {
  "claude-code": "#d97757",
  claude: "#d97757",
  "codex-cli": "#10a37f",
  opencode: "#a1a1aa",
  "cursor-cli": "#e5e5e5",
  "kimi-code": "#5b8def",
  "grok-build": "#e5e5e5",
  "antigravity-cli": "#4f8df5",
  "antigravity-sdk": "#4f8df5",
  "hermes-agent": "#c084fc",
};
export const accentFor = (tool: string | undefined): string => (tool && ACCENT[tool]) || "#9ca3af";

/** The core's state: attention beats busy beats idle. */
export function coreOf(sessions: Pick<SceneSession, "ring">[]): CoreState {
  if (sessions.some(s => s.ring === "needs")) return "attention";
  if (sessions.some(s => s.ring === "working")) return "busy";
  return "idle";
}

/** Build the scene from the orbit layout plus per-session live values. */
export function buildScene(
  placed: OrbitPlacement[],
  extra: (id: string) => { activity: number; accent: string },
  motionLevel: MotionLevel,
): SceneState {
  const sessions = placed.map(p => {
    const { activity, accent } = extra(p.id);
    return {
      id: p.id,
      phase: PHASE_OF_RING[p.ring],
      ring: p.ring,
      slotAngle: p.angle,
      activity: Math.min(1, Math.max(0, activity)),
      accent,
    };
  });
  return { core: coreOf(sessions), motionLevel, sessions };
}

const FIELDS: SessionField[] = ["phase", "ring", "slotAngle", "activity", "accent"];

/** The writes that turn `prev` into `next`. A null `prev` is an empty scene.
 *  Triggers: `arrive` for a new session, `nudge` when one moves to the inner
 *  ring, `complete` when one finishes. */
export function diffScene(prev: SceneState | null, next: SceneState): SceneOp[] {
  const ops: SceneOp[] = [];
  if (!prev || prev.motionLevel !== next.motionLevel) ops.push({ op: "motion", value: next.motionLevel });
  if (!prev || prev.core !== next.core) ops.push({ op: "core", value: next.core });

  const before = new Map((prev?.sessions ?? []).map(s => [s.id, s]));
  const after = new Set(next.sessions.map(s => s.id));
  for (const id of before.keys()) if (!after.has(id)) ops.push({ op: "remove", id });

  for (const s of next.sessions) {
    const old = before.get(s.id);
    if (!old) {
      ops.push({ op: "append", session: s }, { op: "fire", id: s.id, trigger: "arrive" });
      continue;
    }
    for (const field of FIELDS) {
      if (old[field] !== s[field]) ops.push({ op: "set", id: s.id, field, value: s[field] });
    }
    if (old.ring !== "needs" && s.ring === "needs") ops.push({ op: "fire", id: s.id, trigger: "nudge" });
    if (old.phase !== "done" && s.phase === "done") ops.push({ op: "fire", id: s.id, trigger: "complete" });
  }
  return ops;
}

/** Merge scene updates over `delayMs` and hand the renderer one diff per
 *  window, so a burst of session events becomes a single write. */
export function createSceneBatcher(apply: (ops: SceneOp[]) => void, delayMs = 150) {
  let applied: SceneState | null = null;
  let pending: SceneState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const ops = diffScene(applied, pending);
    applied = pending;
    pending = null;
    if (ops.length) apply(ops);
  };
  return {
    push(state: SceneState) {
      pending = state;
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    /** Apply what is pending now (on unmount, or when the window shows again). */
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
