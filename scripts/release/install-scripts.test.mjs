/**
 * Tests for install.sh and install.ps1, which install Fleetify from its
 * GitHub release once the download matches the release's SHA256SUMS.
 *
 *   node --test scripts/release/install-scripts.test.mjs
 *
 * The scripts download from a fixture release, served by launch-smoke.mjs's
 * createReleaseServer the way GitHub serves release assets. It holds every
 * asset expectedAssets() names, under release-assets.mjs's names, so a
 * script that asks for any other name gets a 404: a fake AppImage that is a
 * shell script, an app archive for each Mac holding Fleetify.app, the real
 * install scripts, made-up bytes for the rest, and a correct latest.json and
 * SHA256SUMS.
 *
 * install.sh runs under /bin/sh with a PATH of its own: stand-ins for uname
 * and id, which answer as a test asks, and for sudo, apt-get, dnf and zypper,
 * which log each call and run nothing; and links to the system tools TOOLS
 * lists. So it runs the same on any machine, a package manager is there only
 * when a test puts it there, and a tool the script starts to need fails here
 * until TOOLS lists it. Its macOS branch runs here with uname saying Darwin,
 * and on macOS for real too.
 *
 * shellcheck and pwsh run when they're installed, as on CI's Ubuntu runners.
 * install.ps1 runs its installer only on Windows, which smoke.yml covers.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_BINARY } from "./compiled-tar.mjs";
import { createReleaseServer } from "./launch-smoke.mjs";
import { CHECKSUMS, INSTALL_SCRIPTS, MANIFEST, downloadBase, expectedAssets, latestJson, sha256sums, updaterArtifacts } from "./release-assets.mjs";

const INSTALL_SH = fileURLToPath(new URL("./install.sh", import.meta.url));
const INSTALL_PS1 = fileURLToPath(new URL("./install.ps1", import.meta.url));

/** The executable `name` on PATH, or null. */
function which(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const file of process.platform === "win32" ? [`${name}.exe`, name] : [name]) {
      try {
        accessSync(join(dir, file), constants.X_OK);
        return join(dir, file);
      } catch {
        // Not in this folder.
      }
    }
  }
  return null;
}

const SH = "/bin/sh";
const SKIP_SH = process.platform === "win32" || !existsSync(SH) ? "needs /bin/sh, on Linux or macOS" : false;

/**
 * What install.sh runs besides sh's built-ins, and with it the stand-ins and
 * the fake AppImage: sha256sum checks a download on Linux and shasum on
 * macOS, tar and gzip unpack a Mac's app archive, and sh and curl run the
 * one-liner. Each is linked into a folder of its own, the only one on PATH
 * besides the stand-ins'. A tool this machine lacks is left out, and the
 * tests that need it skip.
 */
const TOOLS = ["awk", "chmod", "cp", "curl", "grep", "gzip", "ln", "ls", "mkdir", "mktemp", "mv", "readlink", "rm", "sed", "sh", "sha256sum", "shasum", "tar"];

const ROOT = mkdtempSync(join(tmpdir(), "install-scripts-"));
let count = 0;
/** A path under ROOT that doesn't exist yet. */
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);
/** A new empty folder under ROOT. */
function folder(name) {
  const dir = fresh(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TOOLS_DIR = folder("tools");
const MISSING_TOOLS = new Set();
for (const name of TOOLS) {
  const path = process.platform === "win32" ? null : which(name);
  if (path === null) MISSING_TOOLS.add(name);
  else symlinkSync(path, join(TOOLS_DIR, name));
}
const SKIP_LINUX = SKIP_SH || (["curl", "sha256sum"].some((name) => MISSING_TOOLS.has(name)) && "needs curl and sha256sum");
const SKIP_MAC_STUB = SKIP_SH || (["curl", "shasum", "tar", "gzip"].some((name) => MISSING_TOOLS.has(name)) && "needs curl, shasum, tar and gzip");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** `text` as a regular expression that matches it literally. */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── The fixture release ─────────────────────────────────────────────────────

const V = "0.2.0";
/** Another release's version, for the tests where the version must come from latest.json. */
const OTHER_V = "10.20.3";
const PUB_DATE = "2026-11-21T10:00:00.000Z";

/**
 * The asset each way of installing fetches, by the latest.json key that
 * points at it, so that the names come from release-assets.mjs alone.
 */
function assetsOf(version) {
  const by = (key) => {
    const found = updaterArtifacts(version).find(({ keys }) => keys.includes(key));
    assert.ok(found, `no updater artifact for ${key}`);
    return found.asset;
  };
  return {
    appimage: by("linux-x86_64-appimage"),
    deb: by("linux-x86_64-deb"),
    rpm: by("linux-x86_64-rpm"),
    nsis: by("windows-x86_64-nsis"),
    macArm: by("darwin-aarch64-app"),
    macIntel: by("darwin-x86_64-app"),
  };
}
const ASSETS = assetsOf(V);

/** The icon the fake AppImage holds: a PNG's signature, then text. */
const ICON = Buffer.from("\x89PNG\r\n\x1a\nthe Fleetify icon\n", "latin1");

/**
 * Where a Tauri AppImage's .DirIcon points: an absolute link into the AppDir
 * on the machine that built it, which the user's machine doesn't have. The
 * icon it names is in the AppImage too, at the root.
 */
const BUILD_MACHINE_ICON = "/nonexistent/build-machine/target/release/bundle/appimage/Fleetify.AppDir/Fleetify.png";

/**
 * A stand-in for a release's AppImage: a shell script that logs each run,
 * and answers --appimage-extract as the AppImage runtime does, writing the
 * entry the pattern names under ./squashfs-root, which it makes in any case.
 * With FAKE_APPIMAGE_NO_ICON set, it holds no icon; with FAKE_APPIMAGE_STUCK
 * set, it also writes a folder its owner can't empty.
 */
const fakeAppImage = (version) => `#!/bin/sh
# Fleetify ${version}'s AppImage, as a test fakes it.
printf '%s\\n' "$*" >> "\${FAKE_APPIMAGE_LOG:-/dev/null}"
if [ "$1" != --appimage-extract ]; then
  echo "Fleetify ${version} started"
  exit 0
fi
mkdir -p squashfs-root
if [ -n "\${FAKE_APPIMAGE_STUCK:-}" ] && [ ! -d squashfs-root/stuck ]; then
  mkdir squashfs-root/stuck && : > squashfs-root/stuck/file && chmod 555 squashfs-root/stuck
fi
if [ -n "\${FAKE_APPIMAGE_NO_ICON:-}" ]; then exit 0; fi
case $2 in
  .DirIcon) ln -sf ${BUILD_MACHINE_ICON} squashfs-root/.DirIcon ;;
  Fleetify.png) printf '\\211PNG\\r\\n\\032\\nthe Fleetify icon\\n' > squashfs-root/Fleetify.png ;;
esac
`;

/** An app archive as a Mac release has one: Fleetify.app, its Info.plist naming the version and the archive's arch. */
function appArchive(version, arch) {
  const dir = folder(`app-${arch}`);
  const contents = join(dir, "Fleetify.app", "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>` +
      `<key>CFBundleShortVersionString</key><string>${version}</string>` +
      `<key>CFBundleExecutable</key><string>${APP_BINARY}</string>` +
      `<key>TestArch</key><string>${arch}</string></dict></plist>\n`,
  );
  writeFileSync(join(contents, "MacOS", APP_BINARY), `Fleetify ${version} for ${arch}\n`, { mode: 0o755 });
  const out = join(dir, "app.tar.gz");
  const result = spawnSync("tar", ["-czf", out, "-C", dir, "Fleetify.app"], { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  assert.equal(result.status, 0, `tar: ${result.stderr}`);
  return readFileSync(out);
}

/**
 * A release folder for `version`: every asset expectedAssets() names, and
 * SHA256SUMS over the others, passed through `sums` (to tamper with it).
 */
function makeRelease(version, { sums = (text) => text } = {}) {
  const dir = folder(`release-${version}`);
  const assets = assetsOf(version);
  const canTar = SKIP_MAC_STUB === false;
  const special = new Map([
    [assets.appimage, fakeAppImage(version)],
    [assets.macArm, canTar ? appArchive(version, "aarch64") : "no tar here\n"],
    [assets.macIntel, canTar ? appArchive(version, "x64") : "no tar here\n"],
    ...INSTALL_SCRIPTS.map((name) => [name, readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)))]),
  ]);
  const signatures = Object.fromEntries(updaterArtifacts(version).map(({ asset }) => [asset, `signature of ${asset}`]));
  special.set(MANIFEST, `${JSON.stringify(latestJson({ version, pubDate: PUB_DATE, signatures, base: downloadBase(version) }), null, 2)}\n`);
  const names = expectedAssets(version).filter((name) => name !== CHECKSUMS);
  for (const name of names) writeFileSync(join(dir, name), special.has(name) ? special.get(name) : `${name} of Fleetify ${version}\n`);
  writeFileSync(join(dir, CHECKSUMS), sums(sha256sums(names.map((name) => ({ name, sha256: sha256(readFileSync(join(dir, name))) })))));
  return dir;
}

/** Every hash in SHA256SUMS replaced by one that matches nothing in the release. */
const tamperAll = (text) => text.replace(/^[0-9a-f]{64}/gm, sha256("tampered"));

const SERVERS = [];

/** Give back write access to `dir` and every folder under it, which some tests take away; links aren't followed. */
function unlock(dir) {
  let entries;
  try {
    chmodSync(dir, 0o755);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) unlock(join(dir, entry.name));
}

// The servers first, so that nothing a failed test left behind keeps the run
// from ending; then the test folders, as far as they go.
after(async () => {
  await Promise.all(
    SERVERS.map(
      (server) =>
        new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
    ),
  );
  unlock(ROOT);
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Left in the system's temporary folder.
  }
});

/** A release folder served as GitHub serves a release: { dir, base, server, since() }. */
async function serve(dir, version) {
  const server = createReleaseServer({ dir, version });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  SERVERS.push(server);
  let mark = 0;
  return {
    dir,
    base: `http://127.0.0.1:${server.address().port}`,
    server,
    /** Start counting requests: since() then returns the ones made after it. */
    mark() {
      mark = server.requests.length;
    },
    since: () => server.requests.slice(mark),
  };
}

let GOOD;
let OTHER;
let TAMPERED;
let NO_LINE;
before(async () => {
  GOOD = await serve(makeRelease(V), V);
  OTHER = await serve(makeRelease(OTHER_V), OTHER_V);
  TAMPERED = await serve(makeRelease(V, { sums: tamperAll }), V);
  // The AppImage's line, and the .deb's, left out.
  NO_LINE = await serve(
    makeRelease(V, { sums: (text) => text.split("\n").filter((line) => !line.endsWith(`  ${ASSETS.appimage}`) && !line.endsWith(`  ${ASSETS.deb}`)).join("\n") }),
    V,
  );
});

// ── Running the scripts ─────────────────────────────────────────────────────

/** Run a command; resolves with its exit code and output. Variables set to undefined are left out. */
function runChild(command, args, { cwd, env, timeoutMs = 60_000 }) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} timed out:\n${stdout}${stderr}`));
    }, timeoutMs);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, output: stdout + stderr });
    });
  });
}

/** A test's own folders: a home, a TMPDIR, which must end up empty, and a working folder. */
function workspace() {
  const root = folder("ws");
  const ws = { root, home: join(root, "home"), tmp: join(root, "tmp"), work: join(root, "work") };
  for (const dir of [ws.home, ws.tmp, ws.work]) mkdirSync(dir);
  return ws;
}

/** What uname answers, for each platform a test can ask for. */
const PLATFORMS = {
  linux: { s: "Linux", m: "x86_64" },
  macArm: { s: "Darwin", m: "arm64" },
  macIntel: { s: "Darwin", m: "x86_64" },
};

/**
 * A stand-in that logs its name and arguments, one call a line, and, when
 * its last argument is a file, keeps a copy of it and the `ls -ld` line of
 * its folder: a package manager's view of the package it was handed. It
 * runs nothing, and exits STUB_EXIT (0 by default).
 */
const RECORD = `line=\${0##*/}
last=
for arg in "$@"; do line="$line $arg"; last=$arg; done
printf '%s\\n' "$line" >> "$STUB_LOG"
if [ -n "$last" ] && [ -f "$last" ]; then
  cp "$last" "$STUB_SEEN/"
  ls -ld "\${last%/*}" >> "$STUB_LOG.dirs"
fi
exit "\${STUB_EXIT:-0}"`;

/**
 * A folder of stand-ins: uname for `platform` (none when null), id, sudo, the
 * package managers in `managers`, and `extra`, { name: script body }.
 */
function stubFolder({ platform, managers, extra = {} }) {
  const dir = folder("stubs");
  const write = (name, body) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (platform !== null) write("uname", `case "$1" in -m) echo ${platform.m} ;; *) echo ${platform.s} ;; esac`);
  write("id", 'if [ "$1" = -u ]; then echo "${STUB_UID:-1000}"; else exit 1; fi');
  for (const name of ["sudo", ...managers]) write(name, RECORD);
  for (const [name, body] of Object.entries(extra)) write(name, body);
  return dir;
}

/** The system's own mv, which the mv stand-ins hand their work to. */
const REAL_MV = SKIP_SH ? null : which("mv");

/**
 * mv, recording: it logs each call to $STUB_LOG.mv, with the `ls -ld` line of
 * any staging folder (.fleetify.*) an argument is in, then does the move.
 */
const RECORDING_MV = `printf 'mv %s\\n' "$*" >> "$STUB_LOG.mv"
for arg in "$@"; do
  case $arg in */.fleetify.*/*) stage=\${arg%/*}; ls -ld "$stage" >> "$STUB_LOG.mv" ;; esac
done
exec ${REAL_MV} "$@"`;

/** mv, refusing only the rename that puts the staged Fleetify.app in its place. */
const FAILING_FINAL_RENAME = `case $1 in
*/.fleetify.*/Fleetify.app) case $2 in */Fleetify.app) echo "mv: the test refuses this rename" >&2; exit 1 ;; esac ;;
esac
exec ${REAL_MV} "$@"`;

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

/**
 * Run install.sh with `args` in `ws` (from ws.work unless `cwd`), against
 * `release`: { status, stdout, stderr, output, calls, dirs, appimageRuns,
 * seen }. calls are the stand-ins' log lines; dirs the `ls -ld` lines of the
 * folders of the files they were handed, copied into the folder `seen`;
 * appimageRuns the fake AppImage's argument lists.
 */
async function installSh(args, { ws, release, platform = PLATFORMS.linux, managers = [], stubs: extra = {}, uid, env = {}, cwd = ws.work, noIcon = false, stuck = false, command = [INSTALL_SH, ...args] }) {
  const stubs = stubFolder({ platform, managers, extra });
  const log = fresh("stub-log");
  const seen = folder("seen");
  const appimageLog = fresh("appimage-log");
  const result = await runChild(SH, command, {
    cwd,
    env: {
      PATH: `${stubs}${delimiter}${TOOLS_DIR}`,
      HOME: ws.home,
      TMPDIR: ws.tmp,
      LC_ALL: "C",
      FLEETIFY_INSTALL_BASE: release.base,
      STUB_LOG: log,
      STUB_SEEN: seen,
      STUB_UID: uid === undefined ? undefined : String(uid),
      FAKE_APPIMAGE_LOG: appimageLog,
      FAKE_APPIMAGE_NO_ICON: noIcon ? "1" : undefined,
      FAKE_APPIMAGE_STUCK: stuck ? "1" : undefined,
      ...env,
    },
  });
  return { ...result, calls: lines(log), dirs: lines(`${log}.dirs`), moves: lines(`${log}.mv`), appimageRuns: lines(appimageLog), seen };
}

/** Every file, folder and link under `dir`, with its mode, size, mtime and contents' hash: what a failed run must leave as it was. */
function snapshot(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
      return `${name} ${kind} ${stat.mode} ${stat.size} ${stat.mtimeMs} ${kind === "file" ? sha256(readFileSync(path)) : ""}`;
    });
}

/** The same, without the mtimes, which a rename back can change on a folder. */
const contents = (dir) => snapshot(dir).map((line) => line.replace(/ [0-9.]+ ([0-9a-f]{64})?$/, " $1"));

/** Assert that the staging folder named in `moves` (RECORDING_MV's log) was a new folder in `parent`, only its owner's, and is gone. */
function assertStaged(moves, parent, before) {
  const stages = [...new Set(moves.flatMap((line) => [...line.matchAll(/(\S*\/\.fleetify\.[A-Za-z0-9]{6})\//g)].map(([, stage]) => stage)))];
  assert.equal(stages.length, 1, `expected one staging folder:\n${moves.join("\n")}`);
  const [stage] = stages;
  assert.equal(stage.slice(0, stage.lastIndexOf("/")), parent, `the staging folder isn't beside the install:\n${moves.join("\n")}`);
  assert.ok(!before.includes(stage.slice(stage.lastIndexOf("/") + 1)), "the staging folder was there before the run");
  for (const line of moves.filter((entry) => entry.startsWith("d"))) assert.match(line, /^drwx------/, line);
  assert.ok(moves.some((entry) => entry.startsWith("d")), "the staging folder wasn't looked at");
  assert.equal(existsSync(stage), false, `${stage} was left behind`);
}

const desktopFile = (dataHome) => join(dataHome, "applications", "fleetify.desktop");
const iconFile = (dataHome) => join(dataHome, "icons", "hicolor", "256x256", "apps", "fleetify.png");

/** Assert that each line a run printed carries the scripts' prefix. */
function assertPrefixed(output) {
  for (const line of output.split("\n").filter(Boolean)) {
    assert.match(line, /^fleetify-install: /, `a line without the prefix:\n${output}`);
  }
}

// ── install.sh on Linux ─────────────────────────────────────────────────────

describe("install.sh on Linux: the AppImage", { skip: SKIP_LINUX }, () => {
  test("--version 0.2.0 --dir T/bin: the release's AppImage as T/bin/fleetify, executable, with its menu entry and icon", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    GOOD.mark();
    const run = await installSh(["--version", V, "--dir", bin], { ws, release: GOOD });
    assert.equal(run.status, 0, run.output);
    const installed = join(bin, "fleetify");
    assert.deepEqual(readFileSync(installed), readFileSync(join(GOOD.dir, ASSETS.appimage)));
    assert.equal(statSync(installed).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(bin), ["fleetify"], "something else was left in the folder");

    const data = join(ws.home, ".local", "share");
    const entry = readFileSync(desktopFile(data), "utf8").split("\n");
    assert.ok(entry.includes(`Exec=${installed} %U`), entry.join("\n"));
    for (const line of ["[Desktop Entry]", "Type=Application", "Name=Fleetify", "Icon=fleetify", "Terminal=false", "Categories=Development;", `StartupWMClass=${APP_BINARY}`]) {
      assert.ok(entry.includes(line), `no ${line} in:\n${entry.join("\n")}`);
    }
    assert.deepEqual(readFileSync(iconFile(data)), ICON);

    // The AppImage ran only to give up its icon; nothing asked for a password.
    assert.ok(run.appimageRuns.length > 0, "the AppImage's icon wasn't taken out");
    assert.equal(run.appimageRuns[0], "--appimage-extract .DirIcon");
    for (const args of run.appimageRuns) assert.match(args, /^--appimage-extract \S+$/);
    assert.deepEqual(run.calls, []);
    // It fetched the release's own files, by their tag's path: SHA256SUMS and the AppImage.
    assert.deepEqual(GOOD.since().sort(), [`/download/v${V}/${ASSETS.appimage}`, `/download/v${V}/${CHECKSUMS}`].sort());
    assert.deepEqual(readdirSync(ws.tmp), [], "its temporary folder was left behind");
    assertPrefixed(run.output);
  });

  test("without --version, it installs the version the latest release's latest.json gives", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    OTHER.mark();
    const run = await installSh(["--dir", bin], { ws, release: OTHER });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(readFileSync(join(bin, "fleetify")), readFileSync(join(OTHER.dir, assetsOf(OTHER_V).appimage)));
    const requests = OTHER.since();
    assert.equal(requests[0], `/latest/download/${MANIFEST}`, requests.join("\n"));
    assert.ok(requests.includes(`/download/v${OTHER_V}/${assetsOf(OTHER_V).appimage}`), requests.join("\n"));
    assert.ok(run.stdout.includes(OTHER_V), run.stdout);
  });

  test("its defaults: ~/.local/bin, and the menu entry and icon under XDG_DATA_HOME when that is an absolute path, else ~/.local/share", async () => {
    const plain = workspace();
    const first = await installSh([], { ws: plain, release: GOOD });
    assert.equal(first.status, 0, first.output);
    const installed = join(plain.home, ".local", "bin", "fleetify");
    assert.deepEqual(readFileSync(installed), readFileSync(join(GOOD.dir, ASSETS.appimage)));
    assert.ok(readFileSync(desktopFile(join(plain.home, ".local", "share")), "utf8").includes(`Exec=${installed} %U\n`));
    assert.ok(existsSync(iconFile(join(plain.home, ".local", "share"))));

    const xdg = workspace();
    const data = join(xdg.root, "data");
    const second = await installSh([], { ws: xdg, release: GOOD, env: { XDG_DATA_HOME: data } });
    assert.equal(second.status, 0, second.output);
    assert.ok(existsSync(desktopFile(data)) && existsSync(iconFile(data)));
    assert.equal(existsSync(join(xdg.home, ".local", "share")), false);

    // The Base Directory spec says to ignore a relative one.
    const relative = workspace();
    const third = await installSh([], { ws: relative, release: GOOD, env: { XDG_DATA_HOME: "data" } });
    assert.equal(third.status, 0, third.output);
    assert.ok(existsSync(desktopFile(join(relative.home, ".local", "share"))));
    assert.equal(existsSync(join(relative.work, "data")), false);
  });

  test("a relative --dir: the menu entry runs the AppImage by its absolute path", async () => {
    const ws = workspace();
    const run = await installSh(["--dir", "apps/bin"], { ws, release: GOOD });
    assert.equal(run.status, 0, run.output);
    const installed = join(ws.work, "apps", "bin", "fleetify");
    assert.ok(existsSync(installed));
    assert.ok(readFileSync(desktopFile(join(ws.home, ".local", "share")), "utf8").includes(`Exec=${installed} %U\n`));
  });

  test("a --dir with a space, a quote or a dollar sign: the menu entry quotes the path, escaped as the Desktop Entry spec asks", async () => {
    for (const [name, exec] of [
      ["my apps", (root) => `Exec="${root}/my apps/fleetify" %U`],
      ['a"b$c', (root) => `Exec="${root}/a\\\\"b\\\\$c/fleetify" %U`],
    ]) {
      const ws = workspace();
      const run = await installSh(["--dir", join(ws.root, name)], { ws, release: GOOD });
      assert.equal(run.status, 0, run.output);
      assert.ok(existsSync(join(ws.root, name, "fleetify")));
      const entry = readFileSync(desktopFile(join(ws.home, ".local", "share")), "utf8").split("\n");
      assert.ok(entry.includes(exec(ws.root)), `expected ${exec(ws.root)} in:\n${entry.join("\n")}`);
    }
  });

  test("a second run replaces the install, whatever became of it, and leaves nothing else behind", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    const first = await installSh(["--dir", bin], { ws, release: GOOD });
    assert.equal(first.status, 0, first.output);
    const data = join(ws.home, ".local", "share");
    const entry = readFileSync(desktopFile(data), "utf8");
    writeFileSync(join(bin, "fleetify"), "something else\n");
    writeFileSync(desktopFile(data), "[Desktop Entry]\nExec=elsewhere\n");
    rmSync(iconFile(data));

    const second = await installSh(["--dir", bin], { ws, release: GOOD });
    assert.equal(second.status, 0, second.output);
    assert.deepEqual(readFileSync(join(bin, "fleetify")), readFileSync(join(GOOD.dir, ASSETS.appimage)));
    assert.equal(statSync(join(bin, "fleetify")).mode & 0o777, 0o755);
    assert.equal(readFileSync(desktopFile(data), "utf8"), entry);
    assert.deepEqual(readFileSync(iconFile(data)), ICON);
    assert.deepEqual(readdirSync(bin), ["fleetify"]);
    assert.deepEqual(readdirSync(join(data, "applications")), ["fleetify.desktop"]);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test("the AppImage is staged in a new folder of its own beside the install, which only you can open, and which goes afterwards", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    mkdirSync(bin);
    const before = readdirSync(bin);
    const run = await installSh(["--dir", bin], { ws, release: GOOD, stubs: { mv: RECORDING_MV } });
    assert.equal(run.status, 0, run.output);
    assertStaged(run.moves, bin, before);
    // The final rename, from that folder onto the install.
    const final = new RegExp(`^mv (-f )?${escapeRe(bin)}/\\.fleetify\\.[A-Za-z0-9]{6}/fleetify ${escapeRe(join(bin, "fleetify"))}$`);
    assert.ok(run.moves.some((line) => final.test(line)), run.moves.join("\n"));
    assert.deepEqual(readdirSync(bin), ["fleetify"]);
  });

  test(
    "a temporary folder that can't be removed: a warning naming it, and the install still succeeds",
    { skip: process.getuid?.() === 0 && "root can remove anything" },
    async () => {
      const ws = workspace();
      const bin = join(ws.root, "bin");
      try {
        const run = await installSh(["--dir", bin], { ws, release: GOOD, stuck: true });
        assert.equal(run.status, 0, run.output);
        assert.deepEqual(readFileSync(join(bin, "fleetify")), readFileSync(join(GOOD.dir, ASSETS.appimage)));
        const warning = /^fleetify-install: warning: couldn't remove the temporary folder (.+)$/m.exec(run.stderr);
        assert.ok(warning, run.stderr);
        assert.match(warning[1], new RegExp(`^${escapeRe(ws.tmp)}/fleetify-install\\.[A-Za-z0-9]{6}$`));
        assert.ok(existsSync(warning[1]));
      } finally {
        unlock(ws.tmp);
      }
    },
  );

  test("an AppImage whose icon can't be taken out: a warning, and the rest is installed", async () => {
    const ws = workspace();
    const run = await installSh(["--dir", join(ws.root, "bin")], { ws, release: GOOD, noIcon: true });
    assert.equal(run.status, 0, run.output);
    assert.match(run.stderr, /^fleetify-install: warning: .*icon/m);
    const data = join(ws.home, ".local", "share");
    assert.ok(existsSync(join(ws.root, "bin", "fleetify")) && existsSync(desktopFile(data)));
    assert.equal(existsSync(iconFile(data)), false);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });
});

describe("install.sh refuses a download that doesn't match SHA256SUMS", { skip: SKIP_LINUX }, () => {
  test("a tampered SHA256SUMS: exit 1, saying the checksum doesn't match, and nothing is installed", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    const run = await installSh(["--version", V, "--dir", bin], { ws, release: TAMPERED });
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /checksum/);
    assert.match(run.stderr, /nothing was installed/);
    assert.equal(existsSync(join(bin, "fleetify")), false);
    assert.deepEqual(snapshot(ws.home), [], "the run wrote into the home");
    assert.deepEqual(run.appimageRuns, [], "the download ran");
    assert.deepEqual(run.calls, []);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test("an earlier install is left exactly as it was", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    const good = await installSh(["--dir", bin], { ws, release: GOOD });
    assert.equal(good.status, 0, good.output);
    const before = [snapshot(bin), snapshot(ws.home)];
    const run = await installSh(["--dir", bin], { ws, release: TAMPERED });
    assert.equal(run.status, 1, run.output);
    assert.deepEqual([snapshot(bin), snapshot(ws.home)], before);
  });

  test("no line for the file in SHA256SUMS: exit 1, and nothing is installed", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    const run = await installSh(["--dir", bin], { ws, release: NO_LINE });
    assert.equal(run.status, 1, run.output);
    assert.ok(run.stderr.includes(`SHA256SUMS has no line for ${ASSETS.appimage}`), run.stderr);
    assert.equal(existsSync(join(bin, "fleetify")), false);
    assert.deepEqual(snapshot(ws.home), []);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test("two lines for the file in SHA256SUMS: exit 1, and nothing is installed", async () => {
    // The same line twice: SHA256SUMS lists each file once, so it isn't the release's.
    const line = readFileSync(join(GOOD.dir, CHECKSUMS), "utf8").split("\n").find((entry) => entry.endsWith(`  ${ASSETS.appimage}`));
    const twice = await serve(makeRelease(V, { sums: (text) => `${text}${line}\n` }), V);
    const ws = workspace();
    const bin = join(ws.root, "bin");
    const run = await installSh(["--dir", bin], { ws, release: twice });
    assert.equal(run.status, 1, run.output);
    assert.ok(run.stderr.includes(`SHA256SUMS has more than one line for ${ASSETS.appimage}`), run.stderr);
    assert.equal(existsSync(join(bin, "fleetify")), false);
    assert.deepEqual(snapshot(ws.home), []);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test("the same for a package: nothing is saved, and the package manager doesn't run", async () => {
    const saved = workspace();
    const download = await installSh(["--deb", "--download-only"], { ws: saved, release: TAMPERED });
    assert.equal(download.status, 1, download.output);
    assert.match(download.stderr, /checksum/);
    assert.deepEqual(readdirSync(saved.work), []);

    const installed = workspace();
    const run = await installSh(["--rpm"], { ws: installed, release: TAMPERED, managers: ["dnf"] });
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /checksum/);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(readdirSync(installed.tmp), []);
  });
});

describe("install.sh on Linux: --deb and --rpm", { skip: SKIP_LINUX }, () => {
  test("--deb --download-only: the checked .deb in the current folder, and the apt-get command printed, not run", async () => {
    const ws = workspace();
    const run = await installSh(["--deb", "--download-only"], { ws, release: GOOD, managers: ["apt-get"] });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(readdirSync(ws.work), [ASSETS.deb]);
    assert.deepEqual(readFileSync(join(ws.work, ASSETS.deb)), readFileSync(join(GOOD.dir, ASSETS.deb)));
    assert.ok(run.stdout.includes(`sudo apt-get install -y ./${ASSETS.deb}`), run.stdout);
    assert.match(run.stdout, /checksum OK/);
    assert.deepEqual(run.calls, [], "it ran sudo or apt-get");
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test("--rpm --download-only --dir: the checked .rpm there, and the command printed with its path", async () => {
    const ws = workspace();
    const run = await installSh(["--rpm", "--download-only", "--dir", "pkgs"], { ws, release: GOOD, managers: ["dnf"] });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(readFileSync(join(ws.work, "pkgs", ASSETS.rpm)), readFileSync(join(GOOD.dir, ASSETS.rpm)));
    assert.ok(run.stdout.includes(`sudo dnf install -y pkgs/${ASSETS.rpm}`), run.stdout);
    assert.deepEqual(run.calls, []);
  });

  test("--rpm --download-only with neither dnf nor zypper here: both commands, for Fedora and for openSUSE", async () => {
    const ws = workspace();
    const run = await installSh(["--rpm", "--download-only"], { ws, release: GOOD, managers: [] });
    assert.equal(run.status, 0, run.output);
    assert.ok(existsSync(join(ws.work, ASSETS.rpm)));
    assert.ok(run.stdout.includes(`fleetify-install: to install it on Fedora, run: sudo dnf install -y ./${ASSETS.rpm}\n`), run.stdout);
    assert.ok(run.stdout.includes(`fleetify-install: or on openSUSE: sudo zypper --non-interactive install --allow-unsigned-rpm ./${ASSETS.rpm}\n`), run.stdout);
    assert.deepEqual(run.calls, []);
  });

  test("--deb: the command is printed, then run through sudo, on the checked package, in a folder no one else can change", async () => {
    const ws = workspace();
    const run = await installSh(["--deb"], { ws, release: GOOD, managers: ["apt-get"] });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.calls.length, 1, run.calls.join("\n"));
    const match = /^sudo apt-get install -y (\/\S+)$/.exec(run.calls[0]);
    assert.ok(match, run.calls[0]);
    const [, path] = match;
    assert.ok(path.startsWith(`${ws.tmp}/`) && path.endsWith(`/${ASSETS.deb}`), path);
    const printed = run.stdout.indexOf(`fleetify-install: running: sudo apt-get install -y ${path}\n`);
    assert.ok(printed !== -1, run.stdout);
    // apt-get got the release's .deb, from a folder only its owner can write to.
    assert.deepEqual(readFileSync(join(run.seen, ASSETS.deb)), readFileSync(join(GOOD.dir, ASSETS.deb)));
    assert.match(run.dirs[0], /^d.{4}-.{2}-/, run.dirs[0]);
    assert.deepEqual(readdirSync(ws.work), [], "the package was left in the current folder");
    assert.deepEqual(readdirSync(ws.tmp), [], "the package was left behind");
  });

  test("--rpm: dnf when it is there, else zypper; with neither, exit 1", async () => {
    const both = await installSh(["--rpm"], { ws: workspace(), release: GOOD, managers: ["dnf", "zypper"] });
    assert.equal(both.status, 0, both.output);
    assert.equal(both.calls.length, 1, both.calls.join("\n"));
    assert.match(both.calls[0], new RegExp(`^sudo dnf install -y /\\S+/${ASSETS.rpm.replace(/\./g, "\\.")}$`));

    const zypper = await installSh(["--rpm"], { ws: workspace(), release: GOOD, managers: ["zypper"] });
    assert.equal(zypper.status, 0, zypper.output);
    assert.equal(zypper.calls.length, 1, zypper.calls.join("\n"));
    assert.match(zypper.calls[0], new RegExp(`^sudo zypper --non-interactive install --allow-unsigned-rpm /\\S+/${ASSETS.rpm.replace(/\./g, "\\.")}$`));
    assert.deepEqual(readFileSync(join(zypper.seen, ASSETS.rpm)), readFileSync(join(GOOD.dir, ASSETS.rpm)));

    const neither = await installSh(["--rpm"], { ws: workspace(), release: GOOD, managers: [] });
    assert.equal(neither.status, 1, neither.output);
    assert.match(neither.stderr, /dnf/);
    assert.deepEqual(neither.calls, []);
  });

  test("a package manager that fails: exit 1, naming it, and no claim that Fleetify is installed", async () => {
    const ws = workspace();
    const run = await installSh(["--deb"], { ws, release: GOOD, managers: ["apt-get"], env: { STUB_EXIT: "100" } });
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /^fleetify-install: error: apt-get couldn't install /m);
    assert.doesNotMatch(run.stdout, /is installed/);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test("--deb without apt-get: exit 1, and nothing runs", async () => {
    const run = await installSh(["--deb"], { ws: workspace(), release: GOOD, managers: ["dnf"] });
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /apt-get/);
    assert.deepEqual(run.calls, []);
  });

  test("as root, the package manager runs without sudo", async () => {
    const run = await installSh(["--deb"], { ws: workspace(), release: GOOD, managers: ["apt-get"], uid: 0 });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.calls.length, 1, run.calls.join("\n"));
    assert.match(run.calls[0], /^apt-get install -y \/\S+$/);
    assert.match(run.stdout, /^fleetify-install: running: apt-get install -y /m);
  });
});

describe("install.sh's options", { skip: SKIP_LINUX }, () => {
  test("an unknown option, or a bad value: exit 2 with the usage, before anything is downloaded or written", async () => {
    for (const args of [
      ["--bogus"],
      [V],
      ["--version"],
      ["--version", ""],
      ["--version="],
      ["--version", "0.2"],
      ["--version", "01.2.0"],
      ["--version", "0.2.0-rc.1"],
      ["--version", "0.2.0\n1.0.0"],
      ["--version=0.2"],
      ["--deb", "--rpm"],
      ["--appimage", "--deb"],
      ["--dir"],
      ["--dir", ""],
      ["--dir", "--deb"],
      ["--dir", "-x"],
      ["--dir=-x"],
      ["--deb", "--dir", "pkgs"],
    ]) {
      const ws = workspace();
      GOOD.mark();
      const run = await installSh(args, { ws, release: GOOD, managers: ["apt-get", "dnf"] });
      const where = JSON.stringify(args);
      assert.equal(run.status, 2, `${where}:\n${run.output}`);
      assert.match(run.stderr, /^usage: /m, where);
      assert.match(run.stderr, /^fleetify-install: /, where);
      assert.equal(run.stdout, "", where);
      assert.deepEqual(GOOD.since(), [], `${where} downloaded`);
      assert.deepEqual([snapshot(ws.home), snapshot(ws.work), readdirSync(ws.tmp)], [[], [], []], `${where} wrote something`);
    }
  });

  test("-h and --help print the usage and exit 0", async () => {
    for (const flag of ["-h", "--help"]) {
      const run = await installSh([flag], { ws: workspace(), release: GOOD });
      assert.equal(run.status, 0, run.output);
      assert.match(run.stdout, /^usage: install\.sh /m);
      for (const option of ["--version", "--appimage", "--deb", "--rpm", "--dir", "--download-only", "FLEETIFY_INSTALL_BASE"]) {
        assert.ok(run.stdout.includes(option), `${flag}: the usage doesn't mention ${option}`);
      }
      assert.equal(run.stderr, "");
    }
  });

  test("--version takes v0.2.0 and --version=0.2.0 too", async () => {
    for (const args of [["--version", `v${V}`], [`--version=${V}`]]) {
      const ws = workspace();
      GOOD.mark();
      const run = await installSh([...args, "--dir", join(ws.root, "bin")], { ws, release: GOOD });
      assert.equal(run.status, 0, `${args.join(" ")}:\n${run.output}`);
      assert.ok(GOOD.since().includes(`/download/v${V}/${ASSETS.appimage}`), GOOD.since().join("\n"));
    }
  });

  test("a FLEETIFY_INSTALL_BASE that isn't an http or https URL: exit 2", async () => {
    for (const base of ["ftp://127.0.0.1/releases", "file:///tmp/releases", "127.0.0.1:18081"]) {
      const run = await installSh([], { ws: workspace(), release: { base } });
      assert.equal(run.status, 2, `${base}:\n${run.output}`);
      assert.match(run.stderr, /FLEETIFY_INSTALL_BASE/);
    }
  });

  test("a platform Fleetify isn't built for: exit 1, naming it; --deb on a Mac: exit 2", async () => {
    const freebsd = await installSh([], { ws: workspace(), release: GOOD, platform: { s: "FreeBSD", m: "amd64" } });
    assert.equal(freebsd.status, 1, freebsd.output);
    assert.match(freebsd.stderr, /FreeBSD/);
    const arm = await installSh([], { ws: workspace(), release: GOOD, platform: { s: "Linux", m: "aarch64" } });
    assert.equal(arm.status, 1, arm.output);
    assert.match(arm.stderr, /aarch64/);
    for (const flag of ["--deb", "--rpm", "--appimage"]) {
      const mac = await installSh([flag], { ws: workspace(), release: GOOD, platform: PLATFORMS.macArm });
      assert.equal(mac.status, 2, `${flag}:\n${mac.output}`);
      assert.match(mac.stderr, /Linux/);
    }
  });

  test("a release that isn't there: exit 1, naming what it couldn't download", async () => {
    const ws = workspace();
    const run = await installSh(["--version", "9.9.9", "--dir", join(ws.root, "bin")], { ws, release: GOOD });
    assert.equal(run.status, 1, run.output);
    assert.ok(run.stderr.includes(`${GOOD.base}/download/v9.9.9/`), run.stderr);
    assert.equal(existsSync(join(ws.root, "bin")), false);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });
});

// ── install.sh on macOS ─────────────────────────────────────────────────────

/** The arch an app archive's Info.plist names (appArchive). */
const archOf = (app) => /<key>TestArch<\/key><string>([^<]+)<\/string>/.exec(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))?.[1];

describe("install.sh on macOS, with uname saying Darwin", { skip: SKIP_MAC_STUB }, () => {
  test("Apple silicon gets the aarch64 app archive and an Intel Mac the x64 one, unpacked into --dir as Fleetify.app", async () => {
    for (const [platform, arch, asset] of [
      [PLATFORMS.macArm, "aarch64", ASSETS.macArm],
      [PLATFORMS.macIntel, "x64", ASSETS.macIntel],
    ]) {
      const ws = workspace();
      const apps = join(ws.root, "Applications");
      GOOD.mark();
      const run = await installSh(["--dir", apps], { ws, release: GOOD, platform });
      assert.equal(run.status, 0, run.output);
      assert.equal(archOf(join(apps, "Fleetify.app")), arch);
      assert.ok(existsSync(join(apps, "Fleetify.app", "Contents", "MacOS", APP_BINARY)));
      assert.deepEqual(readdirSync(apps), ["Fleetify.app"], "something else was left in the folder");
      // The latest release's latest.json (redirected to its tag's copy), then SHA256SUMS and this Mac's archive.
      assert.deepEqual(GOOD.since().sort(), [`/latest/download/${MANIFEST}`, `/download/v${V}/${MANIFEST}`, `/download/v${V}/${asset}`, `/download/v${V}/${CHECKSUMS}`].sort());
      assert.deepEqual(run.calls, []);
      assert.deepEqual(snapshot(ws.home), [], "it wrote into the home");
      assert.deepEqual(readdirSync(ws.tmp), []);
      assertPrefixed(run.output);
    }
  });

  test("an earlier Fleetify.app is replaced, not merged into", async () => {
    const ws = workspace();
    const apps = join(ws.root, "Applications");
    mkdirSync(join(apps, "Fleetify.app", "Contents"), { recursive: true });
    writeFileSync(join(apps, "Fleetify.app", "Contents", "stale.txt"), "from an earlier version\n");
    const run = await installSh(["--dir", apps], { ws, release: GOOD, platform: PLATFORMS.macArm });
    assert.equal(run.status, 0, run.output);
    assert.equal(existsSync(join(apps, "Fleetify.app", "Contents", "stale.txt")), false);
    assert.equal(archOf(join(apps, "Fleetify.app")), "aarch64");
    assert.deepEqual(readdirSync(apps), ["Fleetify.app"]);
  });

  test("the app is staged in a new folder of its own beside the install, which only you can open, and which goes afterwards", async () => {
    const ws = workspace();
    const apps = join(ws.root, "Applications");
    mkdirSync(join(apps, "Fleetify.app", "Contents"), { recursive: true });
    const before = readdirSync(apps);
    const run = await installSh(["--dir", apps], { ws, release: GOOD, platform: PLATFORMS.macArm, stubs: { mv: RECORDING_MV } });
    assert.equal(run.status, 0, run.output);
    assertStaged(run.moves, apps, before);
    // The earlier app went aside into that folder, and the new one came out of it.
    const target = join(apps, "Fleetify.app");
    const stage = `${escapeRe(apps)}/\\.fleetify\\.[A-Za-z0-9]{6}`;
    assert.ok(run.moves.some((line) => new RegExp(`^mv ${escapeRe(target)} ${stage}/Fleetify\\.app\\.old$`).test(line)), run.moves.join("\n"));
    assert.ok(run.moves.some((line) => new RegExp(`^mv ${stage}/Fleetify\\.app ${escapeRe(target)}$`).test(line)), run.moves.join("\n"));
    assert.deepEqual(readdirSync(apps), ["Fleetify.app"]);
  });

  test("when the final rename fails: exit 1, and the earlier Fleetify.app is back, with nothing half installed", async () => {
    const ws = workspace();
    const apps = join(ws.root, "Applications");
    mkdirSync(join(apps, "Fleetify.app", "Contents"), { recursive: true });
    writeFileSync(join(apps, "Fleetify.app", "Contents", "earlier.txt"), "the earlier version\n");
    const before = contents(apps);
    const run = await installSh(["--dir", apps], { ws, release: GOOD, platform: PLATFORMS.macArm, stubs: { mv: FAILING_FINAL_RENAME } });
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /^fleetify-install: error: can't install /m);
    assert.deepEqual(contents(apps), before);
    assert.deepEqual(readdirSync(apps), ["Fleetify.app"]);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test(
    "an earlier copy that can't be removed: a warning naming it, and the new app is installed all the same",
    { skip: process.getuid?.() === 0 && "root can remove anything" },
    async () => {
      const ws = workspace();
      const apps = join(ws.root, "Applications");
      const locked = join(apps, "Fleetify.app", "Contents", "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "stuck.txt"), "can't be removed\n");
      chmodSync(locked, 0o555);
      let leftover;
      try {
        const run = await installSh(["--dir", apps], { ws, release: GOOD, platform: PLATFORMS.macArm });
        assert.equal(run.status, 0, run.output);
        assert.equal(archOf(join(apps, "Fleetify.app")), "aarch64");
        const warning = /^fleetify-install: warning: couldn't remove the earlier copy, (.+)$/m.exec(run.stderr);
        assert.ok(warning, run.stderr);
        [, leftover] = warning;
        assert.match(leftover, new RegExp(`^${escapeRe(apps)}/\\.fleetify\\.[A-Za-z0-9]{6}/Fleetify\\.app\\.old$`));
        assert.ok(existsSync(join(leftover, "Contents", "locked", "stuck.txt")), "the leftover isn't where the warning says");
        assert.deepEqual(readdirSync(apps).filter((name) => name !== "Fleetify.app"), [leftover.split("/").at(-2)], "something else was left");
        assert.deepEqual(readdirSync(ws.tmp), []);
      } finally {
        unlock(apps);
      }
    },
  );

  test("a tampered SHA256SUMS: exit 1, and an earlier Fleetify.app is left as it was", async () => {
    const ws = workspace();
    const apps = join(ws.root, "Applications");
    const good = await installSh(["--dir", apps], { ws, release: GOOD, platform: PLATFORMS.macArm });
    assert.equal(good.status, 0, good.output);
    const before = snapshot(apps);
    const run = await installSh(["--dir", apps], { ws, release: TAMPERED, platform: PLATFORMS.macArm });
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /checksum/);
    assert.deepEqual(snapshot(apps), before);
    assert.deepEqual(readdirSync(ws.tmp), []);
  });

  test(
    "without --dir: ~/Applications when /Applications can't be written to",
    { skip: (() => { try { accessSync("/Applications", constants.W_OK); return "/Applications can be written to here"; } catch { return false; } })() },
    async () => {
      const ws = workspace();
      const run = await installSh([], { ws, release: GOOD, platform: PLATFORMS.macIntel });
      assert.equal(run.status, 0, run.output);
      assert.equal(archOf(join(ws.home, "Applications", "Fleetify.app")), "x64");
    },
  );
});

describe("install.sh on this Mac", { skip: process.platform !== "darwin" ? "runs on macOS only" : SKIP_MAC_STUB }, () => {
  test("--dir T/Applications: Fleetify.app from the app archive for this Mac", async () => {
    const ws = workspace();
    const apps = join(ws.root, "Applications");
    GOOD.mark();
    // uname and sysctl are the Mac's own.
    for (const name of ["uname", "sysctl"]) {
      const path = which(name);
      if (path !== null && !existsSync(join(TOOLS_DIR, name))) symlinkSync(path, join(TOOLS_DIR, name));
    }
    const run = await installSh(["--dir", apps], { ws, release: GOOD, platform: null });
    assert.equal(run.status, 0, run.output);
    assert.ok(["aarch64", "x64"].includes(archOf(join(apps, "Fleetify.app"))));
    assert.ok(GOOD.since().some((path) => path === `/download/v${V}/${ASSETS.macArm}` || path === `/download/v${V}/${ASSETS.macIntel}`));
  });
});

// ── install.sh piped into sh ────────────────────────────────────────────────

describe("install.sh piped into sh, as the one-liner runs it", { skip: SKIP_LINUX }, () => {
  test("curl -fsSL …/latest/download/install.sh | sh -s -- --dir T/bin installs the AppImage", async () => {
    const ws = workspace();
    const bin = join(ws.root, "bin");
    GOOD.mark();
    const run = await installSh([], {
      ws,
      release: GOOD,
      command: ["-c", 'curl -fsSL "$FLEETIFY_INSTALL_BASE/latest/download/install.sh" | sh -s -- --dir "$1"', "sh", bin],
    });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(readFileSync(join(bin, "fleetify")), readFileSync(join(GOOD.dir, ASSETS.appimage)));
    const requests = GOOD.since();
    assert.deepEqual(requests.slice(0, 2), ["/latest/download/install.sh", `/download/v${V}/install.sh`]);
    assert.ok(requests.includes(`/latest/download/${MANIFEST}`), requests.join("\n"));
  });
});

// ── The scripts' text ───────────────────────────────────────────────────────

describe("the install scripts' text", () => {
  test("both are plain ASCII with LF line endings: Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page, and sh can't run CRLF", () => {
    for (const script of [INSTALL_SH, INSTALL_PS1]) {
      const bytes = readFileSync(script);
      const odd = [...bytes].findIndex((byte) => byte > 0x7e || (byte < 0x20 && byte !== 0x0a && byte !== 0x09));
      assert.equal(odd, -1, `${script}: byte ${bytes[odd]} at ${odd}`);
    }
  });

  test("install.sh, cut short anywhere, as a pipe that breaks off delivers it, runs nothing: only its last line calls main", { skip: SKIP_SH }, () => {
    const text = readFileSync(INSTALL_SH, "utf8");
    assert.equal(text.split("\n")[0], "#!/bin/sh");
    assert.equal(text.trimEnd().split("\n").at(-1), 'main "$@"');
    // Every command it could run, as a stand-in that logs its name, and
    // nothing else on PATH; a home, a TMPDIR and a working folder of their own.
    const stand = folder("prefix-stubs");
    const log = fresh("prefix-log");
    const commands = [...new Set([...TOOLS, "apt-get", "basename", "cat", "date", "dirname", "dnf", "env", "find", "head", "id", "od", "sleep", "sudo", "sysctl", "tail", "tee", "touch", "tr", "uname", "wc", "xargs", "zypper"])];
    for (const name of commands) writeFileSync(join(stand, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n`, { mode: 0o755 });
    const scratch = workspace();
    const env = { PATH: stand, HOME: scratch.home, TMPDIR: scratch.tmp, XDG_DATA_HOME: join(scratch.home, "data"), LC_ALL: "C", FLEETIFY_INSTALL_BASE: "http://127.0.0.1:9" };
    const run = (input) => spawnSync(SH, ["-s"], { input, cwd: scratch.work, env, encoding: "utf8" });
    const all = text.split("\n");
    const ran = [];
    // Each prefix that ends at a line's end, short of the whole script.
    for (let n = 1; n < all.length - 1; n += 1) {
      run(`${all.slice(0, n).join("\n")}\n`);
      const calls = lines(log);
      if (calls.length > 0) {
        ran.push(`after line ${n} (${all[n - 1]}): ${calls.join("; ")}`);
        rmSync(log);
      }
    }
    assert.deepEqual(ran, [], "a cut-short install.sh ran commands");
    assert.deepEqual([snapshot(scratch.home), snapshot(scratch.tmp), snapshot(scratch.work)], [[], [], []], "a cut-short install.sh wrote files");
    // The whole script does run: the stand-ins would have seen a prefix that did.
    run(text);
    assert.ok(lines(log).some((call) => call.startsWith("uname ")), `the whole script didn't reach uname: ${lines(log).join("; ")}`);
  });

  test("install.ps1 has none of the syntax PowerShell 6 and 7 added, so Windows PowerShell 5.1 can run it", () => {
    // Comment lines and block comments out; the code holds no strings with these characters.
    const code = readFileSync(INSTALL_PS1, "utf8")
      .replace(/<#[\s\S]*?#>/g, "")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const [pattern, what] of [
      [/\?\?/, "a null-coalescing operator (??, ??=)"],
      [/\?\./, "a null-conditional member access (?.)"],
      [/\?\[/, "a null-conditional index (?[)"],
      [/&&|\|\|/, "a pipeline chain operator (&&, ||)"],
      [/\s\?\s/, "a ternary operator (or the ? alias)"],
      [/-Parallel\b/, "ForEach-Object -Parallel"],
      [/\bclean\s*\{/, "a clean block"],
    ]) {
      assert.doesNotMatch(code, pattern, `install.ps1 uses ${what}`);
    }
  });

  const shellcheck = SKIP_SH ? null : which("shellcheck");
  test("shellcheck, as POSIX sh, finds nothing in install.sh", { skip: shellcheck === null && "shellcheck isn't installed" }, () => {
    const result = spawnSync(shellcheck, ["-s", "sh", INSTALL_SH], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "");
  });
});

// ── install.ps1 ─────────────────────────────────────────────────────────────

const PWSH = which("pwsh");

/**
 * A pwsh script that prints install.ps1's top level as JSON: whether it has
 * a param block, how many other blocks, and each statement of its body with
 * its type, a function's name, the commands it calls and its method calls.
 */
const TOP_LEVEL = `param([string]$Path)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$calls = { param($node) $node -is [System.Management.Automation.Language.CommandAst] }
$methods = { param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }
$statements = @(foreach ($statement in $ast.EndBlock.Statements) {
  $name = ''
  if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) { $name = $statement.Name }
  [ordered]@{
    type = $statement.GetType().Name
    name = $name
    commands = @($statement.FindAll($calls, $true) | ForEach-Object { $_.GetCommandName() })
    methods = @($statement.FindAll($methods, $true)).Count
  }
})
[ordered]@{
  param = $null -ne $ast.ParamBlock
  blocks = @(@($ast.BeginBlock, $ast.ProcessBlock, $ast.DynamicParamBlock) | Where-Object { $null -ne $_ }).Count
  statements = $statements
} | ConvertTo-Json -Depth 5 -Compress
`;

/** Run pwsh with `args`, its home and TEMP in `ws`: { status, stdout, stderr, output }. */
function pwsh(args, { ws, env = {} }) {
  return runChild(PWSH, ["-NoLogo", "-NoProfile", "-NonInteractive", ...args], {
    cwd: ws.work,
    env: {
      ...process.env,
      HOME: ws.home,
      TEMP: ws.tmp,
      TMP: ws.tmp,
      TMPDIR: ws.tmp,
      FLEETIFY_INSTALL_BASE: undefined,
      FLEETIFY_VERSION: undefined,
      POWERSHELL_TELEMETRY_OPTOUT: "1",
      POWERSHELL_UPDATECHECK: "Off",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      ...env,
    },
    timeoutMs: 120_000,
  });
}

/** Run install.ps1 with `args` as a script file. */
const installPs1 = (args, options) => pwsh(["-File", INSTALL_PS1, ...args], options);

/**
 * The folder a run of install.ps1 downloaded into: on Windows,
 * $env:TEMP\fleetify-install; elsewhere, the one new fleetify-install-<GUID>
 * folder in the temporary folder.
 */
function downloads(ws) {
  if (process.platform === "win32") return join(ws.tmp, "fleetify-install");
  const made = readdirSync(ws.tmp).filter((name) => /^fleetify-install-[0-9a-f]{32}$/.test(name));
  assert.equal(made.length, 1, `expected one download folder in ${ws.tmp}, found: ${readdirSync(ws.tmp).join(", ")}`);
  return join(ws.tmp, made[0]);
}

describe("install.ps1, under pwsh", { skip: PWSH === null && "pwsh isn't installed" }, () => {
  test("-Version 0.2.0 -DownloadOnly -BaseUrl …: exit 0, with the checked installer in its download folder", async () => {
    const ws = workspace();
    GOOD.mark();
    const run = await installPs1(["-Version", V, "-DownloadOnly", "-BaseUrl", GOOD.base], { ws });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(readFileSync(join(downloads(ws), ASSETS.nsis)), readFileSync(join(GOOD.dir, ASSETS.nsis)));
    assert.match(run.stdout, /checksum OK/);
    assert.deepEqual(GOOD.since().sort(), [`/download/v${V}/${ASSETS.nsis}`, `/download/v${V}/${CHECKSUMS}`].sort());
    assertPrefixed(run.stdout);
  });

  test(
    "off Windows, each run downloads into a new folder of its own, never into a fleetify-install someone else made in the shared temporary folder",
    { skip: process.platform === "win32" && "on Windows the folder is the user's own $env:TEMP\\fleetify-install" },
    async () => {
      const ws = workspace();
      // Another user's folder, where they could read or swap the download.
      const elsewhere = join(ws.root, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(ws.tmp, "fleetify-install"));
      const folders = [];
      for (let i = 0; i < 2; i += 1) {
        const before = new Set(readdirSync(ws.tmp));
        const run = await installPs1(["-Version", V, "-DownloadOnly", "-BaseUrl", GOOD.base], { ws });
        assert.equal(run.status, 0, run.output);
        const made = readdirSync(ws.tmp).filter((name) => !before.has(name));
        assert.equal(made.length, 1, `run ${i + 1} made ${made.join(", ") || "no folder"}`);
        assert.match(made[0], /^fleetify-install-[0-9a-f]{32}$/);
        assert.deepEqual(readFileSync(join(ws.tmp, made[0], ASSETS.nsis)), readFileSync(join(GOOD.dir, ASSETS.nsis)));
        assert.ok(run.stdout.includes(join(ws.tmp, made[0], ASSETS.nsis)), run.stdout);
        folders.push(made[0]);
      }
      assert.notEqual(folders[0], folders[1]);
      assert.deepEqual(readdirSync(elsewhere), [], "the download went into the planted folder");
    },
  );

  test("a tampered SHA256SUMS: a non-zero exit, saying the checksum doesn't match, and the download is deleted", async () => {
    const ws = workspace();
    const run = await installPs1(["-Version", V, "-DownloadOnly", "-BaseUrl", TAMPERED.base], { ws });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /checksum/);
    assert.equal(existsSync(join(downloads(ws), ASSETS.nsis)), false);
  });

  test("no line for the installer in SHA256SUMS: a non-zero exit, and the download is deleted", async () => {
    const ws = workspace();
    const sums = readFileSync(join(GOOD.dir, CHECKSUMS), "utf8").split("\n").filter((line) => !line.endsWith(`  ${ASSETS.nsis}`)).join("\n");
    const dir = makeRelease(V, { sums: () => sums });
    const release = await serve(dir, V);
    const run = await installPs1(["-Version", V, "-DownloadOnly", "-BaseUrl", release.base], { ws });
    assert.notEqual(run.status, 0, run.output);
    assert.ok(run.output.includes(`SHA256SUMS has no line for ${ASSETS.nsis}`), run.output);
    assert.equal(existsSync(join(downloads(ws), ASSETS.nsis)), false);
  });

  test("two lines for the installer in SHA256SUMS: a non-zero exit, and the download is deleted", async () => {
    const ws = workspace();
    const line = readFileSync(join(GOOD.dir, CHECKSUMS), "utf8").split("\n").find((entry) => entry.endsWith(`  ${ASSETS.nsis}`));
    const release = await serve(makeRelease(V, { sums: (text) => `${text}${line}\n` }), V);
    const run = await installPs1(["-Version", V, "-DownloadOnly", "-BaseUrl", release.base], { ws });
    assert.notEqual(run.status, 0, run.output);
    assert.ok(run.output.includes(`SHA256SUMS has more than one line for ${ASSETS.nsis}`), run.output);
    assert.equal(existsSync(join(downloads(ws), ASSETS.nsis)), false);
  });

  test("without -Version and -BaseUrl: FLEETIFY_INSTALL_BASE, and the version the latest release's latest.json gives", async () => {
    const ws = workspace();
    OTHER.mark();
    const run = await installPs1(["-DownloadOnly"], { ws, env: { FLEETIFY_INSTALL_BASE: OTHER.base } });
    assert.equal(run.status, 0, run.output);
    const asset = assetsOf(OTHER_V).nsis;
    assert.deepEqual(readFileSync(join(downloads(ws), asset)), readFileSync(join(OTHER.dir, asset)));
    assert.equal(OTHER.since()[0], `/latest/download/${MANIFEST}`);
  });

  test("FLEETIFY_VERSION when there is no -Version, and -BaseUrl over FLEETIFY_INSTALL_BASE", async () => {
    const ws = workspace();
    GOOD.mark();
    const run = await installPs1(["-DownloadOnly", "-BaseUrl", GOOD.base], { ws, env: { FLEETIFY_VERSION: V, FLEETIFY_INSTALL_BASE: "http://127.0.0.1:9/nothing" } });
    assert.equal(run.status, 0, run.output);
    assert.ok(existsSync(join(downloads(ws), ASSETS.nsis)));
    assert.ok(!GOOD.since().some((path) => path.startsWith("/latest/")), GOOD.since().join("\n"));
  });

  test("a -Version that isn't MAJOR.MINOR.PATCH, or a base that isn't http or https: refused before any download", async () => {
    for (const args of [
      ["-Version", "0.2", "-DownloadOnly", "-BaseUrl", GOOD.base],
      ["-Version", "0.2.0-rc.1", "-DownloadOnly", "-BaseUrl", GOOD.base],
      ["-Version", V, "-DownloadOnly", "-BaseUrl", "ftp://127.0.0.1/releases"],
    ]) {
      const ws = workspace();
      GOOD.mark();
      const run = await installPs1(args, { ws });
      assert.notEqual(run.status, 0, `${args.join(" ")}:\n${run.output}`);
      assert.deepEqual(GOOD.since(), [], args.join(" "));
    }
  });

  test("through Invoke-Expression, as irm … | iex runs it: the settings come from the environment, and a failure throws instead of ending the session", async () => {
    const ws = workspace();
    GOOD.mark();
    const command =
      `try { Invoke-RestMethod -Uri '${GOOD.base}/latest/download/install.ps1' | Invoke-Expression } ` +
      'catch { Write-Host "caught: $($_.Exception.Message)" }; ' +
      "Write-Host 'the session goes on'";
    const run = await pwsh(["-Command", command], { ws, env: { FLEETIFY_INSTALL_BASE: GOOD.base, FLEETIFY_VERSION: "1.2" } });
    assert.equal(run.status, 0, run.output);
    assert.match(run.stderr, /^fleetify-install: error: the version must be .*\b1\.2$/m);
    assert.match(run.stdout, /^caught: the version must be /m);
    assert.match(run.stdout, /^the session goes on$/m);
    // The script itself, from the release, and nothing more: the version was refused first.
    assert.deepEqual(GOOD.since(), ["/latest/download/install.ps1", `/download/v${V}/install.ps1`]);
  });

  test("an install, not -DownloadOnly, anywhere but Windows: refused before any download", { skip: process.platform === "win32" && "this is Windows" }, async () => {
    const ws = workspace();
    GOOD.mark();
    const run = await installPs1(["-Version", V, "-Silent", "-BaseUrl", GOOD.base], { ws });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /install\.sh/);
    assert.deepEqual(GOOD.since(), []);
  });

  test("install.ps1 does nothing before its last statement calls Install-Fleetify, so a script cut short runs nothing", async () => {
    const ws = workspace();
    const helper = join(ws.root, "top-level.ps1");
    writeFileSync(helper, TOP_LEVEL);
    const run = await pwsh(["-File", helper, "-Path", INSTALL_PS1], { ws });
    assert.equal(run.status, 0, run.output);
    const top = JSON.parse(run.stdout);
    assert.deepEqual([top.param, top.blocks], [true, 0], "its parameters, and no begin, process or dynamicparam block");
    const statements = top.statements;
    const last = statements.at(-1);
    assert.equal(last.type, "TryStatementAst", JSON.stringify(last));
    assert.ok(last.commands.includes("Install-Fleetify"), JSON.stringify(last));
    assert.ok(statements.some(({ type, name }) => type === "FunctionDefinitionAst" && name === "Install-Fleetify"));
    // Before it: function definitions, and assignments that call nothing.
    for (const statement of statements.slice(0, -1)) {
      const quiet = statement.type === "FunctionDefinitionAst" || (statement.type === "AssignmentStatementAst" && statement.commands.length === 0 && statement.methods === 0);
      assert.ok(quiet, `install.ps1 does work at its top level: ${JSON.stringify(statement)}`);
    }
  });
});

describe("the fixture", () => {
  test("serves every release asset under release-assets.mjs's names", async () => {
    const names = readdirSync(GOOD.dir).sort();
    assert.deepEqual(names, expectedAssets(V));
    for (const name of INSTALL_SCRIPTS) assert.ok(names.includes(name), name);
    // SHA256SUMS checks out, by the tool install.sh uses on Linux.
    const tool = which("sha256sum");
    if (tool !== null) {
      const result = spawnSync(tool, ["-c", CHECKSUMS], { cwd: GOOD.dir, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  });
});
