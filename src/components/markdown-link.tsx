/**
 * The `a` of every markdown renderer that shows text the app didn't write: a
 * project's README, an agent's plan, an AI review or diagnosis, a plugin's
 * README. A plain `<a href>` would load the page in the app's own window, in
 * place of the app. This one follows `linkTarget` (`@/lib/links`) instead.
 */
import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import type { Components } from "react-markdown";
import { linkTarget, openExternalUrl } from "@/lib/links";

/** Follows a click on a link to `href` without ever navigating the app's
 *  window: another site opens in the system browser, a fragment scrolls in
 *  place, and anything else does nothing. */
export function followLink(event: MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  const target = linkTarget(href, window.location.href);
  if (target.kind === "anchor") return;
  event.preventDefault();
  if (target.kind === "external") openExternalUrl(target.url);
}

/** A markdown link: an `a` that keeps the app's window on the app. Hovering
 *  it still shows where it goes. */
export function MarkdownLink({ href, onClick: _onClick, ...props }: ComponentPropsWithoutRef<"a">) {
  return <a {...props} href={href} rel="noreferrer" onClick={(event) => followLink(event, href)} />;
}

/** `components` for a `ReactMarkdown` that customises nothing but links. */
export const markdownLinkComponents: Components = {
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
};
