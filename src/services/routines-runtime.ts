/**
 * Routines runtime — fires routines on schedule, records runs.
 *
 * Lives on the renderer side because the routine catalogue lives in
 * localStorage (no backend wiring yet) and the execution shape it
 * needs (createSession + wsManager.send) is renderer-only. This will
 * move to a backend cron the moment routines are persisted server-
 * side, but for the MVP this gets the loop end-to-end.
 *
 * Lifecycle:
 *   - init()   — call once at app boot. Starts the tick loop.
 *   - runNow(routineId) — fire a routine manually.
 *
 * Tick loop (every TICK_MS = 30s):
 *   - For each routine, compute the next fire-at time using the
 *     stored runs history. If now >= next-fire-at AND no run is
 *     currently in-flight for the routine, fire it.
 *   - First run for a non-manual routine fires immediately when the
 *     ticker observes a routine that has zero runs.
 */
import { createSession } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";

export type Schedule = "manual" | "hourly" | "daily" | "weekdays" | "weekly";
export type Provider = "claude" | "codex" | "gemini";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
export type Target = "new" | "resume";

export interface Routine {
  id: string;
  name: string;
  description: string;
  instructions: string;

  target: Target;
  permissionMode: PermissionMode;

  // "new" target
  projectPath: string;
  provider: Provider;
  modelId: string;
  useWorktree: boolean;
  agentTemplate: string | null;

  // "resume" target
  resumeSessionId: string | null;

  schedule: Schedule;
  scheduleTime: string;
  createdAt: string;

  // Whether the schedule is currently active. Undefined = true (old
  // records predate this field). When false, the tick loop skips this
  // routine — the user has explicitly paused its automatic runs.
  enabled?: boolean;

  // Auto-resume: for "new session" routines, the first successful run
  // pins its session here so subsequent runs reuse it instead of
  // starting from scratch. The agent already has the context — no
  // need to re-investigate every cron tick. Cleared if the user
  // deletes the session out from under us.
  rollingSessionId?: string | null;

  // Tracks the instructions text we last fed into the rolling
  // session. When the user edits the routine, this lets execute()
  // detect a delta and send a "your instructions changed" prefix so
  // the agent updates its prior work (e.g. modify the cron entry it
  // already created) instead of either ignoring the change or
  // duplicating its output.
  lastSentInstructions?: string;
}

export function isEnabled(r: Routine): boolean {
  return r.enabled !== false;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "error";
  sessionId: string | null;
  error?: string;
}

const ROUTINES_KEY = "fleet:routines:v2";
const RUNS_KEY = "fleet:routines:runs:v1";
const SPAWNED_KEY = "fleet:routines:spawned:v1"; // sessionIds spawned by routines
const RUNS_CAP = 200;        // keep localStorage from ballooning
const TICK_MS = 30_000;      // 30 s tick

/* ── Storage helpers ──────────────────────────────────────────────── */

export function loadRoutines(): Routine[] {
  try {
    const raw = localStorage.getItem(ROUTINES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveRoutines(rs: Routine[]) {
  try { localStorage.setItem(ROUTINES_KEY, JSON.stringify(rs)); } catch { /* quota */ }
}

export function loadRuns(): RoutineRun[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveRuns(rs: RoutineRun[]) {
  try { localStorage.setItem(RUNS_KEY, JSON.stringify(rs.slice(0, RUNS_CAP))); } catch { /* quota */ }
}

export function runsForRoutine(routineId: string, runs?: RoutineRun[]): RoutineRun[] {
  const all = runs ?? loadRuns();
  return all.filter(r => r.routineId === routineId);
}

/* Sessions spawned by a "new"-target routine. The sidebar filters
   these out so background routine work doesn't clutter the user's
   own agent list. Stored as a plain string[] in localStorage (not a
   Set) so JSON serialisation is trivial. */
export function loadSpawnedSessionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SPAWNED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}

function saveSpawnedSessionIds(ids: Set<string>) {
  try { localStorage.setItem(SPAWNED_KEY, JSON.stringify([...ids])); } catch { /* quota */ }
}

function markSpawned(sessionId: string) {
  const set = loadSpawnedSessionIds();
  if (set.has(sessionId)) return;
  set.add(sessionId);
  saveSpawnedSessionIds(set);
  notify();
}

export function unmarkSpawned(sessionId: string) {
  const set = loadSpawnedSessionIds();
  if (!set.has(sessionId)) return;
  set.delete(sessionId);
  saveSpawnedSessionIds(set);
  notify();
}

/** Most-recent run for a routine (any status). */
export function lastRunFor(routineId: string, runs?: RoutineRun[]): RoutineRun | null {
  const list = runsForRoutine(routineId, runs);
  if (list.length === 0) return null;
  return list.reduce((a, b) => (Date.parse(a.startedAt) > Date.parse(b.startedAt) ? a : b));
}

/* ── Schedule math ────────────────────────────────────────────────── */

/** Compute the next firing time for a routine, given the last run.
 *  Returns null for "manual" schedules. */
export function nextFireAt(routine: Routine, lastRun: RoutineRun | null): Date | null {
  if (routine.schedule === "manual") return null;
  // First run of a non-manual routine: fire as soon as the next tick
  // observes it. We return "epoch" so the comparison `now >= next`
  // always wins immediately.
  if (!lastRun) return new Date(0);

  const base = new Date(lastRun.startedAt);
  if (routine.schedule === "hourly") {
    const next = new Date(base);
    next.setHours(base.getHours() + 1);
    return next;
  }
  const parts = routine.scheduleTime.split(":").map(Number);
  const h = parts[0] ?? NaN;
  const m = parts[1] ?? NaN;
  if (isNaN(h) || isNaN(m)) return null;
  const candidate = new Date(base);
  candidate.setDate(candidate.getDate() + 1);
  candidate.setHours(h, m, 0, 0);
  if (routine.schedule === "weekdays") {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
  } else if (routine.schedule === "weekly") {
    const target = new Date(routine.createdAt).getDay();
    while (candidate.getDay() !== target) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return candidate;
}

/* ── Run logging (with subscriber broadcast) ──────────────────────── */

type Listener = () => void;
// Stash the listener set on window so HMR module reloads don't orphan
// subscribers — a fresh module would otherwise own a brand-new empty
// Set while the components are still pointing at the old one.
const W = typeof window !== "undefined" ? (window as unknown as { __fleetRoutineListeners?: Set<Listener> }) : null;
const listeners: Set<Listener> = W?.__fleetRoutineListeners ?? new Set<Listener>();
if (W) W.__fleetRoutineListeners = listeners;

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function notify() { for (const l of listeners) l(); }

// React to localStorage writes from other tabs (or our own writes in
// dev tools) so the UI also stays in sync there.
if (typeof window !== "undefined" && !(window as unknown as { __fleetRoutineStorageBound?: boolean }).__fleetRoutineStorageBound) {
  window.addEventListener("storage", (e) => {
    if (e.key === RUNS_KEY || e.key === ROUTINES_KEY) notify();
  });
  (window as unknown as { __fleetRoutineStorageBound?: boolean }).__fleetRoutineStorageBound = true;
}

function appendRun(run: RoutineRun) {
  const all = loadRuns();
  all.unshift(run); // newest first
  saveRuns(all);
  notify();
}

function updateRun(id: string, patch: Partial<RoutineRun>) {
  const all = loadRuns();
  const idx = all.findIndex(r => r.id === id);
  if (idx < 0) return;
  const current = all[idx];
  if (!current) return;
  all[idx] = { ...current, ...patch };
  saveRuns(all);
  notify();
}

/* ── Execution ────────────────────────────────────────────────────── */

const inflight = new Set<string>(); // routineId → currently running

/* Poll chat-store's `isStreaming` for a session: wait for it to begin
   (so we don't return immediately if the WS is still warming up),
   then wait for it to end. Bounded by both a start timeout and a
   hard maximum stream length, and abortable via `cancelToken`. */
async function waitForStreamComplete(
  sessionId: string,
  opts: { startTimeoutMs: number; maxStreamMs: number; cancelToken: () => boolean },
): Promise<void> {
  const isStreaming = () => !!useChatStore.getState().sessions[sessionId]?.isStreaming;
  // Phase 1 — wait for the stream to begin.
  const startDeadline = Date.now() + opts.startTimeoutMs;
  while (Date.now() < startDeadline) {
    if (opts.cancelToken()) return;
    if (isStreaming()) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!isStreaming()) return; // never started; treat as done
  // Phase 2 — wait for it to end (or timeout).
  const endDeadline = Date.now() + opts.maxStreamMs;
  while (Date.now() < endDeadline) {
    if (opts.cancelToken()) return;
    if (!isStreaming()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  // Timed out — treat as done; the agent may keep working but we
  // don't want the run record stuck "running" indefinitely.
}

async function execute(routine: Routine): Promise<void> {
  if (inflight.has(routine.id)) {
    console.warn("[routines] skip — already running:", routine.name);
    return;
  }
  inflight.add(routine.id);

  const run: RoutineRun = {
    id: crypto.randomUUID(),
    routineId: routine.id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    sessionId: null,
  };
  appendRun(run);
  console.info("[routines] start", routine.name, "→ run", run.id);

  try {
    let sessionId: string;
    if (routine.target === "resume") {
      if (!routine.resumeSessionId) {
        throw new Error("Routine targets a session that no longer exists");
      }
      sessionId = routine.resumeSessionId;
    } else {
      // Auto-resume: if a prior run already spawned a session and
      // it's still alive in the store, reuse it so the agent builds
      // on prior context instead of re-investigating the same task
      // from scratch every cron tick. Falls through to a fresh spawn
      // if the session is gone (archived, removed, stale storage).
      const sessions = useAppStore.getState().sessions;
      const rolling = routine.rollingSessionId
        ? sessions.find(x => x.id === routine.rollingSessionId)
        : null;
      if (rolling) {
        sessionId = rolling.id;
      } else {
        if (!routine.projectPath?.trim()) {
          throw new Error("New-session routines need a project folder");
        }
        const s = await createSession({
          title: routine.name || "Routine",
          project_path: routine.projectPath,
          tool: routine.provider,
          model_name: routine.modelId,
          permission_mode: routine.permissionMode,
          session_mode: "new",
          agent_template: routine.agentTemplate ?? undefined,
          use_worktree: routine.useWorktree,
        });
        sessionId = s.id;
        // Mark BEFORE adding to the store so the sidebar's filter sees
        // the spawn flag in the same render cycle the session lands —
        // otherwise the session briefly flashes in the sidebar before
        // the next notify fires the hide.
        markSpawned(sessionId);
        useAppStore.getState().addSession(s);

        // Pin this session as the rolling target so the next tick
        // resumes it. Persist immediately — if the process dies
        // before the run finishes, we still want the next tick to
        // continue on the same session.
        const all = loadRoutines();
        const idx = all.findIndex(r => r.id === routine.id);
        if (idx >= 0) {
          const current = all[idx]!;
          all[idx] = { ...current, rollingSessionId: sessionId };
          saveRoutines(all);
          notify();
        }
      }
    }

    updateRun(run.id, { sessionId });

    if (routine.instructions.trim()) {
      // Re-read the routine fresh so we see the most recent
      // lastSentInstructions even if it was updated mid-run.
      const fresh = loadRoutines().find(r => r.id === routine.id) ?? routine;
      const prevSent = fresh.lastSentInstructions;
      const changed = prevSent !== undefined && prevSent !== routine.instructions;

      // If the agent has prior context (lastSentInstructions is set)
      // and the user edited the instructions, prefix the new prompt
      // with an explicit delta. Otherwise just send the instructions.
      // This lets the agent UPDATE its previous setup (e.g. modify
      // the existing crontab entry it created) instead of either
      // ignoring the change or duplicating its prior work.
      const prompt = changed
        ? [
            "The routine's instructions have been updated. Review your previous work and apply the changes below.",
            "",
            "─── Previous instructions ───",
            prevSent!.trim(),
            "",
            "─── New instructions ───",
            routine.instructions.trim(),
            "",
            "Please update what you set up before so it matches the new instructions.",
          ].join("\n")
        : routine.instructions;

      await wsManager.ensureConnected(sessionId);
      await wsManager.send(sessionId, prompt);

      // Record what we just sent so the NEXT run can detect future
      // edits. Persist before waitForStreamComplete so even if the
      // stream gets stuck or the user pauses, the delta tracking
      // stays accurate.
      const all = loadRoutines();
      const idx = all.findIndex(r => r.id === routine.id);
      if (idx >= 0) {
        const current = all[idx]!;
        all[idx] = { ...current, lastSentInstructions: routine.instructions };
        saveRoutines(all);
        notify();
      }

      // wsManager.send only QUEUES the prompt — the actual work
      // happens as the assistant streams. Don't mark the run as
      // "ok" until that stream ends; otherwise the row's Stop
      // button (which only renders on a running run) is gone
      // while the agent is still doing real work.
      await waitForStreamComplete(sessionId, {
        startTimeoutMs: 30_000,      // 30s for the stream to begin
        maxStreamMs:    10 * 60_000, // hard cap so a stuck stream eventually completes
        cancelToken:    () => !inflight.has(routine.id), // user pressed Stop
      });
    }

    updateRun(run.id, {
      status: "ok",
      finishedAt: new Date().toISOString(),
    });
    console.info("[routines] ok", routine.name, "session:", sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Routine failed";
    console.error("[routines] error", routine.name, msg);
    updateRun(run.id, {
      status: "error",
      finishedAt: new Date().toISOString(),
      error: msg,
    });
    // Surface the failure to the user — without this, a misconfigured
    // routine fails silently and the Routines page just shows a red
    // status the user has to dig into to understand.
    try {
      useAppStore.getState().pushNotification({
        id: crypto.randomUUID(),
        sessionId: "",
        title: `Routine "${routine.name}" failed`,
        summary: msg,
        success: false,
        timestamp: Date.now(),
      });
    } catch { /* notification store unavailable */ }
  } finally {
    inflight.delete(routine.id);
  }
}

/* ── Tick loop ───────────────────────────────────────────────────── */

let tickTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

function tick() {
  const routines = loadRoutines();
  const runs = loadRuns();
  const now = Date.now();
  for (const r of routines) {
    if (r.schedule === "manual") continue;
    if (!isEnabled(r)) continue;            // user paused the schedule
    if (inflight.has(r.id)) continue;
    const last = lastRunFor(r.id, runs);
    const next = nextFireAt(r, last);
    if (!next) continue;
    if (now >= next.getTime()) {
      void execute(r);
    }
  }
}

/** Start the runtime. Idempotent — repeat calls are no-ops. */
export function init(): void {
  if (initialized) return;
  initialized = true;
  // First tick on next macro task so callers can subscribe before any
  // runs land. After that, every TICK_MS.
  setTimeout(tick, 0);
  tickTimer = setInterval(tick, TICK_MS);
}

/** Stop the runtime — used in tests / hot reload. */
export function stop(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  initialized = false;
}

/** Stop an in-flight run — sends abort to its session and marks the
 *  run as error("Stopped"). No-op if the run isn't actually in
 *  flight. */
export function stopRun(runId: string): void {
  const all = loadRuns();
  const run = all.find(r => r.id === runId);
  if (!run || run.status !== "running") return;
  if (run.sessionId) {
    void wsManager.abort(run.sessionId).catch(() => { /* ignore */ });
  }
  inflight.delete(run.routineId);
  updateRun(runId, {
    status: "error",
    finishedAt: new Date().toISOString(),
    error: "Stopped by user",
  });
}

/** Drop a run from the log. UI gives users a way to clean up failed
 *  / noisy runs without nuking the whole history. */
export function deleteRun(runId: string): void {
  const all = loadRuns();
  const next = all.filter(r => r.id !== runId);
  if (next.length === all.length) return;
  saveRuns(next);
  notify();
}

/** Replace a routine in-place. Used by the edit form.
 *
 *  If the target session pivots (target switches between new/resume,
 *  or resumeSessionId changes), the rolling session is reset so we
 *  don't keep resuming a session that no longer matches the user's
 *  intent. Instruction edits do NOT clear the rolling session —
 *  execute() detects the delta and sends an "instructions changed"
 *  prefix so the agent updates its prior work instead of losing
 *  context. */
export function updateRoutine(routine: Routine): Routine {
  const all = loadRoutines();
  const idx = all.findIndex(r => r.id === routine.id);
  if (idx < 0) return routine;
  const prev = all[idx]!;
  const targetPivoted =
    prev.target          !== routine.target ||
    prev.resumeSessionId !== routine.resumeSessionId ||
    prev.projectPath     !== routine.projectPath;
  const next: Routine = targetPivoted
    ? { ...routine, rollingSessionId: null, lastSentInstructions: undefined }
    : routine;
  all[idx] = next;
  saveRoutines(all);
  notify();
  return next;
}

/** Pause or resume the schedule for a routine. Doesn't affect manual
 *  runNow — that always fires regardless of enabled state. */
export function setRoutineEnabled(routineId: string, enabled: boolean): void {
  const all = loadRoutines();
  const idx = all.findIndex(r => r.id === routineId);
  if (idx < 0) return;
  const current = all[idx];
  if (!current) return;
  all[idx] = { ...current, enabled };
  saveRoutines(all);
  notify();
}

/** Manual fire. Used by the Play button + post-create for non-manual
 *  routines so the first run lands immediately. Accepts either a
 *  routine id (looked up from storage) or a Routine object directly
 *  (use this when the routine was just created and the React commit
 *  / localStorage write hasn't necessarily flushed yet). */
export function runNow(routineOrId: string | Routine): void {
  let routine: Routine | undefined;
  if (typeof routineOrId === "string") {
    routine = loadRoutines().find(x => x.id === routineOrId);
    if (!routine) {
      console.warn("[routines] runNow: routine not found in storage:", routineOrId);
      return;
    }
  } else {
    routine = routineOrId;
  }
  console.info("[routines] runNow:", routine.name);
  void execute(routine);
}

/* ── React glue ──────────────────────────────────────────────────── */

/** Convenience selector — last N runs for a routine, sorted newest
 *  first. Used by the sparkline + Recent-runs panel. */
export function lastNRuns(routineId: string, n: number, runs?: RoutineRun[]): RoutineRun[] {
  const list = runsForRoutine(routineId, runs);
  return list
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, n);
}

/** Compute success-rate for a routine over its last N runs. Returns
 *  null when there's no data. */
export function successRate(routineId: string, n: number, runs?: RoutineRun[]): number | null {
  const list = lastNRuns(routineId, n, runs);
  const completed = list.filter(r => r.status === "ok" || r.status === "error");
  if (completed.length === 0) return null;
  const ok = completed.filter(r => r.status === "ok").length;
  return Math.round((ok / completed.length) * 100);
}
