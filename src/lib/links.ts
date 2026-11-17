/**
 * Where a link in rendered markdown may take the user. The main window must
 * stay on the app: a page from another site loaded in its place has no way
 * back and no use of the app's commands, which answer the app's own origin
 * only. So a link to another site opens in the system browser, a link to
 * another page of the app's origin does nothing, and only a fragment of the
 * current page (`#usage`) is left to the webview, which scrolls to it.
 */

/** Schemes the system may open for a link: web pages and mail. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export type LinkTarget =
  /** A fragment of the current page: the webview scrolls to it in place. */
  | { kind: "anchor" }
  /** Another site: open `url` in the system browser (or mail client). */
  | { kind: "external"; url: string }
  /** Anything else: the app's own pages, other schemes, unreadable links.
   *  Following it does nothing. */
  | { kind: "blocked" };

/** What following a link to `href` does, on the page at `page`. */
export function linkTarget(href: string | null | undefined, page: string): LinkTarget {
  if (!href) return { kind: "blocked" };
  if (href.startsWith("#")) return { kind: "anchor" };
  let url: URL;
  let here: URL;
  try {
    here = new URL(page);
    url = new URL(href, here);
  } catch {
    return { kind: "blocked" };
  }
  const sameOrigin = url.origin === here.origin;
  if (sameOrigin && url.pathname === here.pathname && url.search === here.search && url.hash) {
    return { kind: "anchor" };
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol) && (url.protocol === "mailto:" || !sameOrigin)) {
    return { kind: "external", url: url.href };
  }
  return { kind: "blocked" };
}

/** Opens `url` with the system's default handler, through the app's bridge
 *  (the `shell_open_external` command). Where there is no bridge, the
 *  renderer in a plain browser, it opens a new tab instead. */
export function openExternalUrl(url: string): void {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
