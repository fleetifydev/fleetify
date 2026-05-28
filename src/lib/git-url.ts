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
  const trimmed = input.trim().replace(/\/+$/, "");
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
