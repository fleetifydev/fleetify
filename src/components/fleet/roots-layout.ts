import type { SessionStatus } from "@/types/session";

/** Where a session stands, as Fleet's root tree shows it. A pending
 *  permission or question counts as `needs` even before the backend flips the
 *  status; a streaming session counts as `working`. */
export type NodeState = "needs" | "failed" | "working" | "done";

/** How much a state asks of the user: 0 first. Failed sits with `needs`, so an
 *  error is flagged as loudly as a question. */
export const STATE_RANK: Record<NodeState, number> = { needs: 0, failed: 0, working: 1, done: 2 };

export function nodeState(status: SessionStatus, hasPending: boolean, isStreaming: boolean): NodeState {
  if (status === "waiting" || hasPending) return "needs";
  if (status === "error") return "failed";
  if (status === "running" || status === "starting" || isStreaming) return "working";
  return "done";
}

export interface TreeSession {
  id: string;
  project: string;
  state: NodeState;
  /** The session that started this one (session.parent_id), if any. */
  parentId: string | null;
  /** When the session was created, epoch millis. A stable sort key: ordering by
   *  last activity reshuffled cards every few seconds as sessions ticked. */
  createdAt: number;
}

export interface TreeRow {
  id: string;
  state: NodeState;
  /** 0 hangs off the project's trunk; 1 and deeper hang off the row above it
   *  that started it. */
  depth: number;
  /** The row this one branches from (depth > 0). */
  parent: string | null;
}

export interface TreeColumn {
  project: string;
  rows: TreeRow[];
  /** Finished sessions folded into one "N done" row (0 when shown). */
  doneFolded: number;
}


/** Turn sessions into one column per project. Inside a column, what needs the
 *  user comes first, then what is working, then what is done; a session that
 *  another one started sits right under it, one step in. Finished sessions fold
 *  into a count unless `expanded` holds the project. Columns are ordered by
 *  how much they need the user. */
export function buildColumns(sessions: TreeSession[], expanded: ReadonlySet<string> = new Set()): TreeColumn[] {
  const byProject = new Map<string, TreeSession[]>();
  for (const s of sessions) {
    const list = byProject.get(s.project);
    if (list) list.push(s); else byProject.set(s.project, [s]);
  }
  const cols: (TreeColumn & { key: number[] })[] = [];
  for (const [project, list] of byProject) {
    // the order sessions started in, never their state: a change of state moves nothing, a new one joins at the end
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const ids = new Set(sorted.map(s => s.id));
    const children = new Map<string, TreeSession[]>();
    for (const s of sorted) if (s.parentId && ids.has(s.parentId)) {
      const c = children.get(s.parentId);
      if (c) c.push(s); else children.set(s.parentId, [s]);
    }
    const live = sorted.filter(s => s.state !== "done");
    const fold = !expanded.has(project) && live.length > 0;
    const rows: TreeRow[] = [];
    let folded = 0;
    const visit = (s: TreeSession, depth: number, parent: string | null, guard: Set<string>) => {
      if (guard.has(s.id)) return;
      guard.add(s.id);
      // a finished leaf folds away; a finished parent with live children stays, it holds them
      const kids = children.get(s.id) ?? [];
      const liveKids = kids.some(k => k.state !== "done");
      if (fold && s.state === "done" && !liveKids) { folded += 1 + countDone(kids, children, guard); return; }
      rows.push({ id: s.id, state: s.state, depth, parent });
      for (const k of kids) visit(k, depth + 1, s.id, guard);
    };
    const guard = new Set<string>();
    for (const s of sorted) if (!s.parentId || !ids.has(s.parentId)) visit(s, 0, null, guard);
    // a cycle in parent_id would leave sessions unvisited: show them at the top level
    for (const s of sorted) if (!guard.has(s.id)) visit(s, 0, null, guard);
    cols.push({ project, rows, doneFolded: folded, key: [Math.min(...list.map(s => s.createdAt))] });
  }
  // projects in the order they started, so the map keeps its shape: what needs the user is shown by colour and the camera, not by moving it
  cols.sort((a, b) => a.key[0]! - b.key[0]! || a.project.localeCompare(b.project));
  return cols.map(({ project, rows, doneFolded }) => ({ project, rows, doneFolded }));
}

function countDone(kids: TreeSession[], children: Map<string, TreeSession[]>, guard: Set<string>): number {
  let n = 0;
  for (const k of kids) { if (guard.has(k.id)) continue; guard.add(k.id); n += 1 + countDone(children.get(k.id) ?? [], children, guard); }
  return n;
}

export interface Box { w: number; h: number }

export type Side = "left" | "right";

export interface BranchInput {
  /** Width and height the tree may use, px. */
  W: number;
  H: number;
  hub: Box;
  /** `weight` balances the sides: give it something that changes only when sessions come or go (their count), so no project crosses sides when a card folds or a sub-agent shows */
  columns: { project: string; head: Box; rows: { id: string; depth: number; box: Box }[]; fold?: Box; weight?: number }[];
}

export interface Placed { x: number; y: number; w: number; h: number }

export interface BranchOutput {
  hub: Placed;
  heads: Record<string, Placed>;
  rows: Record<string, Placed>;
  folds: Record<string, Placed>;
  /** Which side of the hub each project branches to. */
  sides: Record<string, Side>;
  width: number;
  height: number;
}

/** Spacing of the tree, px. */
export const TREE = { rootGap: 120, projGap: 34, headGap: 12, rowGap: 10, branch: 30, indent: 22, pad: 16 };

/** Lay the tree out from the middle: Fleetify's hub in the centre, projects
 *  branching to its left and right, each project's sessions hanging off its
 *  trunk and growing outward, a session started by another one step further
 *  out under it. Projects alternate sides by height, so both sides stay even,
 *  and the most urgent project sits at the top of the first side. The hub sits
 *  near the top and never moves with the branches, so the tree stays still. */
export function layoutBranches(input: BranchInput): BranchOutput {
  const { pad, rootGap, projGap, headGap, rowGap, branch, indent } = TREE;
  const { hub } = input;
  const heightOf = (c: BranchInput["columns"][number]) =>
    c.head.h + (c.rows.length || c.fold ? headGap : 0) + c.rows.reduce((a, r) => a + r.box.h + rowGap, 0) + (c.fold ? c.fold.h + rowGap : 0) - (c.rows.length || c.fold ? rowGap : 0);
  const widthOf = (c: BranchInput["columns"][number]) =>
    Math.max(c.head.w, c.fold ? branch + c.fold.w : 0, ...c.rows.map(r => branch + r.depth * indent + r.box.w));
  const sides: Record<string, Side> = {};
  const stack: Record<Side, { c: BranchInput["columns"][number]; h: number }[]> = { left: [], right: [] };
  const used: Record<Side, number> = { left: 0, right: 0 };
  // sides are balanced by how many rows a project has, not by their pixel heights,
  // so a card that opens, grows or shows its hover tools never sends a project across
  for (const c of input.columns) {
    const side: Side = used.left <= used.right ? "left" : "right";
    sides[c.project] = side;
    stack[side].push({ c, h: heightOf(c) });
    used[side] += c.weight ?? 1 + c.rows.length + (c.fold ? 1 : 0);
  }
  const sideW = (s: Side) => Math.max(0, ...stack[s].map(x => widthOf(x.c)));
  const reach = Math.max(sideW("left"), sideW("right"));
  const width = Math.max(input.W, 2 * (pad + reach + rootGap) + hub.w);
  const hubX = width / 2 - hub.w / 2;
  // fixed anchors: both sides grow downward from the top, and the hub keeps its place,
  // so a card that opens, closes or fills in only moves the cards under it
  const top = pad;
  const hubCY = pad + 40 + hub.h / 2;
  const out: BranchOutput = { hub: { x: hubX, y: hubCY - hub.h / 2, w: hub.w, h: hub.h }, heads: {}, rows: {}, folds: {}, sides, width, height: 0 };
  let bottom = out.hub.y + hub.h;
  for (const side of ["left", "right"] as Side[]) {
    // a side shorter than the other sits level with the hub's middle
    let y = top;
    const edge = side === "left" ? hubX - rootGap : hubX + hub.w + rootGap;
    const at = (off: number, w: number) => (side === "left" ? edge - off - w : edge + off);
    for (const { c, h } of stack[side]) {
      out.heads[c.project] = { x: at(0, c.head.w), y, w: c.head.w, h: c.head.h };
      let ry = y + c.head.h + headGap;
      for (const r of c.rows) {
        out.rows[r.id] = { x: at(branch + r.depth * indent, r.box.w), y: ry, w: r.box.w, h: r.box.h };
        ry += r.box.h + rowGap;
      }
      if (c.fold) out.folds[c.project] = { x: at(branch, c.fold.w), y: ry, w: c.fold.w, h: c.fold.h };
      y += h + projGap;
    }
    bottom = Math.max(bottom, y - projGap);
  }
  out.height = bottom + pad;
  return out;
}
