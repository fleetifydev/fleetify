/**
 * Detects a local dev-server URL in raw terminal output.
 *
 * Every mainstream dev server prints a loopback URL on boot — Vite
 * ("➜  Local:   http://localhost:5173/"), Next ("- Local: http://localhost:3000"),
 * CRA, Astro, Nuxt, Remix. We strip ANSI first because those banners are
 * coloured, then take the LAST match so restarting on a new port moves the
 * preview with it.
 *
 * Deliberately loopback-only: a production https URL printed by a deploy step
 * must never hijack the preview pane. An explicit port is required for the
 * same reason — a bare "http://localhost" carries no server to frame.
 */

/** CSI (`ESC [ … final`) and OSC (`ESC ] … BEL|ST`) sequences colour the banners. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Loopback host + explicit port. `\b` after the port rejects 6-digit garbage
 * rather than silently truncating it to a plausible-looking 5-digit port.
 */
const LOOPBACK = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * @returns a normalised `http://localhost:<port>`, or null when the text holds
 *          no local dev-server URL. All loopback spellings collapse to
 *          `localhost` so the iframe gets one canonical origin.
 */
export function detectDevServerUrl(text: string): string | null {
  const clean = stripAnsi(text);
  let port: string | null = null;
  // Group 1 is non-optional in the pattern, but noUncheckedIndexedAccess widens
  // every index access to `| undefined` — keep the previous value rather than
  // asserting, so the last *real* match still wins.
  for (const m of clean.matchAll(LOOPBACK)) port = m[1] ?? port;
  return port ? `http://localhost:${port}` : null;
}
