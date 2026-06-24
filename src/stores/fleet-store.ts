/**
 * Fleet co-pilot client state.
 *
 * Per-session policy mode, decisions queue, reports log, and Fleet
 * brain cost tracking. The right-panel control tower reads from
 * this; chat-view writes to it after each refine + analyze call.
 *
 * Policy modes (per session, persisted to localStorage):
 *   manual       — Fleet off entirely
 *   refine-only  — refine on send, no post-response analysis
 *   copilot      — refine + post-response decision card (default)
 *   auto         — refine + auto-fire continue decisions (cap-bound)
 */
import { create } from "zustand";

export type FleetSessionStatus =
  | "idle"            // Fleet is on but nothing pending
  | "refining"        // Haiku is rewriting the user's draft
  | "thinking"        // Haiku is analyzing the agent response
  | "auto-continuing" // Fleet sent its own next prompt
  | "awaiting-user"   // Fleet asked a question, waiting on the user
  | "done"            // Last turn was classified as task-complete
  | "paused";         // Cost cap hit — Fleet sleeping until user resumes

export type FleetDecisionKind = "continue" | "ask" | "done";

export type FleetMode =
  | "manual"       // Fleet off
  | "refine-only"  // refine on send, no post-response analysis
  | "copilot"      // refine + decision card (default)
  | "auto";        // refine + auto-fire continue (cap-bound)

// Default Fleet co-pilot mode. We ship "manual" by default so the basic
// chat surface is clean for the MVP demo — no auto-refine, no decision
// cards, no Ask Fleet noise. Users can flip to copilot/auto from the
// mode chip when the co-pilot layer is ready for prime time.
export const FLEET_MODE_DEFAULT: FleetMode = "manual";

/** Auto-mode safety cap: how many "continue" decisions Fleet may
 *  chain together before stopping for a user check. Prevents
 *  runaway loops if the brain gets stuck in a "continue → continue
 *  → continue …" rut. */
export const AUTO_CHAIN_CAP = 3;

/** Default Fleet brain budget cap per session, in USD. Soft cap —
 *  refine + analyze average ~$0.001 each, so $1.00 buys ~500
 *  Fleet-assisted turns. Adjustable per-session. */
export const FLEET_COST_CAP_DEFAULT = 1.00;

export interface FleetDecision {
  id: string;
  sessionId: string;
  kind: FleetDecisionKind;
  reasoning: string;
  /** Set when kind === "continue" */
  nextPrompt?: string;
  /** Set when kind === "ask" */
  question?: string;
  /** Set when kind === "done" */
  summary?: string;
  /** Optional structured body — surfaced as a multi-section card
   *  in the reports list. Backend fills this on "done" decisions
   *  when it can extract structure from the agent's text. */
  sections?: {
    whatDone?: string[];
    decisions?: string[];
    uncertain?: string[];
    options?: string[];
  };
  createdAt: number;
  /** Marks decisions that Fleet fired automatically (auto mode).
   *  Used by the UI to render an "auto" pill instead of action
   *  buttons. */
  auto?: boolean;
}

export interface FleetReport {
  id: string;
  sessionId: string;
  /** One-line headline — what the task was. */
  title: string;
  /** Short body — what Fleet did, what it's unsure about. Fallback
   *  when no structured sections are available. */
  body: string;
  /** Optional structured sections — when present the report card
   *  renders as bullet groups instead of a single paragraph. */
  sections?: {
    whatDone?: string[];
    decisions?: string[];
    uncertain?: string[];
    options?: string[];
  };
  /** Outcome tag for the recent-reports list. */
  outcome: "done" | "stopped" | "failed";
  createdAt: number;
}

interface FleetSessionState {
  status: FleetSessionStatus;
  /** Last user-visible Fleet action ("Refined prompt", "Sent next
   *  prompt", "Asking you", "Reported done"). Short, present-tense. */
  lastAction: string | null;
  /** Current pending decision for this session, if any. Mirror of
   *  the matching entry in `decisions` — kept here so per-session
   *  views don't have to filter. */
  pendingDecisionId: string | null;
  /** Per-session policy mode. Loaded from localStorage on first
   *  read; defaults to FLEET_MODE_DEFAULT. */
  mode: FleetMode;
  /** Cumulative Fleet brain spend for this session in USD —
   *  refines + analyses + meta-chat calls. Capped by `costCap`. */
  costSpent: number;
  /** Per-session cost cap. When `costSpent` >= `costCap`, Fleet
   *  enters "paused" state and refuses new refine / analyze calls
   *  until the user resumes or raises the cap. */
  costCap: number;
  /** How many consecutive auto-fired continue decisions Fleet has
   *  chained for this session. Reset to 0 on any user-initiated
   *  send or any non-continue decision. AUTO_CHAIN_CAP bounds it. */
  autoChainDepth: number;
}

interface FleetStoreState {
  sessions: Record<string, FleetSessionState>;
  decisions: FleetDecision[];
  reports: FleetReport[];
  /** Global default mode set from the Fleet hub. Agent sessions
   *  inherit this when they haven't been overridden per-session.
   *  Persisted to localStorage:fleet:mode:default. */
  globalMode: FleetMode;

  /** Mutators — session lifecycle */
  setStatus: (sessionId: string, status: FleetSessionStatus, lastAction?: string | null) => void;
  pushDecision: (decision: FleetDecision) => void;
  resolveDecision: (decisionId: string) => void;
  pushReport: (report: FleetReport) => void;

  /** Mutators — policy + cost */
  setMode: (sessionId: string, mode: FleetMode) => void;
  cycleMode: (sessionId: string) => FleetMode;
  setGlobalMode: (mode: FleetMode) => void;
  cycleGlobalMode: () => FleetMode;
  setCostCap: (sessionId: string, cap: number) => void;
  recordCost: (sessionId: string, deltaUsd: number) => void;
  resetCost: (sessionId: string) => void;
  bumpAutoChain: (sessionId: string) => number;
  resetAutoChain: (sessionId: string) => void;

  /** Selectors */
  getSession: (sessionId: string) => FleetSessionState;
  pendingForSession: (sessionId: string) => FleetDecision | null;
  pendingCount: () => number;
  /** Live policy check — returns true when Fleet brain calls are
   *  allowed for this session right now (mode != manual, cost OK,
   *  not paused). Use before firing a refine/analyze. */
  isFleetLiveFor: (sessionId: string) => boolean;

  /** Orchestration bridge — the currently-tracked delegation batch id
   *  (set after the user approves a plan; the BatchProgressCard polls it).
   *  Runtime-only; heavy batch state lives on the backend. */
  activeBatchId: string | null;
  setActiveBatch: (batchId: string) => void;
  clearActiveBatch: () => void;
}

/** Read the global default mode set from the Fleet hub. This is the
 *  setting agent sessions inherit when they haven't been overridden
 *  individually. */
function loadGlobalMode(): FleetMode {
  try {
    const raw = localStorage.getItem("fleet:mode:default");
    if (raw === "manual" || raw === "refine-only" || raw === "copilot" || raw === "auto") return raw;
  } catch { /* ignore */ }
  return FLEET_MODE_DEFAULT;
}

function persistGlobalMode(mode: FleetMode): void {
  try { localStorage.setItem("fleet:mode:default", mode); } catch { /* ignore */ }
}

function loadMode(sessionId: string): FleetMode {
  try {
    const raw = localStorage.getItem(`fleet:mode:${sessionId}`);
    if (raw === "manual" || raw === "refine-only" || raw === "copilot" || raw === "auto") return raw;
    // Back-compat: the previous "fleet:copilot:<sid>" off-switch
    // had two values, "on" / "off". Map "off" to manual.
    const legacy = localStorage.getItem(`fleet:copilot:${sessionId}`);
    if (legacy === "off") return "manual";
  } catch { /* ignore */ }
  // Fall through to the global default the user set on the Fleet hub.
  return loadGlobalMode();
}

function loadCap(sessionId: string): number {
  try {
    const raw = localStorage.getItem(`fleet:cap:${sessionId}`);
    if (raw) {
      const n = parseFloat(raw);
      if (isFinite(n) && n > 0) return n;
    }
  } catch { /* ignore */ }
  return FLEET_COST_CAP_DEFAULT;
}

function persistMode(sessionId: string, mode: FleetMode): void {
  try { localStorage.setItem(`fleet:mode:${sessionId}`, mode); } catch { /* ignore */ }
}

function persistCap(sessionId: string, cap: number): void {
  try { localStorage.setItem(`fleet:cap:${sessionId}`, String(cap)); } catch { /* ignore */ }
}

/* ── decisions + reports persistence ────────────────────────────────
 * Per-session `mode` + `costCap` already round-trip via the
 * per-key helpers above. The decisions queue and reports log used
 * to be in-memory only — they vanished on every Electron reload,
 * dropping pending Fleet questions and the full task history.
 *
 * Strategy: write-through localStorage on every push / resolve.
 * Hand-rolled instead of zustand/persist to (a) avoid the hydration
 * race the panel hits when it mounts before persist finishes and
 * (b) keep the live `status` / `costSpent` / `autoChainDepth` out
 * of disk — those are session-runtime, not user-visible history.
 *
 * Caps:
 *   - reports: hard cap REPORT_CAP (50) — already enforced in
 *     pushReport. Same cap on disk.
 *   - decisions: hard cap DECISION_CAP (30) so a runaway brain
 *     can't blow up localStorage. Plus a 7-day age window — a
 *     pending decision the user ignored for a week is dead weight.
 */
const REPORTS_KEY = "fleet:reports";
const DECISIONS_KEY = "fleet:decisions";
const REPORT_CAP = 50;
const DECISION_CAP = 30;
const DECISION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadDecisions(): FleetDecision[] {
  try {
    const raw = localStorage.getItem(DECISIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - DECISION_MAX_AGE_MS;
    return parsed
      .filter((d): d is FleetDecision =>
        !!d && typeof d.id === "string" && typeof d.sessionId === "string"
        && typeof d.createdAt === "number" && d.createdAt >= cutoff)
      .slice(0, DECISION_CAP);
  } catch { return []; }
}

function persistDecisions(decisions: FleetDecision[]): void {
  try {
    // Only persist what fits in the cap. Newer first (the store
    // already prepends), so slice from the head.
    const trimmed = decisions.slice(0, DECISION_CAP);
    localStorage.setItem(DECISIONS_KEY, JSON.stringify(trimmed));
  } catch { /* quota / serialization — ignore */ }
}

function loadReports(): FleetReport[] {
  try {
    const raw = localStorage.getItem(REPORTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is FleetReport =>
        !!r && typeof r.id === "string" && typeof r.sessionId === "string"
        && typeof r.createdAt === "number")
      .slice(0, REPORT_CAP);
  } catch { return []; }
}

function persistReports(reports: FleetReport[]): void {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports.slice(0, REPORT_CAP)));
  } catch { /* quota — ignore */ }
}

/** Build a fresh FleetSessionState pulling persisted preferences
 *  out of localStorage. Centralised so every read path starts from
 *  the same defaults. */
function buildDefault(sessionId: string): FleetSessionState {
  return {
    status: "idle",
    lastAction: null,
    pendingDecisionId: null,
    mode: loadMode(sessionId),
    costSpent: 0,
    costCap: loadCap(sessionId),
    autoChainDepth: 0,
  };
}

const MODE_CYCLE: FleetMode[] = ["manual", "refine-only", "copilot", "auto"];

/** Rebuild the per-session sessions map from persisted decisions so
 *  the FleetPanel and decision card render their pending state on a
 *  fresh page load (without this, restored decisions wouldn't show
 *  in pendingForSession because no session has a pendingDecisionId).
 *  Only the per-session `pendingDecisionId` is recovered here —
 *  status / costSpent / autoChainDepth stay at their runtime
 *  defaults and re-populate naturally on the next Fleet turn. */
/** When the user picks "Auto" on the Fleet hub mode chip, also flip
 *  app-store's legacy `fleetAutoMode` boolean. That's the flag the
 *  staff WS path reads to prepend "[AUTO MODE]" to outgoing messages,
 *  which tells the staff agent prompt "act immediately, no
 *  clarification, parallel dispatch". Without this sync the chip was
 *  decorative on the Fleet hub — the user saw "Auto" but the staff
 *  agent behaved exactly the same as in Co-pilot.
 *
 *  Done by dynamic require to avoid an import cycle with app-store
 *  (which imports from chat-store which imports fleet types). */
function syncFleetHubAutoMode(mode: FleetMode): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useAppStore } = require("@/stores/app-store") as typeof import("@/stores/app-store");
    const state = useAppStore.getState();
    const desired = mode === "auto";
    if (state.fleetAutoMode !== desired) {
      state.toggleFleetAutoMode();
    }
  } catch { /* defensive — boot order race; setting will resync on next click */ }
}

function hydratePendingSessions(decisions: FleetDecision[]): Record<string, FleetSessionState> {
  const sessions: Record<string, FleetSessionState> = {};
  for (const d of decisions) {
    if (sessions[d.sessionId]) continue; // newest-first; first wins
    const base = buildDefault(d.sessionId);
    sessions[d.sessionId] = {
      ...base,
      pendingDecisionId: d.id,
      status: d.kind === "ask" ? "awaiting-user"
            : d.kind === "continue" ? "auto-continuing"
            : "done",
      lastAction:
        d.kind === "ask"      ? "Asking you"
      : d.kind === "continue" ? "Wants to continue"
      :                         "Reported done",
    };
  }
  return sessions;
}

const initialDecisions = loadDecisions();
const initialReports = loadReports();
const initialSessions = hydratePendingSessions(initialDecisions);

export const useFleetStore = create<FleetStoreState>((set, get) => ({
  sessions: initialSessions,
  decisions: initialDecisions,
  reports: initialReports,
  globalMode: loadGlobalMode(),
  activeBatchId: null,
  setActiveBatch: (batchId) => set({ activeBatchId: batchId }),
  clearActiveBatch: () => set({ activeBatchId: null }),

  setStatus: (sessionId, status, lastAction) =>
    set(state => {
      const prev = state.sessions[sessionId] ?? buildDefault(sessionId);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...prev,
            status,
            lastAction: lastAction !== undefined ? lastAction : prev.lastAction,
          },
        },
      };
    }),

  pushDecision: (decision) =>
    set(state => {
      const prev = state.sessions[decision.sessionId] ?? buildDefault(decision.sessionId);
      const remaining = state.decisions.filter(d => d.sessionId !== decision.sessionId);
      const nextDecisions = [decision, ...remaining];
      persistDecisions(nextDecisions);
      return {
        decisions: nextDecisions,
        sessions: {
          ...state.sessions,
          [decision.sessionId]: {
            ...prev,
            pendingDecisionId: decision.id,
            status: decision.kind === "ask" ? "awaiting-user"
                  : decision.kind === "continue" ? "auto-continuing"
                  : "done",
            lastAction:
              decision.kind === "ask"      ? "Asking you"
            : decision.kind === "continue" ? "Wants to continue"
            :                                "Reported done",
          },
        },
      };
    }),

  resolveDecision: (decisionId) =>
    set(state => {
      const target = state.decisions.find(d => d.id === decisionId);
      if (!target) return {};
      const remaining = state.decisions.filter(d => d.id !== decisionId);
      persistDecisions(remaining);
      const prev = state.sessions[target.sessionId] ?? buildDefault(target.sessionId);
      return {
        decisions: remaining,
        sessions: {
          ...state.sessions,
          [target.sessionId]: {
            ...prev,
            pendingDecisionId: prev.pendingDecisionId === decisionId ? null : prev.pendingDecisionId,
          },
        },
      };
    }),

  pushReport: (report) =>
    set(state => {
      const nextReports = [report, ...state.reports].slice(0, REPORT_CAP);
      persistReports(nextReports);
      return { reports: nextReports };
    }),

  setMode: (sessionId, mode) => {
    persistMode(sessionId, mode);
    set(state => {
      const prev = state.sessions[sessionId] ?? buildDefault(sessionId);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...prev,
            mode,
            // Switching to manual clears any pending auto state.
            autoChainDepth: mode === "manual" ? 0 : prev.autoChainDepth,
          },
        },
      };
    });
  },

  cycleMode: (sessionId) => {
    const current = (get().sessions[sessionId] ?? buildDefault(sessionId)).mode;
    const idx = MODE_CYCLE.indexOf(current);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? FLEET_MODE_DEFAULT;
    get().setMode(sessionId, next);
    return next;
  },

  setGlobalMode: (mode) => {
    persistGlobalMode(mode);
    set({ globalMode: mode });
    syncFleetHubAutoMode(mode);
  },

  cycleGlobalMode: () => {
    const idx = MODE_CYCLE.indexOf(get().globalMode);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? FLEET_MODE_DEFAULT;
    persistGlobalMode(next);
    set({ globalMode: next });
    syncFleetHubAutoMode(next);
    return next;
  },

  setCostCap: (sessionId, cap) => {
    persistCap(sessionId, cap);
    set(state => {
      const prev = state.sessions[sessionId] ?? buildDefault(sessionId);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...prev,
            costCap: cap,
            // Raising the cap above current spend resumes Fleet
            // automatically (was paused → idle).
            status: prev.status === "paused" && prev.costSpent < cap ? "idle" : prev.status,
          },
        },
      };
    });
  },

  recordCost: (sessionId, deltaUsd) =>
    set(state => {
      const prev = state.sessions[sessionId] ?? buildDefault(sessionId);
      const nextSpent = prev.costSpent + Math.max(0, deltaUsd);
      const paused = nextSpent >= prev.costCap;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...prev,
            costSpent: nextSpent,
            status: paused ? "paused" : prev.status,
            lastAction: paused ? "Cost cap reached" : prev.lastAction,
          },
        },
      };
    }),

  resetCost: (sessionId) =>
    set(state => {
      const prev = state.sessions[sessionId] ?? buildDefault(sessionId);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...prev,
            costSpent: 0,
            status: prev.status === "paused" ? "idle" : prev.status,
          },
        },
      };
    }),

  bumpAutoChain: (sessionId) => {
    const prev = get().sessions[sessionId] ?? buildDefault(sessionId);
    const next = prev.autoChainDepth + 1;
    set(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...prev, autoChainDepth: next },
      },
    }));
    return next;
  },

  resetAutoChain: (sessionId) =>
    set(state => {
      const prev = state.sessions[sessionId] ?? buildDefault(sessionId);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...prev, autoChainDepth: 0 },
        },
      };
    }),

  getSession: (sessionId) => {
    const existing = get().sessions[sessionId];
    if (existing) return existing;
    // Lazy-init from localStorage on first access so a fresh chat
    // doesn't sit at "idle / manual / no cap" before the user has
    // ever interacted with it.
    return buildDefault(sessionId);
  },

  pendingForSession: (sessionId) => {
    const s = get().sessions[sessionId];
    if (!s?.pendingDecisionId) return null;
    return get().decisions.find(d => d.id === s.pendingDecisionId) ?? null;
  },

  pendingCount: () => get().decisions.length,

  isFleetLiveFor: (sessionId) => {
    const s = get().sessions[sessionId] ?? buildDefault(sessionId);
    if (s.mode === "manual") return false;
    if (s.status === "paused") return false;
    if (s.costSpent >= s.costCap) return false;
    return true;
  },
}));
