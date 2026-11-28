/** Fleet's tools around the tree: the command palette, the status filter, the
 *  action bar for what is selected, and the activity feed. Each one is a view
 *  over the same commands (fleet-commands.ts), so whatever can be done shows in
 *  more than one place: the palette lists it, the bar offers it, the key sheet
 *  prints its key. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity as ActivityIcon, AlertTriangle, ArrowUp, Check, CornerDownLeft, GitBranch, MoreHorizontal, Play, Search, X } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useSessionGitContext } from "@/hooks/use-session-git-context";
import type { SessionChatState } from "@/stores/chat-store";
import type { Session } from "@/types/session";
import { AgentStatusIcon } from "@/components/layout/sidebar";
import { GROUP_TITLE, matchCommands, matchSessions, score, type Activity, type Command, type CommandGroup, type Findable } from "./fleet-commands";
import { filesTouched, logOf, money, ringOf } from "./fleet-cards";
import { modelName } from "./fleet-text";
import type { NodeState } from "./roots-layout";

/** A key as the app prints it. */
export function Kbd({ k }: { k: string }) {
  return <kbd className="fr-kbd">{k}</kbd>;
}

const ago = (now: number, at: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 45 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/* ── the command palette ────────────────────────────────────────────────── */

type Item = { kind: "session"; s: Findable } | { kind: "cmd"; c: Command };

export function Palette({ commands, sessions, query, setQuery, onClose, onSession, onRun }: {
  commands: Command[];
  /** run a command by its id */
  onRun: (id: string) => void;
  sessions: Findable[];
  query: string;
  setQuery: (q: string) => void;
  onClose: () => void;
  /** go to a session; with `chat`, open its full chat */
  onSession: (id: string, chat: boolean) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [confirm, setConfirm] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // with nothing typed: what is selected, what waits on the user, then every command by group;
  // with a query: the sessions that answer it, then the commands
  const sections = useMemo(() => {
    const out: { title: string; items: Item[] }[] = [];
    const q = query.trim();
    if (!q) {
      const sel = commands.filter(c => c.group === "selection");
      if (sel.length) out.push({ title: GROUP_TITLE.selection, items: sel.map(c => ({ kind: "cmd", c })) });
      const waiting = sessions.filter(s => s.state === "needs" || s.state === "failed");
      if (waiting.length) out.push({ title: "Waiting on you", items: waiting.map(s => ({ kind: "session", s })) });
      for (const g of ["go", "cards", "view", "camera", "fleet"] as CommandGroup[]) {
        const cs = commands.filter(c => c.group === g);
        if (cs.length) out.push({ title: GROUP_TITLE[g], items: cs.map(c => ({ kind: "cmd", c })) });
      }
      return out;
    }
    // a loose match (letters in order) only counts when nothing closer does
    const strongS = matchSessions(q, sessions, 55), strongC = matchCommands(q, commands, 55);
    const ss = (strongS.length || strongC.length ? strongS : matchSessions(q, sessions)).slice(0, 6);
    const cs = (strongS.length || strongC.length ? strongC : matchCommands(q, commands)).slice(0, 10);
    // the closer kind goes first
    const bestS = Math.max(0, ...ss.map(x => score(q, x.title))), bestC = Math.max(0, ...cs.map(x => score(q, x.label)));
    const sFirst = bestS >= bestC;
    const S = ss.length ? [{ title: "Sessions", items: ss.map(s => ({ kind: "session", s }) as Item) }] : [];
    const C = cs.length ? [{ title: "Commands", items: cs.map(c => ({ kind: "cmd", c }) as Item) }] : [];
    out.push(...(sFirst ? [...S, ...C] : [...C, ...S]));
    return out;
  }, [commands, sessions, query]);
  const flat = sections.flatMap(s => s.items);
  const cur = Math.min(idx, Math.max(0, flat.length - 1));
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: "nearest" }); }, [cur]);

  const run = (it: Item | undefined, chat = false) => {
    if (!it) return;
    if (it.kind === "session") { onSession(it.s.id, chat); onClose(); return; }
    if (it.c.danger && confirm !== it.c.id) { setConfirm(it.c.id); return; }
    onClose();
    onRun(it.c.id);
  };

  let n = -1;
  return (
    <div className="fr-pal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fr-pal" role="dialog" aria-label="Commands">
        <div className="fr-pal-in">
          <Search size={15} />
          <input autoFocus value={query} placeholder="Find a session or run a command…" spellCheck={false}
            onChange={e => { setQuery(e.target.value); setIdx(0); setConfirm(null); }}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setIdx(Math.min(flat.length - 1, cur + 1)); setConfirm(null); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(Math.max(0, cur - 1)); setConfirm(null); }
              else if (e.key === "Enter") { e.preventDefault(); run(flat[cur], e.metaKey || e.ctrlKey); }
            }} />
          <Kbd k="esc" />
        </div>
        <div className="fr-pal-list" ref={listRef}>
          {!flat.length && <div className="fr-pal-empty">Nothing matches “{query}”</div>}
          {sections.map(sec => (
            <div key={sec.title} className="fr-pal-sec">
              <div className="fr-pal-h">{sec.title}</div>
              {sec.items.map(it => {
                n++;
                const i = n, on = i === cur;
                if (it.kind === "session") {
                  const s = it.s;
                  return (
                    <button key={`s:${s.id}`} type="button" data-i={i} className={`fr-pal-row${on ? " is-on" : ""}`} onPointerMove={() => setIdx(i)} onClick={e => run(it, e.metaKey || e.ctrlKey)}>
                      <AgentStatusIcon status={ringOf(s.state)} size={12} />
                      <span className="fr-pal-t">{s.title || "Session"}</span>
                      <span className="fr-pal-sub">{s.project}{s.branch ? ` · ${s.branch}` : ""}</span>
                      {on && <span className="fr-pal-hint"><Kbd k="↵" /> go <Kbd k="⌘↵" /> chat</span>}
                    </button>
                  );
                }
                const c = it.c, asking = confirm === c.id;
                return (
                  <button key={c.id} type="button" data-i={i} className={`fr-pal-row${on ? " is-on" : ""}${c.danger ? " is-danger" : ""}${asking ? " is-asking" : ""}`} onPointerMove={() => setIdx(i)} onClick={() => run(it)}>
                    <span className="fr-pal-ic">{c.danger ? <AlertTriangle size={12} /> : <Play size={10} />}</span>
                    <span className="fr-pal-t">{asking ? `${c.label}: press ↵ again to confirm` : c.label}</span>
                    {c.key && <span className="fr-pal-key"><Kbd k={c.key} /></span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="fr-pal-foot"><span><Kbd k="↑" /><Kbd k="↓" /> move</span><span><Kbd k="↵" /> run</span><span><Kbd k="⌘↵" /> open chat</span><span className="r">Every command here also has a place on screen</span></div>
      </div>
    </div>
  );
}

/* ── the status filter ──────────────────────────────────────────────────── */

export type Filter = NodeState | null;
const FILTERS: { key: NodeState; label: string }[] = [
  { key: "needs", label: "Needs you" }, { key: "working", label: "Working" }, { key: "failed", label: "Failed" }, { key: "done", label: "Done" },
];

export function FilterBar({ filter, counts, compact, inHead, onFilter, onPalette }: {
  filter: Filter; counts: Record<NodeState, number>; compact: boolean; inHead?: boolean;
  onFilter: (f: Filter) => void; onPalette: () => void;
}) {
  const all = counts.needs + counts.failed + counts.working + counts.done;
  return (
    <div className={`fr-filter${inHead ? " in-head" : ""}`} role="toolbar" aria-label="Filter and commands">
      <button type="button" className="fr-filter-k" onClick={onPalette} title="Find a session or run a command (⌘K)">
        <Search size={12} />{!compact && <span>Search or run…</span>}<Kbd k="⌘K" />
      </button>
      <i />
      <button type="button" className={`fr-filter-b${filter === null ? " is-on" : ""}`} onClick={() => onFilter(null)}>All <em>{all}</em></button>
      {FILTERS.map(f => (
        <button key={f.key} type="button" disabled={!counts[f.key] && filter !== f.key} className={`fr-filter-b f-${f.key}${filter === f.key ? " is-on" : ""}`}
          title={`Show only: ${f.label.toLowerCase()}`} onClick={() => onFilter(filter === f.key ? null : f.key)}>
          <b />{!compact && f.label}<em>{counts[f.key]}</em>
        </button>
      ))}
    </div>
  );
}

/* ── the bar for what is selected ───────────────────────────────────────── */

/** One of the bar's buttons; its id is the command it runs. */
export interface BarAction { id: string; label: string; icon?: ReactNode; key?: string; tone?: "primary" | "tint" | "danger" }

export function ActionBar({ title, state, sub, lead, details, hints, ask, actions, docked, onAction, onMore, onClose }: {
  title: string; state: NodeState | null; sub?: string; actions: BarAction[]; onAction: (id: string) => void; onMore?: (anchor: DOMRect) => void; onClose: () => void;
  /** what stands before the title (the agent's provider); without it, its status */
  lead?: ReactNode;
  /** facts after the title: branch, changes, files, model, cost */
  details?: ReactNode;
  /** the keys that do something now, on a quiet second line */
  hints?: [string, string][];
  /** inside the composer: the composer talks to this agent */
  docked?: boolean;
  /** what the agent asks, shown beside the buttons that answer it */
  ask?: string;
}) {
  const who = (
    <div className="fr-bar-who">
      {docked && state && <span className="fr-bar-to">To</span>}
      {lead ?? (state && <AgentStatusIcon status={ringOf(state)} size={12} />)}
      <span className="fr-bar-t">{title}</span>
      {sub && sub !== title && <span className="fr-bar-sub">{sub}</span>}
      {details}
    </div>
  );
  const buttons = actions.map(a => (
    <button key={a.id} type="button" className={`fr-bar-b${a.tone ? ` t-${a.tone}` : ""}`} onClick={() => onAction(a.id)} title={a.key ? `${a.label} (${a.key})` : a.label}>
      {a.icon}<span>{a.label}</span>{a.key && <Kbd k={a.key} />}
    </button>
  ));
  const more = onMore && <button type="button" className="fr-bar-b fr-bar-ic" aria-label="More" title="More (right-click a card)" onClick={e => onMore(e.currentTarget.getBoundingClientRect())}><MoreHorizontal size={14} /></button>;
  const close = <button type="button" className="fr-bar-b fr-bar-ic" aria-label="Clear the selection" title={docked && state ? "Talk to Fleet again (Esc)" : "Clear (Esc)"} onClick={onClose}><X size={13} /></button>;
  if (docked) {
    // inside the composer, as part of it: who the message goes to as a token, its facts beside it;
    // the answers only while it asks something; the keys on one quiet line
    const decide = actions.filter(a => DECIDE.has(a.id) || a.id.startsWith("opt:"));
    const rest = actions.filter(a => !decide.includes(a));
    const shown = new Set(actions.map(a => a.key).filter(Boolean));
    const keys = hints?.filter(([k]) => !shown.has(k));
    return (
      <div className="fr-bar is-docked" role="toolbar" aria-label={`Actions for ${title}`} onPointerDown={e => e.stopPropagation()}>
        <div className="fr-bar-top">
          <span className="fr-to" title={state ? `Messages go to ${title}` : undefined}>
            {lead ?? (state && <AgentStatusIcon status={ringOf(state)} size={12} />)}
            <b>{title}</b>
            <button type="button" aria-label={state ? "Talk to Fleet again" : "Clear"} title={state ? "Talk to Fleet again (Esc)" : "Clear (Esc)"} onClick={onClose}><X size={11} strokeWidth={2.4} /></button>
          </span>
          {sub && sub !== title && <span className="fr-bar-sub">{sub}</span>}
          {details}
          <span className="fr-bar-gap" />
          {more}
        </div>
        {decide.length > 0 && (
          <div className="fr-bar-decide">
            {ask && <span className="fr-bar-ask" title={ask}>{ask}</span>}
            <span className="fr-bar-gap" />
            {decide.map(a => (
              <button key={a.id} type="button" className={`fr-bar-b${a.tone ? ` t-${a.tone}` : ""}`} onClick={() => onAction(a.id)} title={a.key ? `${a.label} (${a.key})` : a.label}>
                <span>{a.label}</span>{a.key && <Kbd k={a.key} />}
              </button>
            ))}
          </div>
        )}
        {(rest.length > 0 || (keys && keys.length > 0)) && (
          <div className="fr-bar-low">
            {rest.map(a => (
              <button key={a.id} type="button" className={`fr-bar-g${a.tone === "danger" ? " is-danger" : ""}`} onClick={() => onAction(a.id)} title={a.key ? `${a.label} (${a.key})` : a.label}>
                {a.label}{a.key && <em>{a.key}</em>}
              </button>
            ))}
            {keys && keys.length > 0 && <KeyLine items={keys} />}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="fr-bar" role="toolbar" aria-label={`Actions for ${title}`} onPointerDown={e => e.stopPropagation()}>
      {who}
      <i />
      {buttons}
      {more}
      {close}
    </div>
  );
}

/** The buttons that answer what the agent asks. */
const DECIDE = new Set(["deny", "allow", "always", "answer", "send"]);

/** The keys, as one quiet line of text: no boxes, the key a shade brighter than what it does. */
export function KeyLine({ items }: { items: [string, string][] }) {
  return <div className="fr-keyline" aria-hidden>{items.map(([k, v]) => <span key={k + v}><b>{k}</b>{v}</span>)}</div>;
}

/** The keys that do something right now, the way a game shows its button prompts. */
export function Hints({ items }: { items: [string, string][] }) {
  return <div className="fr-bar-hints" aria-hidden>{items.map(([k, v]) => <span key={k + v}><Kbd k={k} />{v}</span>)}</div>;
}

/** The agent's state the way the sidebar shows it (working, waiting, failed); an idle one shows its provider. */
export function AgentLead({ tool, state }: { tool: string | null | undefined; state: NodeState }) {
  return (
    <span className="fr-lead">
      {state === "done" && tool ? <ProviderLogo tool={tool} size={14} /> : <AgentStatusIcon status={ringOf(state)} size={13} />}
    </span>
  );
}

/** Where the agent stands in git and what it costs, in one quiet line. */
export function AgentFacts({ session, cs }: { session: Session; cs: SessionChatState | undefined }) {
  const git = useSessionGitContext(session.worktree_path ?? session.project_path, true);
  const branch = git?.branch ?? session.worktree_branch ?? null;
  const plus = git?.plus ?? 0, minus = git?.minus ?? 0;
  const files = filesTouched(logOf(cs)).length;
  const model = modelName(session.model_name);
  return (
    <span className="fr-facts-line">
      {branch && <span className="br" title={branch}><GitBranch size={11} />{branch}</span>}
      {(plus > 0 || minus > 0) && <span><b className="add">+{plus}</b><b className="del">−{minus}</b></span>}
      {files > 0 && <span>{files} file{files === 1 ? "" : "s"}</span>}
      {model && <span>{model}</span>}
      {(session.budget_used ?? 0) > 0 && <span>{money(session.budget_used)}</span>}
    </span>
  );
}

/* ── the activity feed ──────────────────────────────────────────────────── */

const KIND_ICON: Record<Activity["kind"], ReactNode> = {
  needs: <i className="fr-act-dot d-needs" />, failed: <i className="fr-act-dot d-failed" />, done: <Check size={11} strokeWidth={2.6} />,
  step: <i className="fr-act-dot d-step" />, started: <ArrowUp size={11} strokeWidth={2.4} />,
};

export function ActivityPanel({ items, titleOf, now, onPick, onClose }: {
  items: Activity[]; titleOf: (id: string) => string; now: number; onPick: (sessionId: string) => void; onClose: () => void;
}) {
  return (
    <aside className="fr-act" aria-label="Activity" onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <div className="fr-act-h"><ActivityIcon size={13} /><span>Activity</span><Kbd k="L" /><button type="button" aria-label="Close" onClick={onClose}><X size={12} /></button></div>
      <div className="fr-act-list fr-scrollable">
        {!items.length && <div className="fr-act-empty">Nothing yet</div>}
        {items.map(e => (
          <button key={e.id} type="button" className={`fr-act-row k-${e.kind}`} onClick={() => onPick(e.sessionId)}>
            <span className="fr-act-ic">{KIND_ICON[e.kind]}</span>
            <span className="fr-act-txt"><b>{titleOf(e.sessionId)}</b> <span>{e.text}</span></span>
            <span className="fr-act-at">{ago(now, e.at)}</span>
          </button>
        ))}
      </div>
      <div className="fr-act-foot"><CornerDownLeft size={10} /> Click a line to go to its agent</div>
    </aside>
  );
}
