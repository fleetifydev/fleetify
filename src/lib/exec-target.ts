/** Where a session's agent runs, renderer side.
 *
 *  Mirrors `crates/fleetify-backend/src/services/exec_target.rs`. Kept as a
 *  shared module rather than inline checks because the same question is
 *  asked from three places (the toolbar's git chip, its data fetch, and the
 *  container panel) and one of them getting it wrong took the whole toolbar
 *  down: `listGitBranches("docker://abc/work")` shelled out to git in a
 *  directory that does not exist, returned a shape missing its arrays, and
 *  the render's `branches.local.filter(...)` threw.
 */

/** Execution target for a session. Orthogonal to the *source* — a
 *  `docker-run` session still has a real host `project_path`. */
export type ExecMode = "host" | "docker-attach" | "docker-run";

/** Does host git (and host filesystem work generally) apply to this path?
 *
 *  False for a container or remote target, whose files are not on this
 *  machine. A Windows drive (`C:\…`), a verbatim prefix (`\\?\C:\…`) and a
 *  UNC share all stay true — none of them carry a `<scheme>://`.
 */
export function isHostPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return !/^[a-z0-9]+:\/\//i.test(path);
}

/** The container id encoded in a `docker://<id>/<path>` marker, if any.
 *  Container ids cannot contain a slash, so the first one is an
 *  unambiguous split — same rule the backend parser uses. */
export function containerIdFromPath(path: string | null | undefined): string | null {
  if (!path?.startsWith("docker://")) return null;
  return path.slice("docker://".length).split("/")[0] || null;
}

export interface BranchList {
  local: string[];
  remote: string[];
  current: string | null;
}

export const EMPTY_BRANCHES: BranchList = { local: [], remote: [], current: null };

/** Coerce whatever `listGitBranches` returned into a renderable shape.
 *
 *  The render does `branches.local.filter(...)`, so a result missing either
 *  array takes the toolbar down with a TypeError. `r ?? default` only guards
 *  a null result, not a partial one — which is precisely what a non-host
 *  path produced. Defending the shape here means no future caller can
 *  reintroduce the crash even if the guard is bypassed.
 */
export function normalizeBranches(r: unknown): BranchList {
  const o = (r ?? {}) as Partial<BranchList>;
  return {
    local: Array.isArray(o.local) ? o.local : [],
    remote: Array.isArray(o.remote) ? o.remote : [],
    current: typeof o.current === "string" ? o.current : null,
  };
}

/* ── Project-file helpers (Dockerfile / compose pickers) ─────────────
 *
 * The OS dialog hands back an absolute path; sessions store the file
 * relative to the project folder when it lives inside it (pretty, and
 * robust to the folder moving), absolute otherwise. All of this has to
 * survive Windows: mixed separators, drive letters whose casing differs
 * between two strings that name the same place. */

/** Normalise separators to `/` and strip any trailing one. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Case-insensitive compare is only correct on Windows-shaped paths —
 *  a drive letter or UNC prefix. POSIX paths stay case-sensitive. */
function isWindowsShaped(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.startsWith("//");
}

/** Last path segment. */
export function leafName(p: string): string {
  const n = norm(p);
  return n.split("/").filter(Boolean).pop() ?? n;
}

/** The directory containing `p`. */
export function parentDir(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : n;
}

/** `file` relative to `dir` when it lives inside it, else null.
 *  Forward slashes in the result — the backend's PathBuf::join accepts
 *  them on every platform, and they read cleanly in the UI. */
export function relativeWithin(file: string, dir: string): string | null {
  const f = norm(file);
  const d = norm(dir);
  if (isWindowsShaped(f) && isWindowsShaped(d)) {
    if (!f.toLowerCase().startsWith(d.toLowerCase() + "/")) return null;
    return f.slice(d.length + 1);
  }
  if (!f.startsWith(d + "/")) return null;
  return f.slice(d.length + 1);
}

/** The branch to show as selected.
 *
 *  The real current branch when there is one; otherwise fall back to the
 *  repo's main-line branch when it exists (`main`, then `master`). The
 *  fallback covers a detached HEAD and the unborn-HEAD window right after
 *  an auto-init — states where "—" reads as "this folder has no git" even
 *  though the repo is perfectly healthy. Null only when neither applies.
 */
export function displayBranch(current: string | null, local: string[]): string | null {
  if (current) return current;
  if (local.includes("main")) return "main";
  if (local.includes("master")) return "master";
  return null;
}

/** What the folder-readout chip shows for an attached container.
 *
 *  The workdir's leaf when one was picked; the container's short id when
 *  the user attached at the container root — which used to fall through to
 *  the literal string "Container", telling them nothing about WHICH one. */
export function attachDisplay(projectPath: string): string {
  const id = containerIdFromPath(projectPath);
  const tail = projectPath
    .replace(/^docker:\/\/[^/]+/, "")
    .replace(/\/+$/, "");
  const leaf = tail.split("/").filter(Boolean).pop();
  return leaf ?? (id ? id.slice(0, 12) : "Container");
}
