/** Fleet's command layer, without a screen: how the palette matches what the
 *  user types, and the activity feed built from what the agents did.
 *
 *  Every action Fleet offers is a `Command`: plain data, run by its id through
 *  one handler. The palette lists them, the action bar shows the ones for the
 *  selection, and the key sheet prints their keys, so an action is never hidden
 *  in one place only. */
import type { NodeState } from "./roots-layout";

export type CommandGroup = "selection" | "go" | "cards" | "view" | "camera" | "fleet";

export interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  /** more words the command answers to */
  keywords?: string;
  /** the key that runs it outside the palette */
  key?: string;
  /** asks for a second Enter before it runs */
  danger?: boolean;
}

export const GROUP_TITLE: Record<CommandGroup, string> = {
  selection: "Selected",
  go: "Go to",
  cards: "Cards",
  view: "View",
  camera: "Camera",
  fleet: "Every agent",
};

/** How well `text` answers `query`: 0 is no match; whole-word starts beat
 *  substrings, which beat letters in order (so "nw" finds "Next waiting"). */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 100 - Math.min(40, t.length - q.length) / 4;
  const words = t.split(/[^a-z0-9]+/);
  if (words.some(w => w.startsWith(q))) return 80;
  if (q.split(/\s+/).every(part => words.some(w => w.startsWith(part)))) return 70;
  if (t.includes(q)) return 60;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  if (i === q.length) return 30 - Math.min(20, t.length / 10);
  return 0;
}

/** The commands that answer the query, best first, keeping their own order on a tie. */
export function matchCommands(query: string, commands: Command[], min = 1): Command[] {
  return commands
    .map((c, i) => ({ c, i, s: Math.max(score(query, c.label), score(query, c.keywords ?? "") * 0.9) }))
    .filter(x => x.s >= min)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.c);
}

export interface Findable { id: string; title: string; project: string; branch?: string | null; model?: string | null; state: NodeState }

/** Sessions that answer the query, best first; with no query, the ones that need the user first. */
export function matchSessions(query: string, sessions: Findable[], min = 1): Findable[] {
  const rank: Record<NodeState, number> = { needs: 0, failed: 1, working: 2, done: 3 };
  if (!query.trim()) return [...sessions].sort((a, b) => rank[a.state] - rank[b.state]);
  return sessions
    .map(s => ({ s, v: Math.max(score(query, s.title), score(query, s.project) * 0.85, score(query, s.branch ?? "") * 0.8, score(query, s.model ?? "") * 0.7) }))
    .filter(x => x.v >= min)
    .sort((a, b) => b.v - a.v || rank[a.s.state] - rank[b.s.state])
    .map(x => x.s);
}

/* ── the activity feed ─────────────────────────────────────────────────── */

export type ActivityKind = "needs" | "failed" | "done" | "step" | "started";

export interface Activity { id: string; sessionId: string; at: number; kind: ActivityKind; text: string }

export interface ActivitySource {
  id: string;
  createdAt: number;
  state: NodeState;
  /** since when it has needed the user, if it does */
  needSince?: number;
  /** the time of its last message, for a finished one */
  lastAt?: number;
  steps: { id: string; startedAt: number; endedAt: number | null; status: "running" | "completed" | "errored"; text: string }[];
}

/** What happened across the fleet, newest first: questions, failures, finished
 *  runs, starts and the latest steps of each agent (a few per agent, so one busy
 *  agent cannot crowd the others out). */
export function activityOf(sources: ActivitySource[], limit = 60, stepsPerAgent = 6): Activity[] {
  const out: Activity[] = [];
  for (const s of sources) {
    out.push({ id: `${s.id}:start`, sessionId: s.id, at: s.createdAt, kind: "started", text: "started" });
    for (const e of s.steps.slice(-stepsPerAgent)) {
      const errored = e.status === "errored";
      out.push({ id: `${s.id}:${e.id}`, sessionId: s.id, at: e.endedAt ?? e.startedAt, kind: errored ? "failed" : "step", text: e.text });
    }
    if (s.state === "needs") out.push({ id: `${s.id}:needs`, sessionId: s.id, at: s.needSince ?? Date.now(), kind: "needs", text: "needs you" });
    if (s.state === "done" && s.lastAt) out.push({ id: `${s.id}:done`, sessionId: s.id, at: s.lastAt, kind: "done", text: "finished" });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
