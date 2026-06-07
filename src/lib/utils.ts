import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isWindowsPlatform(): boolean {
  const api = (window as Window).electronAPI;
  if (api && typeof api.platform === "string") return api.platform === "win32";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    return /windows/i.test(ua);
  }
  return false;
}

export function isMacPlatform(): boolean {
  const api = (window as Window).electronAPI;
  if (api && typeof api.platform === "string") return api.platform === "darwin";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    return /mac/i.test(ua);
  }
  return false;
}

/**
 * True on platforms where the window is built decorationless and the renderer
 * paints its OWN title bar (Windows + Linux). See `src-tauri/src/lib.rs`:
 * `decorations(false)` is applied for `not(target_os = "macos")`, so both
 * Windows and Linux ship the in-app title-bar strip. macOS keeps the native
 * traffic lights and is the ONLY platform that does NOT use the in-app bar.
 *
 * Use this — NOT `isWindowsPlatform()` — for every title-bar / window-chrome
 * layout decision so Windows and Linux render identically (the macOS branch is
 * gated on `!usesInAppTitleBar()`).
 */
export function usesInAppTitleBar(): boolean {
  return !isMacPlatform();
}

/**
 * Return the trailing folder/file name of a path, working for both
 * POSIX (`/`) and Windows (`\\`) separators. Strips trailing
 * separators and ignores empty segments so `"C:\\foo\\bar\\"` →
 * `"bar"` and `"/foo/bar"` → `"bar"`.
 *
 * Returns `""` if the input is empty/undefined. Returns the input
 * unchanged when it has no separator (e.g. `"learning_rust"`).
 */
export function folderName(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Return `url` only if it parses as an http(s) URL. Used everywhere we render
 * a `<a href>` whose value originates outside our trust boundary (marketplace
 * payloads, plugin manifests). Blocks `javascript:` / `data:` / file: URIs
 * that could execute when clicked even with `rel=noreferrer`.
 */
export function safeExternalUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
}

/** Middle-truncate a string with an ellipsis so both ends stay
 *  visible. Useful for branch names where the trailing short-id
 *  matters as much as the leading prefix. */
export function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const ellipsis = "…";
  // Keep ~60% on the left, ~40% on the right so the prefix stays
  // dominant ("fleet/auth-fix" reads first).
  const keepLeft = Math.ceil((max - 1) * 0.6);
  const keepRight = (max - 1) - keepLeft;
  return s.slice(0, keepLeft) + ellipsis + s.slice(-keepRight);
}
