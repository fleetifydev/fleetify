/**
 * Where a link the app shows may take the user. The main window must stay on
 * the app: a page from another site loaded in its place has no way back and
 * no use of the app's commands, which answer the app's own origin only. So a
 * link to another site opens in the system browser, a link to another page of
 * the app's origin does nothing, and a fragment of the current page
 * (`#usage`) scrolls to its element without touching the page's URL.
 */

/** Schemes the system may open for a link: web pages and mail. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export type LinkTarget =
  /** A fragment of the current page: scroll to the element with this `id`. */
  | { kind: "anchor"; id: string }
  /** Another site: open `url` in the system browser (or mail client). */
  | { kind: "external"; url: string }
  /** Anything else: the app's own pages, other schemes, unreadable links.
   *  Following it does nothing. */
  | { kind: "blocked" };

/** What following a link to `href` does, on the page at `page`. */
export function linkTarget(href: string | null | undefined, page: string): LinkTarget {
  if (!href) return { kind: "blocked" };
  if (href.startsWith("#")) return { kind: "anchor", id: fragmentId(href.slice(1)) };
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
    return { kind: "anchor", id: fragmentId(url.hash.slice(1)) };
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol) && (url.protocol === "mailto:" || !sameOrigin)) {
    return { kind: "external", url: url.href };
  }
  return { kind: "blocked" };
}

/** The element id a fragment names: percent-decoded, or as it is when it
 *  doesn't decode. */
function fragmentId(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** Scrolls to the element a fragment link names, when the page has one. The
 *  page's URL is left alone: the app reads its own hash (`#logos` swaps the
 *  app for a dev-only gallery), so a link must never set it. */
export function scrollToFragment(id: string): void {
  if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
}

/** Opens `url` with the system's default handler, through the app's bridge
 *  (the `shell_open_external` command). Where there is no bridge, the
 *  renderer in a plain browser, it does nothing: the app never asks its
 *  webview for a new window, which Tauri's webview refuses anyway. A rejected
 *  bridge call never reaches the caller. */
export function openExternalUrl(url: string): void {
  void Promise.resolve(window.electronAPI?.openExternal?.(url)).catch(() => {});
}

/** Opens `href` in the system browser when it links to another site or is a
 *  mail link, as following it would (`linkTarget`); anything else does
 *  nothing. For links the app shows as buttons, such as citation cards. */
export function openLink(href: string | null | undefined): void {
  const target = linkTarget(href, window.location.href);
  if (target.kind === "external") openExternalUrl(target.url);
}
