#!/usr/bin/env node
/**
 * launch-smoke.mjs — start a release bundle's app the way a user does, from
 * the filesystem root with a fresh home, and check that it works. CI runs it
 * against every bundle a release ships.
 *
 *   node scripts/release/launch-smoke.mjs run --app <exe> [--app-arg <a>]... --home <dir>
 *     [--port 18765] [--cwd <dir>] [--log-dir <dir>] [--legal-dir <dir>]
 *     [--csp-origin <origin>] [--expect-posthog-sink]
 *     [--rehearse <release-dir> --rehearsal-signatures <dir> --bundle-type appimage|deb|rpm|nsis|app]
 *     [--update-port 18080] [--timeout-s 120] [--settle-s 10]
 *   node scripts/release/launch-smoke.mjs serve-release --dir <release-dir> --version <v> [--port 18081]
 *
 * run starts the app with the working directory --cwd, by default the
 * filesystem root, and an environment of its own (smokeEnv): its home is
 * --home, which must not hold a sessions DB yet, and its backend listens on
 * 127.0.0.1:--port. It checks, in this order:
 *
 *   healthz       GET /healthz answers 200 with "status":"ok" within --timeout-s;
 *                 an app that exits first fails at once
 *   ui            GET / answers 200 text/html under a content-security-policy
 *                 with default-src 'self', whose connect-src allows
 *                 --csp-origin when that is given (an empty value is not given:
 *                 a fork PR has no repository variables). The backend falls
 *                 back to PostHog's EU host, so an origin equal to that can't
 *                 show the build got the variable; --expect-posthog-sink can.
 *   access token  GET /api/groups without the API token answers 403
 *   access host   GET /healthz with Host: evil.example answers 403
 *   db            <home>/.fleetify/fleet.db exists, and no fleet.db is in the
 *                 launch folder or, on Linux, in the working directory of any of
 *                 the app's processes (read from /proc/<pid>/cwd)
 *   legal         with --legal-dir: it holds LICENSE, NOTICE and
 *                 THIRD-PARTY-NOTICES, none of them empty
 *   posthog sink  with --expect-posthog-sink: the log says the PostHog sink
 *                 started, which it does only when the build compiled in the
 *                 project key (the app gets no POSTHOG_ variable from here)
 *   rehearsal     with --rehearse: an update server (createUpdateServer) on
 *                 127.0.0.1:--update-port offers 99.0.0 from the release
 *                 folder's latest.json, as the dry-run build's only endpoint
 *                 expects, with the rehearsal's signature of the artifact
 *                 from --rehearsal-signatures: <asset>.sig, which the dry
 *                 run's build signed for 99.0.0. The updater refuses a
 *                 signature made for another version than the one it is
 *                 offered, so the release's own can't stand in. Within 180 s
 *                 the app asks it for
 *                 /update/<os>/<arch>/<version>?bundle_type=<--bundle-type>,
 *                 where <version> is the release's, downloads that bundle type's
 *                 artifact in full, verifies it and logs "update ready" 99.0.0.
 *                 The version /healthz reports, the one the backend was built
 *                 as, must be the release's too.
 *   log           --settle-s after the healthz, or after the rehearsal: the
 *                 log folder holds JSON log lines from this run (lines there
 *                 before the launch are not read), and neither they nor the
 *                 app's output show a panic or a content security policy
 *                 violation (logProblems)
 *   running       the app is still running
 *   stop          the app's processes, and only those, are stopped: on Unix its
 *                 process group (it starts in a group of its own), and on Linux
 *                 also any descendant that left the group, with SIGTERM, then
 *                 SIGKILL after 5 s; on Windows `taskkill /T /F /PID`. A
 *                 descendant is signalled only while it has the start time it
 *                 was listed with, so a pid reused meanwhile is left alone.
 *                 If the app's root process survives the stop, the smoke lets
 *                 go of it, so it still exits with its own code.
 *
 * The log folder is --log-dir, or the folder the app writes to (logDirFor).
 * The table of checks goes to stdout; when a check fails, so do the last lines
 * of the app's output and log.
 *
 * The launch-folder check can't see a DB the app writes in a working directory
 * of its own. An AppImage's AppRun changes into $APPDIR/usr before it starts
 * the app, so on Linux the check also reads each process's working directory.
 * On macOS and Windows only the launch folder is checked: the bundles there
 * start the app executable directly, in the folder it was launched from.
 *
 * serve-release serves a release folder the way GitHub serves a release's
 * assets (createReleaseServer), at http://127.0.0.1:--port, until it gets
 * SIGINT or SIGTERM. It logs each request on stdout.
 *
 * Exit codes: 0 every check passed (serve-release: stopped by a signal);
 * 1 a check failed, or the smoke was interrupted; 2 usage, or a setup problem
 * found before the app started (the app isn't a file, the home already holds
 * a DB, a port is in use, the release folder can't be read, the rehearsal's
 * signature of the update offered is missing).
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, createReadStream, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST, REHEARSAL_VERSION, compareVersions, resolveUpdate } from "./release-assets.mjs";

const USAGE = `usage: node scripts/release/launch-smoke.mjs run --app <exe> [--app-arg <a>]... --home <dir>
         [--port 18765] [--cwd <dir>] [--log-dir <dir>] [--legal-dir <dir>]
         [--csp-origin <origin>] [--expect-posthog-sink]
         [--rehearse <release-dir> --rehearsal-signatures <dir> --bundle-type appimage|deb|rpm|nsis|app]
         [--update-port 18080] [--timeout-s 120] [--settle-s 10]
       node scripts/release/launch-smoke.mjs serve-release --dir <release-dir> --version <v> [--port 18081]`;

const DEFAULT_PORT = 18765;
const DEFAULT_UPDATE_PORT = 18080;
const DEFAULT_RELEASE_PORT = 18081;
const DEFAULT_TIMEOUT_S = 120;
const DEFAULT_SETTLE_S = 10;
/** How long the rehearsal waits for the update to download and verify. */
const REHEARSAL_TIMEOUT_S = 180;
/** How long a stop waits after SIGTERM, and after SIGKILL. */
const STOP_GRACE_MS = 5000;
const POLL_MS = 250;
/** The version the update server offers: newer than any release, and the one the rehearsal's signatures name. */
const OFFER_VERSION = REHEARSAL_VERSION;

const BUNDLE_TYPES = ["appimage", "deb", "rpm", "nsis", "app"];
const LEGAL_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"];
/** The sessions DB's name, and the one a no-auth debug run on the shared home uses. */
const DB_NAMES = ["fleet.db", "fleet-noauth.db"];
/** The app's log files: fleetify.log.YYYY-MM-DD. */
const LOG_PREFIX = "fleetify.log";
/** Variables the app reads that would move the DB or quiet the log the checks read. */
const DROPPED = new Set(["FLEET_DB_URL", "RUST_LOG"]);

/** MAJOR.MINOR.PATCH, as release versions are written. */
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** A release asset's name: no path, no spaces. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The updater's names for each platform and arch (tauri-plugin-updater's updater_os and updater_arch). */
const UPDATER_OS = new Map([
  ["linux", "linux"],
  ["darwin", "darwin"],
  ["win32", "windows"],
]);
const UPDATER_ARCH = new Map([
  ["x64", "x86_64"],
  ["arm64", "aarch64"],
  ["ia32", "i686"],
  ["arm", "armv7"],
]);

class UsageError extends Error {}
class SetupError extends Error {}

// ── Arguments ───────────────────────────────────────────────────────────────

/** What each flag takes: a value, a value that may be empty, a repeated value, or nothing. */
const RUN_FLAGS = {
  "--app": "value",
  "--app-arg": "list",
  "--home": "value",
  "--port": "value",
  "--cwd": "value",
  "--log-dir": "value",
  "--legal-dir": "value",
  "--csp-origin": "maybe-empty",
  "--expect-posthog-sink": "switch",
  "--rehearse": "value",
  "--rehearsal-signatures": "value",
  "--bundle-type": "value",
  "--update-port": "value",
  "--timeout-s": "value",
  "--settle-s": "value",
};
const SERVE_FLAGS = { "--dir": "value", "--version": "value", "--port": "value" };

/** The flags in `argv`, as `spec` describes them. Throws a UsageError. */
function readFlags(argv, spec) {
  const values = new Map();
  const lists = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const kind = Object.hasOwn(spec, flag) ? spec[flag] : undefined;
    if (kind === undefined) throw new UsageError(`unexpected argument: ${flag}`);
    if (kind === "switch") {
      if (values.has(flag)) throw new UsageError(`${flag} is given twice`);
      values.set(flag, true);
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (kind === "list") {
      // Any value, dashes and all: these are the app's own arguments.
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      lists.set(flag, [...(lists.get(flag) ?? []), value]);
      continue;
    }
    if (value === undefined || value.startsWith("-") || (value === "" && kind !== "maybe-empty")) {
      // An unquoted empty ${{ vars.X }} leaves the next flag in the value's place.
      const hint = kind === "maybe-empty" ? ` (quote an empty one: ${flag} "")` : "";
      throw new UsageError(`${flag} needs a value${hint}`);
    }
    if (values.has(flag)) throw new UsageError(`${flag} is given twice`);
    values.set(flag, value);
  }
  return { values, lists };
}

function portOf(flag, text) {
  const port = Number(text);
  if (!/^[0-9]+$/.test(text) || port < 1 || port > 65535) {
    throw new UsageError(`${flag} ${JSON.stringify(text)} is not a port from 1 to 65535`);
  }
  return port;
}

function secondsOf(flag, text, min) {
  const seconds = Number(text);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text) || seconds < min) {
    throw new UsageError(`${flag} ${JSON.stringify(text)} is not a number of seconds of at least ${min}`);
  }
  return seconds;
}

/** An http(s) URL's origin, as the backend puts it in the policy. */
function originOf(flag, text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError(`${flag} ${JSON.stringify(text)} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${flag} ${JSON.stringify(text)} is not an http or https URL`);
  }
  return url.origin;
}

function parseRun(argv) {
  const { values, lists } = readFlags(argv, RUN_FLAGS);
  for (const flag of ["--app", "--home"]) {
    if (!values.has(flag)) throw new UsageError(`${flag} is required`);
  }
  const rehearse = values.get("--rehearse");
  const bundleType = values.get("--bundle-type");
  if (rehearse !== undefined && bundleType === undefined) throw new UsageError("--rehearse needs --bundle-type");
  if (rehearse === undefined && bundleType !== undefined) throw new UsageError("--bundle-type goes with --rehearse");
  if (bundleType !== undefined && !BUNDLE_TYPES.includes(bundleType)) {
    throw new UsageError(`--bundle-type must be one of ${BUNDLE_TYPES.join(", ")}, not ${JSON.stringify(bundleType)}`);
  }
  if (rehearse === undefined && values.has("--update-port")) throw new UsageError("--update-port goes with --rehearse");
  const port = values.has("--port") ? portOf("--port", values.get("--port")) : DEFAULT_PORT;
  const updatePort = values.has("--update-port") ? portOf("--update-port", values.get("--update-port")) : DEFAULT_UPDATE_PORT;
  if (rehearse !== undefined && port === updatePort) throw new UsageError(`--port and --update-port are both ${port}`);
  // The updater takes only a signature made for the version it is offered.
  if (rehearse !== undefined && !values.has("--rehearsal-signatures")) throw new UsageError("--rehearse needs --rehearsal-signatures");
  if (rehearse === undefined && values.has("--rehearsal-signatures")) throw new UsageError("--rehearsal-signatures goes with --rehearse");
  const csp = values.get("--csp-origin");
  const path = (flag) => (values.has(flag) ? resolve(values.get(flag)) : null);
  return {
    command: "run",
    // Absolute, because the app starts in another folder.
    app: resolve(values.get("--app")),
    appArgs: lists.get("--app-arg") ?? [],
    home: resolve(values.get("--home")),
    port,
    cwd: values.has("--cwd") ? resolve(values.get("--cwd")) : parse(process.cwd()).root,
    logDir: path("--log-dir"),
    legalDir: path("--legal-dir"),
    cspOrigin: csp === undefined || csp === "" ? null : originOf("--csp-origin", csp),
    expectPosthogSink: values.has("--expect-posthog-sink"),
    rehearse: path("--rehearse"),
    rehearsalSignatures: path("--rehearsal-signatures"),
    bundleType: bundleType ?? null,
    updatePort,
    timeoutS: values.has("--timeout-s") ? secondsOf("--timeout-s", values.get("--timeout-s"), 1) : DEFAULT_TIMEOUT_S,
    settleS: values.has("--settle-s") ? secondsOf("--settle-s", values.get("--settle-s"), 0) : DEFAULT_SETTLE_S,
  };
}

function parseServeRelease(argv) {
  const { values } = readFlags(argv, SERVE_FLAGS);
  for (const flag of ["--dir", "--version"]) {
    if (!values.has(flag)) throw new UsageError(`${flag} is required`);
  }
  const version = values.get("--version");
  if (!VERSION.test(version)) throw new UsageError(`--version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH (no leading v)`);
  return {
    command: "serve-release",
    dir: resolve(values.get("--dir")),
    version,
    port: values.has("--port") ? portOf("--port", values.get("--port")) : DEFAULT_RELEASE_PORT,
  };
}

/**
 * The command line (without node and the script), as the command's options.
 * Paths come back absolute. Throws a UsageError.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") return { command: "help" };
  if (command === "run") return parseRun(rest);
  if (command === "serve-release") return parseServeRelease(rest);
  if (command === undefined) throw new UsageError("missing command: run or serve-release");
  throw new UsageError(`unknown command: ${command}`);
}

// ── The app's environment and log folder ────────────────────────────────────

/**
 * The environment the app starts with: `baseEnv`, with the home, the XDG
 * folders and the backend port set, and on Linux WebKit's compositing and
 * DMA-BUF renderer off, which a virtual display can't run. Every other
 * FLEETIFY_ and POSTHOG_ variable is dropped, in any case: the app is to run
 * as installed, with what its build compiled in. So are FLEET_DB_URL, which
 * moves the sessions DB, and RUST_LOG, which can drop the log lines the
 * checks read. A variable set here replaces one of the same name in any case,
 * so Windows doesn't get two.
 *
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{ home: string, port: number, platform: string }} options
 * @returns {Record<string, string>}
 */
export function smokeEnv(baseEnv, { home, port, platform }) {
  const { join: joinPath } = platform === "win32" ? win32 : posix;
  const set = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: joinPath(home, ".config"),
    XDG_DATA_HOME: joinPath(home, ".local", "share"),
    XDG_CACHE_HOME: joinPath(home, ".cache"),
    XDG_STATE_HOME: joinPath(home, ".local", "state"),
    FLEETIFY_BACKEND_PORT: String(port),
    ...(platform === "linux" ? { WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1" } : {}),
  };
  const replaced = new Set(Object.keys(set));
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    const upper = name.toUpperCase();
    if (value === undefined || replaced.has(upper) || DROPPED.has(upper)) continue;
    if (upper.startsWith("FLEETIFY_") || upper.startsWith("POSTHOG_")) continue;
    env[name] = value;
  }
  return { ...env, ...set };
}

/** A variable of `env`, looked up in any case, as Windows does. */
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The folder the app writes its log to, as src-tauri/src/shell/logging.rs
 * picks it: on Linux $XDG_STATE_HOME/fleetify/logs (lowercase), with an unset
 * or empty XDG_STATE_HOME read as <home>/.local/state; on macOS
 * <home>/Library/Logs/Fleetify; on Windows %LOCALAPPDATA%\Fleetify\logs.
 *
 * @param {string} platform
 * @param {{ home: string, env: Record<string, string | undefined> }} options
 * @throws on Windows without LOCALAPPDATA
 */
export function logDirFor(platform, { home, env }) {
  if (platform === "win32") {
    const base = envValue(env, "LOCALAPPDATA");
    if (!base) throw new Error("LOCALAPPDATA is not set, so the app's log folder is unknown: pass --log-dir");
    return win32.join(base, "Fleetify", "logs");
  }
  if (platform === "darwin") return posix.join(home, "Library", "Logs", "Fleetify");
  const state = env.XDG_STATE_HOME ? env.XDG_STATE_HOME : posix.join(home, ".local", "state");
  return posix.join(state, "fleetify", "logs");
}

// ── Reading what the app says ───────────────────────────────────────────────

/** A log line as an object, or null when it isn't a JSON object. */
function parseJsonLine(line) {
  if (typeof line !== "string" || !line.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A line cut to a length a table can show. */
function clip(text, max = 400) {
  const line = String(text).trim();
  return line.length > max ? `${line.slice(0, max)}… (${line.length} characters)` : line;
}

/** The value of header `name` in a Headers object or a plain one, in any case. */
function headerValue(headers, name) {
  if (headers === null || headers === undefined) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** A policy's directives: name → sources, lowercased, the first of each name winning, as browsers read it. */
function parseCsp(policy) {
  const directives = new Map();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().toLowerCase().split(/\s+/);
    if (name && !directives.has(name)) directives.set(name, sources);
  }
  return directives;
}

/**
 * What is wrong with the answer to GET /: it must be 200 text/html, under a
 * content-security-policy with default-src 'self', and when `cspOrigin` is
 * given (not empty), with a connect-src that allows that origin.
 *
 * @param {{ status: number, headers: object, cspOrigin?: string | null }} answer
 * @returns {string[]}
 */
export function uiProblems({ status, headers, cspOrigin }) {
  const problems = [];
  if (status !== 200) problems.push(`GET / answered ${status}, not 200`);
  const type = headerValue(headers, "content-type");
  if (type === undefined || !/^text\/html\s*(;|$)/i.test(type)) {
    problems.push(`GET / content-type is ${type === undefined ? "missing" : JSON.stringify(type)}, not text/html`);
  }
  const policy = headerValue(headers, "content-security-policy");
  if (policy === undefined) {
    problems.push("GET / has no content-security-policy header");
    return problems;
  }
  const directives = parseCsp(policy);
  if (!(directives.get("default-src") ?? []).includes("'self'")) {
    problems.push(`content-security-policy has no default-src 'self': ${policy}`);
  }
  if (cspOrigin) {
    let origin = cspOrigin;
    try {
      origin = new URL(cspOrigin).origin;
    } catch {
      // Compared as given.
    }
    if (!(directives.get("connect-src") ?? []).includes(origin.toLowerCase())) {
      problems.push(`content-security-policy's connect-src doesn't allow ${origin}: ${policy}`);
    }
  }
  return problems;
}

/**
 * The problems in the app's log lines and output: a panic, which Rust's
 * default hook prints as "… panicked at …" and the app's panic hook logs on
 * the target "panic", and each line on the "fleetify.csp" target, where the
 * backend logs the content security policy violations browsers report.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function logProblems(lines) {
  const problems = [];
  for (const line of lines) {
    if (typeof line !== "string" || line.trim() === "") continue;
    const entry = parseJsonLine(line);
    if (line.includes("panicked at") || entry?.target === "panic") problems.push(`panicked: ${clip(line)}`);
    else if (entry?.target === "fleetify.csp") problems.push(`content security policy violation: ${clip(line)}`);
  }
  return problems;
}

/**
 * The version in the updater's latest "update ready" line, which it logs on
 * the target "fleetify.updater" once a download has verified; null when there
 * is none.
 *
 * @param {string[]} lines
 * @returns {string | null}
 */
export function findUpdaterReady(lines) {
  let version = null;
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (entry?.target !== "fleetify.updater" || entry.fields?.message !== "update ready") continue;
    if (typeof entry.fields.version === "string") version = entry.fields.version;
  }
  return version;
}

/** The updater's first warning or error, such as "update check failed: …"; null when there is none. */
function updaterFailure(lines) {
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (entry?.target !== "fleetify.updater" || (entry.level !== "WARN" && entry.level !== "ERROR")) continue;
    const { message = "?", error } = entry.fields ?? {};
    return error === undefined ? String(message) : `${message}: ${error}`;
  }
  return null;
}

/**
 * Why the log doesn't show a build with the PostHog key: the sink logs
 * "posthog sink initialised" on the "fleetify.posthog" target only when it has
 * a project key, and the app gets none from the smoke's environment, so the
 * key must have been compiled in. A line saying the sink is disabled is a
 * problem too.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function posthogSinkProblems(lines) {
  const entries = lines.map(parseJsonLine).filter((entry) => entry !== null);
  const message = (entry) => String(entry.fields?.message ?? "");
  const problems = [];
  const started = entries.some((entry) => entry.target === "fleetify.posthog" && message(entry).startsWith("posthog sink initialised"));
  if (!started) problems.push('no "posthog sink initialised" line in the log: the build has no PostHog project key');
  for (const entry of entries) {
    const text = message(entry);
    if (text.includes("set neither in env nor at build time") || text.includes("posthog sink disabled")) {
      problems.push(`the log says "${clip(text, 200)}"`);
    }
  }
  return problems;
}

/**
 * The path the dry-run build's updater asks its endpoint for:
 * /update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}},
 * with the plugin's names for the platform and arch.
 *
 * @param {{ platform: string, arch: string, version: string, bundleType: string }} query
 *   platform and arch as Node names them (process.platform, process.arch)
 */
export function updateRequestPath({ platform, arch, version, bundleType }) {
  if (!UPDATER_OS.has(platform) || !UPDATER_ARCH.has(arch)) throw new Error(`the updater doesn't run on ${platform}-${arch}`);
  return `/update/${UPDATER_OS.get(platform)}/${UPDATER_ARCH.get(arch)}/${version}?bundle_type=${bundleType}`;
}

/** Splits byte chunks into lines, each source on its own, keeping the newest `limit` lines. */
class LineCollector {
  constructor(limit = 50_000) {
    this.lines = [];
    this.partials = new Map();
    this.limit = limit;
  }

  push(source, chunk) {
    const bytes = Buffer.concat([this.partials.get(source) ?? Buffer.alloc(0), chunk]);
    // A newline byte is never part of a longer UTF-8 character, so cutting
    // there keeps each character whole.
    const end = bytes.lastIndexOf(0x0a);
    if (end === -1 && bytes.length < 1 << 20) {
      this.partials.set(source, bytes);
      return;
    }
    const cut = end === -1 ? bytes.length : end + 1;
    this.partials.set(source, bytes.subarray(cut));
    this.add(bytes.subarray(0, cut).toString("utf8").split("\n"));
  }

  add(lines) {
    for (const line of lines) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (text !== "") this.lines.push(text);
    }
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
  }

  /** Every line, the unfinished last one of each source included. */
  flush() {
    for (const bytes of this.partials.values()) this.add([bytes.toString("utf8")]);
    this.partials.clear();
    return this.lines;
  }
}

/**
 * fs.stat, following symlinks, with null for a path that isn't there or
 * can't be looked at (too long, not ours to read): the app, run by the same
 * user, couldn't use it either, and a check or a request handler must not
 * throw.
 */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** The lines the app adds to the log files in a folder: those already there when it is created are skipped. */
class LogReader {
  constructor(dir) {
    this.dir = dir;
    this.offsets = new Map(this.files().map(({ name, size }) => [name, size]));
    this.collector = new LineCollector();
  }

  files() {
    let names;
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.startsWith(LOG_PREFIX))
      .sort()
      .map((name) => ({ name, stat: statOrNull(join(this.dir, name)) }))
      .filter(({ stat }) => stat?.isFile() === true)
      .map(({ name, stat }) => ({ name, size: stat.size }));
  }

  /** The complete lines written so far. */
  poll() {
    for (const { name, size } of this.files()) {
      let offset = this.offsets.get(name) ?? 0;
      if (size < offset) offset = 0; // The file was cut short or replaced.
      if (size === offset) continue;
      let fd;
      try {
        fd = openSync(join(this.dir, name), "r");
      } catch {
        continue; // It went away, or was replaced, since the listing.
      }
      try {
        const chunk = Buffer.alloc(size - offset);
        let read = 0;
        while (read < chunk.length) {
          const n = readSync(fd, chunk, read, chunk.length - read, offset + read);
          if (n === 0) break;
          read += n;
        }
        this.offsets.set(name, offset + read);
        this.collector.push(name, chunk.subarray(0, read));
      } catch {
        // Read again at the next poll.
      } finally {
        closeSync(fd);
      }
    }
    return this.collector.lines;
  }

  /** Every line written so far, an unfinished last line included. */
  all() {
    this.poll();
    return this.collector.flush();
  }
}

// ── The update server and the release server ────────────────────────────────

/** A request URL's path, or null when it can't be read. */
function pathOf(url) {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** A URL path segment as a release asset's name, or null when it isn't one. */
function assetNameOf(segment) {
  let name;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return ASSET_NAME.test(name) ? name : null;
}

/** The release asset a download URL names (its last path segment), or null. */
function assetOfUrl(url) {
  try {
    return assetNameOf(new URL(url).pathname.split("/").pop());
  } catch {
    return null;
  }
}

/** The regular file `name` in `dir`: { path, size }, or null. */
function releaseFile(dir, name) {
  if (name === null) return null;
  const path = join(dir, name);
  const stat = statOrNull(path);
  return stat?.isFile() === true ? { path, size: stat.size } : null;
}

/**
 * The rehearsal's signature of `asset`, <dir>/<asset>.sig, trimmed: { text },
 * or { error } saying why there is none.
 */
function rehearsalSignature(dir, asset) {
  const file = releaseFile(dir, `${asset}.sig`);
  if (file === null) return { error: `${dir} has no ${asset}.sig, the rehearsal's signature of ${asset}` };
  const text = readFileSync(file.path, "utf8").trim();
  return text === "" ? { error: `${file.path}, the rehearsal's signature of ${asset}, is empty` } : { text };
}

/** A listening server's base URL. */
function baseUrl(server) {
  const { address, port, family } = server.address();
  const host = family === "IPv6" || family === 6 ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/** A request handler that answers 500 to whatever it throws, instead of ending the smoke. */
function guarded(handler, onError = () => {}) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      onError(`${req.url}: ${err.message}`);
      if (res.headersSent) res.destroy();
      else sendText(res, 500, `${err.message}\n`);
    }
  };
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Send a file, counting into `record` ({ bytes, complete, finished }) when
 * given: bytes, those handed to the response; complete, whether all of them
 * were, by the time the response finished or closed; finished, whether it
 * finished. A client that hangs up as soon as it has every byte, as the
 * Windows updater does, can close the response before the file's end is
 * read, so it never finishes although the download is whole.
 */
function sendFile(req, res, { path, size }, record) {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  if (record) {
    stream.on("data", (chunk) => {
      if (!res.destroyed) record.bytes += chunk.length;
    });
    const settle = () => {
      record.complete = record.bytes === size;
    };
    res.on("finish", () => {
      record.finished = true;
      settle();
    });
    res.on("close", settle);
  }
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/**
 * An update server for the rehearsal, not yet listening: it answers the
 * dry-run build's endpoint, GET /update/{target}/{arch}/{version}?bundle_type=…,
 * with release-assets.mjs's resolveUpdate over the release folder's
 * latest.json, offering `offerVersion` instead of the release's version, with
 * the artifact's URL moved to its own /artifacts/<asset>, which serves the
 * file from the folder, and its signature taken from `signaturesDir`: the
 * rehearsal's, <asset>.sig, made for `offerVersion`. The release's own
 * signature names the release's version, which the updater refuses for an
 * update offered as another. It answers 204 when there is no update, 400 to a
 * malformed request, and 500 when the rehearsal has no signature of the
 * artifact, never a 2xx that isn't the update.
 *
 * The server records each request's path and query in `requests`, each
 * artifact download in `downloads` ({ asset, size, bytes, complete, finished },
 * as sendFile counts them), and each refused request in `errors`. `manifest`
 * is the release's latest.json.
 *
 * @param {{ releaseDir: string, signaturesDir: string, offerVersion?: string }} options
 * @throws when latest.json can't be read, `offerVersion` isn't newer than the
 *   release, or `signaturesDir` isn't given
 */
export function createUpdateServer({ releaseDir, signaturesDir, offerVersion = OFFER_VERSION }) {
  if (typeof signaturesDir !== "string" || signaturesDir === "") {
    throw new Error("signaturesDir is required: the updater takes only a signature made for the version it is offered");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(releaseDir, MANIFEST), "utf8"));
  } catch (err) {
    throw new Error(`can't read ${MANIFEST} in ${releaseDir}: ${err.code ?? err.message}`);
  }
  if (manifest === null || typeof manifest !== "object" || typeof manifest.platforms !== "object" || manifest.platforms === null) {
    throw new Error(`${MANIFEST} in ${releaseDir} is not an updater manifest`);
  }
  if (compareVersions(offerVersion, manifest.version) <= 0) {
    throw new Error(`the offered version ${offerVersion} is not newer than the release's ${manifest.version}`);
  }
  const offered = { ...manifest, version: offerVersion };
  const requests = [];
  const downloads = [];
  const errors = [];

  const handler = (req, res) => {
    requests.push(req.url);
    const segments = (pathOf(req.url) ?? "").split("/");
    if (req.method === "GET" && segments.length === 5 && segments[1] === "update") {
      let update;
      try {
        const [target, arch, currentVersion] = segments.slice(2).map(decodeURIComponent);
        const bundleType = new URL(req.url, "http://localhost").searchParams.get("bundle_type") ?? "unknown";
        update = resolveUpdate(offered, { target, arch, bundleType, currentVersion });
      } catch (err) {
        errors.push(`${req.url}: ${err.message}`);
        sendText(res, 400, `${err.message}\n`);
        return;
      }
      if (update === null) {
        res.writeHead(204).end();
        return;
      }
      const asset = assetOfUrl(update.url);
      if (asset === null) {
        errors.push(`${req.url}: the ${MANIFEST} entry's url ${JSON.stringify(update.url)} doesn't name a release asset`);
        sendText(res, 500, "the release's entry for this platform has no usable url\n");
        return;
      }
      const signature = rehearsalSignature(signaturesDir, asset);
      if (signature.error !== undefined) {
        errors.push(`${req.url}: ${signature.error}`);
        sendText(res, 500, "the rehearsal has no signature of this platform's update\n");
        return;
      }
      if (releaseFile(releaseDir, asset) === null) errors.push(`${req.url}: offered ${asset}, which isn't in ${releaseDir}`);
      const body = JSON.stringify({ ...update, url: `${baseUrl(server)}/artifacts/${encodeURIComponent(asset)}`, signature: signature.text });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && segments.length === 3 && segments[1] === "artifacts") {
      const asset = assetNameOf(segments[2]);
      const file = releaseFile(releaseDir, asset);
      if (file !== null) {
        const record = { asset, size: file.size, bytes: 0, complete: false, finished: false };
        if (req.method === "GET") downloads.push(record);
        sendFile(req, res, file, record);
        return;
      }
    }
    sendText(res, 404, "not found\n");
  };
  const server = createServer(guarded(handler, (error) => errors.push(error)));
  return Object.assign(server, { requests, downloads, errors, manifest });
}

/**
 * A server for a release folder, not yet listening, laid out the way GitHub
 * serves a release's assets under https://github.com/<owner>/<repo>/releases:
 * /download/v<version>/<file> sends the file, and /latest/download/<file>
 * redirects there with a 302, as GitHub does, so a client that follows no
 * redirect fails here as it would there. HEAD answers with the size. Anything
 * else is a 404. Each request's path and query is recorded in `requests`.
 *
 * @param {{ dir: string, version: string }} options
 * @throws on a version that isn't MAJOR.MINOR.PATCH, or a folder that isn't there
 */
export function createReleaseServer({ dir, version }) {
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}: expected MAJOR.MINOR.PATCH`);
  }
  if (statOrNull(dir)?.isDirectory() !== true) throw new Error(`${dir} is not a folder`);
  const requests = [];
  const server = createServer(guarded((req, res) => {
    requests.push(req.url);
    const path = pathOf(req.url) ?? "";
    const latest = /^\/latest\/download\/([^/]+)$/.exec(path);
    const tagged = /^\/download\/v([^/]+)\/([^/]+)$/.exec(path);
    const name = latest ? assetNameOf(latest[1]) : tagged && tagged[1] === version ? assetNameOf(tagged[2]) : null;
    const file = releaseFile(dir, name);
    if (file === null) {
      sendText(res, 404, "not found\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (latest) {
      res.writeHead(302, { location: `${baseUrl(server)}/download/v${version}/${encodeURIComponent(name)}`, "content-length": 0 }).end();
      return;
    }
    sendFile(req, res, file);
  }));
  return Object.assign(server, { requests });
}

/** Start `server` on 127.0.0.1:port. */
function listen(server, port) {
  return new Promise((done, fail) => {
    const onError = (err) => {
      server.off("listening", onListening);
      fail(err);
    };
    const onListening = () => {
      server.off("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** Stop `server`, dropping its connections. */
function closeServer(server) {
  return new Promise((done) => {
    if (!server.listening) {
      done();
      return;
    }
    server.close(() => done());
    server.closeAllConnections();
  });
}

// ── The app's processes ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Wait until `condition()` holds, for at most `ms`; whether it held. */
async function waitUntil(condition, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(POLL_MS, Math.max(1, end - Date.now())));
  }
}

/**
 * The fields of a /proc/<pid>/stat line that the stop reads: comm (field 2),
 * state (3), ppid (4), pgrp (5) and starttime (22), when the process started,
 * in clock ticks after boot. comm sits in parentheses and may hold spaces
 * and parentheses itself, so the other fields are counted from the last ")".
 * null for a line that isn't a stat line.
 *
 * @param {string} text
 * @returns {{ comm: string, state: string, ppid: number, pgrp: number, start: string } | null}
 */
export function parseProcStat(text) {
  if (typeof text !== "string") return null;
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close < open) return null;
  // fields[0] is field 3, state, so starttime, field 22, is fields[19].
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20) return null;
  return { comm: text.slice(open + 1, close), state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), start: fields[19] };
}

/** Linux: every process, from /proc: pid → { comm, state, ppid, pgrp, start }. */
function linuxProcesses() {
  const table = new Map();
  let names;
  try {
    names = readdirSync("/proc");
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // It has exited.
    }
    const entry = parseProcStat(stat);
    if (entry !== null) table.set(Number(name), entry);
  }
  return table;
}

/**
 * Linux: the live processes of the app started as `pid`: its process group,
 * and every descendant of `pid`, which may have left the group. Zombies count
 * as gone.
 */
function linuxTree(pid, table = linuxProcesses()) {
  const children = new Map();
  for (const [child, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), child]);
  const tree = new Set([...table].filter(([, p]) => p.pgrp === pid).map(([member]) => member));
  const seen = new Set();
  const queue = [pid];
  while (queue.length > 0) {
    const next = queue.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (table.has(next)) tree.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return [...tree].filter((member) => table.get(member)?.state !== "Z").sort((a, b) => a - b);
}

/**
 * Of the processes listed before a stop, the ones to signal now: each still
 * has the start time it was listed with, and isn't a zombie. A listed
 * process that exited meanwhile may have left its pid to another process,
 * which has another start time and is left alone.
 *
 * @param {{ pid: number, start: string }[]} listed
 * @param {Map<number, { state: string, start: string }>} table  linuxProcesses(), read now
 * @returns {number[]}
 */
export function stillListed(listed, table) {
  return listed
    .filter(({ pid, start }) => {
      const now = table.get(pid);
      return now !== undefined && now.start === start && now.state !== "Z";
    })
    .map(({ pid }) => pid);
}

/**
 * Let go of the app once the stop is done: close its output pipes, which a
 * process that left the tree may still hold, and when its root process is
 * still running, as after a stop that failed, unref the child, which would
 * otherwise keep the smoke from exiting. Whether it unref'd the child.
 *
 * @param {{ exit: object | null, child: import("node:child_process").ChildProcess }} app
 * @returns {boolean}
 */
export function releaseApp(app) {
  app.child.stdout.destroy();
  app.child.stderr.destroy();
  if (app.exit !== null) return false;
  app.child.unref();
  return true;
}

/** Unix: whether process group `pgid` has a process left. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function signal(target, name) {
  try {
    process.kill(target, name);
  } catch {
    // Already gone.
  }
}

const describeExit = ({ code, signal: name }) => (code !== null ? `code ${code}` : `signal ${name}`);

/** Whether any of the app's processes is alive. */
function appAlive(app) {
  if (process.platform === "win32") return app.exit === null;
  if (process.platform === "linux") return app.exit === null || linuxTree(app.pid).length > 0;
  return app.exit === null || groupAlive(app.pid);
}

/** Linux: the working directories of the app's processes. */
function workingFolders(app) {
  const folders = [];
  for (const pid of linuxTree(app.pid)) {
    try {
      const dir = readlinkSync(`/proc/${pid}/cwd`);
      if (!folders.includes(dir)) folders.push(dir);
    } catch {
      // It has exited, or isn't ours to read.
    }
  }
  return folders;
}

/** Start the app, on Unix in a process group of its own. Resolves once it is running. */
async function launch({ app, appArgs, cwd, env }) {
  const child = spawn(app, appArgs, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const launched = { child, pid: child.pid, exit: null, output: new LineCollector() };
  child.stdout.on("data", (chunk) => launched.output.push("stdout", chunk));
  child.stderr.on("data", (chunk) => launched.output.push("stderr", chunk));
  child.on("exit", (code, name) => {
    launched.exit = { code, signal: name };
  });
  await new Promise((done, fail) => {
    child.once("spawn", done);
    child.once("error", fail);
  });
  launched.pid = child.pid;
  return launched;
}

/** Kill the app's processes at once; for an exit the smoke didn't plan. */
function killNow(app) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  const tree = process.platform === "linux" ? linuxTree(app.pid) : [];
  signal(-app.pid, "SIGKILL");
  for (const pid of tree) signal(pid, "SIGKILL");
}

/** Stop the app's processes, and only those; the stop check. */
async function stopApp(app) {
  const name = "stop";
  if (process.platform === "win32") {
    if (app.exit !== null) return check(name, "PASS", `the app had already exited (${describeExit(app.exit)})`);
    const kill = spawnSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { encoding: "utf8", windowsHide: true });
    if (await waitUntil(() => app.exit !== null, 2 * STOP_GRACE_MS)) {
      return check(name, "PASS", `stopped the app's process tree: taskkill /T /F /PID ${app.pid}`);
    }
    return check(name, "FAIL", `taskkill /T /F /PID ${app.pid} didn't stop it: ${clip(`${kill.stdout ?? ""}${kill.stderr ?? ""}`)}`);
  }
  // A descendant that left the group would be missed once its parent is gone,
  // so list them first, each with its start time.
  const listing = process.platform === "linux" ? linuxProcesses() : new Map();
  const tree = process.platform === "linux" ? linuxTree(app.pid, listing).map((pid) => ({ pid, start: listing.get(pid).start })) : [];
  const alive = () => {
    if (app.exit === null) return true;
    if (process.platform !== "linux") return groupAlive(app.pid);
    const now = linuxProcesses();
    return linuxTree(app.pid, now).length > 0 || stillListed(tree, now).length > 0;
  };
  if (!alive()) return check(name, "PASS", `the app had already exited (${describeExit(app.exit)})`);
  const count = tree.length > 0 ? `, ${tree.length} process${tree.length === 1 ? "" : "es"}` : "";
  const send = (sig) => {
    signal(-app.pid, sig);
    // Only the processes listed, as they were: a pid freed and reused since
    // the listing belongs to another process now.
    for (const pid of stillListed(tree, linuxProcesses())) signal(pid, sig);
  };
  send("SIGTERM");
  if (await waitUntil(() => !alive(), STOP_GRACE_MS)) {
    return check(name, "PASS", `stopped process group ${app.pid}${count} with SIGTERM`);
  }
  send("SIGKILL");
  if (await waitUntil(() => !alive(), STOP_GRACE_MS)) {
    return check(name, "PASS", `stopped process group ${app.pid}${count}: SIGTERM, then SIGKILL after ${STOP_GRACE_MS / 1000} s`);
  }
  const left = process.platform === "linux" ? linuxTree(app.pid).join(", ") : `group ${app.pid}`;
  return check(name, "FAIL", `still running after SIGKILL: ${left}`);
}

// ── The checks ──────────────────────────────────────────────────────────────

/** A row of the table: detail is a line, or a list of lines. */
const check = (name, status, detail) => ({ name, status, detail });

/** GET http://127.0.0.1:port<path>, addressed to `host`: { status, headers, body } or { error }. */
function probe(port, path, { host = `127.0.0.1:${port}` } = {}) {
  return new Promise((done) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", agent: false, timeout: 5000, headers: { host, connection: "close" } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (size < 1 << 20) chunks.push(chunk);
          size += chunk.length;
        });
        res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (error) => done({ error }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error) => done({ error }));
    req.end();
  });
}

const errorText = (error) => error.code ?? error.message;

/** Whether 127.0.0.1:port can be bound: null when it can, else why not. */
function portProblem(port) {
  return new Promise((done) => {
    const server = createNetServer();
    server.once("error", (err) => done(err.code === "EADDRINUSE" ? "in use" : `not usable (${err.code ?? err.message})`));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => done(null)));
  });
}

async function waitForHealth({ port, timeoutS, app }) {
  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  let last = "no answer";
  for (;;) {
    const answer = await probe(port, "/healthz");
    if (answer.error === undefined) {
      const body = answer.status === 200 ? parseJsonLine(answer.body) : null;
      if (body?.status === "ok") {
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const version = typeof body.version === "string" ? body.version : null;
        return { ok: true, version, check: check("healthz", "PASS", `200 ${clip(answer.body, 200)} after ${seconds} s`) };
      }
      last = `${answer.status} ${clip(answer.body, 200)}`;
    } else {
      last = errorText(answer.error);
    }
    if (!appAlive(app)) {
      const how = app.exit === null ? "its processes are gone" : describeExit(app.exit);
      return { ok: false, check: check("healthz", "FAIL", `the app exited (${how}) before /healthz answered; last: ${last}`) };
    }
    if (Date.now() >= deadline) {
      return { ok: false, check: check("healthz", "FAIL", `no "status":"ok" from /healthz within ${timeoutS} s; last: ${last}`) };
    }
    await sleep(POLL_MS);
  }
}

async function uiCheck(port, cspOrigin) {
  const answer = await probe(port, "/");
  if (answer.error !== undefined) return check("ui", "FAIL", `GET / failed: ${errorText(answer.error)}`);
  const problems = uiProblems({ status: answer.status, headers: answer.headers, cspOrigin });
  if (problems.length > 0) return check("ui", "FAIL", problems);
  const origin = cspOrigin ? `, and its connect-src allows ${cspOrigin}` : "";
  return check("ui", "PASS", `200 ${answer.headers["content-type"]}; content-security-policy has default-src 'self'${origin}`);
}

/** A request the access guard must refuse with 403. */
async function refusalCheck(name, port, path, host, what) {
  const answer = await probe(port, path, { host });
  if (answer.error !== undefined) return check(name, "FAIL", `${what}: ${errorText(answer.error)}`);
  return answer.status === 403 ? check(name, "PASS", `${what}: 403`) : check(name, "FAIL", `${what}: ${answer.status}, not 403`);
}

function dbCheck({ home, cwd, app }) {
  const problems = [];
  const fleetifyDir = join(home, ".fleetify");
  const homeDb = join(fleetifyDir, "fleet.db");
  if (statOrNull(homeDb)?.isFile() !== true) problems.push(`${homeDb} doesn't exist`);
  const folders = [cwd];
  if (process.platform === "linux") {
    for (const dir of workingFolders(app)) if (!folders.includes(dir)) folders.push(dir);
  }
  for (const dir of folders) {
    if (dir === fleetifyDir) continue;
    for (const name of DB_NAMES) {
      if (statOrNull(join(dir, name)) !== null) problems.push(`${name} in the working directory ${dir}`);
    }
  }
  if (problems.length > 0) return check("db", "FAIL", problems);
  const where =
    process.platform === "linux"
      ? `in the launch folder or the app's working directories (${folders.join(", ")})`
      : `in the launch folder ${cwd} (the app's own working directory is read only on Linux)`;
  return check("db", "PASS", `${homeDb} exists; no fleet.db ${where}`);
}

function legalCheck(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    return check("legal", "FAIL", `can't read ${dir}: ${errorText(err)}`);
  }
  const problems = [];
  for (const file of LEGAL_FILES) {
    // Listed by exact name, as a case-insensitive filesystem would find "License" too.
    if (!names.includes(file)) {
      problems.push(`no ${file} in ${dir}`);
      continue;
    }
    const stat = statOrNull(join(dir, file));
    if (stat?.isFile() !== true) problems.push(`${file} in ${dir} is not a file`);
    else if (stat.size === 0) problems.push(`${file} in ${dir} is empty`);
  }
  return problems.length > 0 ? check("legal", "FAIL", problems) : check("legal", "PASS", `${LEGAL_FILES.join(", ")} in ${dir}`);
}

/** The update the rehearsal expects the app to ask for and download. Throws a SetupError when the release has none. */
function expectedUpdate(manifest, bundleType) {
  const { platform, arch } = process;
  if (!UPDATER_OS.has(platform) || !UPDATER_ARCH.has(arch)) throw new SetupError(`the updater doesn't run on ${platform}-${arch}`);
  const target = UPDATER_OS.get(platform);
  const updaterArch = UPDATER_ARCH.get(arch);
  let update;
  try {
    update = resolveUpdate({ ...manifest, version: OFFER_VERSION }, { target, arch: updaterArch, bundleType, currentVersion: manifest.version });
  } catch (err) {
    throw new SetupError(`the release's ${MANIFEST}: ${err.message}`);
  }
  if (update === null) throw new SetupError(`the release's ${MANIFEST} has no update for ${target}-${updaterArch}-${bundleType}`);
  const asset = assetOfUrl(update.url);
  if (asset === null) throw new SetupError(`the release's ${MANIFEST} offers ${JSON.stringify(update.url)}, which names no release asset`);
  return { path: updateRequestPath({ platform, arch, version: manifest.version, bundleType }), asset };
}

async function rehearsalCheck({ updates, expected, logs, app, updatePort, deadline, appVersion }) {
  let ready = null;
  let failure = null;
  for (;;) {
    const lines = logs.poll();
    ready = findUpdaterReady(lines);
    failure = updaterFailure(lines);
    const downloaded = updates.downloads.some((d) => d.complete);
    if ((ready !== null && downloaded) || failure !== null || !appAlive(app) || Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  const problems = [];
  if (appVersion !== updates.manifest.version) {
    problems.push(`/healthz reports version ${appVersion ?? "(none)"}, but the release's ${MANIFEST} is ${updates.manifest.version}`);
  }
  const asked = updates.requests.filter((path) => path.startsWith("/update/"));
  if (asked.length === 0) problems.push(`the app never asked http://127.0.0.1:${updatePort} for an update`);
  for (const path of asked) {
    if (path !== expected.path) problems.push(`the app asked for ${path}, not ${expected.path}`);
  }
  if (failure !== null) problems.push(`the updater logged: ${clip(failure)}`);
  const full = updates.downloads.find((d) => d.complete && d.asset === expected.asset);
  if (full === undefined) {
    const seen = updates.downloads.map((d) => `${d.asset} ${d.bytes}/${d.size} bytes${d.finished ? "" : ", unfinished"}`).join(", ");
    problems.push(`${expected.asset} was not downloaded in full${seen ? ` (downloads: ${seen})` : ""}`);
  }
  if (ready === null) problems.push(`no "update ready" line in the log within ${REHEARSAL_TIMEOUT_S} s`);
  else if (ready !== OFFER_VERSION) problems.push(`update ready ${ready}, not ${OFFER_VERSION}`);
  for (const error of updates.errors) problems.push(`update server: ${error}`);
  if (problems.length > 0) return check("rehearsal", "FAIL", problems);
  return check("rehearsal", "PASS", `GET ${expected.path} offered ${expected.asset}; ${full.size} bytes downloaded in full; update ready ${ready}`);
}

function logCheck({ logDir, fileLines, outputLines }) {
  const json = fileLines.filter((line) => parseJsonLine(line) !== null).length;
  const problems = logProblems([...fileLines, ...outputLines]);
  if (json === 0) problems.unshift(`no JSON log lines from this run in ${logDir}`);
  if (problems.length > 0) return check("log", "FAIL", problems);
  return check("log", "PASS", `${json} lines from this run in ${logDir}; no panic or content security policy violation`);
}

function posthogCheck(fileLines) {
  const problems = posthogSinkProblems(fileLines);
  if (problems.length > 0) return check("posthog sink", "FAIL", problems);
  const entry = fileLines.map(parseJsonLine).find((e) => e?.target === "fleetify.posthog" && String(e.fields?.message).startsWith("posthog sink initialised"));
  const host = entry?.fields?.host ? ` (host ${entry.fields.host})` : "";
  return check("posthog sink", "PASS", `the log says "posthog sink initialised"${host}: the build has the project key`);
}

// ── run ─────────────────────────────────────────────────────────────────────

/** The app while it may be running, for the exit hook to stop if the smoke ends early. */
let running = null;

/** Quote a word for a command line shown to a person. */
const shellWord = (word) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : JSON.stringify(word));

function table(checks) {
  const width = Math.max(...checks.map((c) => c.name.length));
  const rows = [];
  for (const { name, status, detail } of checks) {
    const [first = "", ...rest] = Array.isArray(detail) ? detail : [detail];
    rows.push(`  ${status}  ${name.padEnd(width)}  ${first}`);
    for (const line of rest) rows.push(`  ${" ".repeat(status.length)}  ${" ".repeat(width)}  ${line}`);
  }
  return `${rows.join("\n")}\n`;
}

const tail = (lines, n = 40) => lines.slice(-n).map((line) => `    ${clip(line)}\n`).join("");

/** Setup that can fail before the app starts: a SetupError for each problem. */
async function prepare(options) {
  const { app, home, cwd, port, rehearse, rehearsalSignatures, bundleType, updatePort } = options;
  if (statOrNull(app)?.isFile() !== true) throw new SetupError(`--app ${app} is not a file`);
  const homeStat = statOrNull(home);
  if (homeStat !== null && !homeStat.isDirectory()) throw new SetupError(`--home ${home} is not a folder`);
  const homeDb = join(home, ".fleetify", "fleet.db");
  if (statOrNull(homeDb) !== null) throw new SetupError(`${homeDb} already exists: give the smoke a fresh --home`);
  if (statOrNull(cwd)?.isDirectory() !== true) throw new SetupError(`--cwd ${cwd} is not a folder`);
  for (const name of DB_NAMES) {
    const path = join(cwd, name);
    if (statOrNull(path) !== null) throw new SetupError(`${path} is there before the app starts, so the smoke can't tell whether the app writes it`);
  }
  const problem = await portProblem(port);
  if (problem !== null) throw new SetupError(`port ${port} is ${problem} on 127.0.0.1: another app or an earlier run holds it`);

  mkdirSync(home, { recursive: true });
  const env = smokeEnv(process.env, { home, port, platform: process.platform });
  let logDir = options.logDir;
  if (logDir === null) {
    try {
      logDir = logDirFor(process.platform, { home, env });
    } catch (err) {
      throw new SetupError(err.message);
    }
  }

  let updates = null;
  let expected = null;
  if (rehearse !== null) {
    if (statOrNull(rehearsalSignatures)?.isDirectory() !== true) throw new SetupError(`--rehearsal-signatures ${rehearsalSignatures} is not a folder`);
    try {
      updates = createUpdateServer({ releaseDir: rehearse, signaturesDir: rehearsalSignatures });
    } catch (err) {
      throw new SetupError(`--rehearse: ${err.message}`);
    }
    expected = expectedUpdate(updates.manifest, bundleType);
    if (releaseFile(rehearse, expected.asset) === null) {
      throw new SetupError(`--rehearse: ${rehearse} has no ${expected.asset}, which its ${MANIFEST} offers to this platform`);
    }
    // The signature of the update offered to this platform, the one the app will ask for.
    const signature = rehearsalSignature(rehearsalSignatures, expected.asset);
    if (signature.error !== undefined) throw new SetupError(`--rehearsal-signatures: ${signature.error}`);
    try {
      await listen(updates, updatePort);
    } catch (err) {
      throw new SetupError(`can't start the update server on 127.0.0.1:${updatePort}: ${errorText(err)}`);
    }
  }
  return { env, logDir, updates, expected };
}

async function runSmoke(options, write) {
  const { app: appPath, appArgs, home, port, cwd, legalDir, cspOrigin, expectPosthogSink, rehearse, rehearsalSignatures, updatePort, timeoutS, settleS } = options;
  const { env, logDir, updates, expected } = await prepare(options);
  const logs = new LogReader(logDir);

  write(`launch-smoke: ${[appPath, ...appArgs].map(shellWord).join(" ")}\n`);
  write(`  working directory ${cwd}; home ${home}; port ${port}\n`);
  write(`  log folder ${logDir}\n`);
  if (updates !== null) write(`  update server http://127.0.0.1:${updatePort}, offering ${OFFER_VERSION} from ${rehearse}, signed for it in ${rehearsalSignatures}\n`);
  write("\n");

  let app;
  try {
    app = await launch({ app: appPath, appArgs, cwd, env });
  } catch (err) {
    if (updates !== null) await closeServer(updates);
    throw new SetupError(`can't start ${appPath}: ${errorText(err)}`);
  }
  running = app;

  const checks = [];
  let fileLines = [];
  try {
    const health = await waitForHealth({ port, timeoutS, app });
    checks.push(health.check);
    const healthyAt = Date.now();
    if (health.ok) {
      checks.push(await uiCheck(port, cspOrigin));
      checks.push(await refusalCheck("access token", port, "/api/groups", undefined, "GET /api/groups without the token"));
      checks.push(await refusalCheck("access host", port, "/healthz", "evil.example", "GET /healthz with Host: evil.example"));
    } else {
      for (const name of ["ui", "access token", "access host"]) checks.push(check(name, "SKIP", "skipped: /healthz never answered"));
    }
    checks.push(dbCheck({ home, cwd, app }));
    if (legalDir !== null) checks.push(legalCheck(legalDir));
    if (updates !== null) {
      checks.push(
        health.ok
          ? await rehearsalCheck({ updates, expected, logs, app, updatePort, deadline: healthyAt + REHEARSAL_TIMEOUT_S * 1000, appVersion: health.version })
          : check("rehearsal", "SKIP", "skipped: /healthz never answered"),
      );
    }
    if (health.ok) {
      const settled = healthyAt + settleS * 1000;
      await waitUntil(() => Date.now() >= settled || !appAlive(app), Math.max(0, settled - Date.now()) + POLL_MS);
    }
    fileLines = logs.all();
    if (expectPosthogSink) checks.push(posthogCheck(fileLines));
    checks.push(logCheck({ logDir, fileLines, outputLines: [...app.output.lines] }));
    if (appAlive(app)) checks.push(check("running", "PASS", "the app was still running at the end of the checks"));
    else checks.push(check("running", "FAIL", `the app exited (${app.exit === null ? "its processes are gone" : describeExit(app.exit)}) before the smoke stopped it`));
  } finally {
    checks.push(await stopApp(app));
    running = null;
    releaseApp(app);
    if (updates !== null) await closeServer(updates);
  }

  write(table(checks));
  const failed = checks.filter((c) => c.status !== "PASS").length;
  if (failed === 0) {
    write(`\nlaunch-smoke: all ${checks.length} checks passed\n`);
    return 0;
  }
  const output = app.output.flush();
  write(`\napp output, last ${Math.min(output.length, 40)} of ${output.length} lines:\n${tail(output)}`);
  write(`app log, last ${Math.min(fileLines.length, 40)} of ${fileLines.length} lines from this run:\n${tail(fileLines)}`);
  write(`\nlaunch-smoke: ${failed} of ${checks.length} checks failed\n`);
  return 1;
}

// ── serve-release ───────────────────────────────────────────────────────────

async function serveRelease({ dir, version, port }, write) {
  let server;
  try {
    server = createReleaseServer({ dir, version });
  } catch (err) {
    throw new SetupError(err.message);
  }
  server.on("request", (req, res) => res.on("finish", () => write(`${req.method} ${req.url} ${res.statusCode}\n`)));
  try {
    await listen(server, port);
  } catch (err) {
    throw new SetupError(`can't serve on 127.0.0.1:${port}: ${errorText(err)}`);
  }
  const base = baseUrl(server);
  write(`launch-smoke: serving ${dir} as release v${version} at ${base}/latest/download/<file> and ${base}/download/v${version}/<file>\n`);
  const name = await new Promise((done) => {
    for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => done(sig));
  });
  await closeServer(server);
  write(`launch-smoke: ${name}: stopped\n`);
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const out = (text) => process.stdout.write(text);
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`launch-smoke: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.command === "help") {
    out(`${USAGE}\n`);
    return 0;
  }
  try {
    if (options.command === "serve-release") return await serveRelease(options, out);
    // Never leave the app running: a signal or a crash of the smoke stops it too.
    process.on("exit", () => {
      if (running !== null) killNow(running);
    });
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.once(sig, () => {
        process.stderr.write(`launch-smoke: ${sig}: stopping the app\n`);
        process.exit(1);
      });
    }
    return await runSmoke(options, out);
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    process.stderr.write(`launch-smoke: ${err.message}\n`);
    return 2;
  }
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    // exitCode instead of process.exit(), so buffered output is written first.
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`launch-smoke: ${err.stack ?? err}\n`);
      process.exitCode = 2;
    },
  );
}
