#!/usr/bin/env node
/**
 * fake-app.mjs — a stand-in for the Fleetify app in the tests of
 * launch-smoke.mjs, which starts it as the app under test.
 *
 * Like the real app's embedded backend, it serves on 127.0.0.1 at
 * FLEETIFY_BACKEND_PORT:
 *   GET /healthz   {"status":"ok","version":…}
 *   GET /          index.html, under a Content-Security-Policy
 *   /api/…         403 without this run's X-Fleetify-Token header
 * and answers 403 to a request addressed to another host. It keeps its
 * sessions DB at $HOME/.fleetify/fleet.db, and writes the real app's JSON log
 * lines (fleetify.log.<date>) into FAKE_LOG_DIR, or, when that is unset, the
 * folder the real app writes to (src-tauri/src/shell/logging.rs).
 *
 * FAKE_MODE picks what it gets wrong:
 *   ok       nothing (the default)
 *   panic    logs a panic, as the real app's panic hook and Rust's default
 *            hook do, and goes on serving, as the app does after a task panics
 *   no-csp   serves index.html without a Content-Security-Policy
 *   cwd-db   keeps its DB in its working directory instead of under HOME
 *   open     answers every request: no host or token check
 *   exit     fails to start: logs why and exits with code 3
 *   hang     never serves
 *
 * And these environment variables:
 *   FAKE_UPDATE_URL      an update endpoint, written as the updater's config
 *                        writes one, with {{target}}, {{arch}},
 *                        {{current_version}} and {{bundle_type}}. A second
 *                        after starting it asks it for an update, downloads
 *                        the one offered and logs "update ready", as the real
 *                        updater does once a download has verified.
 *   FAKE_BUNDLE_TYPE     the bundle type it reports (default appimage)
 *   FAKE_DOWNLOAD_ASSET  a release asset it downloads from the update
 *                        server's /artifacts/ instead of the one offered
 *   FAKE_POSTHOG         "initialised": it logs that the PostHog sink started,
 *                        as a build with the key does; else that there is no key
 *   FAKE_APPRUN          a folder: it starts the app as a child process in
 *                        that folder and waits for it, as an AppImage's runtime
 *                        and AppRun do
 *   FAKE_IGNORE_SIGTERM  "1": the app ignores SIGTERM
 *   FAKE_PID_FILE        where the app writes its pid
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The version the app reports to the updater. */
const VERSION = "0.2.0";

/** The updater's names for this platform, as tauri-plugin-updater writes them. */
const UPDATER_OS = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform] ?? "unknown";
const UPDATER_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "i686", arm: "armv7" }[process.arch] ?? "unknown";

/** Where the real app writes its log. */
function realLogDir(env) {
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? "", "Fleetify", "logs");
  if (process.platform === "darwin") return join(env.HOME ?? "", "Library", "Logs", "Fleetify");
  return join(env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state"), "fleetify", "logs");
}

const LOG_DIR = process.env.FAKE_LOG_DIR || realLogDir(process.env);

/**
 * One log line, as the real app writes it: JSON into today's file, and a
 * compact line on stderr.
 */
function log(level, target, message, fields = {}) {
  const timestamp = new Date().toISOString();
  mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp, level, fields: { message, ...fields }, target });
  appendFileSync(join(LOG_DIR, `fleetify.log.${timestamp.slice(0, 10)}`), `${line}\n`);
  const extra = Object.entries(fields).map(([key, value]) => ` ${key}=${value}`);
  process.stderr.write(`${timestamp} ${level.padStart(5)} ${target}: ${message}${extra.join("")}\n`);
}

/** The policy the real backend serves the UI under (crates/fleetify-backend/src/ui.rs). */
const csp = (port) =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:${port} https://eu.i.posthog.com`,
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
  ].join("; ");

/** Serve the backend's routes on 127.0.0.1:port. */
function serve(port, mode, onListening) {
  const token = Math.random().toString(16).slice(2);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const checked = mode !== "open";
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://fake");
    if (checked && !hosts.has(req.headers.host ?? "")) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
      return;
    }
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", version: VERSION }));
      return;
    }
    if (pathname.startsWith("/api/")) {
      if (checked && req.headers["x-fleetify-token"] !== token) {
        res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    if (pathname === "/") {
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (mode !== "no-csp") headers["content-security-policy"] = csp(port);
      res.writeHead(200, headers).end("<!doctype html><title>Fleetify</title><div id=root></div>\n");
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", onListening);
}

/** Ask the update endpoint, download what it offers, and log the outcome as the updater does. */
async function checkForUpdate(template) {
  const url = template
    .replaceAll("{{target}}", UPDATER_OS)
    .replaceAll("{{arch}}", UPDATER_ARCH)
    .replaceAll("{{current_version}}", VERSION)
    .replaceAll("{{bundle_type}}", process.env.FAKE_BUNDLE_TYPE || "appimage");
  try {
    const answer = await fetch(url, { headers: { accept: "application/json" } });
    if (answer.status === 204) {
      log("INFO", "fleetify.updater", "no update");
      return;
    }
    if (!answer.ok) throw new Error(`the update endpoint answered ${answer.status}`);
    const update = await answer.json();
    const other = process.env.FAKE_DOWNLOAD_ASSET;
    const download = await fetch(other ? new URL(`/artifacts/${other}`, update.url) : update.url);
    if (!download.ok) throw new Error(`the download answered ${download.status}`);
    await download.arrayBuffer();
    log("INFO", "fleetify.updater", "update ready", { version: update.version });
  } catch (err) {
    log("WARN", "fleetify.updater", "update check failed", { error: err.message });
  }
}

/** Start the app as a child in `dir` and wait for it, as an AppImage's runtime does. */
function runtime(dir) {
  const env = { ...process.env };
  delete env.FAKE_APPRUN;
  const app = spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: dir, env, stdio: "inherit" });
  app.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

function app() {
  const mode = process.env.FAKE_MODE || "ok";
  const port = Number(process.env.FLEETIFY_BACKEND_PORT);
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!Number.isInteger(port) || port < 1 || !home) {
    process.stderr.write("fake app: FLEETIFY_BACKEND_PORT and HOME are required\n");
    process.exitCode = 2;
    return;
  }
  if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  if (process.env.FAKE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

  log("INFO", "logging", "fleetify session started", { version: VERSION, os: process.platform, arch: process.arch });
  if (mode === "exit") {
    log("ERROR", "fleetify_app_lib", "backend failed to start: fake failure");
    process.exitCode = 3;
    return;
  }
  if (mode === "hang") {
    setInterval(() => {}, 60_000);
    return;
  }

  if (mode === "cwd-db") {
    writeFileSync(join(process.cwd(), "fleet.db"), "SQLite format 3\0");
  } else {
    mkdirSync(join(home, ".fleetify"), { recursive: true });
    writeFileSync(join(home, ".fleetify", "fleet.db"), "SQLite format 3\0");
  }
  if (process.env.FAKE_POSTHOG === "initialised") {
    log("INFO", "fleetify.posthog", "posthog sink initialised (runtime gate currently closed)", { host: "https://eu.i.posthog.com" });
  } else {
    log("INFO", "fleetify.posthog", "POSTHOG_API_KEY set neither in env nor at build time; posthog sink disabled");
  }

  serve(port, mode, () => {
    log("INFO", "fleet-backend", `fleetify-backend listening on http://127.0.0.1:${port}`);
    if (mode === "panic") {
      const location = "crates/fleetify-backend/src/lib.rs:1:1";
      log("ERROR", "panic", "rust panic", { thread: "tokio-runtime-worker", location, payload: "fake panic" });
      process.stderr.write(`thread 'tokio-runtime-worker' panicked at ${location}:\nfake panic\n`);
    }
    if (process.env.FAKE_UPDATE_URL) setTimeout(() => checkForUpdate(process.env.FAKE_UPDATE_URL), 1000);
  });
}

if (process.env.FAKE_APPRUN) runtime(process.env.FAKE_APPRUN);
else app();
