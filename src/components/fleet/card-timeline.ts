/** A session's work as a tree for its card: each thing the user asked is a
 *  turn, and the turn branches into the steps the agent took and what it
 *  answered. Built from the saved messages (tool calls and their results), with
 *  the live process log laid over them, so a running step shows as running and
 *  a step not yet saved still shows. */
import type { ContentBlock } from "@/types/chat";

export type StepStatus = "running" | "completed" | "errored";

export interface TStep { id: string; name: string; input: Record<string, unknown>; status: StepStatus; output?: string; startedAt: number; endedAt: number | null }

export interface Turn {
  id: string;
  /** what the user asked; null for work that began before any ask (a resumed or dispatched session) */
  ask: string | null;
  at: number;
  steps: TStep[];
  /** the ids of the agent's messages in this turn that carry text, in order */
  replies: string[];
  /** steps and replies in the order they happened */
  items: ({ kind: "step"; id: string } | { kind: "reply"; id: string })[];
}

interface Msg { id: string; role: string; content: ContentBlock[]; timestamp: string }
interface LiveStep { id: string; tool_id: string; name: string; input: Record<string, unknown>; status: StepStatus; output?: string; startedAt: number; endedAt: number | null }

const textOf = (content: ContentBlock[]) => content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map(b => b.text).join("\n").trim();

export function turnsOf(messages: Msg[], live: LiveStep[] = []): Turn[] {
  const results = new Map<string, { output: string; err: boolean }>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_id, { output: b.output, err: b.is_error });

  const turns: Turn[] = [];
  const at = (m: Msg) => new Date(m.timestamp).getTime() || 0;
  const current = (m: Msg): Turn => {
    const last = turns[turns.length - 1];
    if (last) return last;
    const t: Turn = { id: `t-${m.id}`, ask: null, at: at(m), steps: [], replies: [], items: [] };
    turns.push(t);
    return t;
  };
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const ask = textOf(m.content);
      // a message of tool results only belongs to the turn it answers
      if (!ask) continue;
      turns.push({ id: `t-${m.id}`, ask, at: at(m), steps: [], replies: [], items: [] });
      continue;
    }
    const t = current(m);
    let replied = false;
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim() && !replied) { replied = true; t.replies.push(m.id); t.items.push({ kind: "reply", id: m.id }); continue; }
      if (b.type !== "tool_use" || seen.has(b.tool_id)) continue;
      seen.add(b.tool_id);
      const r = results.get(b.tool_id);
      t.steps.push({ id: b.tool_id, name: b.tool_name, input: b.input ?? {}, status: r ? (r.err ? "errored" : "completed") : "completed", output: r?.output, startedAt: at(m), endedAt: at(m) });
      t.items.push({ kind: "step", id: b.tool_id });
    }
  }

  // the live log: newer states for saved steps, and the steps not saved yet, on the last turn
  const byId = new Map(turns.flatMap(t => t.steps.map(s => [s.id, s] as const)));
  for (const e of live) {
    const id = e.tool_id || e.id;
    const known = byId.get(id);
    if (known) { Object.assign(known, { status: e.status, output: e.output ?? known.output, startedAt: e.startedAt, endedAt: e.endedAt }); continue; }
    const last = turns[turns.length - 1] ?? (turns.push({ id: `t-live-${id}`, ask: null, at: e.startedAt, steps: [], replies: [], items: [] }), turns[turns.length - 1]!);
    const s: TStep = { id, name: e.name, input: e.input ?? {}, status: e.status, output: e.output, startedAt: e.startedAt, endedAt: e.endedAt };
    last.steps.push(s);
    last.items.push({ kind: "step", id });
    byId.set(id, s);
  }
  return turns;
}
