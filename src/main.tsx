import "@fontsource-variable/geist";
import "./globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installGlobalErrorCapture, log } from "./lib/log";

// Initialize theme from localStorage
const saved = localStorage.getItem("fleet-theme");
if (saved === "light") {
  document.documentElement.classList.remove("dark");
} else {
  document.documentElement.classList.add("dark");
}

// Wire renderer logging FIRST so any subsequent module-init errors
// or React mount failures land in the on-disk log file. Catches
// `window.onerror` + `unhandledrejection` + flushes on beforeunload.
installGlobalErrorCapture();
log.info("renderer.boot", "renderer mounted", {
  userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  // Time from page navigation to renderer module eval — a cold-start signal.
  sinceNavMs: typeof performance !== "undefined" ? Math.round(performance.now()) : null,
});

// NOTE: no <StrictMode>. It double-invokes every render + effect in dev, which
// doubled the chat/session-switch render cost (measured: heavy sessions blocked
// the main thread ~2× longer). StrictMode is a dev-only behaviour with zero
// effect on production builds, so dropping it only changes the dev experience —
// making switching feel as snappy as a release build.
// Suppress the webview's native right-click menu (Inspect / Reload /
// Back) app-wide. preventDefault only cancels the browser's default
// context menu — React's own onContextMenu handlers (e.g. the sidebar
// session menu) still fire, so our custom menus keep working. DevTools
// stays reachable via F12 / Ctrl+Shift+I.
window.addEventListener("contextmenu", e => e.preventDefault());

createRoot(document.getElementById("root")!).render(<App />);
// Cold-start marker — pair with sinceNavMs above to measure mount cost.
if (typeof performance !== "undefined") performance.mark("fleet:react-render");
