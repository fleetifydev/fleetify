/**
 * Fleetify renderer logger — thin batch-and-ship wrapper around the
 * `electronAPI.appLog` IPC. Every call:
 *   1. Mirrors to the dev console (live visibility while debugging in
 *      DevTools).
 *   2. Pushes onto an internal queue that flushes every 100 ms or when
 *      50 events are buffered — whichever comes first. ERROR events
 *      bypass the buffer and fire immediately so a crash trail isn't
 *      lost to a quiet 100 ms window before exit.
 *   3. Lands in the backend's tracing pipeline → NDJSON log file
 *      (`fleetify.log.YYYY-MM-DD`) under the OS log dir.
 *
 * Targets are free-form strings used to identify the source of the
 * event when grepping logs. Convention: dot-namespaced, lowercase,
 * dash-separated (e.g. `ui.branch-picker`, `ws.dispatch`,
 * `create-pr.execute`). Backend events use the same shape via
 * `tracing!(target: ...)`.
 *
 * Sensitive data — tokens, API keys, JWTs, message bodies, file
 * contents — must never reach this layer. The backend's redact layer
 * is a seatbelt, not a substitute for not logging secrets in the
 * first place. When in doubt about a field, leave it out.
 */

type Level = "trace" | "debug" | "info" | "warn" | "error";

interface QueuedEvent {
  level: Level;
  target: string;
  message: string;
  fields?: Record<string, unknown> | null;
}

const BATCH_INTERVAL_MS = 100;
const BATCH_MAX_SIZE = 50;

const queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function consoleMirror(ev: QueuedEvent) {
  // Dev terminal mirror — short prefix so the [target] is easy to
  // visually scan when 30 lines/sec are streaming through.
  const prefix = `[${ev.target}]`;
  switch (ev.level) {
    case "error":
      console.error(prefix, ev.message, ev.fields ?? "");
      break;
    case "warn":
      console.warn(prefix, ev.message, ev.fields ?? "");
      break;
    case "debug":
    case "trace":
      console.debug(prefix, ev.message, ev.fields ?? "");
      break;
    default:
      console.log(prefix, ev.message, ev.fields ?? "");
  }
}

async function ship(ev: QueuedEvent): Promise<void> {
  try {
    await window.electronAPI?.appLog?.(
      ev.level,
      ev.target,
      ev.message,
      ev.fields ?? null,
    );
  } catch {
    // Logging itself must never throw — if the IPC bridge is broken
    // we still want the renderer to keep running. The dev console
    // mirror above already captured the event for live debugging.
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, BATCH_INTERVAL_MS);
}

async function flushNow(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  // Fire-and-forget per event so a slow IPC roundtrip doesn't gate
  // the next batch. Tauri's IPC is serialised on the channel anyway,
  // so this won't actually parallelise — but it also won't block.
  await Promise.all(batch.map(ship));
}

function emit(
  level: Level,
  target: string,
  message: string,
  fields?: Record<string, unknown>,
) {
  const ev: QueuedEvent = { level, target, message, fields };
  consoleMirror(ev);
  if (level === "error") {
    // Errors bypass the batch window — if the page tears down 50ms
    // later (uncaught throw, navigation, etc.) we'd rather pay the
    // immediate IPC cost than lose the trail.
    void ship(ev);
    return;
  }
  queue.push(ev);
  if (queue.length >= BATCH_MAX_SIZE) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flushNow();
  } else {
    scheduleFlush();
  }
}

export const log = {
  trace: (target: string, message: string, fields?: Record<string, unknown>) =>
    emit("trace", target, message, fields),
  debug: (target: string, message: string, fields?: Record<string, unknown>) =>
    emit("debug", target, message, fields),
  info: (target: string, message: string, fields?: Record<string, unknown>) =>
    emit("info", target, message, fields),
  warn: (target: string, message: string, fields?: Record<string, unknown>) =>
    emit("warn", target, message, fields),
  error: (target: string, message: string, fields?: Record<string, unknown>) =>
    emit("error", target, message, fields),
  /** Force-flush any queued events. Useful right before a navigation
   *  or programmatic teardown when buffered INFO/DEBUG events would
   *  otherwise be dropped. */
  flush: () => flushNow(),
};

/**
 * Wire global error capture. Call once from the renderer entry point.
 *   • `window.onerror`         — synchronous throws that escape every
 *                                React error boundary AND non-React
 *                                code (raw script errors, image
 *                                onload throws, …).
 *   • `unhandledrejection`     — promise rejections without a .catch.
 *                                Common cause of silent UI freezes.
 *   • `beforeunload`           — last-ditch flush so the final batch
 *                                lands before the window dies.
 */
export function installGlobalErrorCapture(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (ev) => {
    const err = ev.error;
    const message = err instanceof Error ? err.message : String(ev.message || "Uncaught error");
    log.error("renderer.uncaught", message, {
      filename: ev.filename || null,
      line: ev.lineno ?? null,
      col: ev.colno ?? null,
      stack: err instanceof Error ? err.stack : null,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const message = reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "Unhandled promise rejection";
    log.error("renderer.unhandled-rejection", message, {
      stack: reason instanceof Error ? reason.stack : null,
    });
  });
  window.addEventListener("beforeunload", () => {
    // Best-effort sync flush. The promise it returns may not resolve
    // before the page dies, but the IPC writes are fire-and-forget
    // on the backend side so most of the batch still lands.
    void log.flush();
  });
}
