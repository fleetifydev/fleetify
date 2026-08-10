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
