/**
 * Tests for launch-smoke.mjs, which starts a release bundle's app from the
 * filesystem root with a fresh home and checks that it works, rehearses an
 * update against a local update server, and serves a release folder the way
 * GitHub serves release assets.
 *
 *   node --test scripts/release/launch-smoke.test.mjs
 *
 * The app under test is fixtures/fake-app.mjs, run by this Node. Each run
 * gets ports the system hands out, never the smoke's defaults, so the runs
 * can go in parallel with each other and with a real smoke.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReleaseServer,
  createUpdateServer,
  findUpdaterReady,
  logDirFor,
  logProblems,
  parseArgs,
  parseProcStat,
  posthogSinkProblems,
  releaseApp,
  smokeEnv,
  stillListed,
  uiProblems,
  updateRequestPath,
} from "./launch-smoke.mjs";
import { dryRunConfig } from "./dry-run-config.mjs";
import { downloadBase, latestJson, updaterArtifacts } from "./release-assets.mjs";

const SCRIPT = fileURLToPath(new URL("./launch-smoke.mjs", import.meta.url));
const FAKE_APP = fileURLToPath(new URL("./fixtures/fake-app.mjs", import.meta.url));
const ROOT_DIR = parse(process.cwd()).root;

/**
 * Every fake app: its pid → its start time on Linux, else null. A run that
 * went wrong may leave one behind; the last hook kills it, and only it: by
 * then its pid may belong to another process, with another start time.
 */
const FAKE_APPS = new Map();
after(() => {
  for (const [pid, start] of FAKE_APPS) if (alive(pid) && (start === null || startOf(pid) === start)) process.kill(pid, "SIGKILL");
});

/** Linux: a process's start time, from /proc/<pid>/stat; null when it is gone. */
function startOf(pid) {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.start ?? null;
  } catch {
    return null;
  }
}

/** The fake app's pid file: its pid, and on Linux its start time, which it writes itself while it runs. */
function readPidFile(path) {
  const [pid, start] = readFileSync(path, "utf8").trim().split(" ");
  return { pid: Number(pid), start: start ?? null };
}

const ROOT = mkdtempSync(join(tmpdir(), "launch-smoke-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
/** A path under ROOT that doesn't exist yet. */
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);
/** A new empty folder under ROOT. */
function folder(name) {
  const dir = fresh(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The updater's names for this machine, written out independently of launch-smoke.mjs. */
const OS = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const ARCH = { x64: "x86_64", arm64: "aarch64" }[process.arch];

// ── A release folder for the update server: latest.json and the updater artifacts ──

const V = "0.2.0";
const PUB_DATE = "2026-11-21T10:00:00.000Z";
const RELEASE = folder("release");
/** Each updater artifact's bytes: distinct, and larger than one read chunk. */
const ARTIFACT_BYTES = new Map(updaterArtifacts(V).map(({ asset }, i) => [asset, Buffer.alloc(70_000 + i, i + 1)]));
for (const [asset, bytes] of ARTIFACT_BYTES) writeFileSync(join(RELEASE, asset), bytes);
const MANIFEST = latestJson({
  version: V,
  pubDate: PUB_DATE,
  signatures: Object.fromEntries(updaterArtifacts(V).map(({ asset }) => [asset, `sig ${asset}`])),
  base: downloadBase(V),
});
writeFileSync(join(RELEASE, "latest.json"), `${JSON.stringify(MANIFEST, null, 2)}\n`);
writeFileSync(join(RELEASE, "SHA256SUMS"), "not checked here\n");
/** Whether this machine is one of the release's platforms, which the rehearsal runs need. */
const RELEASED_HERE = Object.hasOwn(MANIFEST.platforms, `${OS}-${ARCH}`);

// ── Ports: handed out by the system, all held open together so they differ ──

let PORTS = [];
before(async () => {
  const servers = [];
  for (let i = 0; i < 48; i += 1) {
    const server = createNetServer();
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    servers.push(server);
  }
  PORTS = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
});
const takePort = () => {
  const port = PORTS.pop();
  assert.ok(port, "out of test ports");
  return port;
};

// ── Helpers ──

/** An HTTP request that follows no redirect: { status, headers, body (Buffer) }. */
function request(url, { method = "GET", headers = {}, agent = false } = {}) {
  return new Promise((done, fail) => {
    const req = httpRequest(url, { method, headers, agent }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Start `server` on a port of the system's choosing; resolves with its base URL. */
async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}`;
}

const close = (server) =>
  new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });

/** Whether a process is alive; on Linux a zombie counts as gone. */
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

/** Wait up to `ms` for `pid` to be gone; true when it is. */
async function gone(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return !alive(pid);
}

/**
 * Run the CLI with `args`; resolves with its exit code and output. An env
 * value of undefined removes that variable.
 */
function cli(args, { env = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((done, fail) => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[name];
      else childEnv[name] = value;
    }
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // SIGTERM first: the smoke then stops its app before it exits.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      fail(new Error(`launch-smoke timed out:\n${stdout}${stderr}`));
    }, timeoutMs);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, output: stdout + stderr });
    });
  });
}

/**
 * Smoke-test the fake app: FAKE_MODE `mode`, a fresh home, its own port, a
 * short settle and the log folder `logDir` (null: the smoke's default, and
 * the fake app's, which is the real app's).
 */
async function smokeFake({ mode = "ok", args = [], env = {}, logDir = fresh("logs"), home = fresh("home"), timeoutS = 30 } = {}) {
  const port = takePort();
  const pidFile = fresh("pid");
  const result = await cli(
    [
      "run",
      "--app",
      process.execPath,
      "--app-arg",
      FAKE_APP,
      "--home",
      home,
      "--port",
      String(port),
      ...(logDir === null ? [] : ["--log-dir", logDir]),
      "--settle-s",
      "0.5",
      "--timeout-s",
      String(timeoutS),
      ...args,
    ],
    { env: { FAKE_MODE: mode, FAKE_LOG_DIR: logDir ?? undefined, FAKE_PID_FILE: pidFile, ...env } },
  );
  const app = existsSync(pidFile) ? readPidFile(pidFile) : null;
  if (app) FAKE_APPS.set(app.pid, app.start);
  return { ...result, home, logDir, port, pid: app?.pid ?? null };
}

/** A check's row in the table: `PASS  healthz …`. */
const row = (status, name) => new RegExp(`^ {2}${status} {2}${name}\\b`, "m");

const LEGAL = folder("legal");
for (const name of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"]) writeFileSync(join(LEGAL, name), `${name}\n`);

// ── parseArgs ──

const RUN = ["run", "--app", "/opt/fleetify/fleetify-app", "--home", "/tmp/smoke-home"];

describe("parseArgs", () => {
  test("run: the defaults, with the working directory at the filesystem root", () => {
    assert.deepEqual(parseArgs(RUN), {
      command: "run",
      app: resolve("/opt/fleetify/fleetify-app"),
      appArgs: [],
      home: resolve("/tmp/smoke-home"),
      port: 18765,
      cwd: ROOT_DIR,
      logDir: null,
      legalDir: null,
      cspOrigin: null,
      expectPosthogSink: false,
      rehearse: null,
      bundleType: null,
      updatePort: 18080,
      timeoutS: 120,
      settleS: 10,
    });
  });

  test("run: every option", () => {
    const options = parseArgs([
      ...RUN,
      "--port",
      "18766",
      "--cwd",
      "/srv",
      "--log-dir",
      "/var/log/f",
      "--legal-dir",
      "/usr/lib/fleetify/legal",
      "--csp-origin",
      "https://eu.i.posthog.com",
      "--expect-posthog-sink",
      "--rehearse",
      "release",
      "--bundle-type",
      "deb",
      "--update-port",
      "18090",
      "--timeout-s",
      "60",
      "--settle-s",
      "2.5",
    ]);
    assert.deepEqual(options, {
      command: "run",
      app: resolve("/opt/fleetify/fleetify-app"),
      appArgs: [],
      home: resolve("/tmp/smoke-home"),
      port: 18766,
      cwd: resolve("/srv"),
      logDir: resolve("/var/log/f"),
      legalDir: resolve("/usr/lib/fleetify/legal"),
      cspOrigin: "https://eu.i.posthog.com",
      expectPosthogSink: true,
      rehearse: resolve("release"),
      bundleType: "deb",
      updatePort: 18090,
      timeoutS: 60,
      settleS: 2.5,
    });
  });

  test("run: --app-arg repeats, in order, and takes values that start with a dash", () => {
    const { appArgs } = parseArgs([...RUN, "--app-arg", "--appimage-extract-and-run", "--app-arg", "-v", "--app-arg", ""]);
    assert.deepEqual(appArgs, ["--appimage-extract-and-run", "-v", ""]);
  });

  test("run: relative paths are made absolute, as the app starts in another folder", () => {
    const options = parseArgs(["run", "--app", "bin/app", "--home", "h", "--cwd", "c", "--legal-dir", "l", "--log-dir", "g"]);
    assert.equal(options.app, resolve("bin/app"));
    assert.equal(options.home, resolve("h"));
    assert.equal(options.cwd, resolve("c"));
    assert.equal(options.legalDir, resolve("l"));
    assert.equal(options.logDir, resolve("g"));
  });

  test('--csp-origin: an empty value counts as not given, as on a fork PR; a URL counts as its origin', () => {
    assert.equal(parseArgs([...RUN, "--csp-origin", ""]).cspOrigin, null);
    assert.equal(parseArgs([...RUN, "--csp-origin", "https://eu.i.posthog.com/"]).cspOrigin, "https://eu.i.posthog.com");
    assert.equal(parseArgs([...RUN, "--csp-origin", "https://PH.example.com:443/x?y"]).cspOrigin, "https://ph.example.com");
    assert.equal(parseArgs([...RUN, "--csp-origin", "http://127.0.0.1:8010"]).cspOrigin, "http://127.0.0.1:8010");
  });

  test("--csp-origin with nothing after it, a flag after it, or a value that isn't an http(s) URL is a usage error", () => {
    assert.throws(() => parseArgs([...RUN, "--csp-origin"]), /--csp-origin needs a value.*""/);
    // What an unquoted empty ${{ vars.X }} leaves: the next flag in the value's place.
    assert.throws(() => parseArgs([...RUN, "--csp-origin", "--expect-posthog-sink"]), /--csp-origin needs a value/);
    for (const value of ["eu.i.posthog.com", "ftp://eu.i.posthog.com", "https://"]) {
      assert.throws(() => parseArgs([...RUN, "--csp-origin", value]), /--csp-origin/, value);
    }
  });

  test("run: usage errors", () => {
    const cases = [
      [["run", "--home", "/h"], /--app is required/],
      [["run", "--app", "/a"], /--home is required/],
      [[...RUN, "--app", "/b"], /--app is given twice/],
      [[...RUN, "--expect-posthog-sink", "--expect-posthog-sink"], /given twice/],
      [[...RUN, "--port"], /--port needs a value/],
      [[...RUN, "--port", "0"], /--port/],
      [[...RUN, "--port", "65536"], /--port/],
      [[...RUN, "--port", "80x"], /--port/],
      [[...RUN, "--timeout-s", "0"], /--timeout-s/],
      [[...RUN, "--timeout-s", "-5"], /--timeout-s needs a value/],
      [[...RUN, "--settle-s", "soon"], /--settle-s/],
      [[...RUN, "--app-arg"], /--app-arg needs a value/],
      [[...RUN, "--home", ""], /given twice|needs a value/],
      [[...RUN, "--rehearse", "release"], /--rehearse needs --bundle-type/],
      [[...RUN, "--bundle-type", "deb"], /--bundle-type goes with --rehearse/],
      [[...RUN, "--rehearse", "r", "--bundle-type", "msi"], /--bundle-type must be one of appimage, deb, rpm, nsis, app/],
      [[...RUN, "--update-port", "18090"], /--update-port goes with --rehearse/],
      [[...RUN, "--rehearse", "r", "--bundle-type", "deb", "--port", "18080"], /--port and --update-port are both 18080/],
      [[...RUN, "--verbose"], /unexpected argument: --verbose/],
      [[...RUN, "extra"], /unexpected argument: extra/],
    ];
    for (const [argv, message] of cases) assert.throws(() => parseArgs(argv), message, argv.join(" "));
  });

  test("serve-release: the defaults and the port", () => {
    assert.deepEqual(parseArgs(["serve-release", "--dir", "release", "--version", "0.2.0"]), {
      command: "serve-release",
      dir: resolve("release"),
      version: "0.2.0",
      port: 18081,
    });
    assert.equal(parseArgs(["serve-release", "--dir", "r", "--version", "0.2.0", "--port", "18082"]).port, 18082);
  });

  test("serve-release: usage errors", () => {
    const cases = [
      [["serve-release", "--version", "0.2.0"], /--dir is required/],
      [["serve-release", "--dir", "r"], /--version is required/],
      [["serve-release", "--dir", "r", "--version", "v0.2.0"], /--version "v0.2.0" is not MAJOR.MINOR.PATCH/],
      [["serve-release", "--dir", "r", "--version", "0.2"], /MAJOR.MINOR.PATCH/],
      [["serve-release", "--dir", "r", "--version", "0.2.0", "--app", "x"], /unexpected argument: --app/],
    ];
    for (const [argv, message] of cases) assert.throws(() => parseArgs(argv), message, argv.join(" "));
  });

  test("no command, or an unknown one, is a usage error", () => {
    assert.throws(() => parseArgs([]), /missing command/);
    assert.throws(() => parseArgs(["serve"]), /unknown command: serve/);
  });
});

// ── smokeEnv ──

describe("smokeEnv", () => {
  const BASE = {
    PATH: "/usr/bin",
    DISPLAY: ":99",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus",
    HOME: "/home/runner",
    FLEETIFY_HOME: "/elsewhere",
    FLEETIFY_NOAUTH: "1",
    FLEETIFY_BACKEND_PORT: "8765",
    FLEETIFY_ISSUER: "http://localhost:3001",
    fleetify_home: "/lowercase",
    POSTHOG_API_KEY: "phc_runtime",
    POSTHOG_HOST: "https://us.i.posthog.com",
    FLEET_DB_URL: "sqlite::memory:",
    RUST_LOG: "error",
    XDG_STATE_HOME: "/home/runner/.local/state",
    VITE_SOMETHING: "kept",
  };

  test("sets the home, the XDG folders and the port, and keeps what the app needs to show a window", () => {
    const env = smokeEnv(BASE, { home: "/tmp/h", port: 18765, platform: "linux" });
    assert.equal(env.HOME, "/tmp/h");
    assert.equal(env.USERPROFILE, "/tmp/h");
    assert.equal(env.XDG_CONFIG_HOME, "/tmp/h/.config");
    assert.equal(env.XDG_DATA_HOME, "/tmp/h/.local/share");
    assert.equal(env.XDG_CACHE_HOME, "/tmp/h/.cache");
    assert.equal(env.XDG_STATE_HOME, "/tmp/h/.local/state");
    assert.equal(env.FLEETIFY_BACKEND_PORT, "18765");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.DISPLAY, ":99");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/tmp/bus");
    assert.equal(env.VITE_SOMETHING, "kept");
  });

  test("drops every other FLEETIFY_ and POSTHOG_ variable, whatever its case, and FLEET_DB_URL and RUST_LOG", () => {
    const env = smokeEnv(BASE, { home: "/tmp/h", port: 18765, platform: "linux" });
    const names = Object.keys(env);
    assert.deepEqual(
      names.filter((name) => /^(fleetify_|posthog_)/i.test(name)),
      ["FLEETIFY_BACKEND_PORT"],
    );
    assert.equal(env.FLEET_DB_URL, undefined);
    assert.equal(env.RUST_LOG, undefined);
  });

  test("on Linux, WebKit's compositing and DMA-BUF renderer are off; not on macOS or Windows", () => {
    const linux = smokeEnv(BASE, { home: "/tmp/h", port: 1, platform: "linux" });
    assert.equal(linux.WEBKIT_DISABLE_COMPOSITING_MODE, "1");
    assert.equal(linux.WEBKIT_DISABLE_DMABUF_RENDERER, "1");
    for (const platform of ["darwin", "win32"]) {
      const env = smokeEnv(BASE, { home: "/tmp/h", port: 1, platform });
      assert.equal(env.WEBKIT_DISABLE_COMPOSITING_MODE, undefined, platform);
      assert.equal(env.WEBKIT_DISABLE_DMABUF_RENDERER, undefined, platform);
    }
  });

  test("on Windows, the folders are Windows paths, and a variable set in another case is replaced, not doubled", () => {
    const env = smokeEnv({ Path: "C:\\Windows", UserProfile: "C:\\Users\\runner", LOCALAPPDATA: "C:\\L" }, {
      home: "D:\\smoke\\home",
      port: 18765,
      platform: "win32",
    });
    assert.equal(env.USERPROFILE, "D:\\smoke\\home");
    assert.equal(env.UserProfile, undefined);
    assert.equal(env.XDG_STATE_HOME, "D:\\smoke\\home\\.local\\state");
    assert.equal(env.LOCALAPPDATA, "C:\\L");
    assert.equal(env.Path, "C:\\Windows");
  });

  test("leaves the env it is given as it was", () => {
    const base = { ...BASE };
    smokeEnv(base, { home: "/tmp/h", port: 18765, platform: "linux" });
    assert.deepEqual(base, BASE);
  });
});

// ── logDirFor ──

describe("logDirFor", () => {
  test("Linux: $XDG_STATE_HOME/fleetify/logs, lowercase", () => {
    assert.equal(logDirFor("linux", { home: "/tmp/h", env: { XDG_STATE_HOME: "/state" } }), "/state/fleetify/logs");
  });

  test("Linux without XDG_STATE_HOME, or with it empty: <home>/.local/state/fleetify/logs", () => {
    assert.equal(logDirFor("linux", { home: "/tmp/h", env: {} }), "/tmp/h/.local/state/fleetify/logs");
    assert.equal(logDirFor("linux", { home: "/tmp/h", env: { XDG_STATE_HOME: "" } }), "/tmp/h/.local/state/fleetify/logs");
  });

  test("macOS: <home>/Library/Logs/Fleetify", () => {
    assert.equal(logDirFor("darwin", { home: "/Users/r", env: { XDG_STATE_HOME: "/state" } }), "/Users/r/Library/Logs/Fleetify");
  });

  test("Windows: %LOCALAPPDATA%\\Fleetify\\logs; without LOCALAPPDATA there is no telling", () => {
    assert.equal(logDirFor("win32", { home: "D:\\h", env: { LOCALAPPDATA: "C:\\Users\\r\\AppData\\Local" } }), "C:\\Users\\r\\AppData\\Local\\Fleetify\\logs");
    assert.throws(() => logDirFor("win32", { home: "D:\\h", env: {} }), /LOCALAPPDATA.*--log-dir/);
  });

  test("with the smoke's env: under the smoke's home on Linux, in LOCALAPPDATA on Windows", () => {
    const linux = smokeEnv({ XDG_STATE_HOME: "/real/state" }, { home: "/tmp/h", port: 1, platform: "linux" });
    assert.equal(logDirFor("linux", { home: "/tmp/h", env: linux }), posix.join("/tmp/h", ".local", "state", "fleetify", "logs"));
    const win = smokeEnv({ LOCALAPPDATA: "C:\\L" }, { home: "D:\\h", port: 1, platform: "win32" });
    assert.equal(logDirFor("win32", { home: "D:\\h", env: win }), win32.join("C:\\L", "Fleetify", "logs"));
  });
});

// ── uiProblems ──

describe("uiProblems", () => {
  const CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:18765 https://eu.i.posthog.com; report-uri /api/csp-report";
  const ok = { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP } };

  test("index.html under a policy with default-src 'self' has no problems", () => {
    assert.deepEqual(uiProblems({ ...ok, cspOrigin: null }), []);
    assert.deepEqual(uiProblems({ ...ok, cspOrigin: "https://eu.i.posthog.com" }), []);
    assert.deepEqual(uiProblems({ ...ok, headers: { "Content-Type": "text/html", "Content-Security-Policy": CSP } }), []);
  });

  test("a status other than 200 or a type other than text/html is a problem", () => {
    assert.match(uiProblems({ ...ok, status: 404 }).join("\n"), /GET \/ answered 404, not 200/);
    assert.match(uiProblems({ ...ok, headers: { ...ok.headers, "content-type": "text/plain" } }).join("\n"), /content-type is "text\/plain", not text\/html/);
    assert.match(uiProblems({ ...ok, headers: { "content-security-policy": CSP } }).join("\n"), /content-type is missing/);
  });

  test("no content-security-policy header is a problem", () => {
    assert.deepEqual(uiProblems({ status: 200, headers: { "content-type": "text/html" }, cspOrigin: null }), [
      "GET / has no content-security-policy header",
    ]);
  });

  test("a policy without default-src 'self' is a problem", () => {
    for (const csp of ["script-src 'self'", "default-src *", "default-src https:; script-src 'self'", "x-default-src 'self'"]) {
      const problems = uiProblems({ status: 200, headers: { "content-type": "text/html", "content-security-policy": csp } });
      assert.match(problems.join("\n"), /has no default-src 'self'/, csp);
    }
  });

  test("a --csp-origin the policy's connect-src doesn't allow is a problem; an empty one isn't checked", () => {
    assert.match(uiProblems({ ...ok, cspOrigin: "https://us.i.posthog.com" }).join("\n"), /connect-src doesn't allow https:\/\/us\.i\.posthog\.com/);
    const elsewhere = { ...ok, headers: { ...ok.headers, "content-security-policy": "default-src 'self'; img-src https://ph.example" } };
    assert.match(uiProblems({ ...elsewhere, cspOrigin: "https://ph.example" }).join("\n"), /connect-src doesn't allow/);
    assert.deepEqual(uiProblems({ ...ok, cspOrigin: "" }), []);
  });
});

// ── logProblems ──

describe("logProblems", () => {
  const json = (target, message, fields = {}) =>
    JSON.stringify({ timestamp: "2026-11-21T10:00:00.000Z", level: "WARN", fields: { message, ...fields }, target });

  test("a clean log has no problems, refused probes and update lines included", () => {
    const lines = [
      json("logging", "fleetify session started"),
      json("fleetify.access", "refused a request", { reason: "token" }),
      json("fleetify.updater", "update ready", { version: "99.0.0" }),
      "2026-11-21T10:00:00Z  INFO fleet-backend: fleetify-backend listening on http://127.0.0.1:18765",
      "",
      "{not json",
    ];
    assert.deepEqual(logProblems(lines), []);
  });

  test("Rust's default hook ('panicked at') and the app's panic hook (target panic) are panics", () => {
    const problems = logProblems([
      "thread 'tokio-runtime-worker' panicked at crates/x.rs:1:2:",
      json("panic", "rust panic", { payload: "boom", location: "crates/x.rs:1:2" }),
    ]);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /^panicked: /);
  });

  test("a content security policy line (target fleetify.csp) is a problem, the suppressed count included", () => {
    const problems = logProblems([
      json("fleetify.csp", "content security policy violation", { directive: "script-src", blocked: "inline" }),
      json("fleetify.csp", "3 more content security policy violations suppressed"),
    ]);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /^content security policy violation: /);
  });

  test("a very long line is cut short in the problem", () => {
    const [problem] = logProblems([`thread 'main' panicked at ${"x".repeat(5000)}`]);
    assert.ok(problem.length < 600, problem.length);
  });
});

// ── findUpdaterReady ──

describe("findUpdaterReady", () => {
  const line = (target, message, fields = {}) =>
    JSON.stringify({ timestamp: "2026-11-21T10:00:00.000Z", level: "INFO", fields: { message, ...fields }, target });

  test("the version of the updater's 'update ready' line", () => {
    assert.equal(findUpdaterReady([line("logging", "fleetify session started"), line("fleetify.updater", "update ready", { version: "99.0.0" })]), "99.0.0");
  });

  test("null without one; other targets, other updater lines and text lines don't count", () => {
    assert.equal(findUpdaterReady([]), null);
    assert.equal(
      findUpdaterReady([
        line("renderer", "update ready", { version: "1.0.0" }),
        line("fleetify.updater", "installing update", { version: "99.0.0" }),
        line("fleetify.updater", "update ready"),
        "INFO fleetify.updater: update ready version=99.0.0",
      ]),
      null,
    );
  });

  test("the latest one wins", () => {
    const lines = [line("fleetify.updater", "update ready", { version: "98.0.0" }), line("fleetify.updater", "update ready", { version: "99.0.0" })];
    assert.equal(findUpdaterReady(lines), "99.0.0");
  });
});

// ── posthogSinkProblems ──

describe("posthogSinkProblems", () => {
  const line = (target, message) => JSON.stringify({ level: "INFO", fields: { message }, target });
  const INIT = line("fleetify.posthog", "posthog sink initialised (runtime gate currently closed)");
  const NO_KEY = line("fleetify.posthog", "POSTHOG_API_KEY set neither in env nor at build time; posthog sink disabled");

  test("the sink started: no problems", () => {
    assert.deepEqual(posthogSinkProblems([INIT]), []);
  });

  test("a build without the key, or a sink that never started, is a problem", () => {
    const noKey = posthogSinkProblems([NO_KEY]).join("\n");
    assert.match(noKey, /no "posthog sink initialised" line/);
    assert.match(noKey, /set neither in env nor at build time/);
    assert.match(posthogSinkProblems([]).join("\n"), /no "posthog sink initialised" line/);
    const failed = line("fleetify_backend", "telemetry: posthog init failed: boom (posthog sink disabled)");
    assert.match(posthogSinkProblems([INIT, failed]).join("\n"), /posthog init failed/);
  });
});

// ── updateRequestPath ──

describe("updateRequestPath", () => {
  test("the path the dry-run build's updater asks for, with the plugin's names for each release platform", () => {
    const cases = [
      [{ platform: "linux", arch: "x64", version: "0.2.0", bundleType: "appimage" }, "/update/linux/x86_64/0.2.0?bundle_type=appimage"],
      [{ platform: "linux", arch: "x64", version: "0.2.0", bundleType: "deb" }, "/update/linux/x86_64/0.2.0?bundle_type=deb"],
      [{ platform: "win32", arch: "x64", version: "0.2.0", bundleType: "nsis" }, "/update/windows/x86_64/0.2.0?bundle_type=nsis"],
      [{ platform: "darwin", arch: "arm64", version: "0.2.0", bundleType: "app" }, "/update/darwin/aarch64/0.2.0?bundle_type=app"],
      [{ platform: "darwin", arch: "x64", version: "1.10.3", bundleType: "app" }, "/update/darwin/x86_64/1.10.3?bundle_type=app"],
    ];
    for (const [query, path] of cases) assert.equal(updateRequestPath(query), path);
  });

  test("a platform the updater doesn't run on is refused", () => {
    assert.throws(() => updateRequestPath({ platform: "freebsd", arch: "x64", version: "0.2.0", bundleType: "deb" }), /freebsd/);
    assert.throws(() => updateRequestPath({ platform: "linux", arch: "constructor", version: "0.2.0", bundleType: "deb" }), /constructor/);
  });
});

// ── createUpdateServer ──

describe("createUpdateServer", () => {
  /** Ask a fresh server one path; resolves with the answer and what the server recorded. */
  async function ask(path, options) {
    const server = createUpdateServer({ releaseDir: RELEASE, ...options });
    const base = await listen(server);
    try {
      const answer = await request(`${base}${path}`);
      return { answer, base, server };
    } finally {
      await close(server);
    }
  }

  test("offers the release's entry for the bundle type asked about, as 99.0.0, from /artifacts/, and records the path", async () => {
    const path = "/update/linux/x86_64/0.2.0?bundle_type=deb";
    const { answer, base, server } = await ask(path);
    assert.equal(answer.status, 200);
    assert.match(answer.headers["content-type"], /^application\/json/);
    assert.deepEqual(JSON.parse(answer.body), {
      version: "99.0.0",
      url: `${base}/artifacts/Fleetify_0.2.0_amd64.deb`,
      signature: "sig Fleetify_0.2.0_amd64.deb",
      notes: MANIFEST.notes,
      pub_date: PUB_DATE,
    });
    assert.deepEqual(server.requests, [path]);
  });

  test("each platform and bundle type gets its own artifact; an unknown bundle type gets the platform's fallback", async () => {
    const cases = [
      ["/update/linux/x86_64/0.2.0?bundle_type=appimage", "Fleetify_0.2.0_amd64.AppImage"],
      ["/update/linux/x86_64/0.2.0?bundle_type=rpm", "Fleetify-0.2.0-1.x86_64.rpm"],
      ["/update/linux/x86_64/0.2.0?bundle_type=unknown", "Fleetify_0.2.0_amd64.AppImage"],
      ["/update/windows/x86_64/0.2.0?bundle_type=nsis", "Fleetify_0.2.0_x64-setup.exe"],
      ["/update/darwin/aarch64/0.2.0?bundle_type=app", "Fleetify_0.2.0_aarch64.app.tar.gz"],
      ["/update/darwin/x86_64/0.2.0?bundle_type=app", "Fleetify_0.2.0_x64.app.tar.gz"],
    ];
    for (const [path, asset] of cases) {
      const { answer, base } = await ask(path);
      assert.equal(JSON.parse(answer.body).url, `${base}/artifacts/${asset}`, path);
    }
  });

  test("another offered version", async () => {
    const { answer } = await ask("/update/linux/x86_64/0.2.0?bundle_type=deb", { offerVersion: "0.3.0" });
    assert.equal(JSON.parse(answer.body).version, "0.3.0");
  });

  test("a copy already on the offered version or newer, or a platform the release lacks, gets 204", async () => {
    for (const path of [
      "/update/linux/x86_64/99.0.0?bundle_type=deb",
      "/update/linux/x86_64/100.0.0?bundle_type=deb",
      "/update/freebsd/x86_64/0.2.0?bundle_type=deb",
    ]) {
      const { answer } = await ask(path);
      assert.equal(answer.status, 204, path);
      assert.equal(answer.body.length, 0, path);
    }
  });

  test("a version that isn't MAJOR.MINOR.PATCH gets a 400, never a 2xx, and is recorded as an error", async () => {
    const { answer, server } = await ask("/update/linux/x86_64/latest?bundle_type=deb");
    assert.equal(answer.status, 400);
    assert.match(server.errors.join("\n"), /latest/);
  });

  test("/artifacts/<asset> sends the file in full, and the download is recorded as complete", async () => {
    const server = createUpdateServer({ releaseDir: RELEASE });
    const base = await listen(server);
    // A client that keeps the connection open, as the updater's does. One
    // that hangs up as soon as it has the body can close the connection
    // before the server's file stream reaches its end; the response then
    // closes without finishing, and the download isn't complete.
    const agent = new Agent({ keepAlive: true });
    let timer;
    try {
      const asset = "Fleetify_0.2.0_amd64.AppImage";
      // The server finishes once the last bytes are handed to the system,
      // which may come after the client has read them, and later still on a
      // busy machine: wait for the event itself, for 30 s at most. Its
      // listeners all run before this promise's continuation does.
      const finished = new Promise((done, fail) => {
        timer = setTimeout(() => fail(new Error("the server didn't finish the response within 30 s")), 30_000);
        server.once("request", (req, res) => res.once("finish", done));
      });
      finished.catch(() => {});
      const answer = await request(`${base}/artifacts/${asset}`, { agent });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["content-length"], String(ARTIFACT_BYTES.get(asset).length));
      assert.ok(answer.body.equals(ARTIFACT_BYTES.get(asset)));
      await finished;
      assert.deepEqual(server.downloads, [{ asset, size: ARTIFACT_BYTES.get(asset).length, bytes: ARTIFACT_BYTES.get(asset).length, complete: true }]);
    } finally {
      clearTimeout(timer);
      agent.destroy();
      await close(server);
    }
  });

  test("/artifacts/ sends only files in the release folder; other paths get 404", async () => {
    for (const path of ["/artifacts/..%2Flatest.json", "/artifacts/nope.AppImage", "/artifacts/", "/artifacts/a/b", "/latest.json", "/update/linux/x86_64"]) {
      const { answer } = await ask(path);
      assert.equal(answer.status, 404, path);
    }
  });

  test("a name too long for the filesystem gets 404, and the server goes on serving", async () => {
    const server = createUpdateServer({ releaseDir: RELEASE });
    const base = await listen(server);
    try {
      assert.equal((await request(`${base}/artifacts/${"a".repeat(300)}.AppImage`)).status, 404);
      assert.equal((await request(`${base}/update/linux/x86_64/0.2.0?bundle_type=deb`)).status, 200);
    } finally {
      await close(server);
    }
  });

  test("a latest.json entry whose url isn't a URL gets a 500 and an error, not a crash", async () => {
    const release = folder("release");
    const broken = structuredClone(MANIFEST);
    broken.platforms["linux-x86_64-deb"].url = "not a url";
    writeFileSync(join(release, "latest.json"), JSON.stringify(broken));
    const server = createUpdateServer({ releaseDir: release });
    const base = await listen(server);
    try {
      assert.equal((await request(`${base}/update/linux/x86_64/0.2.0?bundle_type=deb`)).status, 500);
      assert.match(server.errors.join("\n"), /bundle_type=deb/);
      assert.equal((await request(`${base}/update/linux/x86_64/0.2.0?bundle_type=rpm`)).status, 200);
    } finally {
      await close(server);
    }
  });

  test("refuses a release folder without latest.json, and an offered version that isn't newer than the release", () => {
    assert.throws(() => createUpdateServer({ releaseDir: folder("empty") }), /latest\.json/);
    assert.throws(() => createUpdateServer({ releaseDir: RELEASE, offerVersion: "0.2.0" }), /not newer/);
    assert.throws(() => createUpdateServer({ releaseDir: RELEASE, offerVersion: "next" }), /MAJOR\.MINOR\.PATCH/);
  });
});

// ── createReleaseServer ──

describe("createReleaseServer", () => {
  async function withServer(fn, version = V) {
    const server = createReleaseServer({ dir: RELEASE, version });
    const base = await listen(server);
    try {
      return await fn(base, server);
    } finally {
      await close(server);
    }
  }

  test("serves a release file under /download/v<version>/", async () => {
    await withServer(async (base, server) => {
      const answer = await request(`${base}/download/v0.2.0/latest.json`);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["content-type"], "application/octet-stream");
      assert.deepEqual(answer.body, readFileSync(join(RELEASE, "latest.json")));
      assert.deepEqual(server.requests, ["/download/v0.2.0/latest.json"]);
    });
  });

  test("/latest/download/<file> redirects to /download/v<version>/<file>, as GitHub does, and fetch follows it", async () => {
    await withServer(async (base) => {
      const answer = await request(`${base}/latest/download/Fleetify_0.2.0_amd64.AppImage`);
      assert.equal(answer.status, 302);
      assert.equal(answer.headers.location, `${base}/download/v0.2.0/Fleetify_0.2.0_amd64.AppImage`);
      const followed = await fetch(`${base}/latest/download/Fleetify_0.2.0_amd64.AppImage`);
      assert.equal(followed.status, 200);
      assert.ok(Buffer.from(await followed.arrayBuffer()).equals(ARTIFACT_BYTES.get("Fleetify_0.2.0_amd64.AppImage")));
    });
  });

  test("HEAD answers with the size and no body", async () => {
    await withServer(async (base) => {
      const answer = await request(`${base}/download/v0.2.0/SHA256SUMS`, { method: "HEAD" });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["content-length"], String(readFileSync(join(RELEASE, "SHA256SUMS")).length));
      assert.equal(answer.body.length, 0);
    });
  });

  test("another version, a missing file or a path out of the folder gets 404", async () => {
    await withServer(async (base) => {
      for (const path of [
        "/download/v0.1.0/latest.json",
        "/download/0.2.0/latest.json",
        "/download/v0.2.0/missing.txt",
        "/latest/download/missing.txt",
        "/download/v0.2.0/..%2F..%2Fetc%2Fpasswd",
        "/latest/download/",
        "/latest.json",
        "/",
      ]) {
        const answer = await request(`${base}${path}`);
        assert.equal(answer.status, 404, path);
      }
    });
  });

  test("a name too long for the filesystem gets 404, and the server goes on serving", async () => {
    await withServer(async (base) => {
      assert.equal((await request(`${base}/download/v0.2.0/${"a".repeat(300)}.txt`)).status, 404);
      assert.equal((await request(`${base}/latest/download/${"a".repeat(300)}.txt`)).status, 404);
      assert.equal((await request(`${base}/download/v0.2.0/latest.json`)).status, 200);
    });
  });

  test("refuses a version that isn't MAJOR.MINOR.PATCH, or a folder that isn't there", () => {
    assert.throws(() => createReleaseServer({ dir: RELEASE, version: "v0.2.0" }), /MAJOR\.MINOR\.PATCH/);
    assert.throws(() => createReleaseServer({ dir: fresh("missing"), version: V }), /not a folder/);
  });
});

// ── The strings the smoke reads from the app ──

describe("the app still writes what the smoke reads", () => {
  /** A source file with all whitespace removed, so a rustfmt reflow doesn't matter. */
  const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\s+/g, "");
  const has = (path, ...needles) => {
    const text = source(path);
    for (const needle of needles) assert.ok(text.includes(needle.replace(/\s+/g, "")), `${path} no longer has ${needle}`);
  };

  test("the log folders, the file name and the panic target (logging.rs)", () => {
    has(
      "src-tauri/src/shell/logging.rs",
      'var_os("LOCALAPPDATA")',
      '.join("Fleetify").join("logs")',
      '.join("Library").join("Logs").join("Fleetify")',
      'var_os("XDG_STATE_HOME")',
      '.join(".local").join("state")',
      '.join("fleetify").join("logs")',
      'const LOG_FILE_PREFIX: &str = "fleetify.log";',
      'target: "panic"',
    );
  });

  test("the updater's lines (updater.rs)", () => {
    has(
      "src-tauri/src/shell/updater.rs",
      'const LOG_TARGET: &str = "fleetify.updater";',
      '"update ready"',
      '"update check failed"',
      '"update download failed"',
    );
  });

  test("the PostHog sink's lines (posthog/mod.rs)", () => {
    has(
      "crates/fleetify-backend/src/services/telemetry/posthog/mod.rs",
      '"posthog sink initialised (runtime gate currently {})"',
      "set neither in env nor at build time; posthog sink disabled",
    );
  });

  test("the policy, its report target and the health route (ui.rs, http.rs)", () => {
    has("crates/fleetify-backend/src/ui.rs", `"default-src 'self'"`, 'target: "fleetify.csp"');
    has("crates/fleetify-backend/src/http.rs", 'HEALTH_PATH: &str = "/healthz"', '"status": "ok"', '"version": env!("CARGO_PKG_VERSION")');
  });

  test("the DB under the home's .fleetify, found through USERPROFILE or HOME", () => {
    has("config/default.toml", 'path = "fleet.db"');
    has("crates/fleetify-core/src/lib.rs", 'env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))', 'user_home().join(".fleetify")');
  });

  test("the update server's default port and path are the dry-run build's endpoint", () => {
    const pubkey = readFileSync(new URL("./fixtures/minisign/fixture.pub", import.meta.url), "utf8");
    const [endpoint] = dryRunConfig({ pubkey }).plugins.updater.endpoints;
    const { updatePort } = parseArgs(RUN);
    const filled = endpoint
      .replace("{{target}}", "linux")
      .replace("{{arch}}", "x86_64")
      .replace("{{current_version}}", "0.2.0")
      .replace("{{bundle_type}}", "deb");
    const path = updateRequestPath({ platform: "linux", arch: "x64", version: "0.2.0", bundleType: "deb" });
    assert.equal(filled, `http://127.0.0.1:${updatePort}${path}`);
  });
});

// ── run, against the fake app ──

describe("run against the fake app", { concurrency: 8, timeout: 120_000 }, () => {
  test("ok: every check passes from the filesystem root, and the app is stopped", async () => {
    const result = await smokeFake();
    assert.equal(result.status, 0, result.output);
    for (const name of ["healthz", "ui", "access token", "access host", "db", "log", "running", "stop"]) {
      assert.match(result.stdout, row("PASS", name), `${name}\n${result.output}`);
    }
    assert.ok(result.stdout.includes(`working directory ${ROOT_DIR};`), result.output);
    assert.match(result.stdout, /all 8 checks passed/);
    assert.ok(existsSync(join(result.home, ".fleetify", "fleet.db")));
    assert.ok(result.pid, "the fake app ran");
    assert.ok(await gone(result.pid), "the fake app was stopped");
  });

  test("panic: exit 1, naming the panic", async () => {
    const result = await smokeFake({ mode: "panic" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "log"));
    assert.match(result.stdout, /panicked/);
  });

  test("no-csp: exit 1, naming the missing content-security-policy", async () => {
    const result = await smokeFake({ mode: "no-csp" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "ui"));
    assert.match(result.stdout, /content-security-policy/);
  });

  test("cwd-db: exit 1, naming the fleet.db in the working directory", async () => {
    const cwd = folder("cwd");
    const result = await smokeFake({ mode: "cwd-db", args: ["--cwd", cwd] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "db"));
    assert.match(result.stdout, /fleet\.db in the working directory/);
    assert.ok(result.stdout.includes(`fleet.db in the working directory ${cwd}`), result.stdout);
    assert.match(result.stdout, /\.fleetify[\\/]fleet\.db doesn't exist/);
  });

  test("open: exit 1 when the API needs no token, and when a request for another host is answered", async () => {
    const result = await smokeFake({ mode: "open" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "access token"));
    assert.match(result.stdout, /GET \/api\/groups without the token: 200, not 403/);
    assert.match(result.stdout, row("FAIL", "access host"));
    assert.match(result.stdout, /Host: evil\.example: 200, not 403/);
  });

  test("--csp-origin: the origin the policy allows passes", async () => {
    const result = await smokeFake({ args: ["--csp-origin", "https://eu.i.posthog.com/"] });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /allows https:\/\/eu\.i\.posthog\.com/);
  });

  test("--csp-origin: an origin the policy doesn't allow fails", async () => {
    const result = await smokeFake({ args: ["--csp-origin", "https://us.i.posthog.com"] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "ui"));
    assert.match(result.stdout, /connect-src doesn't allow https:\/\/us\.i\.posthog\.com/);
  });

  test('--csp-origin "": not checked, as on a fork PR', async () => {
    const result = await smokeFake({ args: ["--csp-origin", ""] });
    assert.equal(result.status, 0, result.output);
  });

  test("--legal-dir: LICENSE, NOTICE and THIRD-PARTY-NOTICES there pass", async () => {
    const result = await smokeFake({ args: ["--legal-dir", LEGAL] });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, row("PASS", "legal"));
  });

  test("--legal-dir: a missing or empty file fails, by name", async () => {
    const legal = folder("legal");
    writeFileSync(join(legal, "LICENSE"), "Apache\n");
    writeFileSync(join(legal, "THIRD-PARTY-NOTICES"), "");
    const result = await smokeFake({ args: ["--legal-dir", legal] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "legal"));
    assert.match(result.stdout, /no NOTICE in /);
    assert.match(result.stdout, /THIRD-PARTY-NOTICES in .* is empty/);
  });

  test("--expect-posthog-sink: passes when the sink started", async () => {
    const result = await smokeFake({ args: ["--expect-posthog-sink"], env: { FAKE_POSTHOG: "initialised" } });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, row("PASS", "posthog sink"));
  });

  test("--expect-posthog-sink: fails when the build has no key", async () => {
    const result = await smokeFake({ args: ["--expect-posthog-sink"] });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "posthog sink"));
    assert.match(result.stdout, /set neither in env nor at build time/);
  });

  test("an app that exits at startup fails at once, with its exit code", async () => {
    const started = Date.now();
    const result = await smokeFake({ mode: "exit", timeoutS: 60 });
    assert.equal(result.status, 1, result.output);
    assert.ok(Date.now() - started < 20_000, "didn't wait for --timeout-s");
    assert.match(result.stdout, row("FAIL", "healthz"));
    assert.match(result.stdout, /exited \(code 3\)/);
    assert.match(result.stdout, row("FAIL", "running"));
    assert.match(result.stdout, /backend failed to start: fake failure/);
  });

  test("an app that never answers fails after --timeout-s, and is stopped", async () => {
    const result = await smokeFake({ mode: "hang", timeoutS: 1 });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "healthz"));
    assert.match(result.stdout, /within 1 s/);
    assert.match(result.stdout, row("SKIP", "ui"));
    assert.ok(await gone(result.pid), "the fake app was stopped");
  });

  test("the log check fails when the log folder holds nothing from this run", async () => {
    const result = await smokeFake({ env: { FAKE_LOG_DIR: folder("elsewhere") } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "log"));
    assert.match(result.stdout, /no JSON log lines from this run in /);
  });

  test("lines already in the log folder before the launch are not this run's", async () => {
    const logDir = folder("logs");
    const old = JSON.stringify({ level: "ERROR", fields: { message: "rust panic" }, target: "panic" });
    writeFileSync(join(logDir, "fleetify.log.2026-11-20"), `${old}\n`);
    const result = await smokeFake({ logDir });
    assert.equal(result.status, 0, result.output);
  });

  test(
    "without --log-dir, the log is read where the app writes it, under the smoke's home",
    { skip: process.platform === "win32" && "the default is the real %LOCALAPPDATA%" },
    async () => {
      const home = fresh("home");
      const result = await smokeFake({ logDir: null, home });
      assert.equal(result.status, 0, result.output);
      const expected = process.platform === "darwin" ? join(home, "Library", "Logs", "Fleetify") : join(home, ".local", "state", "fleetify", "logs");
      assert.ok(result.stdout.includes(`log folder ${expected}`), result.stdout);
    },
  );

  test(
    "an AppImage-like runtime that starts the app in another folder: a fleet.db there is found",
    { skip: process.platform !== "linux" && "the app's working directory is read from /proc" },
    async () => {
      const cwd = folder("launch");
      const appDir = folder("appdir-usr");
      const result = await smokeFake({ mode: "cwd-db", args: ["--cwd", cwd], env: { FAKE_APPRUN: appDir } });
      assert.equal(result.status, 1, result.output);
      assert.ok(result.stdout.includes(`fleet.db in the working directory ${appDir}`), result.stdout);
      assert.ok(!result.stdout.includes(`fleet.db in the working directory ${cwd}`), result.stdout);
      assert.ok(await gone(result.pid), "the app, a grandchild, was stopped");
    },
  );

  test(
    "the whole process tree is stopped, with SIGKILL when SIGTERM is ignored",
    { skip: process.platform === "win32" && "taskkill /F doesn't ask first" },
    async () => {
      const result = await smokeFake({ env: { FAKE_APPRUN: folder("appdir-usr"), FAKE_IGNORE_SIGTERM: "1" } });
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, row("PASS", "stop"));
      assert.match(result.stdout, /SIGKILL/);
      assert.ok(await gone(result.pid), "the app, a grandchild that ignores SIGTERM, was stopped");
    },
  );

  test("rehearsal reports the bundle type", { skip: !RELEASED_HERE && "no release platform for this machine" }, async () => {
    const updatePort = takePort();
    const result = await smokeFake({
      args: ["--rehearse", RELEASE, "--bundle-type", "appimage", "--update-port", String(updatePort)],
      env: { FAKE_UPDATE_URL: `http://127.0.0.1:${updatePort}/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}` },
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, row("PASS", "rehearsal"));
    assert.ok(result.stdout.includes(`GET /update/${OS}/${ARCH}/0.2.0?bundle_type=appimage`), result.stdout);
    assert.match(result.stdout, /downloaded in full; update ready 99\.0\.0/);
  });

  test("rehearsal fails when the app reports another bundle type", { skip: !RELEASED_HERE && "no release platform for this machine" }, async () => {
    const updatePort = takePort();
    const result = await smokeFake({
      args: ["--rehearse", RELEASE, "--bundle-type", "appimage", "--update-port", String(updatePort)],
      env: {
        FAKE_UPDATE_URL: `http://127.0.0.1:${updatePort}/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}`,
        FAKE_BUNDLE_TYPE: "deb",
      },
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "rehearsal"));
    assert.ok(result.stdout.includes(`the app asked for /update/${OS}/${ARCH}/0.2.0?bundle_type=deb, not `), result.stdout);
  });

  test("rehearsal fails when /healthz reports another version than the release's", { skip: !RELEASED_HERE && "no release platform for this machine" }, async () => {
    const updatePort = takePort();
    const result = await smokeFake({
      args: ["--rehearse", RELEASE, "--bundle-type", "appimage", "--update-port", String(updatePort)],
      env: {
        FAKE_UPDATE_URL: `http://127.0.0.1:${updatePort}/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}`,
        FAKE_HEALTH_VERSION: "0.1.0",
      },
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "rehearsal"));
    assert.match(result.stdout, /\/healthz reports version 0\.1\.0, but the release's latest\.json is 0\.2\.0/);
  });

  test("rehearsal fails when the app downloads another artifact than the one offered", { skip: !RELEASED_HERE && "no release platform for this machine" }, async () => {
    const updatePort = takePort();
    const result = await smokeFake({
      args: ["--rehearse", RELEASE, "--bundle-type", "appimage", "--update-port", String(updatePort)],
      env: {
        FAKE_UPDATE_URL: `http://127.0.0.1:${updatePort}/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}`,
        FAKE_DOWNLOAD_ASSET: "Fleetify-0.2.0-1.x86_64.rpm",
      },
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stdout, row("FAIL", "rehearsal"));
    assert.match(result.stdout, /was not downloaded in full \(downloads: Fleetify-0\.2\.0-1\.x86_64\.rpm \d+\/\d+ bytes\)/);
  });

  test("setup errors exit 2 before the app starts: no app file, a used home, a busy port", async () => {
    const noApp = await cli(["run", "--app", fresh("missing"), "--home", fresh("home")]);
    assert.equal(noApp.status, 2, noApp.output);
    assert.match(noApp.stderr, /is not a file/);

    const home = folder("home");
    mkdirSync(join(home, ".fleetify"));
    writeFileSync(join(home, ".fleetify", "fleet.db"), "");
    const used = await smokeFake({ home });
    assert.equal(used.status, 2, used.output);
    assert.match(used.stderr, /fresh --home/);
    assert.equal(used.pid, null, "the app never started");

    const holder = createNetServer();
    const port = takePort();
    await new Promise((done) => holder.listen(port, "127.0.0.1", done));
    try {
      const busy = await cli(["run", "--app", process.execPath, "--app-arg", FAKE_APP, "--home", fresh("home"), "--port", String(port)]);
      assert.equal(busy.status, 2, busy.output);
      assert.match(busy.stderr, new RegExp(`port ${port} is in use`));
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });

  test("setup errors exit 2 before the app starts: a release folder without the artifact its latest.json offers", { skip: !RELEASED_HERE && "no release platform for this machine" }, async () => {
    const release = folder("release");
    writeFileSync(join(release, "latest.json"), JSON.stringify(MANIFEST));
    const result = await smokeFake({ args: ["--rehearse", release, "--bundle-type", "appimage", "--update-port", String(takePort())] });
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /has no Fleetify_0\.2\.0_.*, which its latest\.json offers/);
    assert.equal(result.pid, null, "the app never started");
  });

  test(
    "a smoke stopped with SIGTERM stops the app, a grandchild here, before it exits",
    { skip: process.platform === "win32" && "a SIGTERM from Node ends a Windows process at once" },
    async () => {
      const pidFile = fresh("pid");
      const env = { ...process.env, FAKE_MODE: "hang", FAKE_APPRUN: folder("appdir-usr"), FAKE_PID_FILE: pidFile };
      delete env.NODE_TEST_CONTEXT;
      const args = ["run", "--app", process.execPath, "--app-arg", FAKE_APP, "--home", fresh("home"), "--port", String(takePort())];
      const child = spawn(process.execPath, [SCRIPT, ...args, "--log-dir", fresh("logs"), "--timeout-s", "60"], { env, stdio: "ignore" });
      const exited = new Promise((done) => child.on("close", (status) => done(status)));
      for (let i = 0; i < 300 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8")); i += 1) await new Promise((done) => setTimeout(done, 20));
      const { pid, start } = readPidFile(pidFile);
      FAKE_APPS.set(pid, start);
      assert.ok(alive(pid), "the app is running");
      child.kill("SIGTERM");
      assert.equal(await exited, 1);
      assert.ok(await gone(pid), "the app was stopped with the smoke");
    },
  );

  test("usage errors exit 2", async () => {
    const result = await cli(["run", "--app"]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /usage:/);
  });
});

// ── serve-release ──

describe("serve-release", () => {
  test("serves both URL layouts until it is stopped", async () => {
    const port = takePort();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [SCRIPT, "serve-release", "--dir", RELEASE, "--version", V, "--port", String(port)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const exited = new Promise((done) => child.on("close", (status, signal) => done({ status, signal })));
    try {
      await new Promise((done, fail) => {
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("serving")) done();
        });
        child.on("close", () => fail(new Error(`serve-release exited: ${stdout}`)));
      });
      const latest = await fetch(`http://127.0.0.1:${port}/latest/download/latest.json`);
      assert.equal(latest.status, 200);
      assert.deepEqual(JSON.parse(await latest.text()), MANIFEST);
      const tagged = await request(`http://127.0.0.1:${port}/download/v0.2.0/SHA256SUMS`);
      assert.equal(tagged.status, 200);
    } finally {
      child.kill("SIGTERM");
    }
    const { status } = await exited;
    if (process.platform !== "win32") assert.equal(status, 0, stdout);
    assert.match(stdout, /GET \/latest\/download\/latest\.json 302/);
  });

  test("a port in use is a setup error", async () => {
    const holder = createNetServer();
    const port = takePort();
    await new Promise((done) => holder.listen(port, "127.0.0.1", done));
    try {
      const result = await cli(["serve-release", "--dir", RELEASE, "--version", V, "--port", String(port)]);
      assert.equal(result.status, 2, result.output);
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });
});

describe("stopping only the app's own processes", () => {
  test("parseProcStat counts the fields from the last parenthesis, whatever the command name holds", () => {
    const stat = "4321 (a) b) S 1 4321 4321 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 987654 12345678 300 18446744073709551615";
    assert.deepEqual(parseProcStat(stat), { comm: "a) b", state: "S", ppid: 1, pgrp: 4321, start: "987654" });
    assert.equal(parseProcStat("not a stat line"), null);
    assert.equal(parseProcStat("12 (x) S 1 12"), null, "a line too short for the start time");
  });

  test("on Linux, parseProcStat reads this process's own stat", { skip: process.platform !== "linux" && "/proc is Linux's" }, () => {
    const own = parseProcStat(readFileSync(`/proc/${process.pid}/stat`, "utf8"));
    assert.equal(own.ppid, process.ppid);
    assert.match(own.start, /^[0-9]+$/);
  });

  test("a listed process whose start time changed, or that is gone or a zombie, isn't signalled", () => {
    const listed = [
      { pid: 10, start: "100" },
      { pid: 11, start: "200" },
      { pid: 12, start: "300" },
      { pid: 13, start: "400" },
    ];
    const now = new Map([
      [10, { state: "S", start: "100" }],
      // Pid 11 now belongs to another process, which started later.
      [11, { state: "S", start: "999" }],
      [13, { state: "Z", start: "400" }],
    ]);
    assert.deepEqual(stillListed(listed, now), [10]);
  });

  test("after a stop that left the app's root process running, the smoke lets go of it and can exit", () => {
    const stub = (exit) => {
      const calls = [];
      const stream = (name) => ({ destroy: () => calls.push(`${name} destroyed`) });
      return { calls, app: { exit, child: { stdout: stream("stdout"), stderr: stream("stderr"), unref: () => calls.push("unref") } } };
    };
    const survivor = stub(null);
    assert.equal(releaseApp(survivor.app), true);
    assert.deepEqual(survivor.calls, ["stdout destroyed", "stderr destroyed", "unref"]);
    const stopped = stub({ code: 0, signal: null });
    assert.equal(releaseApp(stopped.app), false);
    assert.deepEqual(stopped.calls, ["stdout destroyed", "stderr destroyed"]);
  });
});
