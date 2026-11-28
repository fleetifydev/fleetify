import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Activity as ActivityIcon, ArrowUp, Check, ChevronsDownUp, ChevronsUpDown, Copy, ExternalLink, Keyboard, Maximize2, Minus, Plus, Reply, X } from "lucide-react";
import { useChatStore, type SubagentTask } from "@/stores/chat-store";
import { fetchMessages } from "@/lib/api";
import { parseStoredMessages } from "@/lib/session-messages";
import { usePinnedSessions } from "@/lib/session-pins";
import { LogoMark } from "@/components/brand/logo-mark";
import { folderName } from "@/lib/utils";
import type { Session } from "@/types/session";
import { CAM, decide, initialPolicy, type Base, type CamEvent, type Cmd, type Ctx, type PolicyState } from "./camera-policy";
import { planFlight, stepFlight, type Flight, type View } from "./camera-flight";
import { buildColumns, layoutBranches, nodeState, TREE, type BranchOutput, type NodeState, type Placed, type TreeRow, type TreeSession } from "./roots-layout";
import { C_ORANGE, C_RED, FleetThread, NowCtx, SessionCard, SubagentCard, hasPending, kindOf, logOf, money, sessionActions, targetOf, useTicker } from "./fleet-cards";
import { activityOf, matchSessions, type Command, type Findable } from "./fleet-commands";
import { navigate, navMap, type Dir } from "./fleet-nav";
import { ActionBar, ActivityPanel, AgentFacts, AgentLead, FilterBar, Kbd, KeyLine, Palette, type Filter } from "./fleet-tools";
import { wsManager } from "@/services/ws-manager";

/** Fleet's home: a tree that grows out of Fleetify's mark. Projects branch to
 *  the left and right of the mark, each along its own lane; each project's
 *  sessions hang off its trunk, and the sessions and sub-agents they started
 *  hang off them. The cards (fleet-cards.tsx) tell the whole story and take
 *  every decision; the canvas pans, zooms and flies to any card. */

const STATE_COLOR: Record<NodeState, string> = { needs: C_ORANGE, failed: C_RED, working: "#4ade80", done: "rgba(160,160,160,.6)" };

interface Props {
  sessions: Session[];
  /** enter a session: its full chat opens beside the map (null closes it) */
  onOpen: (id: string | null) => void;
  /** leave Fleet for the session's own page */
  onLeave?: (id: string) => void;
  /** the session whose chat is open beside the map */
  panelId?: string | null;
  /** places in the window's header for Fleet's toolbars, in line with the title; without them the toolbars float over the canvas */
  head?: { left: HTMLElement | null; right: HTMLElement | null };
  /** a place on top of the composer: the selected card's bar docks there */
  dock?: HTMLElement | null;
  /** who the composer talks to: the card selected, the cards picked, every working agent; none means Fleet itself */
  onTarget?: (ids: string[] | null, label: string) => void;
  /** Fleet's own session, whose conversation shows under the hub */
  fleetSessionId?: string | null;
  /** show Fleet's whole conversation (the header's Chat view) */
  onShowChat?: () => void;
}

/* ── the hub ─────────────────────────────────────────────────────────── */

/** A number that rolls to its new value instead of jumping. */
function Num({ value, format }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current, to = value, f = format ?? ((n: number) => String(Math.round(n)));
    if (from === to) { el.textContent = f(to); return; }
    const ease = (u: number) => 1 - Math.pow(1 - Math.min(1, u), 3);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const u = ease((t - t0) / 700);
      shown.current = from + (to - from) * u;
      el.textContent = f(u >= 1 ? to : shown.current);
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, format]);
  return <span ref={ref} />;
}

/* The hub is Fleetify's own lockup, the mark beside the wordmark, plain, with nothing around it. */
const MARK = 30;
/** The lockup's box: the cables meet it at its sides, level with its middle. */
const LOCK = { w: 132, h: 40 };
/** Where the lockup's middle sits inside the hub node, and how far its sides reach, px. */
const HUB_CORE = { cy: LOCK.h / 2, half: LOCK.w / 2 + 10 };

type Pick = "needs" | "failed" | "working";
function Hub({ counts, markRef, onPick, fleetBusy, thread }: { counts: Record<NodeState, number>; markRef: RefObject<HTMLDivElement | null>; onPick: (k: Pick) => void; fleetBusy?: boolean; thread?: ReactNode }) {
  const calling = counts.needs + counts.failed > 0;
  return (
    <>
      <Lockup working={counts.working > 0 || !!fleetBusy} markRef={markRef} />
      <div className="fr-hub-headline">
        {counts.needs > 0 && <button type="button" className="fr-hub-count" style={{ color: C_ORANGE }} title="Show the next one that needs you (N)" onClick={e => { e.stopPropagation(); onPick("needs"); }}><b><Num value={counts.needs} /></b> need{counts.needs === 1 ? "s" : ""} you</button>}
        {counts.failed > 0 && <button type="button" className="fr-hub-count" style={{ color: C_RED }} title="Show the next failed one" onClick={e => { e.stopPropagation(); onPick("failed"); }}><b><Num value={counts.failed} /></b> failed</button>}
        {counts.working > 0 && <button type="button" className="fr-hub-count" title="Show every agent at work" onClick={e => { e.stopPropagation(); onPick("working"); }}>{counts.working} working</button>}
        {!calling && !counts.working && !fleetBusy && <span>All quiet</span>}
        {fleetBusy && <span className="fr-hub-busy">Fleet is on it…</span>}
      </div>
      {thread}
    </>
  );
}

/** Fleetify's lockup, the one the app uses everywhere (<Logo>): the mark beside
 *  the bold wordmark. Its motion is quiet: the bars draw in from the left and the
 *  word follows; while agents work a slow, soft wave of light passes down the
 *  bars; on hover the two shorter bars reach out, the way a click on it reaches
 *  for the whole fleet. Same geometry as <LogoMark>. */
function Lockup({ working, markRef }: { working: boolean; markRef: RefObject<HTMLDivElement | null> }) {
  const bars = [{ y: 4, w: 18, o: 1 }, { y: 10.5, w: 11, o: 0.85 }, { y: 17, w: 7, o: 0.7 }];
  return (
    <div ref={markRef} className={`fr-lockup${working ? " is-working" : ""}`} style={{ width: LOCK.w, height: LOCK.h }} role="img" aria-label="Fleetify"
      title="Click: back to the middle · double-click: close every card">
      <svg className="fr-mark" viewBox="0 0 24 24" width={MARK} height={MARK} aria-hidden>
        {bars.map((b, i) => <rect key={b.y} className={`b${i + 1}`} x={3} y={b.y} width={b.w} height={3} rx={1.5} fill="currentColor" style={{ ["--o" as string]: b.o }} />)}
      </svg>
      <span className="fr-wordmark">Fleetify</span>
    </div>
  );
}

/** The camera over the tree: where it looks, how close, and where it is heading. */
interface Cam { x: number; y: number; s: number; vx: number; vy: number; init: boolean; userAt: number }
type Who = "user" | "auto";
/** How long the camera keeps its hands off after the user steers, ms. */
const ZOOM = { min: 0.3, max: 2, step: 1.25 };
/** Room the toolbars take along the top of the view, px: nothing is framed under them. */
const SAFE_TOP = 16;
/** Render a toolbar into the header's slot when there is one, else in place. */
const inHead = (slot: HTMLElement | null | undefined, node: ReactNode) => (slot ? createPortal(node, slot) : node);
/** Room the composer takes at the bottom of the view, px. */
const COMPOSER = 130;
/** Height the selected card's bar adds on top of the composer, px. */
const DOCK_H = 76;

/* ── the tree ────────────────────────────────────────────────────────── */

/** A node's motion: where it is, how fast it moves, where it is going, and
 *  when it may start to show (a staggered entrance). */
interface Motion { x: number; y: number; vx: number; vy: number; tx: number; ty: number; showAt: number; shown: boolean; u: number }
interface Draw { at: number; dur: number; done: boolean }
/** A spark: one new step, carried from its card up the branch to the hub. */
interface Spark { id: string; born: number }
const TASK = "task:";
const taskId = (sid: string, tid: string) => `${TASK}${sid}:${tid}`;
const subState = (t: SubagentTask): NodeState => (t.status === "running" ? "working" : t.status === "failed" ? "failed" : "done");
const worst = (states: NodeState[]): NodeState =>
  states.includes("needs") ? "needs" : states.includes("failed") ? "failed" : states.includes("working") ? "working" : "done";
const ease = (u: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
const easeInOut = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const SPRING = { k: 220, c: 2 * Math.sqrt(220) };
const APPEAR_MS = 480;
const SPARK_MS = 1100;
const SPARK_POOL = 14;
/** The monotonic clock the camera keeps its hands-off time on. */
const clockNow = () => performance.now();
/** Wall-clock time, for what is compared with message and step times. */
const wallNow = () => Date.now();
const projectOf = (s: Session) => (s.project_path ? folderName(s.project_path) : "No project");

export function FleetRoots({ sessions, onOpen, onLeave, panelId, head, dock, onTarget, fleetSessionId, onShowChat }: Props) {
  const now = useTicker();
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [field, setField] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e) setField({ w: e.contentRect.width, h: e.contentRect.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chat = useChatStore(s => s.sessions);
  const byId = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // cards opened or closed by hand; the rest follow defaultOpen (a waiting card opens while selected)
  const [flip, setFlip] = useState<Map<string, boolean>>(new Map());

  const tree = useMemo(() => sessions.map<TreeSession>(s => {
    const cs = chat[s.id];
    return {
      id: s.id,
      project: projectOf(s),
      state: nodeState(s.status, hasPending(cs), !!cs?.isStreaming),
      parentId: s.parent_id,
      createdAt: new Date(s.created_at).getTime() || 0,
    };
  }), [sessions, chat]);

  // sessions, then each session's sub-agents as rows of their own, one step out
  const columns = useMemo(() => buildColumns(tree, expanded).map(c => {
    const rows: TreeRow[] = [];
    for (const r of c.rows) {
      rows.push(r);
      const tasks = Object.values(chat[r.id]?.subagentTasks ?? {});
      for (const t of tasks.slice(-4)) rows.push({ id: taskId(r.id, t.id), state: subState(t), depth: r.depth + 1, parent: r.id });
    }
    return { ...c, rows };
  }), [tree, expanded, chat]);

  // a project whose only session carries its own name needs no label: the row stands for both
  const merged = useMemo(() => {
    const m = new Set<string>();
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const c of columns) {
      if (c.rows.length !== 1 || c.doneFolded) continue;
      const one = byId.get(c.rows[0]!.id);
      if (one && norm(one.title || "") === norm(c.project)) m.add(c.project);
    }
    return m;
  }, [columns, byId]);

  const projState = useMemo(() => {
    const m = new Map<string, NodeState>();
    for (const c of columns) m.set(c.project, worst(tree.filter(t => t.project === c.project).map(t => t.state)));
    return m;
  }, [columns, tree]);

  // a row shows its details when it needs the user; any row opens or folds by hand
  // a card waiting on the user opens by itself when it is selected; any card opens or closes by hand
  const defaultOpen = (id: string, state: NodeState) => state === "needs" && sel === `s:${id}`;
  const isOpen = (id: string, state: NodeState) => flip.get(id) ?? defaultOpen(id, state);
  // a card the user picked holds the camera: the autopilot waits until they let it go
  const userPick = useRef<string | null>(null);
  // opening a card brings all of it into view once it has laid out
  const pendingFocus = useRef<string | null>(null);
  const toggle = (id: string, state: NodeState) => {
    if (!isOpen(id, state)) { pendingFocus.current = `s:${id}`; setSel(`s:${id}`); userPick.current = `s:${id}`; }
    else if (userPick.current === `s:${id}`) userPick.current = null;
    const open = !isOpen(id, state);
    setFlip(f => new Map(f).set(id, open));
  };

  const counts = { needs: 0, failed: 0, working: 0, done: 0 } as Record<NodeState, number>;
  for (const t of tree) counts[t.state]++;

  // a session not opened since the app started has no messages in memory: load
  // its latest ones, so its card can show what it asked, did, changed and said
  // the app empties transcripts no chat view shows; Fleet shows these, so it holds them
  usePinnedSessions(sessions.map(s => s.id));
  const tried = useRef(new Map<string, number>());
  useEffect(() => {
    let cancelled = false;
    const t = Date.now();
    // a failed load is tried again after a while; a loaded one never again
    const todo = sessions.filter(s => !s.local_only && t - (tried.current.get(s.id) ?? 0) > 30000 && !useChatStore.getState().sessions[s.id]?.messages.length);
    todo.forEach(s => tried.current.set(s.id, t));
    void (async () => {
      for (let i = 0; i < todo.length && !cancelled; i += 3) {
        await Promise.all(todo.slice(i, i + 3).map(async s => {
          try {
            const rows = await fetchMessages(s.id, { limit: 40 });
            const st = useChatStore.getState();
            if (cancelled || !Array.isArray(rows) || !rows.length || st.sessions[s.id]?.messages.length) return;
            st.setMessages(s.id, parseStoredMessages(rows));
          } catch { /* tried again later; meanwhile the card shows its live state */ }
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [sessions]);

  // measure every node, lay the tree out, and let a frame loop spring nodes and lines there
  const els = useRef(new Map<string, HTMLDivElement>());
  // node sizes as last measured, so the frame loop never reads layout
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const layStamp = useRef(0);
  const motion = useRef(new Map<string, Motion>());
  const draws = useRef(new Map<string, Draw>());
  const [lay, setLay] = useState<BranchOutput | null>(null);
  const layRef = useRef<BranchOutput | null>(null);
  const laidOut = useRef(false);
  const reduce = useMemo(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
  const [measureTick, setMeasureTick] = useState(0);
  const markRef = useRef<HTMLDivElement>(null);
  const cam = useRef<Cam>({ x: 0, y: 0, s: 1, vx: 0, vy: 0, init: false, userAt: -Infinity });
  const flight = useRef<Flight | null>(null);
  const fieldRef = useRef(field);
  useEffect(() => { fieldRef.current = field; }, [field]);
  const [zoom, setZoom] = useState(1);
  const zoomShown = useRef(100);

  // ── what the user is doing, read by the camera policy (refs only: no re-renders)
  const sig = useRef({
    lastSteerAt: -Infinity, lastPointerAt: -Infinity, px: 0, py: 0, pointerIn: false,
    hoverId: null as string | null, hoverSince: 0, scrollAt: -Infinity, typing: false, selecting: false,
    pointerDown: false, visible: true, focused: true, lastInputAt: 0, hiddenAt: null as number | null,
  });
  const pol = useRef<PolicyState>(initialPolicy());
  const lastLayoutAt = useRef(0);

  // ── the camera: pan, zoom, fit everything, focus one card
  const clampZ = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
  /** The bar docked on the composer makes it taller: the camera frames above both. */
  const dockedBar = useRef(false);
  const viewH = () => Math.max(200, field.h - COMPOSER - (dockedBar.current ? DOCK_H : 0));
  /** The camera as (centre, width) in the world, the way flights are planned. */
  const safeCY = () => SAFE_TOP + (viewH() - SAFE_TOP) / 2;
  const toView = (x: number, y: number, s: number): View => [(field.w / 2 - x) / s, (safeCY() - y) / s, field.w / s];
  const moveTo = (tx: number, ty: number, ts: number, animate: boolean, who: Who = "user") => {
    const c = cam.current, L = layRef.current;
    const w = L?.width ?? 0, h = L?.height ?? 0, m = 120;
    ts = clampZ(ts);
    tx = Math.min(field.w - m, Math.max(m - w * ts, tx));
    ty = Math.min(field.h - m, Math.max(m - h * ts, ty));
    if (who === "user") {
      const t = clockNow();
      c.userAt = t; sig.current.lastSteerAt = t; sig.current.lastInputAt = t;
      pol.current = decide(pol.current, { type: "steer" }, policyCtx(t))[0];
      setCamBase(pol.current.base);
    } else if (!flight.current && Math.abs(tx - c.x) < 24 && Math.abs(ty - c.y) < 24 && Math.abs(ts - c.s) < 0.02) return;
    c.vx = 0; c.vy = 0;
    if (animate) flight.current = planFlight(toView(c.x, c.y, c.s), toView(tx, ty, ts), who, clockNow(), reduce);
    else { flight.current = null; Object.assign(c, { x: tx, y: ty, s: ts }); }
  };
  const zoomAt = (px: number, py: number, z: number, animate: boolean) => {
    const c = cam.current;
    const k = clampZ(z) / c.s;
    moveTo(px - (px - c.x) * k, py - (py - c.y) * k, c.s * k, animate);
  };
  const zoomBy = (f: number) => { const c = cam.current; zoomAt(field.w / 2, safeCY(), c.s * f, true); };
  const fit = (who: Who = "user") => {
    const L = layRef.current;
    if (!L) return;
    const room = viewH() - SAFE_TOP - 24;
    const z = clampZ(Math.min(1, (field.w - 48) / L.width, room / L.height));
    moveTo((field.w - L.width * z) / 2, Math.max(SAFE_TOP, safeCY() - (L.height * z) / 2), z, true, who);
  };
  const focus = (id: string, who: Who = "user") => {
    const p = motion.current.get(id), el = els.current.get(id);
    if (!p || !el) return;
    // a card still opening counts at the height it is growing to
    const grow = el.querySelector<HTMLElement>(".fr-collapse.is-open"), inner = grow?.firstElementChild as HTMLElement | null;
    const w = el.offsetWidth, h = el.offsetHeight + (grow && inner ? Math.max(0, inner.scrollHeight - grow.offsetHeight) : 0);
    // the card and Fleetify's mark together, both clear of the toolbars along the top,
    // so the way back is always in sight; full size when they fit
    const hp = motion.current.get("fleet"), he = els.current.get("fleet");
    const top = SAFE_TOP, room = viewH() - top - 24;
    const box = { x0: p.tx, y0: p.ty, x1: p.tx + w, y1: p.ty + h };
    if (hp && he && id !== "fleet") {
      const withHub = { x0: Math.min(box.x0, hp.tx), y0: Math.min(box.y0, hp.ty), x1: Math.max(box.x1, hp.tx + he.offsetWidth), y1: Math.max(box.y1, hp.ty + HUB_CORE.cy * 2 + 30) };
      const zHub = Math.min(1, (field.w - 80) / (withHub.x1 - withHub.x0), room / (withHub.y1 - withHub.y0));
      if (zHub >= 0.6) Object.assign(box, withHub);
    }
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    // automatic moves stay between 50 % and 100 %: cards are drawn for 100 %, and below half they cannot be read
    const z = clampZ(Math.min(1, (field.w - 80) / bw, Math.max(who === "auto" ? 0.8 : 0.6, room / bh)));
    const y = bh * z <= room ? top + room / 2 - (box.y0 + bh / 2) * z : top - box.y0 * z;
    moveTo(field.w / 2 - (box.x0 + bw / 2) * z, y, z, true, who);
  };
  /** The boxes of everything still at work: the hub, their heads and their cards. */
  const liveBoxes = (): Placed[] => {
    const L = layRef.current;
    if (!L) return [];
    const bs: Placed[] = [L.hub];
    for (const c of columns) for (const r of c.rows) {
      if (r.state === "done") continue;
      const b = L.rows[r.id], hd = L.heads[c.project];
      if (b) bs.push(b);
      if (hd) bs.push(hd);
    }
    return bs;
  };
  // every agent still at work, and the hub, in view
  const frameLive = () => {
    const bs = liveBoxes();
    if (bs.length <= 1) { fit("auto"); return; }
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    const w = Math.max(...bs.map(b => b.x + b.w)) - x0, h = Math.max(...bs.map(b => b.y + b.h)) - y0;
    const room = viewH() - SAFE_TOP - 24;
    const z = clampZ(Math.max(0.5, Math.min(1, (field.w - 80) / w, room / h)));
    const y = h * z <= room ? safeCY() - (y0 + h / 2) * z : SAFE_TOP - y0 * z;
    moveTo(field.w / 2 - (x0 + w / 2) * z, y, z, true, "auto");
  };
  // the mark in the middle of the view; the camera is handed back to the policy
  const centerHub = () => {
    userPick.current = null;
    const p = motion.current.get("fleet"), el = els.current.get("fleet"), c = cam.current;
    if (!p || !el) return;
    const z = clampZ(Math.min(1, Math.max(0.7, c.s)));
    moveTo(field.w / 2 - (p.tx + el.offsetWidth / 2) * z, safeCY() - (p.ty + HUB_CORE.cy) * z, z, true, "auto");
    c.userAt = -Infinity; sig.current.lastSteerAt = -Infinity;
    pol.current = { ...pol.current, base: "overview", attendId: null, answeredAt: null };
    setCamBase("overview");
  };
  // a whole project in view: its head, its trunk and every card on it
  const fitProject = (project: string) => {
    const L = layRef.current, col = columns.find(c => c.project === project);
    if (!L || !col) return;
    const bs = [L.heads[project], ...col.rows.map(r => L.rows[r.id]), L.folds[project]].filter((b): b is Placed => !!b);
    if (!bs.length) return;
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    const w = Math.max(...bs.map(b => b.x + b.w)) - x0, h = Math.max(...bs.map(b => b.y + b.h)) - y0;
    const room = viewH() - SAFE_TOP - 24;
    let z = clampZ(Math.min(1, (field.w - 80) / w, room / h));
    if (z < 0.7) z = clampZ(Math.min(1, (field.w - 80) / w));
    const y = h * z <= room ? safeCY() - (y0 + h / 2) * z : SAFE_TOP - y0 * z;
    moveTo(field.w / 2 - (x0 + w / 2) * z, y, z, true);
  };
  // what waits on the user, in the tree's order; the waiting button and N walk through it
  const waiting = columns.flatMap(c => c.rows.filter(r => (r.state === "needs" || r.state === "failed") && !r.id.startsWith(TASK)).map(r => r.id));
  const waitIdx = useRef(-1);
  const [sel, setSel] = useState<string | null>(null);
  /** The selection, for the frame loop and for timers that check it later. */
  const selRef = useRef<string | null>(null);
  /** Where the selection has been, for Backspace. */
  const history = useRef<string[]>([]);
  /** Select a node. A jump frames it (with the hub when they fit); a walk moves the camera only as far as needed. */
  const select = (id: string, how: "jump" | "walk" = "jump") => {
    if (sel && sel !== id) { history.current.push(sel); if (history.current.length > 40) history.current.shift(); }
    setSel(id); userPick.current = id.startsWith("s:") ? id : null;
    if (id === "fleet") centerHub();
    else if (how === "walk") ensureVisible(id);
    else focus(id);
  };
  /** The game camera: a card already in view keeps the camera still; one near or past the edge brings the view along just enough. */
  const ensureVisible = (id: string) => {
    const p = motion.current.get(id), b = sizes.current.get(id), c = cam.current;
    if (!p || !b) return;
    if (c.s < 0.7) { focus(id); return; }
    const m = 48, top = SAFE_TOP + m, bottom = viewH() - m, left = m, right = field.w - m;
    const x0 = c.x + p.tx * c.s, y0 = c.y + p.ty * c.s, x1 = x0 + b.w * c.s, y1 = y0 + Math.min(b.h * c.s, bottom - top);
    let dx = 0, dy = 0;
    if (x0 < left) dx = left - x0; else if (x1 > right) dx = right - x1;
    if (y0 < top) dy = top - y0; else if (y1 > bottom) dy = bottom - y1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    moveTo(c.x + dx, c.y + dy, c.s, true);
  };
  /** Tab and N walk what waits on the user, from wherever the selection is. */
  const stepWaiting = (d: 1 | -1) => {
    if (!waiting.length) { say("Nothing is waiting on you"); return; }
    const here = sel?.startsWith("s:") ? waiting.indexOf(sel.slice(2)) : -1;
    const from = here >= 0 ? here : d === 1 ? waitIdx.current : waitIdx.current + 1;
    waitIdx.current = ((from + d) % waiting.length + waiting.length) % waiting.length;
    select(`s:${waiting[waitIdx.current]}`);
  };
  const nextWaiting = () => stepWaiting(1);
  const prevWaiting = () => stepWaiting(-1);
  /** What 1–9 jump to: the cards waiting on the user first, then the rest in the order of the tree. */
  const numbered = [...waiting, ...columns.flatMap(c => c.rows.filter(r => !r.id.startsWith(TASK) && !waiting.includes(r.id)).map(r => r.id))].slice(0, 9);
  const jumpWaiting = (i: number) => {
    const id = numbered[i];
    if (!id) { say(numbered.length ? `Only ${numbered.length} numbered card${numbered.length === 1 ? "" : "s"}` : "No cards to jump to"); return; }
    if (i < waiting.length) waitIdx.current = i;
    select(`s:${id}`);
  };
  /** Backspace: back to what was selected before. */
  const back = () => {
    const prev = history.current.pop();
    if (!prev) return;
    setSel(prev); userPick.current = prev.startsWith("s:") ? prev : null;
    if (prev === "fleet") centerHub(); else focus(prev);
  };
  /** The arrows (and j, k) walk the tree like a cursor: see fleet-nav.ts. */
  const walk = (dir: Dir) => {
    const L = layRef.current;
    if (!L) return;
    const map = navMap("fleet", columns.map(c => ({ project: c.project, rows: c.rows, folded: c.doneFolded > 0 || expanded.has(c.project), merged: merged.has(c.project) })), L);
    const next = navigate(sel, dir, map);
    if (next) select(next, "walk");
  };
  const clearSel = () => { setSel(null); userPick.current = null; };
  /** O: the selected session's full chat, beside the map. */
  const openSel = () => { if (sel?.startsWith("s:") && !sel.startsWith(`s:${TASK}`)) onOpen(sel.slice(2)); };
  /** Shift+O: leave Fleet for the session's own page. */
  const leave = () => { if (sel?.startsWith("s:") && !sel.startsWith(`s:${TASK}`)) onLeave?.(sel.slice(2)); };

  // ── the camera policy (camera-policy.ts): when the camera moves on its own, and where
  const [autoOn, setAutoOn] = useState(true);
  const [camBase, setCamBase] = useState<Base>("overview");
  /** Questions and permission requests still open, the oldest first. */
  const needSince = useRef(new Map<string, number>());
  const openQuestions = () => [...needSince.current.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  /** A card fully inside the safe view at a readable zoom. */
  const inView = (id: string) => {
    const p = motion.current.get(`s:${id}`), b = sizes.current.get(`s:${id}`), c = cam.current;
    if (!p || !b || c.s < 0.8) return false;
    const x0 = c.x + p.tx * c.s, y0 = c.y + p.ty * c.s, x1 = x0 + b.w * c.s, y1 = y0 + Math.min(b.h, 420) * c.s;
    return x0 >= 0 && x1 <= field.w && y0 >= SAFE_TOP - 4 && y1 <= viewH() + 4;
  };
  const policyCtx = (now: number): Ctx => {
    const s = sig.current, c = cam.current;
    const reading = (!!s.hoverId && now - s.hoverSince >= CAM.HOVER_READ) || now - s.scrollAt < CAM.READ_GRACE || s.typing || s.selecting || !!userPick.current;
    const steering = s.pointerDown || now - s.lastSteerAt < CAM.STEER_QUIET;
    const idleFor = now - s.lastInputAt;
    const pointerBusy = s.focused && s.pointerIn && now - s.lastPointerAt < CAM.POINTER_QUIET;
    const ambient = s.visible && (!s.focused || idleFor >= CAM.AMBIENT_IDLE);
    // how the agents at work sit in the view: any clipped, all gone, or shrunk to a corner
    const bs = liveBoxes().slice(1);
    let clipped = false, anyIn = false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bs) {
      const sx0 = c.x + b.x * c.s, sy0 = c.y + b.y * c.s, sx1 = sx0 + b.w * c.s, sy1 = sy0 + Math.min(b.h, 420) * c.s;
      x0 = Math.min(x0, sx0); y0 = Math.min(y0, sy0); x1 = Math.max(x1, sx1); y1 = Math.max(y1, sy1);
      if (sx1 > 0 && sx0 < field.w && sy1 > SAFE_TOP && sy0 < viewH()) anyIn = true;
      if (sx0 < -24 || sx1 > field.w + 24 || sy0 < SAFE_TOP - 24 || sy1 > viewH() + 24) clipped = true;
    }
    const small = bs.length > 0 && (x1 - x0) < field.w * 0.4 && (y1 - y0) < (viewH() - SAFE_TOP) * 0.4;
    return {
      now, reading, idleFor, waiting: openQuestions(), inView,
      mayMove: autoOn && s.visible && !steering && !reading && (ambient || !pointerBusy),
      liveOutOfView: bs.length > 0 && !anyIn, overviewStale: clipped || small,
      layoutStill: now - lastLayoutAt.current,
    };
  };
  const run = (cmd: Cmd) => {
    if (cmd.kind !== "fly") return;
    if (cmd.frame === "live") frameLive();
    else focus(`s:${cmd.frame.id}`, "auto");
  };
  const step = (ev: CamEvent) => {
    const now = clockNow();
    const [next, cmd] = decide(pol.current, ev, policyCtx(now));
    pol.current = next;
    if (next.base !== camBase) setCamBase(next.base);
    if (autoOn) run(cmd);
  };
  const recenter = () => { userPick.current = null; sig.current.lastSteerAt = -Infinity; step({ type: "recenter" }); };
  // ── handy things: open and close cards in bulk, a short note, a menu, a search, a key sheet
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const say = (text: string) => { setToast(text); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 2600); };
  /** Open or close these rows, whatever they were. */
  const setOpenMany = (rows: TreeRow[], open: boolean) => setFlip(f => {
    const n = new Map(f);
    for (const r of rows) n.set(r.id, open);
    return n;
  });
  const allRows = columns.flatMap(c => c.rows);
  const anyOpen = allRows.some(r => isOpen(r.id, r.state));
  /** Double-click on Fleetify (or C): close every card; again, open the ones that need you. */
  const toggleAll = () => {
    userPick.current = null;
    // closing all forgets what was opened by hand; a waiting card still opens when it is next selected
    if (anyOpen) { setFlip(new Map(allRows.filter(r => defaultOpen(r.id, r.state)).map(r => [r.id, false]))); centerHub(); say("All cards closed · double-click Fleetify to open what needs you"); return; }
    const needs = allRows.filter(r => r.state === "needs");
    setFlip(new Map(needs.map(r => [r.id, true])));
    say(needs.length ? `Opened ${needs.length} that need${needs.length === 1 ? "s" : ""} you` : "Nothing needs you right now");
  };
  /** Double-click on a project: close its cards, or open all of them. */
  const toggleProject = (project: string) => {
    const rows = columns.find(c => c.project === project)?.rows.filter(r => !r.id.startsWith(TASK)) ?? [];
    if (!rows.length) return;
    const open = !rows.some(r => isOpen(r.id, r.state));
    setOpenMany(rows, open);
    if (open) window.setTimeout(() => api.current.fitProject(project), 80);
  };
  /** The hub's counts: each one walks through its own kind. */
  const pickIdx = useRef<Record<Pick, number>>({ needs: -1, failed: -1, working: -1 });
  const onPick = (k: Pick) => {
    if (k === "working") { frameLive(); return; }
    const ids = allRows.filter(r => r.state === k && !r.id.startsWith(TASK)).map(r => r.id);
    if (!ids.length) return;
    pickIdx.current[k] = (pickIdx.current[k] + 1) % ids.length;
    const id = `s:${ids[pickIdx.current[k]]}`;
    select(id);
    ring(els.current.get(id), k === "needs" ? C_ORANGE : C_RED);
  };
  const toggleFold = (project: string) => setExpanded(e => { const n = new Set(e); if (n.has(project)) n.delete(project); else n.add(project); return n; });
  /** Space: open or close the selected card; on a project, all its cards; on the finished ones, unfold them. */
  const toggleSel = () => {
    if (!sel) return;
    if (sel.startsWith("head:")) { toggleProject(sel.slice(5)); return; }
    if (sel.startsWith("fold:")) { toggleFold(sel.slice(5)); return; }
    if (!sel.startsWith("s:")) return;
    const r = allRows.find(x => `s:${x.id}` === sel);
    if (r) toggle(r.id, r.state);
  };

  // right-click on a card: what the card can do, without opening it
  /** the menu's place in the view: at the pointer, or (`up`) above the bar's ⋯ button, its right edge on the button's */
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; up?: boolean } | null>(null);
  const onMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>(".fr-node");
    const id = n?.dataset.id;
    if (!id?.startsWith("s:") || id.startsWith(`s:${TASK}`)) return;
    e.preventDefault();
    const r = viewRef.current?.getBoundingClientRect();
    setMenu({ x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0), id: id.slice(2) });
    setSel(id);
  };
  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setMenu(null);
    try { await fn(); say(`${label}: done`); } catch { say(`${label} did not work`); }
  };
  const copy = (label: string, text: string) => { setMenu(null); void navigator.clipboard?.writeText(text).then(() => say(`${label} copied`), () => say("Could not copy")); };

  // ── the command palette (⌘K or /): every session and every command, in one list
  const [palette, setPalette] = useState<string | null>(null);
  const findable = useMemo<Findable[]>(() => sessions.map(x => ({ id: x.id, title: x.title, project: projectOf(x), branch: x.worktree_branch, model: x.model_name, state: tree.find(t => t.id === x.id)?.state ?? "done" })), [sessions, tree]);
  const hits = useMemo(() => (palette?.trim() ? matchSessions(palette, findable).map(f => f.id) : []), [palette, findable]);
  // ── the status filter: one kind stays lit, the rest steps back
  const [filter, setFilterState] = useState<Filter>(null);
  /** What stays lit: the sessions the palette finds while typing, else the ones the filter keeps. */
  const keep = useMemo(() => (palette?.trim() ? new Set(hits) : filter ? new Set(tree.filter(t => t.state === filter).map(t => t.id)) : null), [palette, hits, filter, tree]);
  /** Every agent in view whose card is in this set, with the hub. */
  const frameIds = (ids: string[]) => {
    const L = layRef.current;
    if (!L) return;
    const bs = [L.hub, ...ids.map(id => L.rows[id]).filter((b): b is Placed => !!b)];
    if (bs.length <= 1) return;
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    const w = Math.max(...bs.map(b => b.x + b.w)) - x0, h = Math.max(...bs.map(b => b.y + Math.min(b.h, 420))) - y0;
    const room = viewH() - SAFE_TOP - 24;
    const z = clampZ(Math.max(0.45, Math.min(1, (field.w - 80) / w, room / h)));
    const y = h * z <= room ? safeCY() - (y0 + h / 2) * z : SAFE_TOP - y0 * z;
    moveTo(field.w / 2 - (x0 + w / 2) * z, y, z, true);
  };
  const setFilter = (f: Filter) => {
    setFilterState(f);
    if (!f) return;
    const ids = tree.filter(t => t.state === f).map(t => t.id);
    // finished cards are folded away: unfold them to show them
    if (f === "done") setExpanded(new Set(columns.map(c => c.project)));
    window.setTimeout(() => api.current.frameIds(ids), f === "done" ? 160 : 0);
  };
  /** Go to a session: unfold its project if it is folded away, or open its full chat. */
  const goSession = (id: string, chat = false) => {
    if (chat) { onOpen(id); return; }
    if (!layRef.current?.rows[id]) {
      const sx = byId.get(id);
      if (sx) setExpanded(e => new Set(e).add(projectOf(sx)));
      pendingFocus.current = `s:${id}`; setSel(`s:${id}`); userPick.current = `s:${id}`;
      return;
    }
    select(`s:${id}`);
  };
  // ── several cards at once: shift- or cmd-click picks them, the bar acts on all
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (id: string) => setPicked(p => {
    const n = new Set(p);
    if (!n.size && sel?.startsWith("s:") && !sel.startsWith(`s:${TASK}`) && sel.slice(2) !== id) n.add(sel.slice(2));
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  // ── answering from anywhere: allow, deny, reply
  const answer = (id: string, allow: boolean, always = false) => {
    const pr = useChatStore.getState().sessions[id]?.permissionRequest;
    if (!pr) return;
    void wsManager.sendPermissionResponse(id, pr.id, allow, always, pr.tool_name);
    say(allow ? (always ? `Always allowed ${pr.tool_name}` : `Allowed ${pr.tool_name}`) : `Denied ${pr.tool_name}`);
    advanceFrom(id);
  };
  // ── the answer loop: answer the selected card, and after a beat the next one that waits is selected
  /** An answer picked from the keys (1–9) on a one-question card, sent with Enter. */
  const [pick, setPick] = useState<{ sid: string; label: string } | null>(null);
  const advanceFrom = (id: string) => { window.setTimeout(() => api.current.advance(id), CAM.AFTER_ANSWER); };
  const advance = (id: string) => {
    if (selRef.current !== `s:${id}`) return; // the user moved on themself
    // questions first (the oldest), then failures
    const next = openQuestions().find(w => w !== id) ?? waiting.find(w => w !== id);
    if (next) { select(`s:${next}`); say(`Next: ${byId.get(next)?.title || "Session"}`); }
    else { setSel(null); userPick.current = null; frameLive(); say("All clear · nothing is waiting on you"); }
  };
  /** Reply: with the composer docked, it already talks to the selected agent, so just go there; without it, the card's own box. */
  const replyTo = (id: string) => {
    if (panelId) {
      if (sel !== `s:${id}`) select(`s:${id}`);
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-fleet-composer] textarea")?.focus(), 30);
      return;
    }
    if (dock) {
      if (sel !== `s:${id}`) select(`s:${id}`);
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-fleet-composer] textarea")?.focus(), 30);
      return;
    }
    const r = allRows.find(x => x.id === id);
    if (r && !isOpen(r.id, r.state)) toggle(r.id, r.state); else select(`s:${id}`);
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(`.fr-node[data-id="s:${id}"] .fr-reply textarea`)?.focus(), 360);
  };
  const stopAll = (ids: string[]) => {
    let n = 0;
    for (const id of ids) {
      const sx = byId.get(id);
      const a = sx ? sessionActions(sx, true).find(x => x.key === "stop") : undefined;
      if (a) { n++; void a.fn().catch(() => {}); }
    }
    say(n ? `Stopping ${n} agent${n === 1 ? "" : "s"}` : "Nothing to stop");
  };
  // ── the activity feed: what every agent did, newest first
  const [activity, setActivity] = useState(false);
  const [seenAt, setSeenAt] = useState(wallNow);
  const feed = useMemo(() => activityOf(sessions.map(x => {
    const cs = chat[x.id], st = tree.find(t => t.id === x.id)?.state ?? "done";
    const last = cs?.messages?.[cs.messages.length - 1]?.timestamp;
    return {
      id: x.id, createdAt: new Date(x.created_at).getTime() || 0, state: st,
      needSince: last ? new Date(last).getTime() : undefined, lastAt: last ? new Date(last).getTime() : undefined,
      steps: logOf(cs).filter(e => !/^todowrite$/i.test(e.name)).map(e => ({ id: e.id, startedAt: e.startedAt, endedAt: e.endedAt, status: e.status, text: `${kindOf(e.name).verb} ${targetOf(e)}`.trim() })),
    };
  })), [sessions, chat, tree]);
  const unread = activity ? 0 : feed.filter(e => e.at > seenAt && e.kind !== "step").length;
  const toggleActivity = () => { setActivity(a => !a); setSeenAt(wallNow()); };

  const closePalette = () => setPalette(null);
  const [help, setHelp] = useState(false);
  /** Esc closes the top-most thing: the menu, the key sheet, the palette, the picks, then the selection. */
  const escape = () => {
    if (menu) setMenu(null);
    else if (help) setHelp(false);
    else if (palette !== null) closePalette();
    else if (panelId) onOpen(null);
    else if (picked.size) setPicked(new Set());
    else if (filter) setFilterState(null);
    else clearSel();
  };
  const openSearch = () => { setPalette(q => q ?? ""); setMenu(null); setHelp(false); };
  const toggleHelp = () => setHelp(h => !h);
  // the menu closes on a press anywhere else, a scroll, or leaving the window
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("wheel", close); window.removeEventListener("blur", close); };
  }, [menu]);
  /** The menu's items say what they do in data-act; one handler does it. */
  const onMenuClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const ms = menu ? byId.get(menu.id) : undefined;
    if (!act || !ms) return;
    const row = allRows.find(r => r.id === ms.id);
    if (act === "toggle" && row) { setMenu(null); toggle(row.id, row.state); }
    else if (act === "open") { setMenu(null); onOpen(ms.id); }
    else if (act === "reply") { setMenu(null); replyTo(ms.id); }
    else if (act === "branch" && ms.worktree_branch) copy("Branch", ms.worktree_branch);
    else if (act === "path") copy("Path", ms.worktree_path ?? ms.project_path ?? "");
    else if (act.startsWith("do:")) {
      const a = sessionActions(ms, row?.state === "working").find(x => x.key === act.slice(3));
      if (a) void runAction(a.label, a.fn);
    }
  };

  // ── every command, in one list: the palette shows it, the bar and the key sheet draw on it
  const selId = sel?.startsWith("s:") && !sel.startsWith(`s:${TASK}`) ? sel.slice(2) : null;
  const selS = selId ? byId.get(selId) : undefined;
  const selRow = selId ? allRows.find(r => r.id === selId) : undefined;
  const selPerm = selId ? chat[selId]?.permissionRequest ?? null : null;
  const working = tree.filter(t => t.state === "working").map(t => t.id);
  const commands: Command[] = [];
  if (selId && selS && selRow) {
    const t = selS.title || "this session";
    if (selPerm) commands.push(
      { id: "allow", group: "selection", label: `Allow ${selPerm.tool_name} for ${t}`, keywords: "yes approve permission", key: "A" },
      { id: "deny", group: "selection", label: `Deny ${selPerm.tool_name} for ${t}`, keywords: "no reject permission", key: "D" },
      { id: "always", group: "selection", label: `Always allow ${selPerm.tool_name}`, keywords: "approve permission" },
    );
    commands.push(
      { id: "chat", group: "selection", label: `Dive into ${t}`, keywords: "open enter full chat cockpit", key: "↵" },
      { id: "leave", group: "selection", label: `Go to ${t}'s own page`, keywords: "leave navigate", key: "⇧O" },
      { id: "reply", group: "selection", label: `Talk to ${t}`, keywords: "reply message send tell", key: "R" },
      { id: "card", group: "selection", label: isOpen(selRow.id, selRow.state) ? `Close the card of ${t}` : `Open the card of ${t}`, keywords: "expand collapse details", key: "Space" },
      ...sessionActions(selS, selRow.state === "working").map(a => ({ id: `do:${a.key}`, group: "selection" as const, label: `${a.label} ${t}` })),
    );
    if (selS.worktree_branch) commands.push({ id: "branch", group: "selection", label: "Copy its branch name", keywords: "git" });
  }
  commands.push(
    { id: "next", group: "go", label: "Next one that needs you", keywords: "waiting question permission", key: "Tab" },
    { id: "prev", group: "go", label: "Previous one that needs you", keywords: "waiting back", key: "⇧Tab" },
    { id: "back", group: "go", label: "Back to the last selected", keywords: "previous history", key: "⌫" },
    { id: "failed", group: "go", label: "Next failed agent", keywords: "error broken" },
    { id: "live", group: "go", label: "Every agent at work", keywords: "working running live" },
    { id: "hub", group: "go", label: "Back to Fleetify", keywords: "home center hub", key: "H" },
    { id: "all", group: "cards", label: anyOpen ? "Close every card" : "Open the cards that need you", keywords: "collapse expand fold", key: "C" },
    ...([["needs", "Needs you"], ["working", "Working"], ["failed", "Failed"], ["done", "Done"]] as [NodeState, string][]).map(([k, l]) => ({ id: `f:${k}`, group: "view" as const, label: `Show only: ${l}`, keywords: "filter" })),
    ...(filter ? [{ id: "f:none", group: "view" as const, label: "Show everything", keywords: "filter clear all" }] : []),
    { id: "activity", group: "view", label: activity ? "Hide the activity feed" : "Show the activity feed", keywords: "log history events timeline", key: "L" },
    { id: "fit", group: "view", label: "Fit everything", keywords: "zoom out overview", key: "0" },
    { id: "ztoggle", group: "view", label: "Zoom to the selection, or back out", keywords: "close up overview", key: "Z" },
    { id: "full", group: "view", label: "Full size", keywords: "zoom 100 actual" },
    { id: "zin", group: "view", label: "Zoom in", key: "+" },
    { id: "zout", group: "view", label: "Zoom out", key: "−" },
    { id: "keys", group: "view", label: "Keyboard shortcuts", keywords: "help keys", key: "?" },
    autoOn
      ? { id: "still", group: "camera", label: "Keep the camera still", keywords: "auto follow off" }
      : { id: "follow", group: "camera", label: "Let the camera follow what needs you", keywords: "auto on" },
    { id: "recenter", group: "camera", label: "Re-center the camera", keywords: "auto" },
  );
  commands.push({ id: "fleet:new", group: "fleet", label: "Start a new session", keywords: "new agent create spawn open" });
  if (working.length) commands.push({ id: "fleet:all", group: "fleet", label: `Message every working agent (${working.length})`, keywords: "broadcast tell all" });
  if (working.length) commands.push({ id: "stopall", group: "fleet", label: `Stop every agent at work (${working.length})`, keywords: "abort kill halt", danger: true });

  // a one-question, one-answer card can be answered from the keys
  const selAsk = selId ? chat[selId]?.askQuestion ?? null : null;
  const simpleAsk = selAsk && selAsk.questions.length === 1 && !selAsk.questions[0]!.multiSelect ? selAsk : null;
  const askOptions = simpleAsk ? simpleAsk.questions[0]!.options.map(o => o.label) : [];
  const pickLabel = pick && pick.sid === selId && askOptions.includes(pick.label) ? pick.label : null;
  const sendPick = () => {
    if (!selId || !simpleAsk || !pickLabel) return;
    const q = simpleAsk.questions[0]!;
    void wsManager.sendAskQuestionResponse(selId, simpleAsk.id, true, [{ header: q.header, question: q.question, selected: [pickLabel] }]);
    say(`Answered: ${pickLabel}`);
    setPick(null);
    advanceFrom(selId);
  };
  /** 1–9: an answer on the selected card when it asks one, else the waiting card with that number. */
  const digit = (n: number) => {
    if (simpleAsk && selId) { const label = askOptions[n - 1]; if (label) setPick({ sid: selId, label }); return; }
    jumpWaiting(n - 1);
  };
  /** Enter: send the picked answer; talk to the selected agent; show a project; unfold the finished. */
  const enter = () => {
    if (pickLabel) { sendPick(); return; }
    // in the cockpit, Enter goes to Fleet's composer, which talks to this agent
    if (panelId) { window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-fleet-composer] textarea")?.focus(), 20); return; }
    if (!sel) { nextWaiting(); return; }
    if (sel === "fleet") { window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-fleet-composer] textarea")?.focus(), 30); return; }
    if (sel.startsWith("head:")) { fitProject(sel.slice(5)); return; }
    if (sel.startsWith("fold:")) { toggleFold(sel.slice(5)); return; }
    // a card: dive into it
    if (selId) openSel();
  };
  /** Z: close up on the selection, or back out to every agent at work. */
  const zoomToggle = () => {
    if (sel && sel !== "fleet" && cam.current.s < 0.9) focus(sel);
    else frameLive();
  };
  const goHub = () => { if (panelId) surface(); select("fleet"); };
  const notifyNeeds = (id: string) => { if (selRef.current !== `s:${id}`) say(`${byId.get(id)?.title || "An agent"} needs you · Tab to go there`); };
  /** The keyboard is in use: show the number badges and the key prompts. */
  const [kbd, setKbd] = useState(false);
  const kbdOn = () => setKbd(true);
  const clearPicks = () => setPicked(new Set());
  // inside the cockpit, moving to another agent (Tab, a number) brings that agent into it
  useEffect(() => { if (panelId && selId && selId !== panelId) onOpen(selId); }, [panelId, selId, onOpen]);
  /** Back to the map: the cockpit closes itself, with its animation. */
  const surface = () => window.dispatchEvent(new Event("fleet:surface"));

  // the composer talks to the one card selected; several picked, or none, and it talks to Fleet again
  // Fleet selected: the composer talks to Fleet, or (Message every working agent) to all of them at once
  const [broadcast, setBroadcast] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const fleetSel = sel === "fleet";
  const targetIds = picked.size ? [...picked] : selId ? [selId] : fleetSel && broadcast && working.length ? working : null;
  const targetLabel = picked.size ? `${picked.size} agents` : selId ? selS?.title || "this agent" : `every working agent (${working.length})`;
  const targetKey = targetIds ? targetIds.join(",") : "";
  useEffect(() => { onTarget?.(targetKey ? targetKey.split(",") : null, targetKey ? targetLabel : fleetSel ? "Fleet" : ""); dockedBar.current = !!(dock && (targetKey || fleetSel)); }, [targetKey, targetLabel, onTarget, dock, fleetSel]);
  useEffect(() => () => onTarget?.(null, ""), [onTarget]);
  const openBarMenu = (anchor: DOMRect) => {
    if (!selId) return;
    const r = viewRef.current?.getBoundingClientRect();
    setMenu({ x: anchor.right - (r?.left ?? 0), y: anchor.top - (r?.top ?? 0) - 6, id: selId, up: true });
  };
  /** Run a command by its id: the palette, the bar, the menu and the keys all come here. */
  const runCommand = (id: string) => {
    const sid = selId, ss = selS, sr = selRow;
    if (id.startsWith("opt:")) { if (sid) setPick({ sid, label: id.slice(4) }); return; }
    if (id.startsWith("f:")) { setFilter(id === "f:none" ? null : (id.slice(2) as NodeState)); return; }
    if (id.startsWith("do:") && ss) {
      const a = sessionActions(ss, sr?.state === "working").find(x => x.key === id.slice(3));
      if (a) void runAction(a.label, a.fn);
      return;
    }
    const pickedRows = allRows.filter(r => picked.has(r.id));
    switch (id) {
      case "allow": if (sid) answer(sid, true); break;
      case "deny": if (sid) answer(sid, false); break;
      case "always": if (sid) answer(sid, true, true); break;
      case "chat": if (sid) onOpen(sid); break;
      case "surface": surface(); break;
      case "leave": if (sid) onLeave?.(sid); break;
      case "reply": if (sid) replyTo(sid); break;
      case "card": case "answer": if (sr) toggle(sr.id, sr.state); break;
      case "stop": if (sid) stopAll([sid]); break;
      case "branch": if (ss?.worktree_branch) copy("Branch", ss.worktree_branch); break;
      case "next": nextWaiting(); break;
      case "prev": prevWaiting(); break;
      case "back": back(); break;
      case "ztoggle": zoomToggle(); break;
      case "send": sendPick(); break;
      case "failed": onPick("failed"); break;
      case "live": frameLive(); break;
      case "hub": setSel(null); centerHub(); break;
      case "all": toggleAll(); break;
      case "activity": toggleActivity(); break;
      case "fit": fit(); break;
      case "full": zoomBy(1 / cam.current.s); break;
      case "zin": zoomBy(ZOOM.step); break;
      case "zout": zoomBy(1 / ZOOM.step); break;
      case "keys": toggleHelp(); break;
      case "still": setAutoOn(false); break;
      case "follow": setAutoOn(true); recenter(); break;
      case "recenter": recenter(); break;
      case "stopall": stopAll(working); break;
      case "fleet:new": window.dispatchEvent(new Event("fleet:new-agent")); break;
      case "fleet:all": setSel("fleet"); setBroadcast(b => !b); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-fleet-composer] textarea")?.focus(), 30); break;
      case "fleet:stop":
        if (!confirmStop) { setConfirmStop(true); window.setTimeout(() => setConfirmStop(false), 3000); }
        else { setConfirmStop(false); stopAll(working); }
        break;
      case "pick:open": setOpenMany(pickedRows, true); break;
      case "pick:close": setOpenMany(pickedRows, false); break;
      case "pick:frame": frameIds([...picked]); break;
      case "pick:stop": stopAll(working.filter(w => picked.has(w))); break;
    }
  };

  // Fleet's own session: busy while it works; its thread opens under the hub when the hub is selected,
  // or by itself for a minute after Fleet last spoke while nothing else is selected
  const fleetCs = fleetSessionId ? chat[fleetSessionId] : undefined;
  const fleetBusy = !!(fleetCs?.isStreaming || fleetCs?.streamingText);
  const fleetLast = fleetCs?.messages?.[fleetCs.messages.length - 1]?.timestamp;
  const hubOpen = fleetSel || (!sel && (fleetBusy || (!!fleetLast && now - new Date(fleetLast).getTime() < 60000)));
  /** The keys that do something right now, shown along the bottom while the keyboard is in use, the way a game shows its button prompts. */
  const prompts: [string, string][] = (() => {
    if (sel === "fleet") return [["↵", "talk to Fleet"], ["←→", "enter a side"], ["Tab", "next waiting"], ["⌘K", "search"]];
    if (panelId) return [...(selPerm ? [["A", "allow"], ["D", "deny"]] as [string, string][] : []), ["Tab", "next waiting"], ["[ ]", "tabs"], ["Esc", "back to map"]];
    if (!sel) return [["←→", "enter a side"], ["Tab", waiting.length ? `next waiting (${waiting.length})` : "next waiting"], ["⌘K", "search"], ["?", "all keys"]];
    if (sel.startsWith("head:")) return [["↑↓", "move"], ["↵", "show the project"], ["Space", "open its cards"], ["H", "hub"]];
    if (sel.startsWith("fold:")) return [["↑↓", "move"], ["Space", "show the finished"], ["H", "hub"]];
    if (selPerm) return [["A", "allow"], ["D", "deny"], ["↵", "reply"], ["Tab", "next"], ["⌫", "back"]];
    if (simpleAsk) return [[`1–${Math.min(9, askOptions.length)}`, "pick"], ...(pickLabel ? [["↵", "send"] as [string, string]] : []), ["Space", selRow && isOpen(selRow.id, selRow.state) ? "close" : "open"], ["Tab", "next"]];
    return [["↑↓←→", "move"], ["↵", "dive in"], ["R", "talk"], ["Space", selRow && isOpen(selRow.id, selRow.state) ? "close" : "open"], ["Z", "zoom"], ["Tab", "next waiting"]];
  })();

  const api = useRef({ moveTo, zoomAt, zoomBy, fit, focus, walk, nextWaiting, openSel, clearSel, step, recenter, fitProject, toggleAll, toggleSel, openSearch, escape, toggleHelp, frameIds, answer, replyTo, toggleActivity, selPerm: selPerm as unknown, selId, prevWaiting, back, digit, enter, zoomToggle, goHub, kbdOn, advance, notifyNeeds, leave, dived: !!panelId });
  useLayoutEffect(() => { api.current = { moveTo, zoomAt, zoomBy, fit, focus, walk, nextWaiting, openSel, clearSel, step, recenter, fitProject, toggleAll, toggleSel, openSearch, escape, toggleHelp, frameIds, answer, replyTo, toggleActivity, selPerm, selId, prevWaiting, back, digit, enter, zoomToggle, goHub, kbdOn, advance, notifyNeeds, leave, dived: !!panelId }; });


  // what changed in the fleet, gathered over a short window into one decision
  const seenStates = useRef(new Map<string, NodeState>());
  const batch = useRef({ needs: new Set<string>(), failed: new Set<string>(), fresh: new Set<string>(), resolved: new Set<string>(), timer: 0 });
  useEffect(() => {
    if (!lay) return;
    const rows = columns.flatMap(c => c.rows);
    const first = seenStates.current.size === 0;
    const b = batch.current, t = clockNow();
    for (const r of rows) {
      const was = seenStates.current.get(r.id), session = !r.id.startsWith(TASK);
      if (session && r.state === "needs" && !needSince.current.has(r.id)) needSince.current.set(r.id, t);
      if (session && r.state !== "needs") needSince.current.delete(r.id);
      if (first) continue;
      if (session && r.state === "needs" && was !== "needs") b.needs.add(r.id);
      if (session && r.state === "failed" && was !== "failed") b.failed.add(r.id);
      if (!was && r.state !== "done") b.fresh.add(r.id);
      if (was === "needs" && r.state !== "needs") b.resolved.add(r.id);
    }
    for (const [id, st] of seenStates.current) if (st === "needs" && !rows.some(r => r.id === id)) { b.resolved.add(id); needSince.current.delete(id); }
    seenStates.current = new Map(rows.map(r => [r.id, r.state]));
    if (first) { api.current.step({ type: "recenter" }); return; }
    if (!b.needs.size && !b.failed.size && !b.fresh.size && !b.resolved.size) return;
    window.clearTimeout(b.timer);
    b.timer = window.setTimeout(() => {
      const ev: CamEvent = { type: "changes", needs: [...b.needs], failed: [...b.failed], fresh: [...b.fresh], resolved: [...b.resolved] };
      b.needs.clear(); b.failed.clear(); b.fresh.clear(); b.resolved.clear();
      api.current.step(ev);
      // a question the camera held back for (the user is busy): say so, with the key that goes there
      const first = ev.needs[0];
      if (first && pol.current.attendId !== first) api.current.notifyNeeds(first);
    }, CAM.EVENT_BATCH);
  }, [lay, columns]);

  // a quiet look at deferred work four times a second: no timers that fire on stale assumptions
  useEffect(() => {
    const id = window.setInterval(() => api.current.step({ type: "tick" }), 250);
    return () => window.clearInterval(id);
  }, []);

  // the signals: typing, selecting, a pressed pointer, the window shown or hidden, focused or not
  const [welcome, setWelcome] = useState<{ needs: number; failed: number; done: number } | null>(null);
  const awaySnap = useRef<{ needs: number; failed: number; done: number } | null>(null);
  const countsRef = useRef({ needs: 0, failed: 0, done: 0 });
  useEffect(() => { countsRef.current = { needs: counts.needs, failed: counts.failed, done: counts.done }; });
  useEffect(() => {
    const s = sig.current;
    const editable = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']");
    const fin = (e: FocusEvent) => { s.typing = editable(e.target); };
    const fout = () => { s.typing = false; };
    const selc = () => {
      const se = document.getSelection();
      s.selecting = !!se && !se.isCollapsed && !!viewRef.current?.contains(se.anchorNode);
    };
    const down = () => { s.pointerDown = true; s.lastInputAt = clockNow(); flight.current = null; };
    const up = () => { s.pointerDown = false; };
    const key = () => { s.lastInputAt = clockNow(); setWelcome(null); };
    const focusW = () => { s.focused = true; };
    const blurW = () => { s.focused = false; };
    let returnTimer = 0;
    const vis = () => {
      if (document.hidden) {
        s.visible = false; s.hiddenAt = clockNow();
        awaySnap.current = { ...countsRef.current };
        // finish any flight at its end: no animation while hidden
        const f = flight.current;
        if (f) { flight.current = { ...f, dur: 0 }; }
        return;
      }
      s.visible = true;
      const away = s.hiddenAt === null ? 0 : clockNow() - s.hiddenAt;
      s.hiddenAt = null;
      window.clearTimeout(returnTimer);
      returnTimer = window.setTimeout(() => {
        const was = awaySnap.current, nowC = countsRef.current;
        if (was && away > 5000) {
          const d = { needs: Math.max(0, nowC.needs - was.needs), failed: Math.max(0, nowC.failed - was.failed), done: Math.max(0, nowC.done - was.done) };
          if (d.needs || d.failed || d.done) { setWelcome(d); window.setTimeout(() => setWelcome(null), 6000); }
        }
        api.current.step({ type: "return" });
      }, CAM.RETURN_DELAY);
    };
    document.addEventListener("focusin", fin);
    document.addEventListener("focusout", fout);
    document.addEventListener("selectionchange", selc);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("focus", focusW);
    window.addEventListener("blur", blurW);
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("focusin", fin);
      document.removeEventListener("focusout", fout);
      document.removeEventListener("selectionchange", selc);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("focus", focusW);
      window.removeEventListener("blur", blurW);
      document.removeEventListener("visibilitychange", vis);
      window.clearTimeout(returnTimer);
    };
  }, []);
  // the pointer: moving over the canvas means the user may be about to click; resting on a card means reading
  const onViewPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sig.current;
    if (e.buttons === 0) s.pointerDown = false;
    if (Math.hypot(e.clientX - s.px, e.clientY - s.py) < 4) return;
    s.px = e.clientX; s.py = e.clientY;
    const t = clockNow();
    s.lastPointerAt = t; s.lastInputAt = t; s.hoverSince = t;
    if (welcome) setWelcome(null);
    if (kbd) setKbd(false);
  };

  // trackpad and wheel: two fingers pan, pinch (or ctrl/cmd + wheel) zooms at the pointer
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const wheel = (e: WheelEvent) => {
      // a card's own scrolling area scrolls itself while it can
      const sc = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fr-scrollable");
      if (sc && !e.ctrlKey && !e.metaKey && ((e.deltaY > 0 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) || (e.deltaY < 0 && sc.scrollTop > 0))) { sig.current.scrollAt = clockNow(); return; }
      e.preventDefault();
      const c = cam.current;
      if (e.ctrlKey || e.metaKey) { const [x, y] = local(e); api.current.zoomAt(x, y, c.s * Math.exp(-e.deltaY * 0.008), false); return; }
      const sideways = e.shiftKey && !e.deltaX;
      const dx = sideways ? e.deltaY : e.deltaX, dy = sideways ? 0 : e.deltaY;
      // a mouse wheel's coarse notches glide; a trackpad's fine deltas follow the fingers
      const notch = e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40 && !e.deltaX);
      const b = c;
      api.current.moveTo(b.x - dx * (e.deltaMode === 1 ? 16 : 1), b.y - dy * (e.deltaMode === 1 ? 16 : 1), c.s, notch);
    };
    // WebKit's own pinch events, which the macOS webview sends
    let g0 = 1;
    const gs = (e: Event) => { e.preventDefault(); g0 = cam.current.s; };
    const gc = (e: Event) => {
      e.preventDefault();
      const ge = e as unknown as { scale: number; clientX: number; clientY: number };
      const [x, y] = local(ge);
      api.current.zoomAt(x, y, g0 * ge.scale, false);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gc);
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("gesturestart", gs); el.removeEventListener("gesturechange", gc); };
  }, []);

  // keys, when no text field has focus: + and - zoom, 0 fits everything, 1 is full size
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, [contenteditable='true']");
      // inside the cockpit Fleet's keys still work; arrows, Space and the zoom keys stay the cockpit's (its pages scroll with them)
      if (api.current.dived && !/^(Tab|n|N|a|A|d|D|r|R|h|H|l|L|\/|\?|Enter|[1-9])$/.test(e.key) && !((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "f"))) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "f") && !typing) { e.preventDefault(); api.current.openSearch(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !typing) { e.preventDefault(); api.current.openSel(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || typing) return;
      const k = e.key;
      if (k === "=" || k === "+") api.current.zoomBy(ZOOM.step);
      else if (k === "-") api.current.zoomBy(1 / ZOOM.step);
      else if (k === "0") api.current.fit();
      else if (k === "z" || k === "Z") api.current.zoomToggle();
      else if (k === "ArrowUp" || k === "k") api.current.walk("up");
      else if (k === "ArrowDown" || k === "j") api.current.walk("down");
      else if (k === "ArrowLeft") api.current.walk("left");
      else if (k === "ArrowRight") api.current.walk("right");
      else if (k === "Tab") { if (e.shiftKey) api.current.prevWaiting(); else api.current.nextWaiting(); }
      else if (k === "n") api.current.nextWaiting();
      else if (k === "N") api.current.prevWaiting();
      else if (/^[1-9]$/.test(k)) api.current.digit(Number(k));
      else if (k === "Backspace") api.current.back();
      else if (k === "h" || k === "H") api.current.goHub();
      else if (k === "o") api.current.openSel();
      else if (k === "O") api.current.leave();
      else if (e.key === "Enter") api.current.enter();
      else if (e.key === "Escape") api.current.escape();
      else if (e.key === "/") api.current.openSearch();
      else if (e.key === "?") api.current.toggleHelp();
      else if (e.key === " ") api.current.toggleSel();
      else if (e.key === "c" || e.key === "C") api.current.toggleAll();
      else if (e.key === "l" || e.key === "L") api.current.toggleActivity();
      else if ((e.key === "r" || e.key === "R") && api.current.selId) api.current.replyTo(api.current.selId);
      else if ((e.key === "a" || e.key === "A") && api.current.selId && api.current.selPerm) api.current.answer(api.current.selId, true);
      else if ((e.key === "d" || e.key === "D") && api.current.selId && api.current.selPerm) api.current.answer(api.current.selId, false);
      else return;
      e.preventDefault();
      api.current.kbdOn();
    };
    // Esc in the composer hands the keys back to the canvas (unless the composer used it, say to close a popup)
    const escOut = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const a = document.activeElement as HTMLElement | null;
      if (a?.closest("[data-fleet-composer]")) { a.blur(); api.current.kbdOn(); }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keydown", escOut);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("keydown", escOut); };
  }, []);

  // dragging pans the canvas from anywhere, a card included, once the pointer has
  // moved a few pixels; buttons, fields and scrolling lists keep their own gestures.
  // A flick carries on a little.
  const drag = useRef<{ x: number; y: number; x0: number; y0: number; vx: number; vy: number; on: boolean; id: number } | null>(null);
  const dragged = useRef(false);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && t.closest("button, input, textarea, select, a, [role='tab'], .fr-scrollable, .fr-embed")) return;
    drag.current = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, vx: 0, vy: 0, on: false, id: e.pointerId };
    Object.assign(cam.current, { vx: 0, vy: 0 });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // the button came up outside the window: that press is over, a plain move is no drag
    if (e.buttons === 0) { drag.current = null; sig.current.pointerDown = false; return; }
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      d.on = true;
      e.currentTarget.setPointerCapture(d.id);
      e.currentTarget.classList.add("is-dragging");
      flight.current = null;
    }
    d.vx = e.clientX - d.x; d.vy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY;
    const c = cam.current;
    moveTo(c.x + d.vx, c.y + d.vy, c.s, false);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    dragged.current = true;
    e.currentTarget.classList.remove("is-dragging");
    if (!reduce) Object.assign(cam.current, { vx: d.vx, vy: d.vy });
  };
  // the click that ends a drag is not a click on what lies under the pointer
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragged.current) return;
    dragged.current = false;
    e.stopPropagation();
    e.preventDefault();
  };
  // a click selects what it lands on; a click on a project brings the whole project into view
  const onClickView = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".fr-fleetthread")) return;
    const n = (e.target as HTMLElement).closest<HTMLElement>(".fr-node");
    const id = n?.dataset.id;
    if (!id) return;
    if ((e.shiftKey || e.metaKey) && id.startsWith("s:") && !id.startsWith(`s:${TASK}`)) { togglePick(id.slice(2)); return; }
    if (picked.size) setPicked(new Set());
    setSel(id);
    userPick.current = id.startsWith("s:") ? id : null;
    if (id.startsWith("head:")) fitProject(id.slice(5));
    if (id === "fleet") centerHub();
  };
  // double-click a card to look at it closely, the empty canvas to see everything
  const onDouble = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("button")) return;
    const n = t.closest<HTMLElement>(".fr-node");
    const id = n?.dataset.id;
    if (id === "fleet") toggleAll();
    else if (id?.startsWith("head:")) toggleProject(id.slice(5));
    else if (id?.startsWith("s:")) focus(id);
    else if (!n) fit();
  };

  // cards change height as their activity changes: re-measure when any node resizes
  useEffect(() => {
    const ro = new ResizeObserver(() => setMeasureTick(t => t + 1));
    for (const el of els.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [columns, flip]);

  useLayoutEffect(() => {
    if (!field.w) return;
    const box = (id: string) => { const el = els.current.get(id); const b = { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 }; sizes.current.set(id, b); return b; };
    const out = layoutBranches({
      W: field.w, H: Math.max(200, field.h - COMPOSER), hub: box("fleet"),
      columns: columns.map(c => ({
        project: c.project, head: box(`head:${c.project}`),
        rows: c.rows.map(r => ({ id: r.id, depth: r.depth, box: box(`s:${r.id}`) })),
        fold: c.doneFolded || expanded.has(c.project) ? box(`fold:${c.project}`) : undefined,
        weight: 1 + tree.filter(t => t.project === c.project).length,
      })),
    });
    const t0 = performance.now();
    const first = !laidOut.current;
    // the order the tree grows in on first show: the hub, then the roots,
    // the projects, and each project's branches top-down, the first project first
    const delayOf = new Map<string, number>([["fleet", 0]]);
    columns.forEach((c, s) => {
      delayOf.set(`root:${c.project}`, 220 + s * 90);
      delayOf.set(`trunk:${c.project}`, 560 + s * 90);
      c.rows.forEach((r, i) => delayOf.set(`trunk:${r.id}`, 760 + s * 90 + i * 70));
      delayOf.set(`head:${c.project}`, 560 + s * 90);
      c.rows.forEach((r, i) => { delayOf.set(`br:${r.id}`, 640 + s * 90 + i * 70); delayOf.set(`s:${r.id}`, 760 + s * 90 + i * 70); });
      delayOf.set(`br:fold:${c.project}`, 640 + s * 90 + c.rows.length * 70);
      delayOf.set(`fold:${c.project}`, 760 + s * 90 + c.rows.length * 70);
    });
    const targets = new Map<string, { x: number; y: number }>([["fleet", out.hub]]);
    for (const [p, v] of Object.entries(out.heads)) targets.set(`head:${p}`, v);
    for (const [id, v] of Object.entries(out.rows)) targets.set(`s:${id}`, v);
    for (const [p, v] of Object.entries(out.folds)) targets.set(`fold:${p}`, v);
    const m = motion.current;
    for (const [id, t] of targets) {
      const cur = m.get(id);
      if (cur) { cur.tx = t.x; cur.ty = t.y; continue; }
      // a node grows out of what it hangs from: on first show the hub, later its parent
      let from: { x: number; y: number } | undefined;
      const col = columns.find(c => c.rows.some(r => `s:${r.id}` === id) || `head:${c.project}` === id);
      const row = col?.rows.find(r => `s:${r.id}` === id);
      if (id.startsWith("head:")) from = first ? { x: out.hub.x + out.hub.w / 2 - 40, y: out.hub.y + out.hub.h / 2 } : undefined;
      else if (!first) from = row?.parent ? targets.get(`s:${row.parent}`) : col ? targets.get(`head:${col.project}`) : undefined;
      m.set(id, { x: from?.x ?? t.x, y: from?.y ?? t.y, vx: 0, vy: 0, tx: t.x, ty: t.y, showAt: t0 + (first ? delayOf.get(id) ?? 0 : 0), shown: false, u: 0 });
    }
    for (const id of [...m.keys()]) if (!targets.has(id)) m.delete(id);
    // lines draw themselves in: on first show in the growth order, later as they appear
    const d = draws.current;
    const live = new Set<string>();
    for (const c of columns) {
      const keys = [`root:${c.project}`, `trunk:${c.project}`, ...c.rows.map(r => `br:${r.id}`), ...c.rows.filter(r => c.rows.some(x => x.parent === r.id)).map(r => `trunk:${r.id}`),
        ...(c.doneFolded || expanded.has(c.project) ? [`br:fold:${c.project}`] : [])];
      for (const k of keys) {
        live.add(k);
        if (!d.has(k)) d.set(k, { at: t0 + (first ? delayOf.get(k) ?? 0 : 80), dur: k.startsWith("root:") ? 640 : 420, done: reduce });
      }
    }
    for (const k of [...d.keys()]) if (!live.has(k)) d.delete(k);
    laidOut.current = true;
    layStamp.current++;
    lastLayoutAt.current = clockNow();
    layRef.current = out;
    // the camera opens on the hub, as wide as the tree, at full size when it fits,
    // and keeps the hub there as the tree grows until the user moves it
    const cm = cam.current;
    if (!cm.init) {
      const s0 = Math.max(0.55, Math.min(1, (field.w - 32) / out.width));
      const vh = Math.max(200, field.h - COMPOSER), hubMid = out.hub.y + out.hub.h / 2;
      const y0 = out.height * s0 <= vh ? (vh - out.height * s0) / 2 : Math.min(0, Math.max(vh - out.height * s0, vh / 2 - hubMid * s0));
      const x0 = (field.w - out.width * s0) / 2;
      Object.assign(cm, { s: s0, x: x0, y: y0, init: true });
      setZoom(s0);
    }
    setLay(out);
    const pf = pendingFocus.current;
    if (pf && targets.has(pf)) { pendingFocus.current = null; requestAnimationFrame(() => api.current.focus(pf, "user")); }
  }, [field, columns, expanded, measureTick, flip, reduce, tree]);

  // a card that changes state rings once in its new colour
  const prevState = useRef(new Map<string, NodeState>());
  useEffect(() => {
    const prev = prevState.current;
    for (const c of columns) for (const r of c.rows) {
      const was = prev.get(r.id);
      prev.set(r.id, r.state);
      if (!was || was === r.state || reduce) continue;
      ring(els.current.get(`s:${r.id}`), STATE_COLOR[r.state]);
    }
  }, [columns, reduce]);

  // every new step sends a spark from its card up the branch to the hub
  const sparks = useRef<Spark[]>([]);
  const seen = useRef(new Map<string, number>());
  useEffect(() => {
    const t = performance.now();
    for (const c of columns) for (const r of c.rows) {
      let n: number;
      if (r.id.startsWith(TASK)) {
        const [sid, tid] = r.id.slice(TASK.length).split(":");
        n = sid && tid ? chat[sid]?.subagentTasks[tid]?.content.filter(b => b.type === "tool_use").length ?? 0 : 0;
      } else n = chat[r.id]?.processLog.length ?? 0; // live steps only: history loading in is not a new step
      const was = seen.current.get(r.id);
      seen.current.set(r.id, n);
      if (was !== undefined && n > was && !reduce && sparks.current.length < SPARK_POOL) sparks.current.push({ id: r.id, born: t });
    }
  }, [columns, chat, reduce]);

  // ── lines: computed from the live (springing) positions every frame
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const path = useRef(new Map<string, SVGPathElement>());
  /** the light that flows along a working agent's cables, toward the hub */
  const flows = useRef(new Map<string, SVGPathElement>());
  // every cable on the way from a working agent to the hub carries the flow
  const flowKeys = [...new Set(columns.flatMap(c => c.rows.filter(r => r.state === "working").flatMap(r => [`root:${c.project}`, `trunk:${c.project}`, `br:${r.id}`, ...(r.parent ? [`trunk:${r.parent}`] : [])])))];
  const sockets = useRef(new Map<string, SVGGElement>());
  const upBtn = useRef<HTMLButtonElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const chipEls = useRef(new Map<string, HTMLButtonElement>());
  // a cable that starts to flow gets its shape on the next frame
  const flowSig = flowKeys.join("|");
  useEffect(() => { layStamp.current++; }, [flowSig]);
  // the frame loop places the up button; a new selection asks it for one more frame
  useEffect(() => { selRef.current = sel; layStamp.current++; }, [sel]);

  useEffect(() => {
    let raf = 0, last = performance.now();
    const P = (id: string) => { const p = motion.current.get(id), b = sizes.current.get(id); return p && b ? { x: p.x, y: p.y, w: b.w, h: b.h } : null; };
    let drawnStamp = -1, upAnchored = false;
    /** the selected node's place last frame: the camera follows its moves so it holds still on screen */
    let anchor: { id: string | null; x: number; y: number } = { id: null, x: 0, y: 0 };
    /** the focus cursor: a ring that glides from the last selection to the new one */
    const cur = { x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, vw: 0, vh: 0, on: false };
    const stepCam = (dt: number) => {
      const c = cam.current, st = stageRef.current;
      if (!st) return false;
      const moving = !!flight.current || !!c.vx || !!c.vy;
      const f = flight.current;
      if (f) {
        const { view, done } = stepFlight(f, performance.now()), fd = fieldRef.current;
        c.s = fd.w / view[2];
        c.x = fd.w / 2 - view[0] * c.s;
        c.y = SAFE_TOP + (Math.max(200, fd.h - COMPOSER) - SAFE_TOP) / 2 - view[1] * c.s;
        if (done) flight.current = null;
      } else if (c.vx || c.vy) {
        const f = Math.pow(0.92, dt * 60);
        c.x += c.vx * dt * 60; c.y += c.vy * dt * 60; c.vx *= f; c.vy *= f;
        if (Math.abs(c.vx) < 0.15 && Math.abs(c.vy) < 0.15) { c.vx = 0; c.vy = 0; }
      }
      st.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
      const pct = Math.round(c.s * 100);
      if (pct !== zoomShown.current) { zoomShown.current = pct; setZoom(c.s); }
      return moving;
    };
    const frame = (now: number) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      stepCam(dt);
      // an off-screen question or failure gets a chip on the edge of the view, on the line
      // from the view's centre to the card, pointing at it: the camera stays where it is
      if (chipEls.current.size) {
        const fd = fieldRef.current, c = cam.current;
        const vh = Math.max(200, fd.h - COMPOSER - (dockedBar.current ? DOCK_H : 0)), cx0 = fd.w / 2, cy0 = SAFE_TOP + (vh - SAFE_TOP) / 2;
        const L = 100, R = fd.w - 100, T = SAFE_TOP + 18, B = vh - 18;
        const placed: { x: number; y: number; w: number }[] = [];
        for (const [id, chip] of chipEls.current) {
          const p = motion.current.get(`s:${id}`), b = sizes.current.get(`s:${id}`);
          if (!p || !b) { delete chip.dataset.on; continue; }
          const x0 = c.x + p.x * c.s, y0 = c.y + p.y * c.s, x1 = x0 + b.w * c.s, y1 = y0 + b.h * c.s;
          // a card with a fair piece of it in view needs no pointer to it
          const seenW = Math.min(x1, fd.w) - Math.max(x0, 0), seenH = Math.min(y1, vh) - Math.max(y0, SAFE_TOP);
          if (seenW > 60 && seenH > 36) { delete chip.dataset.on; continue; }
          const dx = (x0 + x1) / 2 - cx0, dy = (y0 + Math.min(y1, y0 + 60 * c.s)) / 2 - cy0;
          const tx = dx > 0 ? (R - cx0) / dx : dx < 0 ? (L - cx0) / dx : Infinity;
          const ty = dy > 0 ? (B - cy0) / dy : dy < 0 ? (T - cy0) / dy : Infinity;
          const k = Math.min(tx, ty), side = tx < ty;
          let x = cx0 + dx * k, y = cy0 + dy * k;
          const w = chip.offsetWidth || 160;
          // chips on the same edge line up instead of piling on each other
          for (let i = 0; i < 12 && placed.some(q => Math.abs(q.x - x) < (q.w + w) / 2 + 6 && Math.abs(q.y - y) < 32); i++) {
            if (side) y += y > cy0 ? -32 : 32; else x += (x > cx0 ? -1 : 1) * (w / 2 + 86);
          }
          placed.push({ x, y, w });
          chip.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
          const arrow = chip.firstElementChild as HTMLElement | null;
          if (arrow) arrow.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
          chip.dataset.on = "1";
        }
      }
      // the way back to Fleetify only shows while its mark is out of sight; checked every
      // frame, since the camera moves without a new layout
      const ub0 = upBtn.current, hb = P("fleet");
      if (ub0) {
        let hubSeen = false;
        if (ub0.dataset.fleet && hb) {
          const fd = fieldRef.current, cm = cam.current;
          const mx0 = cm.x + hb.x * cm.s, my0 = cm.y + hb.y * cm.s, mx1 = mx0 + hb.w * cm.s, my1 = my0 + HUB_CORE.cy * 2 * cm.s;
          hubSeen = mx0 >= 0 && mx1 <= fd.w && my0 >= SAFE_TOP - 10 && my1 <= Math.max(200, fd.h - COMPOSER);
        }
        if (upAnchored && !hubSeen) ub0.dataset.on = "1"; else delete ub0.dataset.on;
      }
      // the focus cursor springs to the selected node's box, a little outside it
      const cursorEl = cursorRef.current, rid = selRef.current;
      if (cursorEl) {
        // the ring hugs the selected card as it is now (its live size, not the last layout's), and only a card:
        // the hub shows its selection by itself, and a node that went away takes the ring with it
        const rp = rid && rid !== "fleet" ? motion.current.get(rid) : undefined, rEl = rid && rid !== "fleet" ? els.current.get(rid) : undefined;
        if (rp && rEl && rEl.isConnected && rp.shown) {
          const tx = rp.x, ty = rp.y, tw = rEl.offsetWidth, th = Math.min(rEl.offsetHeight, 2000);
          // the first time it lands in place; after that it glides from wherever it last was, even after a gap
          if (!cur.on) {
            if (cur.w === 0) Object.assign(cur, { x: tx, y: ty, w: tw, h: th });
            Object.assign(cur, { vx: 0, vy: 0, vw: 0, vh: 0, on: true });
            cursorEl.dataset.on = "1";
          }
          // an ease-out follow, the same at any frame rate: it leaves at once and slows into place, never overshooting
          if (reduce) Object.assign(cur, { x: tx, y: ty, w: tw, h: th });
          else {
            const mv = 1 - Math.exp(-dt * 12), sz = 1 - Math.exp(-dt * 10);
            cur.x += (tx - cur.x) * mv; cur.y += (ty - cur.y) * mv;
            cur.w += (tw - cur.w) * sz; cur.h += (th - cur.h) * sz;
            if (Math.abs(tx - cur.x) < 0.3 && Math.abs(ty - cur.y) < 0.3 && Math.abs(tw - cur.w) < 0.3 && Math.abs(th - cur.h) < 0.3) Object.assign(cur, { x: tx, y: ty, w: tw, h: th });
          }
          cursorEl.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
          cursorEl.style.width = `${cur.w}px`; cursorEl.style.height = `${cur.h}px`;
        } else if (cur.on) { cur.on = false; delete cursorEl.dataset.on; }
      }
      // nothing moving, nothing drawing in, no spark in flight, no new layout: rest
      let busy = drawnStamp !== layStamp.current || sparks.current.length > 0;
      if (!busy) for (const p of motion.current.values()) if (!p.shown || p.x !== p.tx || p.y !== p.ty) { busy = true; break; }
      if (!busy) for (const d of draws.current.values()) if (!d.done) { busy = true; break; }
      if (!busy) { raf = requestAnimationFrame(frame); return; }
      drawnStamp = layStamp.current;
      for (const [id, p] of motion.current) {
        const el = els.current.get(id);
        if (!el) continue;
        if (reduce) { p.x = p.tx; p.y = p.ty; p.vx = p.vy = 0; }
        else if (now >= p.showAt || p.shown) {
          // a spring, a touch under critical damping: quick, with no visible bounce
          p.vx += (SPRING.k * (p.tx - p.x) - SPRING.c * p.vx) * dt;
          p.vy += (SPRING.k * (p.ty - p.y) - SPRING.c * p.vy) * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          if (Math.abs(p.tx - p.x) < 0.2 && Math.abs(p.vx) < 2) { p.x = p.tx; p.vx = 0; }
          if (Math.abs(p.ty - p.y) < 0.2 && Math.abs(p.vy) < 2) { p.y = p.ty; p.vy = 0; }
        }
        // the entrance: fades up and settles to full size, once
        const u = reduce ? 1 : ease((now - p.showAt) / APPEAR_MS);
        p.u = p.shown ? 1 : u;
        if (!p.shown) {
          el.style.opacity = String(u);
          el.style.scale = String(0.94 + 0.06 * u);
          if (u >= 1) { p.shown = true; el.style.opacity = ""; el.style.scale = ""; }
        }
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
        if (!el.dataset.placed && u > 0) el.dataset.placed = "1";
        if (!p.shown || p.x !== p.tx || p.y !== p.ty) drawnStamp = -1;
      }
      // the selected card holds still on screen while the tree moves around it (a card above opens, a new one arrives)
      const as = selRef.current, ap = as ? motion.current.get(as) : undefined;
      if (ap && anchor.id === as && !flight.current && !drag.current?.on) {
        const dx = ap.x - anchor.x, dy = ap.y - anchor.y;
        if (dx || dy) {
          const c = cam.current, stg = stageRef.current;
          c.x -= dx * c.s; c.y -= dy * c.s;
          if (stg) stg.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
        }
      }
      anchor = { id: as, x: ap?.x ?? 0, y: ap?.y ?? 0 };
      const f = P("fleet"), L0 = layRef.current;
      if (L0 && f) {
        const set = (key: string, d: string) => {
          flows.current.get(key)?.setAttribute("d", d);
          const el = path.current.get(key);
          if (!el) return;
          el.setAttribute("d", d);
          const dr = draws.current.get(key);
          if (dr && !dr.done) {
            const len = el.getTotalLength(), u = easeInOut((now - dr.at) / dr.dur);
            el.style.strokeDasharray = `${len} ${len}`;
            el.style.strokeDashoffset = String(len * (1 - u));
            if (u >= 1) { dr.done = true; el.style.strokeDasharray = ""; el.style.strokeDashoffset = ""; }
          }
          // a live line carries a slow current, once it has drawn in
          path.current.get(`flow:${key}`)?.setAttribute("d", !dr || dr.done ? d : "");
        };
        const attach = (r: { y: number; h: number }) => r.y + Math.min(17, r.h / 2);
        const rr = 12;
        const cx = f.x + f.w / 2, cy = f.y + HUB_CORE.cy;
        // open, the hub is a card: the roots leave from its sides, not from under it
        const hubHalf = els.current.get("fleet")?.classList.contains("is-open") ? f.w / 2 + 6 : HUB_CORE.half;
        // each side's roots leave the mark at their own height, top to bottom in the
        // order of their projects, so no two curves ever cross
        const port = new Map<string, number>();
        for (const side of ["left", "right"] as const) {
          const list = columns.filter(c => L0.sides[c.project] === side).map(c => ({ p: c.project, y: P(`head:${c.project}`)?.y ?? cy })).sort((a, b) => a.y - b.y);
          const spread = Math.min(MARK * 0.7, Math.max(0, list.length - 1) * 9);
          list.forEach((c, i) => port.set(c.p, cy - spread / 2 + (list.length > 1 ? (spread * i) / (list.length - 1) : 0)));
        }
        const curve = (x0: number, y0: number, x1: number, y1: number) => { const mx = (x0 + x1) / 2; return `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`; };
        const routeOf = new Map<string, string>();
        // where each node's cable meets it, for the "up" button on the selected node's cable
        const anchors = new Map<string, { x: number; y: number; left: boolean }>();
        for (const c of columns) {
          const h = P(`head:${c.project}`);
          if (!h) continue;
          const left = L0.sides[c.project] === "left", s = left ? -1 : 1;
          const py = port.get(c.project) ?? cy, px = cx + s * hubHalf;
          const single = merged.has(c.project) ? c.rows[0] : undefined;
          // a project with one session of the same name has no label: its root goes straight to the row
          const sr = single ? P(`s:${single.id}`) : null;
          const hx = sr ? (left ? sr.x + sr.w : sr.x) : left ? h.x + h.w : h.x;
          const hy = sr ? attach(sr) : h.y + h.h / 2;
          // the root: one hairline curve out of the mark and level into the project
          set(`root:${c.project}`, curve(px, py, hx, hy));
          anchors.set(single ? `s:${single.id}` : `head:${c.project}`, { x: hx, y: hy, left });
          const back = `C${(px + hx) / 2} ${hy} ${(px + hx) / 2} ${py} ${px} ${py}`;
          if (single && sr) {
            const sk = sockets.current.get(single.id);
            if (sk) sk.setAttribute("transform", `translate(${hx} ${hy})`);
            routeOf.set(single.id, `M${hx} ${hy} ${back}`);
            set(`trunk:${c.project}`, "");
            set(`br:${single.id}`, "");
            continue;
          }
          // one trunk down the column, and one under every card that started others;
          // each card hangs off it on a short rounded branch
          const trunkX = left ? h.x + h.w - 10 : h.x + 10;
          const lastOf = new Map<string, number>();
          const ys = new Map<string, number>();
          for (const row of c.rows) {
            const r = P(`s:${row.id}`);
            if (!r) continue;
            const my = attach(r);
            ys.set(row.id, my);
            lastOf.set(row.depth > 0 && row.parent ? row.parent : "", my);
          }
          const fold = P(`fold:${c.project}`);
          if (fold) lastOf.set("", attach(fold));
          const top = lastOf.get("");
          set(`trunk:${c.project}`, top !== undefined ? `M${trunkX} ${h.y + h.h + 3} L${trunkX} ${top - rr}` : "");
          const up = new Map<string, string>();
          for (const row of c.rows) {
            const r = P(`s:${row.id}`), my = ys.get(row.id);
            if (!r || my === undefined) continue;
            const ax = left ? r.x + r.w : r.x;
            let fx = trunkX, rest: string;
            if (row.depth > 0 && row.parent) {
              const par = P(`s:${row.parent}`), pmy = ys.get(row.parent), pu = up.get(row.parent);
              if (!par || pmy === undefined || !pu) continue;
              fx = left ? par.x + par.w - 14 : par.x + 14;
              rest = `L${fx} ${par.y + par.h} L${fx} ${pmy} ${pu.replace(/^M[^L]+/, "")}`;
            } else rest = `L${trunkX} ${h.y + h.h} L${trunkX} ${hy} L${hx} ${hy} ${back}`;
            const last = lastOf.get(row.id);
            if (last !== undefined) set(`trunk:${row.id}`, `M${left ? r.x + r.w - 14 : r.x + 14} ${r.y + r.h} L${left ? r.x + r.w - 14 : r.x + 14} ${last - rr}`);
            set(`br:${row.id}`, `M${fx} ${my - rr} Q${fx} ${my} ${fx + s * rr} ${my} L${ax} ${my}`);
            anchors.set(`s:${row.id}`, { x: ax, y: my, left });
            const sk = sockets.current.get(row.id);
            if (sk) { sk.setAttribute("transform", `translate(${ax} ${my})`); const su = motion.current.get(`s:${row.id}`)?.u ?? 1; sk.style.opacity = su < 1 ? String(su) : ""; }
            const u = `M${ax} ${my} L${fx + s * rr} ${my} Q${fx} ${my} ${fx} ${my - rr} ${rest}`;
            up.set(row.id, u);
            routeOf.set(row.id, u);
          }
          if (fold) {
            const my = attach(fold), ax = left ? fold.x + fold.w : fold.x;
            set(`br:fold:${c.project}`, `M${trunkX} ${my - rr} Q${trunkX} ${my} ${trunkX + s * rr} ${my} L${ax} ${my}`);
          }
        }
        // the way up sits on the selected node's own cable, just above where it meets the node
        const ub = upBtn.current, an = selRef.current ? anchors.get(selRef.current) : undefined;
        upAnchored = false;
        const sb = selRef.current ? P(selRef.current) : null;
        if (ub && an && sb) { ub.style.transform = `translate(${an.left ? sb.x - 8 : sb.x + sb.w + 8}px, ${sb.y + 3}px) translateX(${an.left ? "-100%" : "0"})`; upAnchored = true; }
        // a new step's spark rides its branch to the mark
        const svg = svgRef.current;
        if (!reduce && svg) {
          // sparks: each new step rides its branch to the hub, which answers with a beat
          const pool = svg.querySelectorAll<SVGGElement>("g[data-spark]");
          sparks.current = sparks.current.filter(sp => {
            const u = (now - sp.born) / SPARK_MS;
            if (u >= 1) {

              return false;
            }
            return !!routeOf.get(sp.id);
          });
          pool.forEach((g, i) => {
            const sp = sparks.current[i];
            if (!sp) { g.style.opacity = "0"; return; }
            const tr = g.querySelector("path"), d = routeOf.get(sp.id)!;
            if (!tr) return;
            tr.setAttribute("d", d);
            const len = tr.getTotalLength(), u = easeInOut((now - sp.born) / SPARK_MS), at = u * len, pt = tr.getPointAtLength(at);
            // a bright head with a short tail behind it
            tr.style.strokeDasharray = `${Math.min(56, at)} ${len + 60}`;
            tr.style.strokeDashoffset = String(-Math.max(0, at - 56));
            g.querySelectorAll("circle").forEach(cl => { cl.setAttribute("cx", String(pt.x)); cl.setAttribute("cy", String(pt.y)); });
            g.style.opacity = String(Math.sin(Math.min(1, u * 1.05) * Math.PI));
          });
        }
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const vis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", vis);
    start();
    return () => { stop(); document.removeEventListener("visibilitychange", vis); };
  }, [columns, merged, reduce]);

  // hover: the path from a node back to the hub comes forward
  const lit = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>(["fleet"]);
    for (const c of columns) {
      if (hover === `head:${c.project}`) { set.add(hover); set.add(`root:${c.project}`); set.add(`trunk:${c.project}`); c.rows.forEach(r => { set.add(`s:${r.id}`); set.add(`br:${r.id}`); set.add(`trunk:${r.id}`); }); }
      const row = c.rows.find(r => `s:${r.id}` === hover);
      if (!row) continue;
      set.add(`head:${c.project}`); set.add(`root:${c.project}`);
      let cur: TreeRow | undefined = row;
      while (cur) { set.add(`s:${cur.id}`); set.add(`br:${cur.id}`); set.add(`trunk:${cur.parent ?? c.project}`); const pid: string | null = cur.parent; cur = pid ? c.rows.find(r => r.id === pid) : undefined; }
    }
    return set;
  }, [hover, columns]);

  /** While a search or filter is on: what it keeps, their sub-agents, their projects and the hub stay lit. */
  const keepNode = (id: string) => {
    if (!keep || id === "fleet") return true;
    if (id.startsWith("head:") || id.startsWith("fold:")) { const pr = id.slice(id.indexOf(":") + 1); return [...keep].some(h => byId.get(h) && projectOf(byId.get(h)!) === pr); }
    const rid = id.slice(2);
    return keep.has(rid.startsWith(TASK) ? rid.slice(TASK.length).split(":")[0]! : rid);
  };
  /** With the keyboard in use, each waiting card carries its number for 1–9 (unless the digits pick an answer). */
  const badgeOf = (id: string) => {
    if (!kbd || simpleAsk || !id.startsWith("s:")) return null;
    const i = numbered.indexOf(id.slice(2));
    return i >= 0 ? String(i + 1) : null;
  };
  const node = (id: string, cls: string, child: ReactNode, onClick?: () => void) => (
    <div key={id} data-id={id} ref={el => { if (el) els.current.set(id, el); else els.current.delete(id); }}
      className={`fr-node ${cls}${sel === id ? " is-selected" : ""}${!keepNode(id) ? " is-dim" : ""}${palette?.trim() && id.startsWith("s:") && keep?.has(id.slice(2)) ? " is-hit" : ""}${id.startsWith("s:") && picked.has(id.slice(2)) ? " is-picked" : ""}`}
      onPointerEnter={() => { setHover(id); sig.current.hoverId = id; sig.current.hoverSince = clockNow(); }}
      onPointerLeave={() => { setHover(h => (h === id ? null : h)); if (sig.current.hoverId === id) sig.current.hoverId = null; }} onClick={onClick}>
      {child}
      {badgeOf(id) && <span className={`fr-kbadge${waiting.includes(id.slice(2)) ? " is-waiting" : ""}`} aria-hidden>{badgeOf(id)}</span>}
    </div>
  );

  const edgeKeys: { key: string; cls: string }[] = [];
  for (const c of columns) {
    edgeKeys.push({ key: `trunk:${c.project}`, cls: "trunk" });
    for (const r of c.rows) {
      if (c.rows.some(x => x.parent === r.id)) edgeKeys.push({ key: `trunk:${r.id}`, cls: "trunk" });
      edgeKeys.push({ key: `br:${r.id}`, cls: `br br--${r.state}${r.depth ? " br--child" : ""}` });
    }
    if (c.doneFolded || expanded.has(c.project)) edgeKeys.push({ key: `br:fold:${c.project}`, cls: "br br--done" });
  }
  // one level up from what is selected: a sub-agent's session, a session's project, a project's Fleetify
  const up = (() => {
    if (!sel || sel === "fleet") return null;
    if (sel.startsWith("head:")) return { to: "fleet", label: "Fleetify" };
    const id = sel.slice(2);
    for (const c of columns) {
      const row = c.rows.find(r => r.id === id);
      if (!row) continue;
      if (row.parent) return { to: `s:${row.parent}`, label: byId.get(row.parent)?.title || "Session" };
      if (merged.has(c.project)) return { to: "fleet", label: "Fleetify" };
      return { to: `head:${c.project}`, label: c.project };
    }
    return null;
  })();
  const goUp = () => {
    if (!up) return;
    if (up.to === "fleet") { setSel(null); centerHub(); return; }
    if (up.to.startsWith("head:")) { setSel(up.to); userPick.current = null; fitProject(up.to.slice(5)); return; }
    select(up.to);
  };
  const pathRef = (key: string) => (el: SVGPathElement | null) => { if (el) path.current.set(key, el); else path.current.delete(key); };
  const flowRef = (key: string) => (el: SVGPathElement | null) => { if (el) flows.current.set(key, el); else flows.current.delete(key); };
  // cards widen to use the room each side of the hub, within limits
  const cardW = Math.round(Math.max(400, Math.min(440, (field.w - 150) / 2 - TREE.rootGap - TREE.pad - TREE.branch - TREE.indent - 6)));

  return (
    <NowCtx.Provider value={now}>
      <div className={`fr-map${panelId ? " is-dived" : ""}`}>
        <div ref={viewRef} className={`fr-view${keep ? " is-searching" : ""}`} onContextMenu={onMenu} onPointerMoveCapture={onViewPointerMove} onPointerEnter={() => { sig.current.pointerIn = true; }} onPointerLeave={() => { sig.current.pointerIn = false; sig.current.hoverId = null; }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClickCapture={onClickCapture} onClick={onClickView} onDoubleClick={onDouble}>
            <div ref={stageRef} className="fr-stage" style={{ width: lay?.width ?? "100%", height: lay?.height ?? "100%", ["--fr-card-w" as string]: `${cardW}px`, ["--fr-body-max" as string]: `${Math.max(220, field.h - COMPOSER - 210)}px` }}>
              <svg ref={svgRef} aria-hidden className="fr-lines" width={lay?.width ?? 0} height={lay?.height ?? 0}>
                {columns.map(c => (
                  <path key={`root:${c.project}`} ref={pathRef(`root:${c.project}`)}
                    className={`fr-edge fr-root fr-root--${projState.get(c.project)}${lit?.has(`root:${c.project}`) ? " is-on" : ""}`} />
                ))}
                {edgeKeys.map(e => (
                  <path key={e.key} ref={pathRef(e.key)}
                    className={`fr-edge ${e.cls.split(" ").map(c => `fr-edge--${c}`).join(" ")}${lit?.has(e.key) ? " is-on" : ""}`} />
                ))}
                {!reduce && flowKeys.map(k => <path key={`flow:${k}`} ref={flowRef(k)} className={`fr-flow${k.startsWith("root:") ? " is-root" : ""}`} />)}
                {columns.flatMap(c => c.rows.map(r => (
                  <g key={`sk-${r.id}`} data-sk={r.id} ref={el => { if (el) sockets.current.set(r.id, el); else sockets.current.delete(r.id); }} className={`fr-socket fr-socket--${r.state}`}>
                    <circle className="dot" r={r.depth ? 2.4 : 3} />
                  </g>
                )))}
                {Array.from({ length: SPARK_POOL }, (_, i) => (
                  <g key={`spark-${i}`} data-spark={i} className="fr-spark" style={{ opacity: 0 }}>
                    <path className="track" />
                    <circle className="halo" r={8} /><circle className="core" r={2.6} />
                  </g>
                ))}
              </svg>

              <div ref={cursorRef} className="fr-cursor" aria-hidden />
              <button ref={upBtn} type="button" className="fr-up" data-fleet={up?.to === "fleet" ? "1" : undefined} onClick={e => { e.stopPropagation(); goUp(); }} title={up ? `Up to ${up.label}` : undefined} aria-hidden={!up}>
                <ArrowUp size={11} strokeWidth={2.4} />{up?.to === "fleet" && <LogoMark size={13} ariaLabel="" />}<span>{up?.label}</span>
              </button>
              {node("fleet", `fr-hub${hubOpen ? " is-open" : ""}`, (
                <Hub counts={counts} markRef={markRef} onPick={onPick} fleetBusy={fleetBusy} thread={hubOpen ? <FleetThread sessionId={fleetSessionId ?? null} onShowChat={() => onShowChat?.()} /> : null} />
              ))}

              {columns.map(c => {
                const inProj = tree.filter(t => t.project === c.project);
                const projSpent = sessions.filter(s => projectOf(s) === c.project).reduce((a, s) => a + (s.budget_used ?? 0), 0);
                const side = lay?.sides[c.project] ?? "right";
                return (
                  <div key={c.project} style={{ display: "contents" }}>
                    {node(`head:${c.project}`, `fr-proj fr-proj--${projState.get(c.project)} fr-proj--${side}${merged.has(c.project) ? " fr-proj--merged" : ""}`, merged.has(c.project) ? null : (
                      <>
                        {(projState.get(c.project) === "needs" || projState.get(c.project) === "failed") && <i className={`fr-proj-dot d-${projState.get(c.project)}`} />}
                        <span className="fr-proj-name">{c.project}</span>
                        <span className="fr-proj-n">{inProj.length}</span>
                        {projSpent > 0 && <span className="fr-proj-n">{money(projSpent)}</span>}
                      </>
                    ))}
                    {c.rows.map(r => {
                      const cls = `fr-row fr-row--${side}`;
                      if (r.id.startsWith(TASK)) {
                        const [sid, tid] = r.id.slice(TASK.length).split(":");
                        const task = sid && tid ? chat[sid]?.subagentTasks[tid] : undefined;
                        if (!task) return null;
                        return node(`s:${r.id}`, cls, <SubagentCard task={task} open={isOpen(r.id, r.state)} onToggle={() => toggle(r.id, r.state)} />);
                      }
                      const s = byId.get(r.id);
                      if (!s) return null;
                      return node(`s:${r.id}`, cls, <SessionCard session={s} cs={chat[s.id]} state={r.state} open={isOpen(s.id, r.state)} onToggle={() => toggle(s.id, r.state)} onOpen={() => onOpen(s.id)} talk={!!dock && !picked.size && selId === s.id} />);
                    })}
                    {(c.doneFolded > 0 || expanded.has(c.project)) && node(`fold:${c.project}`, `fr-row fr-row--${side} fr-click`, (
                      <span className="fr-fold">{expanded.has(c.project) ? "Hide finished" : <><Check size={11} strokeWidth={2.4} />{c.doneFolded} done</>}</span>
                    ), () => setExpanded(e => { const n = new Set(e); if (n.has(c.project)) n.delete(c.project); else n.add(c.project); return n; }))}
                  </div>
                );
              })}
            </div>
        </div>
        <div className="fr-chips">
          {waiting.map(id => {
            const st = tree.find(t => t.id === id)?.state ?? "needs";
            return (
              <button key={id} type="button" className={`fr-chip fr-chip--${st}`} ref={el => { if (el) chipEls.current.set(id, el); else chipEls.current.delete(id); }}
                onClick={() => select(`s:${id}`)} title={st === "failed" ? "Failed: show it" : "Needs you: show it"}>
                <ArrowUp size={11} strokeWidth={2.6} />
                <span>{byId.get(id)?.title || "Session"}</span>
              </button>
            );
          })}
        </div>
        {welcome && (
          <button type="button" className="fr-welcome" onClick={() => { setWelcome(null); recenter(); }}>
            While you were away:
            {welcome.needs > 0 && <b className="n">{welcome.needs} need{welcome.needs === 1 ? "s" : ""} you</b>}
            {welcome.failed > 0 && <b className="f">{welcome.failed} failed</b>}
            {welcome.done > 0 && <b>{welcome.done} finished</b>}
          </button>
        )}
        {menu && (() => {
          const ms = byId.get(menu.id);
          if (!ms) return null;
          const row = allRows.find(r => r.id === menu.id);
          const live = row?.state === "working";
          const folder = ms.worktree_path ?? ms.project_path;
          const fd = field;
          return (
            <div className={`fr-menu${menu.up ? " is-up" : ""}`} role="menu" style={menu.up ? { right: Math.max(8, fd.w - menu.x), bottom: Math.max(8, fd.h - menu.y) } : { left: Math.min(menu.x, fd.w - 220), top: Math.min(menu.y, Math.max(0, fd.h - COMPOSER - 260)) }} onPointerDown={e => e.stopPropagation()} onClick={onMenuClick}>
              <div className="fr-menu-h">{ms.title || "Session"}</div>
              {row && <button type="button" role="menuitem" data-act="toggle">{isOpen(row.id, row.state) ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}{isOpen(row.id, row.state) ? "Close card" : "Open card"}<kbd>Space</kbd></button>}
              <button type="button" role="menuitem" data-act="open"><ExternalLink size={13} />Open the full chat<kbd>↵</kbd></button>
              {!dock && <button type="button" role="menuitem" data-act="reply"><Reply size={13} />Reply<kbd>R</kbd></button>}
              <i />
              {sessionActions(ms, live).map(a => (
                <button key={a.key} type="button" role="menuitem" className={a.key === "stop" ? "is-danger" : undefined} data-act={`do:${a.key}`}>{a.icon}{a.label}</button>
              ))}
              <i />
              {ms.worktree_branch && <button type="button" role="menuitem" data-act="branch"><Copy size={13} />Copy branch</button>}
              {folder && <button type="button" role="menuitem" data-act="path"><Copy size={13} />Copy folder path</button>}
            </div>
          );
        })()}
        {inHead(head?.left, <FilterBar filter={filter} counts={counts} compact={field.w < 1180} inHead={!!head?.left} onFilter={setFilter} onPalette={openSearch} />)}
        {palette !== null && (
          <Palette commands={commands} sessions={findable} query={palette} setQuery={setPalette} onClose={closePalette} onSession={goSession} onRun={runCommand} />
        )}
        {palette === null && !picked.size && fleetSel && dock && inHead(dock, (
          <ActionBar docked title="Fleet" state={null} lead={<LogoMark size={14} ariaLabel="" />}
            details={<span className="fr-facts-line"><span>{broadcast ? `Your message goes to every working agent (${working.length})` : "Starts, steers and stops your agents"}</span></span>}
            hints={kbd ? prompts : undefined} onClose={clearSel} onAction={runCommand}
            actions={[
              { id: "fleet:new", label: "New session" },
              ...(working.length ? [{ id: "fleet:all", label: broadcast ? "Talk to Fleet" : `Message all working (${working.length})`, tone: broadcast ? "tint" as const : undefined }] : []),
              ...(working.length ? [{ id: "fleet:stop", label: confirmStop ? `Confirm: stop ${working.length}` : `Stop all (${working.length})`, tone: "danger" as const }] : []),
            ]} />
        ))}
        {palette === null && picked.size > 0 && inHead(dock, (
          <ActionBar docked={!!dock} title={`${picked.size} selected`} state={null} onClose={clearPicks} onAction={runCommand} actions={[
            { id: "pick:open", label: "Open cards" },
            { id: "pick:close", label: "Close cards" },
            { id: "pick:frame", label: "Show them" },
            ...(working.some(id => picked.has(id)) ? [{ id: "pick:stop", label: `Stop ${working.filter(id => picked.has(id)).length}`, tone: "danger" as const }] : []),
          ]} />
        ))}
        {palette === null && !picked.size && selId && selS && selRow && inHead(dock, (
          <ActionBar docked={!!dock} title={selS.title || "Session"} state={selRow.state} sub={projectOf(selS)} onClose={clearSel}
            lead={<AgentLead tool={selS.tool} state={selRow.state} />} details={<AgentFacts session={selS} cs={chat[selS.id]} />} hints={dock && kbd ? prompts : undefined}
            ask={selPerm ? `${selPerm.tool_name}${selPerm.command ? `: ${selPerm.command}` : ""}` : simpleAsk ? simpleAsk.questions[0]!.question : undefined}
            onMore={openBarMenu} onAction={runCommand}
            actions={[
              ...(selPerm ? [
                { id: "deny", label: "Deny", key: "D" },
                { id: "allow", label: "Allow", key: "A", tone: "tint" as const },
                { id: "always", label: "Always allow", tone: "primary" as const },
              ] : simpleAsk ? [
                ...askOptions.slice(0, 9).map((o, i) => ({ id: `opt:${o}`, label: o, key: String(i + 1), tone: pickLabel === o ? "tint" as const : undefined })),
                ...(pickLabel ? [{ id: "send", label: "Send", key: "↵", tone: "primary" as const }] : []),
              ] : selRow.state === "needs" && !isOpen(selRow.id, selRow.state) ? [{ id: "answer", label: "Answer", key: "Space", tone: "primary" as const }] : []),
              // docked, the composer below is the reply box
              ...(dock ? [] : [{ id: "reply", label: "Reply", key: "R" }]),
              panelId ? { id: "surface", label: "Back to map", key: "Esc" } : { id: "chat", label: "Dive in", key: "↵" },
              ...(selRow.state === "working" ? [{ id: "stop", label: "Stop", tone: "danger" as const }] : []),
            ]} />
        ))}
        {activity && <ActivityPanel items={feed} now={now} titleOf={id => byId.get(id)?.title || "Session"} onPick={goSession} onClose={toggleActivity} />}
        {help && (
          <div className="fr-help" role="dialog" aria-label="Keyboard shortcuts" onPointerDown={e => e.stopPropagation()}>
            <div className="fr-help-h"><Keyboard size={13} />Shortcuts<button type="button" aria-label="Close" onClick={() => setHelp(false)}><X size={12} /></button></div>
            {[["⌘K", "Find a session or run any command"], ...commands.filter(c => c.key && c.group !== "selection").map(c => [c.key!, c.label]), ["← ↑ → ↓  j k", "Move; left and right cross over the hub"], ["↵", "Dive into the selected agent (Esc comes back)"], ["R", "Talk to it from here"], ["⇧O", "Go to its own page"], ["A  D", "Allow or deny its request"], ["1–9", "Pick an answer, or jump to a numbered card"], ["Space", "Open or close the card"], ["Esc", "Back out"]].map(([k, v]) => <div key={k} className="fr-help-row"><kbd>{k}</kbd><span>{v}</span></div>)}
            <div className="fr-help-foot">Double-click Fleetify to close every card · double-click a project to open or close its cards · shift-click to pick several · right-click a card for more</div>
          </div>
        )}
        {toast && <div className="fr-toast" role="status">{toast}</div>}
        {kbd && palette === null && !dock && (
          <div className="fr-prompts" aria-hidden style={{ bottom: COMPOSER + 12 }}>
            {prompts.map(([k, v]) => <span key={k + v}><Kbd k={k} />{v}</span>)}
          </div>
        )}
        {kbd && palette === null && dock && !picked.size && !fleetSel && !(selId && selS && selRow) && inHead(dock, (
          <div className="fr-bar is-docked is-hints"><KeyLine items={prompts} /></div>
        ))}
        {inHead(head?.right, <div className={`fr-zoom${head?.right ? " in-head" : ""}`} role="toolbar" aria-label="Zoom">
          {/* following, paused while the user steers (then a click re-centres), or turned off */}
          <button type="button" className={`fr-zoom-auto${autoOn && camBase !== "user" ? " on" : ""}`}
            title={!autoOn ? "The camera stays where you put it. Click to let it follow what needs you." : camBase === "user" ? "You are steering. Click to let the camera take over again." : "The camera follows what needs you. Click to keep it still."}
            onClick={() => { if (!autoOn) { setAutoOn(true); recenter(); } else if (camBase === "user") recenter(); else setAutoOn(false); }}>
            <i />{!autoOn ? "Still" : camBase === "user" ? "Re-center" : "Following"}
          </button>
          {waiting.length > 0 && <button type="button" className="fr-zoom-wait" title="Go to the next one waiting on you (N)" onClick={nextWaiting}><i />{waiting.length} waiting</button>}
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / ZOOM.step)}><Minus size={13} /></button>
          <button type="button" className="fr-zoom-pct" title="Full size (1)" onClick={() => zoomBy(1 / cam.current.s)}>{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(ZOOM.step)}><Plus size={13} /></button>
          <i />
          <button type="button" aria-label="Fit everything" title="Fit everything (0)" onClick={() => fit()}><Maximize2 size={12} /></button>
          <button type="button" aria-label={anyOpen ? "Close every card" : "Open what needs you"} title={anyOpen ? "Close every card (C)" : "Open what needs you (C)"} onClick={toggleAll}>{anyOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}</button>
          <i />
          <button type="button" aria-label="Activity" title="Activity (L)" className={`fr-zoom-act${activity ? " is-on" : ""}`} onClick={toggleActivity}><ActivityIcon size={13} />{unread > 0 && <em>{unread > 9 ? "9+" : unread}</em>}</button>
          <button type="button" aria-label="Keyboard shortcuts" title="Shortcuts (?)" onClick={toggleHelp}><Keyboard size={13} /></button>
        </div>)}
      </div>
    </NowCtx.Provider>
  );
}

/** A card rings once in a colour: on a change of state, or when the hub jumps to it. */
function ring(node: HTMLElement | undefined, color: string) {
  const card = node?.firstElementChild as HTMLElement | null;
  card?.animate([
    { boxShadow: `0 0 0 0 ${color}`, offset: 0 },
    { boxShadow: `0 0 0 3px ${color}`, offset: 0.18 },
    { boxShadow: "0 0 0 16px transparent", offset: 1 },
  ], { duration: 1100, easing: "cubic-bezier(.2,.7,.2,1)" });
}
