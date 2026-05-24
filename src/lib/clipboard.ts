/**
 * Cross-context clipboard helper. Tauri's webview exposes a working
 * native clipboard via the preload `writeText` shim; navigator.clipboard
 * is unreliable because Tauri's secure-context flags vary by OS and
 * sometimes the promise resolves without the data actually landing.
 * The execCommand fallback covers very old WebKit builds in CI.
 *
 * Returns true if any path succeeded, false if every path failed.
 * Never throws — handlers can early-return on `false` and show a UI
 * error without try/catch ceremony at the call site.
 */
export async function copyText(text: string): Promise<boolean> {
  // 1. Tauri IPC bridge.
  type Shim = { writeText?: (t: string) => Promise<unknown> };
  const shim = (window as unknown as { electronAPI?: Shim }).electronAPI;
  if (shim?.writeText) {
    try {
      const r = await shim.writeText(text);
      // Tauri returns true | undefined on success; treat anything not
      // explicitly false as success.
      if (r !== false) return true;
    } catch {
      // fall through
    }
  }

  // 2. Browser clipboard (secure context).
  const clip = navigator.clipboard;
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }

  // 3. execCommand fallback.
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}
