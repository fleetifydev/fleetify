/**
 * Renderer-side structured logger for the git/PR pipeline.
 *
 * Mirrors `gitLog(channel, event, detail)` in `electron/main.cjs` so
 * the user can grep both streams (DevTools console + main-process
 * stdout) with the same shape and reconstruct an end-to-end trace:
 *
 *   [HH:MM:SS.SSS] [git:<channel>] <event> { k: v, … }
 *
 * The detail object is logged separately (not stringified) so it
 * stays expandable in DevTools. Pass small, scalar-ish detail; large
 * payloads (full diffs, raw markdown) should be truncated by the
 * caller before passing.
 */
export function glog(channel: string, event: string, detail?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `[${ts}] [git:${channel}] ${event}`;
  if (detail && Object.keys(detail).length > 0) {
    // console.log keeps the prefix as a label and lets DevTools render
    // the object as a collapsible tree — easier to scan than a single
    // stringified blob.
    console.log(prefix, detail);
  } else {
    console.log(prefix);
  }
}
