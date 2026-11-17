/**
 * Images in a plugin's README and CHANGELOG: third-party markdown that would
 * otherwise load any image straight into the WebView, a tracking pixel or a
 * request to a host on the user's own network. Shared by both renderers
 * (`OverviewBody` in PluginDetailPage, `ChangelogBody`).
 *
 * - `data:` images render.
 * - `https:` images from a few well-known image hosts render.
 * - Any other `https:` image shows a "Load image from <host>" button and
 *   loads only after a click.
 * - Every other scheme, and relative paths, show the alt text.
 *
 * Links in them go through `MarkdownLink`: another site opens in the system
 * browser, never in the app's own window.
 */
import { useState, type ComponentPropsWithoutRef } from "react";
import { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import { MarkdownLink } from "@/components/markdown-link";

/** Hosts whose images load without asking: GitHub's image hosts and badges. */
const IMAGE_HOSTS = new Set([
  "raw.githubusercontent.com",
  "github.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "avatars.githubusercontent.com",
  "img.shields.io",
]);

const DATA_IMAGE = /^data:image\//i;

export type ImageSource =
  | { kind: "load"; src: string }
  | { kind: "ask"; src: string; host: string }
  | { kind: "alt" };

/** What to do with a markdown image's `src`. */
export function imageSource(src: string | undefined): ImageSource {
  if (!src) return { kind: "alt" };
  if (DATA_IMAGE.test(src)) return { kind: "load", src };
  let url: URL;
  try {
    // No base: a relative path doesn't parse, and shows its alt text.
    url = new URL(src);
  } catch {
    return { kind: "alt" };
  }
  if (url.protocol !== "https:") return { kind: "alt" };
  // Only the listed host itself: not on another port, not with credentials.
  const listed = IMAGE_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password;
  return listed ? { kind: "load", src: url.href } : { kind: "ask", src: url.href, host: url.host };
}

/**
 * react-markdown's default URL check drops every `data:` URL. Keep `data:`
 * images in an `img` `src`, and leave every other URL to the default.
 */
export const markdownUrlTransform: UrlTransform = (url, key, node) =>
  key === "src" && node.tagName === "img" && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url);

const loadButton: React.CSSProperties = {
  display: "inline-flex", alignItems: "center",
  padding: "3px 9px", borderRadius: 6,
  border: "1px solid var(--sidebar-border)", background: "var(--c-srf)",
  color: "var(--c-med)", fontSize: 12, fontFamily: "inherit",
  cursor: "pointer",
};

/** The `img` of both markdown renderers. */
export function MarkdownImage({ src, alt, title }: ComponentPropsWithoutRef<"img">) {
  const [asked, setAsked] = useState(false);
  const source = imageSource(typeof src === "string" ? src : undefined);
  if (source.kind === "alt") return alt ? <span>{alt}</span> : null;
  if (source.kind === "ask" && !asked) {
    return (
      <button type="button" style={loadButton} title={alt || undefined} onClick={() => setAsked(true)}>
        Load image from {source.host}
      </button>
    );
  }
  return (
    <img
      src={source.src}
      alt={alt ?? ""}
      title={title}
      // The plugin's host learns nothing about where it is shown.
      referrerPolicy="no-referrer"
      style={{ maxWidth: "100%" }}
    />
  );
}

/** Props both renderers give `ReactMarkdown`. */
export const markdownComponents: Components = {
  img: ({ node: _node, ...props }) => <MarkdownImage {...props} />,
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
};
