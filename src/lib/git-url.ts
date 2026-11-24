/** Normalize a user-typed clone target into a URL `git clone` will accept.
 *
 *  Accepted inputs:
 *    - `owner/repo`                              → https://github.com/owner/repo
 *    - `github.com/owner/repo`                   → https://github.com/owner/repo
 *    - `https://github.com/owner/repo`           → unchanged
 *    - `https://github.com/owner/repo.git`       → unchanged
 *    - `git@github.com:owner/repo.git`           → unchanged
 *    - any URL with an explicit scheme           → unchanged
 *
 *  Anything that doesn't look like one of the above is returned as-is so
 *  the backend can surface a sensible error instead of us silently
 *  mangling the input.
 */
export function normalizeCloneUrl(input: string): string {
  // Trailing slashes go, and any spaces mixed in with them (`owner/repo /`).
  const trimmed = input.trim().replace(/[\s/]+$/, "");
  if (!trimmed) return trimmed;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (/^[\w.-]+@[\w.-]+:/.test(trimmed)) return trimmed;

  if (/^[\w-]+(\.[\w-]+)+\//.test(trimmed)) {
    return `https://${trimmed}`;
  }

  if (/^[\w.][\w.-]*\/[\w.][\w.-]*$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }

  return trimmed;
}

/** Derive the `owner/repo` label from any of the accepted clone-target
 *  forms or from a Fleetify clone path. Returns null when no two-segment
 *  identifier can be recovered (e.g. plain folder path, "weird-name").
 *
 *  Inputs handled:
 *    - URL with scheme              → strip scheme, host, trailing `.git`
 *    - scp-style `git@host:owner/repo[.git]` → take the path after `:`
 *    - bare `owner/repo`            → return as-is (with `.git` stripped)
 *    - clone path containing
 *      `.fleetify/clones/<host>/<owner>/<repo>` → `owner/repo`
 */
export function extractOwnerRepo(input: string): string | null {
  if (!input) return null;
  const raw = input.trim().replace(/\/+$/, "");

  const clonesMatch = raw.match(/[/\\]\.fleetify[/\\]clones[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]([^/\\]+)/);
  if (clonesMatch) {
    return `${clonesMatch[2]}/${clonesMatch[3]}`;
  }

  const scp = raw.match(/^[\w.-]+@[\w.-]+:(.+)$/);
  if (scp && scp[1]) {
    return stripGitSuffixAndTake2(scp[1]);
  }

  const scheme = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/);
  if (scheme && scheme[1]) {
    const rest = scheme[1].replace(/^[^@/]+@/, "");
    const afterHost = rest.split("/").slice(1).join("/");
    return stripGitSuffixAndTake2(afterHost);
  }

  if (/^[\w-]+(\.[\w-]+)+\//.test(raw)) {
    const afterHost = raw.split("/").slice(1).join("/");
    return stripGitSuffixAndTake2(afterHost);
  }

  if (/^[\w.][\w.-]*\/[\w.][\w.-]*$/.test(raw)) {
    return raw.replace(/\.git$/, "");
  }

  return null;
}

function stripGitSuffixAndTake2(path: string): string | null {
  const parts = path.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}
