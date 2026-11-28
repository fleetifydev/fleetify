import { createContext, useContext, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  ArrowUpRight, Bot, Check, ChevronRight, Circle, FileText, GitFork, Globe, ListChecks, Pin, RotateCcw,
  Pencil, Search, Square, SquareTerminal, Wrench, type LucideIcon,
} from "lucide-react";
import { useChatStore, type ProcessEvent, type SessionChatState, type SubagentTask } from "@/stores/chat-store";
import { wsManager } from "@/services/ws-manager";
import { ProviderLogo } from "@/components/ui/provider-logo";

import { AgentStatusIcon } from "@/components/layout/sidebar";
import { MessageContent, StreamingMessage } from "@/components/chat/message-content";
import { apiFetch, forkSession, restartSession, stopSession } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { ContentBlock } from "@/types/chat";
import type { Session } from "@/types/session";
import type { NodeState } from "./roots-layout";
import { turnsOf, type TStep } from "./card-timeline";
import { plain } from "./fleet-text";
import { AskQuestionCard } from "@/components/chat/ask-question-card";

/** The cards Fleet's tree hangs: one per session and one per sub-agent. A
 *  card tells the whole story and takes every decision without opening the
 *  chat: what the agent was asked, what it is doing this second, every step
 *  with its output, the conversation so far, each file's changes line by
 *  line, its plan; and it answers the agent's questions, grants or refuses
 *  its permissions, stops it, or sends it a message. */

export const C_ORANGE = "#fb923c";
export const C_RED = "#f87171";

/** One clock for every card, ticking once a second while the window shows. */
export const NowCtx = createContext(0);
export function useTicker() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let id = 0;
    const start = () => { if (!id) id = window.setInterval(() => setNow(Date.now()), 1000); };
    const stop = () => { window.clearInterval(id); id = 0; };
    const vis = () => (document.hidden ? stop() : (setNow(Date.now()), start()));
    document.addEventListener("visibilitychange", vis);
    start();
    return () => { stop(); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return now;
}

/* ── reading an agent's activity ─────────────────────────────────────── */

type Cat = "read" | "edit" | "run" | "search" | "web" | "agent" | "plan" | "other";
const KIND: { test: RegExp; icon: LucideIcon; verb: string; cat: Cat; noun: string }[] = [
  { test: /^(read|notebookread|view)/i, icon: FileText, verb: "Reading", cat: "read", noun: "read" },
  { test: /^(edit|multiedit|write|notebookedit|str_replace|create)/i, icon: Pencil, verb: "Editing", cat: "edit", noun: "edit" },
  { test: /^(bash|shell|exec|run|terminal)/i, icon: SquareTerminal, verb: "Running", cat: "run", noun: "run" },
  { test: /^(grep|glob|ls|search|find)/i, icon: Search, verb: "Searching", cat: "search", noun: "search" },
  { test: /^(webfetch|websearch|fetch|browse)/i, icon: Globe, verb: "Browsing", cat: "web", noun: "web" },
  { test: /^(task|agent|dispatch)/i, icon: Bot, verb: "Delegating", cat: "agent", noun: "agent" },
  { test: /^(todowrite|todo)/i, icon: ListChecks, verb: "Planning", cat: "plan", noun: "plan" },
];
export const kindOf = (name: string) => KIND.find(k => k.test.test(name)) ?? { icon: Wrench, verb: name, cat: "other" as Cat, noun: "other" };

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** The thing a tool call works on, short: a file name, a command, a pattern. */
export function targetOf(e: { name: string; input: Record<string, unknown> }): string {
  const i = e.input;
  const file = i.file_path ?? i.path ?? i.notebook_path;
  if (typeof file === "string") return base(file);
  for (const k of ["command", "pattern", "url", "query", "description"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return v.length > 46 ? `${v.slice(0, 45)}…` : v;
  }
  return "";
}
/** The same, in full: a whole path, a whole command. */
function fullTarget(e: { input: Record<string, unknown> }): string {
  const i = e.input;
  for (const k of ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "description"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

interface Hunk { del: string[]; add: string[] }
/** What a file tool changed, read from its input: lines out and lines in. */
function hunksOf(e: ProcessEvent): Hunk[] {
  const i = e.input;
  const split = (s: unknown) => (typeof s === "string" && s ? s.split("\n") : []);
  if (Array.isArray(i.edits)) return (i.edits as { old_string?: unknown; new_string?: unknown }[]).map(x => ({ del: split(x?.old_string), add: split(x?.new_string) }));
  if (typeof i.content === "string") return [{ del: [], add: split(i.content) }];
  return [{ del: split(i.old_string), add: split(i.new_string) }];
}
const diffOf = (e: ProcessEvent) => hunksOf(e).reduce((a, h) => ({ add: a.add + h.add.length, del: a.del + h.del.length }), { add: 0, del: 0 });

const FILE_TOOLS = /^(edit|multiedit|write|notebookedit|str_replace|create)/i;
interface Touched { name: string; path: string; n: number; add: number; del: number; edits: ProcessEvent[] }
/** Files the agent changed, most recent first, with every edit to each. */
export function filesTouched(log: ProcessEvent[]): Touched[] {
  const out: Touched[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (!FILE_TOOLS.test(e.name) || e.status === "errored") continue;
    const f = e.input.file_path ?? e.input.path ?? e.input.notebook_path;
    if (typeof f !== "string") continue;
    const d = diffOf(e);
    const hit = out.find(x => x.path === f);
    if (hit) { hit.n++; hit.add += d.add; hit.del += d.del; hit.edits.push(e); } else out.push({ name: base(f), path: f, n: 1, ...d, edits: [e] });
  }
  return out;
}

const textOf = (blocks: ContentBlock[]) => blocks.filter(b => b.type === "text").map(b => (b as { text: string }).text).join(" ").trim();
export function lastText(cs: SessionChatState | undefined, role: "assistant" | "user", first = false): string | null {
  if (!cs) return null;
  const list = first ? cs.messages : [...cs.messages].reverse();
  for (const m of list) if (m.role === role) { const t = textOf(m.content); if (t) return t; }
  return null;
}
/** Tokens the session has used, from its finished replies. */
export const tokensOf = (cs: SessionChatState | undefined) =>
  (cs?.messages ?? []).reduce((a, m) => a + (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0) + (m.usage?.cache_read_tokens ?? 0), 0);



/** A session's steps: the live log while this run of the app watched it, or
 *  else rebuilt from its saved messages, so a session the user has not opened
 *  since the app started still shows everything it did. */
const fromHistory = new WeakMap<object, ProcessEvent[]>();
export function logOf(cs: SessionChatState | undefined): ProcessEvent[] {
  if (!cs) return [];
  if (cs.processLog.length) return cs.processLog;
  const hit = fromHistory.get(cs.messages);
  if (hit) return hit;
  const results = new Map<string, { output: string; err: boolean }>();
  for (const m of cs.messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_id, { output: b.output, err: b.is_error });
  const out: ProcessEvent[] = [];
  for (const m of cs.messages) {
    const at = new Date(m.timestamp).getTime() || 0;
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.tool_id);
      out.push({ id: b.tool_id, tool_id: b.tool_id, name: b.tool_name, input: b.input ?? {}, startedAt: at, endedAt: at, status: r?.err ? "errored" : "completed", output: r?.output });
    }
  }
  fromHistory.set(cs.messages, out);
  return out;
}
export const hasPending = (cs: SessionChatState | undefined) => !!(cs?.permissionRequest || cs?.askQuestion || cs?.cursorQuestion || cs?.cursorPlan);
export const money = (n: number | undefined) => ((n ?? 0) > 0 ? `$${(n ?? 0).toFixed(2)}` : "$0");
export const kfmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** A live span: 8s, 1:24, 12m, 3h. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};
const agoAt = (now: number, iso: string | null) => {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const firstLine = (s: string | undefined) => (s ?? "").split("\n").map(x => x.trim()).find(Boolean) ?? "";
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/* ── small parts ─────────────────────────────────────────────────────── */

const Label = ({ children }: { children: ReactNode }) => <div className="fr-label">{children}</div>;










/** A line to message the agent from its card. */

/* ── decisions, taken on the card ────────────────────────────────────── */

const TOOL_VERB: Record<string, string> = {
  Bash: "run a shell command", PowerShell: "run a shell command", Read: "read a file", Write: "create a new file",
  Edit: "edit a file", MultiEdit: "edit multiple files", Glob: "search for files", Grep: "search the code",
  Agent: "dispatch a sub-agent", WebFetch: "fetch a URL", WebSearch: "search the web", NotebookEdit: "edit a notebook",
};

export function Decision({ session, cs }: { session: Session; cs: SessionChatState | undefined }) {
  const perm = cs?.permissionRequest ?? null;
  const ask = cs?.askQuestion ?? null;
  const cq = cs?.cursorQuestion ?? null;
  const plan = cs?.cursorPlan ?? null;
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const pick = (qi: number, label: string, multi: boolean) => setPicked(p => {
    const cur = p[qi] ?? [];
    return { ...p, [qi]: multi ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label] };
  });

  if (perm) {
    return (
      <div className="fr-block fr-block--needs">
        <div className="fr-kicker"><b>Permission</b><i>·</i><span>{perm.tool_name}</span></div>
        <div className="fr-prompt">Allow this agent to {perm.tool_description ?? TOOL_VERB[perm.tool_name] ?? perm.tool_name.toLowerCase()}?</div>
        {perm.command && <pre className="fr-inset">{perm.command}</pre>}
        <div className="fr-buttons">
          <button type="button" className="fr-btn" onClick={e => { stop(e); void wsManager.sendPermissionResponse(session.id, perm.id, false, false, perm.tool_name); }}>Deny</button>
          <button type="button" className="fr-btn fr-btn--tint" onClick={e => { stop(e); void wsManager.sendPermissionResponse(session.id, perm.id, true, false, perm.tool_name); }}>Allow</button>
          <button type="button" className="fr-btn fr-btn--primary" onClick={e => { stop(e); void wsManager.sendPermissionResponse(session.id, perm.id, true, true, perm.tool_name); }}>Always allow</button>
        </div>
      </div>
    );
  }

  if (ask) {
    return (
      <div className="fr-embed" onPointerDown={stop} onDoubleClick={stop}>
        <AskQuestionCard question={ask}
          onAnswer={(id, answers) => void wsManager.sendAskQuestionResponse(session.id, id, true, answers)}
          onSkip={id => void wsManager.sendAskQuestionResponse(session.id, id, false, [])} />
      </div>
    );
  }

  if (cq) {
    const ready = cq.questions.every((_, i) => (picked[i] ?? []).length > 0);
    return (
      <div className="fr-block fr-block--needs">
        <div className="fr-kicker"><b>Question</b>{cq.title && <><i>·</i><span>{cq.title}</span></>}</div>
        {cq.questions.map((q, qi) => (
          <div key={q.id} className="fr-q-block">
            <p className="fr-ask">{q.prompt}</p>
            <div className="fr-options">
              {q.options.map(o => {
                const on = (picked[qi] ?? []).includes(o.id);
                return (
                  <button key={o.id} type="button" className={`fr-option${on ? " is-on" : ""}`} onClick={e => { stop(e); pick(qi, o.id, !!q.allowMultiple); }}>
                    <span className="fr-option-mark">{q.allowMultiple ? (on ? <Check size={10} strokeWidth={3} /> : null) : <i />}</span>
                    <span className="fr-option-text"><b>{o.label}</b></span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="fr-buttons">
          <button type="button" className="fr-btn fr-btn--primary" disabled={!ready}
            onClick={e => { stop(e); void wsManager.sendQuestionResponse(session.id, cq.id, { outcome: "answered", answers: cq.questions.map((q, i) => ({ questionId: q.id, selectedOptionIds: picked[i] ?? [] })) }); }}>Send answers</button>
          <button type="button" className="fr-btn" onClick={e => { stop(e); void wsManager.sendQuestionResponse(session.id, cq.id, { outcome: "skipped" }); }}>Skip</button>
        </div>
      </div>
    );
  }

  if (plan) {
    return (
      <div className="fr-block fr-block--needs">
        <div className="fr-kicker"><b>Plan</b>{plan.name && <><i>·</i><span>{plan.name}</span></>}</div>
        {plan.overview && <p className="fr-ask">{plan.overview}</p>}
        {plan.todos.length > 0 && <div className="fr-plan-list">{plan.todos.slice(0, 8).map(t => <div key={t.id} className="fr-todo"><Circle size={9} /><span>{t.content}</span></div>)}</div>}
        <div className="fr-buttons">
          <button type="button" className="fr-btn" onClick={e => { stop(e); void wsManager.sendPlanResponse(session.id, plan.id, { outcome: "rejected" }); }}>Reject</button>
          <button type="button" className="fr-btn fr-btn--primary" onClick={e => { stop(e); void wsManager.sendPlanResponse(session.id, plan.id, { outcome: "accepted" }); }}>Accept plan</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fr-block fr-block--needs">
      <div className="fr-kicker"><b>Waiting</b><i>·</i><span>your reply</span></div>
      <p className="fr-ask">{lastText(cs, "assistant") ?? "The agent is waiting for your reply."}</p>
    </div>
  );
}

export function Failure({ cs }: { cs: SessionChatState | undefined }) {
  const log = logOf(cs);
  const broke = [...log].reverse().find(e => e.status === "errored");
  const msg = broke?.output?.trim() || lastText(cs, "assistant") || "Stopped with an error.";
  return (
    <div className="fr-block fr-block--failed">
      <div className="fr-kicker"><b>Failed</b>{broke && <><i>·</i><span>{kindOf(broke.name).verb}</span></>}</div>
      {broke && fullTarget(broke) && <div className="fr-target">{fullTarget(broke)}</div>}
      <pre className="fr-inset">{msg.length > 1200 ? `${msg.slice(0, 1200)}\n…` : msg}</pre>
    </div>
  );
}

/* ── the session card ────────────────────────────────────────────────── */


export interface SessionCardProps {
  session: Session;
  cs: SessionChatState | undefined;
  state: NodeState;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  /** the composer talks to this card: its own reply box steps aside */
  talk?: boolean;
}

/** The one line under a row: what the agent needs, what broke, or what it is doing. */
function lineOf(state: NodeState, cs: SessionChatState | undefined, now: number): string | null {
  const l = lineRaw(state, cs, now);
  return l ? plain(l) : l;
}
function lineRaw(state: NodeState, cs: SessionChatState | undefined, now: number): string | null {
  const log = logOf(cs);
  if (state === "needs") {
    const perm = cs?.permissionRequest;
    if (perm) return `Wants to ${perm.command ? `run ${perm.command}` : TOOL_VERB[perm.tool_name] ?? perm.tool_name.toLowerCase()}`;
    const q = cs?.askQuestion?.questions[0]?.question ?? cs?.cursorQuestion?.questions[0]?.prompt;
    if (q) return q;
    if (cs?.cursorPlan) return "Proposes a plan";
    return lastText(cs, "assistant") ?? "Waiting for your reply";
  }
  if (state === "failed") {
    const broke = [...log].reverse().find(e => e.status === "errored");
    return broke ? `${kindOf(broke.name).verb} ${targetOf(broke)} · ${firstLine(broke.output) || "failed"}` : lastText(cs, "assistant") ?? "Stopped with an error";
  }
  if (state === "working") {
    const running = [...log].reverse().find(e => e.status === "running");
    const call = running ?? (cs ? Object.values(cs.activeToolCalls).pop() : undefined);
    if (call) return `${kindOf(call.name).verb} ${targetOf(call)}${running ? ` · ${clock(now - running.startedAt)}` : ""}`;
    return cs?.streamingText ? "Writing" : "Thinking";
  }
  // finished: what it came back with, or what it changed
  const said = firstLine(lastText(cs, "assistant") ?? "");
  if (said) return said;
  const files = filesTouched(log);
  return files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : null;
}
export const ringOf = (state: NodeState) => (state === "needs" ? "waiting" : state === "failed" ? "error" : state === "working" ? "running" : "idle");


/** Last two segments of a path, the way the sidebar's preview card shows a folder. */

/** The sidebar menu's actions for a session, as one quiet row of buttons. */
/** What can be done to a session from Fleet: the card's buttons and its right-click menu share these. */
export interface SessionAction { key: string; label: string; icon: ReactNode; fn: () => Promise<unknown> }
export function sessionActions(session: Session, live: boolean): SessionAction[] {
  const app = useAppStore.getState;
  const all: (SessionAction & { show: boolean })[] = [
    { key: "stop", label: "Stop", icon: <Square size={10} fill="currentColor" />, show: live, fn: async () => { void wsManager.abort(session.id); await stopSession(session.id); app().updateSession(session.id, { status: "idle" }); } },
    { key: "restart", label: "Restart", icon: <RotateCcw size={12} />, show: true, fn: async () => { await restartSession(session.id); app().updateSession(session.id, { status: "idle" }); } },
    { key: "fork", label: "Fork", icon: <GitFork size={12} />, show: true, fn: async () => { const f = await forkSession(session.id); app().addSession(f); } },
    { key: "pin", label: session.pinned ? "Unpin" : "Pin", icon: <Pin size={12} />, show: true, fn: async () => {
      const pinned = !session.pinned;
      await apiFetch(`/api/sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }) });
      app().updateSession(session.id, { pinned });
    } },
  ];
  return all.filter(a => a.show);
}


/** A titled group inside an open card, headed the way the sidebar heads its groups. */
function Group({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="fr-grp">
      <div className="fr-grp-h"><span>{title}</span>{count !== undefined && <em>{count}</em>}{action}</div>
      {children}
    </div>
  );
}

/** Every file the agent touched, with its +/− lines; a click shows the diff. */
export function FileRows({ log }: { log: ProcessEvent[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const files = filesTouched(log);
  if (!files.length) return null;
  return (
    <Group title="Files" count={files.length}>
      {files.slice(0, 8).map(f => {
        const isOpen = open === f.path;
        return (
          <div key={f.path} className={`fr-step2${isOpen ? " is-open" : ""}`}>
            <button type="button" className="fr-step2-row" title={f.path} onClick={ev => { stop(ev); setOpen(isOpen ? null : f.path); }}>
              <FileText size={12} />
              <span className="fr-file2">{f.name}</span>
              <em><b className="add">+{f.add}</b> <b className="del">−{f.del}</b></em>
            </button>
            <Collapse open={isOpen}>
              <div className="fr-step2-out">
                <code>{f.path}</code>
                {f.edits.slice(0, 3).flatMap(e => hunksOf(e).slice(0, 2).map((h, i) => (
                  <div key={`${e.id}-${i}`} className="fr-hunk">
                    {h.del.slice(0, 8).map((l, j) => <div key={`d${j}`} className="del"><b>−</b>{l || " "}</div>)}
                    {h.add.slice(0, 12).map((l, j) => <div key={`a${j}`} className="add"><b>+</b>{l || " "}</div>)}
                    {h.add.length > 12 && <div className="more">… {h.add.length - 12} more lines</div>}
                  </div>
                )))}
              </div>
            </Collapse>
          </div>
        );
      })}
      {files.length > 8 && <div className="fr-more">+{files.length - 8} more files</div>}
    </Group>
  );
}

/** The agent's plan, from its last TodoWrite call, as checklist rows. */
export type Todo = { content: string; status: string; activeForm?: string };
/** The agent's latest plan (its last TodoWrite), or none. */
export function planOf(log: ProcessEvent[]): Todo[] {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (/^todowrite$/i.test(e.name) && Array.isArray(e.input.todos)) return (e.input.todos as Todo[]).filter(t => t && typeof t.content === "string");
  }
  return [];
}
export function PlanRows({ log }: { log: ProcessEvent[] }) {
  const todos = planOf(log);
  if (!todos.length) return null;
  const done = todos.filter(t => t.status === "completed").length;
  return (
    <Group title="Plan" count={undefined} action={<span className="fr-grp-n">{done} of {todos.length}</span>}>
      {todos.map((t, i) => (
        <div key={i} className={`fr-todo2 fr-todo2--${t.status}`}>
          {t.status === "completed" ? <Check size={11} strokeWidth={2.4} /> : t.status === "in_progress" ? <AgentStatusIcon status="running" size={11} /> : <Circle size={10} />}
          <span>{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
        </div>
      ))}
    </Group>
  );
}

/** An open card: everything about the session, scrolled inside the card so the
 *  card keeps its height and the tree stays still. The facts first, then the
 *  decision or failure, what it was asked, its plan, its steps, the files it
 *  changed, the conversation in the chat's own look, and a line to message it. */

/** A session, drawn like a row in the sidebar: the same status mark, title
 *  and time, an amber strip when it needs the user, and one quiet line under
 *  it. A click opens everything underneath: the decision, the steps, the
 *  chat, the files, and a line to message the agent. */
export function SessionCard({ session, cs, state, open, onToggle, onOpen, talk }: SessionCardProps) {
  const now = useContext(NowCtx);
  const log = logOf(cs);
  const live = state === "working" || !!cs?.isStreaming;
  const started = cs?.streamStartTime ?? log.find(e => e.status === "running")?.startedAt ?? new Date(session.created_at).getTime();
  const line = lineOf(state, cs, now);
  return (
    <div className={`fr-srow fr-srow--${state}${open ? " is-open" : ""}`}>
      <div className="fr-srow-main" role="button" tabIndex={-1} onClick={e => { if (e.shiftKey || e.metaKey) return; stop(e); onToggle(); }}>
        <div className="fr-srow-top">
          <AgentStatusIcon status={ringOf(state)} size={13} />
          <span className="fr-srow-title" title={session.title}>{session.title || "Untitled"}</span>
          <span className="fr-srow-time">{state === "working" ? clock(now - started) : agoAt(now, session.last_accessed ?? session.created_at)}</span>
          <span className="fr-srow-hover">
            {session.tool && <ProviderLogo tool={session.tool} size={12} />}
            {(session.budget_used ?? 0) > 0 && <span className="fr-srow-cost">{money(session.budget_used)}</span>}
            {live && <button type="button" className="fr-icon-btn" aria-label="Stop" title="Stop this agent" onClick={e => { stop(e); void wsManager.abort(session.id); }}><Square size={9} fill="currentColor" /></button>}
            <button type="button" className="fr-icon-btn" aria-label="Open chat" title="Open the chat" onClick={e => { stop(e); onOpen(); }}><ArrowUpRight size={12} /></button>
          </span>
        </div>
        {line && <div className="fr-srow-line" title={line}>{line}</div>}
      </div>

      <Collapse open={open}><MissionBody session={session} cs={cs} state={state} onDive={onOpen} talk={!!talk} /></Collapse>
    </div>
  );
}

/* ── the sub-agent card ──────────────────────────────────────────────── */


/** A sub-agent a session runs, on its own branch, drawn like a sidebar row. */
export function SubagentCard({ task, open, onToggle }: { task: SubagentTask; open: boolean; onToggle: () => void }) {
  const now = useContext(NowCtx);
  const calls = task.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
  const running = task.status === "running";
  const elapsed = running ? clock(now - task.startedAt) : task.durationMs ? clock(task.durationMs) : "";
  const active = Object.values(task.activeToolCalls ?? {}).pop();
  const last = active ?? (calls.length ? { name: calls[calls.length - 1]!.tool_name, input: calls[calls.length - 1]!.input } : null);
  const line = running ? (last ? `${kindOf(last.name).verb} ${targetOf(last)}` : "Starting") : task.summary ? firstLine(task.summary) : `${task.toolUses} tools`;
  const live = (task.streamingText || task.streamingThinking || "").trim();
  return (
    <div className={`fr-srow fr-srow--sub${open ? " is-open" : ""}`}>
      <div className="fr-srow-main" role="button" tabIndex={-1} onClick={e => { if (e.shiftKey || e.metaKey) return; stop(e); onToggle(); }}>
        <div className="fr-srow-top">
          <AgentStatusIcon status={running ? "running" : task.status === "failed" ? "error" : "idle"} size={13} />
          <span className="fr-srow-title" title={task.description}>{task.description || "Sub-agent"}</span>
          <span className="fr-srow-time">{elapsed}</span>
        </div>
        <div className="fr-srow-line" title={line}>{task.taskType ? `${task.taskType} · ` : ""}{line}</div>
      </div>
      <Collapse open={open}>
        <div className="fr-srow-body">
          <div className="fr-sub"><span>{task.toolUses} tool{task.toolUses === 1 ? "" : "s"}</span>{task.totalTokens > 0 && <span>{kfmt(task.totalTokens)} tok</span>}<span>{task.status}</span></div>
          {calls.length > 0 && (
            <div className="fr-tl">
              {calls.slice(-6).map(c => {
                const k = kindOf(c.tool_name), Icon = k.icon;
                return <div key={c.tool_id} className="fr-tl-step fr-tl-step--completed"><span className="fr-tl-dot"><Icon size={10} /></span><div className="fr-tl-body"><div className="fr-tl-line"><b>{k.verb}</b><span>{targetOf({ name: c.tool_name, input: c.input })}</span></div></div></div>;
              })}
            </div>
          )}
          {running && live && <div className="fr-live"><p>{live.length > 200 ? `…${live.slice(-199)}` : live}<span className="fr-caret" /></p></div>}
          {task.summary && <div className="fr-task"><Label>Result</Label><p>{task.summary}</p></div>}
        </div>
      </Collapse>
    </div>
  );
}

/** Fleet's own conversation, under the hub: what the user asked Fleet and what it did across the agents (started, dispatched), live. */
export function FleetThread({ sessionId, onShowChat }: { sessionId: string | null; onShowChat: () => void }) {
  const cs = useChatStore(st => (sessionId ? st.sessions[sessionId] : undefined));
  const msgs = (cs?.messages ?? []).filter(m => m.role !== "system" && !(m.role === "user" && m.content.every(b => b.type === "tool_result")));
  const shown = msgs.slice(-4);
  const live = !!(cs?.streamingText || cs?.streamingThinking || cs?.isStreaming);
  return (
    <div className="fr-fleetthread" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      {msgs.length > 0 || live ? (
        <div className="fr-transcript fr-scrollable">
          {shown.map(m => <div key={m.id} className="fr-msgwrap"><MessageContent message={m} /></div>)}
          {live && <StreamingMessage text={cs?.streamingText ?? ""} thinking={cs?.streamingThinking ?? ""} />}
        </div>
      ) : (
        <div className="fr-fleet-empty">
          <b>Tell Fleet what to do.</b>
          <span>It starts new sessions, hands tasks to your agents and keeps an eye on them. Try “start a session in my blog to fix the RSS feed”.</span>
        </div>
      )}
      {msgs.length > 0 && <button type="button" className="fr-openchat" onClick={e => { stop(e); onShowChat(); }}>The whole conversation<ArrowUpRight size={11} /></button>}
    </div>
  );
}

/** Opens and closes its content by height, smoothly, and keeps the content until the close has played. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [render, setRender] = useState(open);
  if (open && !render) setRender(true);
  if (!render) return null;
  return (
    <div className={`fr-collapse${open ? " is-open" : " is-closing"}`} onTransitionEnd={e => { if (!open && e.target === e.currentTarget && e.propertyName === "grid-template-rows") setRender(false); }}>
      <div className="fr-collapse-in">{children}</div>
    </div>
  );
}

/** The session's work as a tree: each ask is a node; the steps and replies of its turn branch from it,
 *  and a sub-agent's own steps branch from the step that started it. The latest turn shows open. */
export function Timeline({ cs }: { cs: SessionChatState | undefined }) {
  const now = useContext(NowCtx);
  const turns = useMemo(() => turnsOf(cs?.messages ?? [], cs?.processLog ?? []), [cs?.messages, cs?.processLog]);
  const [all, setAll] = useState(false);
  const [flip, setFlip] = useState<Record<string, boolean>>({});
  const live = !!(cs?.streamingText || cs?.streamingThinking);
  if (!turns.length && !live) return null;
  const shown = all ? turns : turns.slice(-3);
  const msgs = new Map((cs?.messages ?? []).map(m => [m.id, m]));
  const tasks = new Map(Object.values(cs?.subagentTasks ?? {}).filter(t => t.toolUseId).map(t => [t.toolUseId!, t]));
  const lastId = turns[turns.length - 1]?.id;
  return (
    <Group title="Timeline" count={turns.length} action={turns.length > 3 ? <button type="button" className="fr-link" onClick={e => { stop(e); setAll(a => !a); }}>{all ? "Latest" : `Earlier (${turns.length - 3})`}</button> : undefined}>
      <div className="fr-tt">
        {shown.map(t => {
          const last = t.id === lastId;
          const open = flip[t.id] ?? last;
          const steps = new Map(t.steps.map(x => [x.id, x]));
          const items = t.items.filter(it => it.kind === "reply" || !/^todowrite$/i.test(steps.get(it.id)?.name ?? ""));
          const nSteps = items.filter(it => it.kind === "step").length;
          const failed = t.steps.some(x => x.status === "errored");
          const running = t.steps.some(x => x.status === "running") || (last && live);
          const hidden = items.length > 10 ? items.length - 8 : 0;
          return (
            <div key={t.id} className={`fr-tt-turn${open ? " is-open" : ""}${running ? " is-live" : ""}${failed ? " is-failed" : ""}`}>
              <button type="button" className="fr-tt-head" onClick={e => { stop(e); setFlip(f => ({ ...f, [t.id]: !open })); }}>
                <i className="fr-tt-node" />
                <span className="fr-tt-ask">{askLabel(t.ask)}</span>
                <em>{running ? "working" : nSteps ? `${nSteps} step${nSteps === 1 ? "" : "s"}${failed ? " · a failure" : ""}` : t.replies.length ? "answered" : ""}</em>
                <span className="fr-tt-at">{t.at ? agoMs(now - t.at) : ""}</span>
                <ChevronRight size={12} className="fr-tt-chev" />
              </button>
              <Collapse open={open}>
                <div className="fr-tt-kids">
                  {hidden > 0 && <div className="fr-tt-more">{hidden} earlier step{hidden === 1 ? "" : "s"}</div>}
                  {items.slice(hidden ? -8 : 0).map(it => {
                    if (it.kind === "reply") {
                      const m = msgs.get(it.id);
                      if (!m) return null;
                      const txt = m.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map(b => b.text).join("\n").trim();
                      return txt ? <ReplyNode key={it.id} text={txt} /> : null;
                    }
                    const st = steps.get(it.id);
                    return st ? <StepNode key={it.id} step={st} task={tasks.get(st.id)} now={now} /> : null;
                  })}
                  {last && live && <div className="fr-tt-kid fr-tt-reply is-live"><StreamingMessage text={cs?.streamingText ?? ""} thinking={cs?.streamingThinking ?? ""} /></div>}
                </div>
              </Collapse>
            </div>
          );
        })}
      </div>
    </Group>
  );
}

const agoMs = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** One step on its branch; a click shows its command and output, or its diff. A sub-agent's step branches into the sub-agent's own steps. */
function StepNode({ step, task, now }: { step: TStep; task: SubagentTask | undefined; now: number }) {
  const [open, setOpen] = useState(false);
  const k = kindOf(step.name), Icon = k.icon;
  const took = step.endedAt !== null && step.endedAt !== step.startedAt ? clock(step.endedAt - step.startedAt) : step.status === "running" ? clock(now - step.startedAt) : "";
  const ev = step as unknown as ProcessEvent;
  const edit = /^(edit|multiedit|write)$/i.test(step.name);
  const calls = task ? task.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use") : [];
  return (
    <div className={`fr-tt-kid fr-tt-step s-${step.status}${open ? " is-open" : ""}`}>
      <button type="button" className="fr-step2-row" onClick={e => { stop(e); setOpen(o => !o); }}>
        <Icon size={12} />
        <b>{task ? "Sub-agent" : k.verb}</b>
        <span>{task ? task.description || targetOf(ev) : targetOf(ev)}</span>
        <em>{step.status === "errored" ? "failed" : step.status === "running" ? <i className="fr-tt-spin" /> : took}</em>
      </button>
      <Collapse open={open}>
        <div className="fr-step2-out">
          {fullTarget(ev) && <code>{fullTarget(ev)}</code>}
          {edit ? hunksOf(ev).slice(0, 2).map((h, i) => (
            <div key={i} className="fr-hunk">
              {h.del.slice(0, 8).map((l, j) => <div key={`d${j}`} className="del"><b>−</b>{l || " "}</div>)}
              {h.add.slice(0, 12).map((l, j) => <div key={`a${j}`} className="add"><b>+</b>{l || " "}</div>)}
              {h.add.length > 12 && <div className="more">… {h.add.length - 12} more lines</div>}
            </div>
          )) : <pre>{step.output ? (step.output.length > 2000 ? `${step.output.slice(0, 2000)}\n…` : step.output) : step.status === "running" ? "Still running." : "No output."}</pre>}
        </div>
      </Collapse>
      {task && (calls.length > 0 || task.summary) && (
        <div className="fr-tt-kids fr-tt-sub">
          {calls.slice(-5).map(c => {
            const kk = kindOf(c.tool_name), I = kk.icon;
            return <div key={c.tool_id} className="fr-tt-kid fr-tt-step s-completed"><div className="fr-step2-row is-static"><I size={11} /><b>{kk.verb}</b><span>{targetOf({ name: c.tool_name, input: c.input })}</span></div></div>;
          })}
          {task.summary && <div className="fr-tt-kid fr-tt-reply"><p className="fr-tt-summary">{task.summary}</p></div>}
        </div>
      )}
    </div>
  );
}

/** One-tap replies that fit where the agent stands. */
export function QuickReplies({ session, state, live }: { session: Session; state: NodeState; live: boolean }) {
  const [sent, setSent] = useState<string | null>(null);
  const send = (label: string, text: string) => { void wsManager.send(session.id, text); setSent(label); window.setTimeout(() => setSent(null), 1500); };
  const stopIt = () => { const a = sessionActions(session, true).find(x => x.key === "stop"); void a?.fn().catch(() => {}); };
  const chips: { label: string; run: (e: ReactMouseEvent<HTMLButtonElement>) => void; tone?: "danger" }[] =
    state === "working" || live ? [
      // Stop itself is on the card's controls and in the composer; this one also hands over the reply box
      { label: "Stop and redirect", run: e => { stopIt(); ((e.currentTarget.closest(".fr-body-foot")?.querySelector(".fr-reply textarea") ?? document.querySelector("[data-fleet-composer] textarea")) as HTMLTextAreaElement | null)?.focus(); } },
    ] : state === "failed" ? [
      { label: "Try again", run: () => send("Try again", "Try again.") },
      { label: "Explain the error", run: () => send("Explain the error", "Explain briefly what went wrong.") },
      { label: "Fix it", run: () => send("Fix it", "Fix the error, then run the checks again.") },
    ] : state === "done" ? [
      { label: "Continue", run: () => send("Continue", "Continue.") },
      { label: "Summarize", run: () => send("Summarize", "Summarize briefly what you did and what is left.") },
      { label: "Run the tests", run: () => send("Run the tests", "Run the tests and tell me the result.") },
    ] : [];
  if (!chips.length) return null;
  return (
    <div className="fr-quick" onPointerDown={stop}>
      {chips.map(c => (
        <button key={c.label} type="button" className={`fr-quick-b${c.tone ? ` t-${c.tone}` : ""}${sent === c.label ? " is-sent" : ""}`} onClick={e => { stop(e); c.run(e); }}>{sent === c.label ? "Sent" : c.label}</button>
      ))}
    </div>
  );
}

/** An ask as one line: markdown marks and invisible characters out; a message of attachments only says so. */
export const askLabel = (ask: string | null) => {
  if (ask === null) return "Started on its own";
  const clean = plain(ask).replace(/\p{C}|[\u2028\u2029\ufffc\ufffd]/gu, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : "Sent an attachment";
};

/** What the agent said, compact: four lines, the rest a click away. */
function ReplyNode({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 4;
  return (
    <div className={`fr-tt-kid fr-tt-reply${full ? " is-full" : ""}`}>
      <p className="fr-tt-text">{plain(text)}</p>
      {long && <button type="button" className="fr-link" onClick={e => { stop(e); setFull(f => !f); }}>{full ? "Less" : "More"}</button>}
    </div>
  );
}

/** The open card on the map: the agent's mission at a glance (what it is after, how far along, what it is
 *  doing or stuck on, what came of it) and the decision it waits for. Everything else is one dive away. */
function MissionBody({ session, cs, state, onDive, talk }: { session: Session; cs: SessionChatState | undefined; state: NodeState; onDive: () => void; talk: boolean }) {
  const now = useContext(NowCtx);
  const log = logOf(cs);
  const todos = planOf(log);
  const done = todos.filter(t => t.status === "completed").length;
  const doing = todos.find(t => t.status === "in_progress");
  const goal = lastText(cs, "user", true);
  const files = filesTouched(log);
  const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
  const live = !!(cs?.streamingText || cs?.streamingThinking);
  const steps = log.filter(e => !/^todowrite$/i.test(e.name));
  const running = [...steps].reverse().find(e => e.status === "running");
  const said = state === "done" ? firstLine(plain(lastText(cs, "assistant") ?? "")) : "";
  return (
    <div className="fr-srow-body fr-mission" onDoubleClick={stop}>
      {state === "needs" && <Decision session={session} cs={cs} />}
      {state === "failed" && <Failure cs={cs} />}
      {goal && <div className="fr-ms-goal"><span>Goal</span><p>{askLabel(goal)}</p></div>}
      {todos.length > 0 ? (
        <div className="fr-ms-plan">
          <div className="fr-ms-bar"><i style={{ width: `${(done / todos.length) * 100}%` }} /></div>
          <div className="fr-ms-planline"><b>{done} of {todos.length}</b><span>{doing ? doing.activeForm || doing.content : done === todos.length ? "Plan done" : todos.find(t => t.status !== "completed")?.content}</span></div>
        </div>
      ) : steps.length > 0 ? (
        <div className="fr-ms-planline"><b>{steps.length} step{steps.length === 1 ? "" : "s"}</b><span>{running ? `${kindOf(running.name).verb} ${targetOf(running)} · ${clock(now - running.startedAt)}` : live ? "Writing" : state === "working" ? "Thinking" : ""}</span></div>
      ) : null}
      {(files.length > 0 || said) && (
        <div className="fr-ms-out">
          {files.length > 0 && <span><FileText size={11} />{files.length} file{files.length === 1 ? "" : "s"} <b className="add">+{add}</b> <b className="del">−{del}</b></span>}
          {said && <p>{said}</p>}
        </div>
      )}
      <div className="fr-ms-foot">
        <QuickReplies session={session} state={state} live={live} />
        <span className="fr-bar-gap" />
        <button type="button" className="fr-ms-dive" onClick={e => { stop(e); onDive(); }} title={talk ? "Dive in (Enter)" : "Dive in"}>Dive in <kbd>↵</kbd></button>
      </div>
    </div>
  );
}
