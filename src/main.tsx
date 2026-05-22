import "@fontsource-variable/geist";
import "./globals.css";
import { StrictMode } from "react";
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
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
