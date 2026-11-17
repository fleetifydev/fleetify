/**
 * The dev-only logo gallery: `#logos` swaps the whole app for it, to compare
 * brand-mark candidates. A release build never shows it: a link or a drop
 * that sets the hash must not strand the user there.
 */

/** Whether the window shows the logo gallery in place of the app: only in a
 *  dev build (`dev`, Vite's `import.meta.env.DEV`), and only for `#logos`. */
export function showsLogoGallery(hash: string, dev: boolean = import.meta.env.DEV): boolean {
  return dev && hash === "#logos";
}
