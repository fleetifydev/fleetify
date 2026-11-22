/**
 * Tests for appimage-exclude.mjs, which takes out of the Linux AppImage the
 * libraries it must leave to the system, and repacks it.
 *
 *   node --test scripts/release/appimage-exclude.test.mjs
 *
 * The AppImage and the plugin that repacks it are stand-ins, shell scripts.
 * The AppImage is a small runtime, which answers --appimage-offset and
 * --appimage-extract, followed by a tar of its files. The plugin writes down
 * how it was run, then packs the AppDir behind the runtime file it is given,
 * as appimagetool does, so what it saw is what the repacked AppImage holds.
 * Each CLI run gets a TMPDIR of its own, which must be empty afterwards.
 * Nothing here touches the network.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXCLUDED_LIBRARIES, excludeLibraries, isExcludedName, pinnedPlugin } from "./appimage-exclude.mjs";

const SCRIPT = fileURLToPath(new URL("./appimage-exclude.mjs", import.meta.url));
const SKIP = process.platform === "win32" && "the stand-in AppImage and plugin are shell scripts";

const ROOT = mkdtempSync(join(tmpdir(), "appimage-exclude-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);
const freshDir = (name) => {
  const dir = fresh(name);
  mkdirSync(dir);
  return dir;
};

/** The stand-in runtime's size: --appimage-offset prints it, and the files' tar follows it. */
const RUNTIME_SIZE = 512;

/**
 * A stand-in AppImage runtime, padded to RUNTIME_SIZE bytes. --appimage-offset
 * prints where the files start; --appimage-extract unpacks them into
 * ./squashfs-root and leaves every folder 0700, as the real runtime does.
 * FAKE_EXTRACT_FAIL makes the extraction fail; FAKE_OFFSET replaces the offset.
 */
const RUNTIME = (() => {
  const text = `#!/bin/sh
case "$1" in
--appimage-offset) echo "\${FAKE_OFFSET:-${RUNTIME_SIZE}}" ;;
--appimage-extract)
  if [ -n "\${FAKE_EXTRACT_FAIL:-}" ]; then echo "stand-in: can't extract" >&2; exit 1; fi
  mkdir squashfs-root && tail -c +${RUNTIME_SIZE + 1} "$0" | tar -xf - -C squashfs-root || exit 1
  find squashfs-root -type d -exec chmod 700 {} + ;;
*) exit 64 ;;
esac
exit 0
`;
  assert.ok(text.length < RUNTIME_SIZE - 1, "the stand-in runtime outgrew its size");
  return Buffer.from(`${text.padEnd(RUNTIME_SIZE - 1, "#")}\n`);
})();

/**
 * A stand-in linuxdeploy-plugin-appimage. It writes its arguments, the
 * variables the script sets and a copy of its runtime file into $FAKE_LOG,
 * then packs the AppDir behind the runtime file into $OUTPUT. FAKE_PLUGIN_EXIT
 * makes it fail with that code; FAKE_PLUGIN_NO_OUTPUT makes it write nothing;
 * FAKE_PLUGIN_KEEP puts the library back first; FAKE_PLUGIN_SWAP packs one
 * file less and one more.
 */
const PLUGIN = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG/args"
printf 'APPIMAGE_EXTRACT_AND_RUN=%s\\nARCH=%s\\nOUTPUT=%s\\nLDAI_RUNTIME_FILE=%s\\nTMPDIR=%s\\n' \\
  "$APPIMAGE_EXTRACT_AND_RUN" "$ARCH" "$OUTPUT" "$LDAI_RUNTIME_FILE" "$TMPDIR" > "$FAKE_LOG/env"
[ "$1" = --appdir ] && [ -d "$2" ] || exit 64
cp "$LDAI_RUNTIME_FILE" "$FAKE_LOG/runtime" || exit 65
if [ -n "\${FAKE_PLUGIN_EXIT:-}" ]; then echo "stand-in plugin: it failed" >&2; exit "$FAKE_PLUGIN_EXIT"; fi
if [ -n "\${FAKE_PLUGIN_NO_OUTPUT:-}" ]; then exit 0; fi
if [ -n "\${FAKE_PLUGIN_KEEP:-}" ]; then echo back > "$2/usr/lib/libwayland-client.so.0"; fi
if [ -n "\${FAKE_PLUGIN_SWAP:-}" ]; then rm "$2/usr/bin/fleetify-app" && echo new > "$2/usr/bin/surprise"; fi
{ cat "$LDAI_RUNTIME_FILE" && tar -cf - -C "$2" .; } > "$OUTPUT" || exit 66
chmod 755 "$OUTPUT"
`;

/** The files of the stand-in AppImage: text for a file, { text, mode } for one with a mode, { link } for a symlink. */
const TREE = {
  AppRun: { text: "#!/bin/sh\n", mode: 0o755 },
  "Fleetify.desktop": "[Desktop Entry]\n",
  ".DirIcon": { link: "fleetify-app.png" },
  "fleetify-app.png": "png\n",
  "usr/bin/fleetify-app": { text: "app\n", mode: 0o755 },
  "usr/lib/libwayland-client.so.0": "Ubuntu 22.04's libwayland-client\n",
  "usr/lib/libwayland-client.so.0.20.0": { link: "libwayland-client.so.0" },
  "usr/lib/x86_64-linux-gnu/libwayland-client.so.0": { link: "../libwayland-client.so.0" },
  "usr/lib/libwayland-cursor.so.0": "cursor\n",
  "usr/lib/libwayland-egl.so.1": "egl\n",
  "usr/lib/libwayland-server.so.0": "server\n",
  "usr/share/doc/libwayland-client0/copyright": "copyright\n",
};

/** What the script takes out of TREE, sorted. */
const TAKEN_OUT = ["usr/lib/libwayland-client.so.0", "usr/lib/libwayland-client.so.0.20.0", "usr/lib/x86_64-linux-gnu/libwayland-client.so.0"];

/** TREE without anything to take out. */
const CLEAN_TREE = Object.fromEntries(Object.entries(TREE).filter(([path]) => !TAKEN_OUT.includes(path)));

const NAME = "Fleetify_1.2.3_amd64.AppImage";

/** A folder holding `files` as TREE describes them. */
function tree(files) {
  const root = freshDir("tree");
  for (const [path, what] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof what === "string") {
      writeFileSync(target, what);
    } else if (what.link !== undefined) {
      symlinkSync(what.link, target);
    } else {
      writeFileSync(target, what.text);
      chmodSync(target, what.mode);
    }
  }
  return root;
}

/** Write a stand-in AppImage holding `files` at `path`, mode 0755. */
function appImage(path, files) {
  const packed = spawnSync("tar", ["-cf", "-", "-C", tree(files), "."], { maxBuffer: 1 << 26 });
  assert.equal(packed.status, 0, String(packed.stderr));
  writeFileSync(path, Buffer.concat([RUNTIME, packed.stdout]));
  chmodSync(path, 0o755);
}

/** A bundle/appimage folder: the bundler's AppDir, and a stand-in AppImage for each of `appimages` (name → files). */
function bundle(appimages = { [NAME]: TREE }) {
  const dir = freshDir("appimage");
  mkdirSync(join(dir, "Fleetify.AppDir"));
  writeFileSync(join(dir, "Fleetify.AppDir", "AppRun"), "#!/bin/sh\n");
  for (const [name, files] of Object.entries(appimages)) appImage(join(dir, name), files);
  return { dir, appimage: join(dir, NAME) };
}

/** A file's bytes and mode, to check later that it was left as it was. */
const snapshot = (path) => ({ bytes: readFileSync(path), mode: statSync(path).mode & 0o7777 });
function assertUnchanged(path, before) {
  const now = snapshot(path);
  assert.ok(now.bytes.equals(before.bytes), `${path} was changed`);
  assert.equal(now.mode, before.mode, `${path}'s mode was changed`);
}

/** Every entry under `root`, sorted: "dir <path>", "file <path>" or "link <path>". */
function listing(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const stats = lstatSync(join(dir, name));
      found.push(`${stats.isDirectory() ? "dir" : stats.isSymbolicLink() ? "link" : "file"} ${rel}`);
      if (stats.isDirectory()) walk(join(dir, name), rel);
    }
  };
  walk(root, "");
  return found.sort();
}

/** The folders under `root`, with `root` itself as ".", each with its mode. */
function folderModes(root) {
  const modes = { ".": statSync(root).mode & 0o777 };
  for (const entry of listing(root).filter((line) => line.startsWith("dir "))) {
    const rel = entry.slice("dir ".length);
    modes[rel] = statSync(join(root, rel)).mode & 0o777;
  }
  return modes;
}

/** The files a stand-in AppImage holds, unpacked with their modes into a new folder. */
function unpacked(appimage) {
  const into = freshDir("unpacked");
  const result = spawnSync("tar", ["-xpf", "-", "-C", into], { input: readFileSync(appimage).subarray(RUNTIME_SIZE) });
  assert.equal(result.status, 0, String(result.stderr));
  return into;
}

/** The variables the stand-in plugin wrote down. */
const pluginEnv = (log) =>
  Object.fromEntries(
    readFileSync(join(log, "env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/**
 * Run the CLI, by default on `dir`, with the stand-in plugin where the
 * bundler's cache keeps it ($XDG_CACHE_HOME/tauri) unless `plugin` is false,
 * a TMPDIR of its own and `env` added.
 */
function run(dir, { env = {}, plugin = true, args = ["--dir", dir] } = {}) {
  const cache = freshDir("cache");
  if (plugin) {
    mkdirSync(join(cache, "tauri"));
    writeFileSync(join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage"), PLUGIN);
    chmodSync(join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage"), 0o755);
  }
  const log = freshDir("log");
  const tmp = freshDir("tmp");
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    // In the temporary folder, so a relative path can't land in the repository.
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cache, TMPDIR: tmp, FAKE_LOG: log, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log, tmp, pluginRan: existsSync(join(log, "args")) };
}

describe("the libraries to leave out", () => {
  test("the list is libwayland-client.so.0", () => {
    assert.deepEqual(EXCLUDED_LIBRARIES, ["libwayland-client.so.0"]);
  });

  test("a library is left out by its name, or its name with more version numbers after it", () => {
    for (const name of ["libwayland-client.so.0", "libwayland-client.so.0.20.0", "libwayland-client.so.0.22.1"]) {
      assert.ok(isExcludedName(name), name);
    }
    for (const name of [
      "libwayland-client.so",
      "libwayland-client.so.1",
      "libwayland-client.so.00",
      "libwayland-client.so.0.debug",
      "libwayland-client.so.0x",
      "xlibwayland-client.so.0",
      "libwayland-cursor.so.0",
      "libwayland-egl.so.1",
      "libwayland-server.so.0",
      "libwayland-client0",
    ]) {
      assert.ok(!isExcludedName(name), name);
    }
  });

  test("the plugin is the linuxdeploy-plugin-appimage that appimage-tools.json pins, in the cache it is given", () => {
    assert.equal(pinnedPlugin(join("/cache", "tauri")), join("/cache", "tauri", "linuxdeploy-plugin-appimage.AppImage"));
  });
});

describe("appimage-exclude.mjs", { skip: SKIP }, () => {
  test("it takes each excluded library and its symlinks out, repacks the rest, and puts the result in the AppImage's place", () => {
    const { dir, appimage } = bundle();
    const before = statSync(appimage).size;
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const after = statSync(appimage).size;
    assert.equal(
      result.stdout,
      `appimage-exclude: took ${TAKEN_OUT.join(", ")} out of ${NAME} and repacked it: ${before} bytes before, ${after} after\n`,
    );
    // What the plugin packed: everything but what was taken out, every folder 0755 again.
    const packed = unpacked(appimage);
    const expected = listing(tree(TREE)).filter((line) => !TAKEN_OUT.includes(line.slice(line.indexOf(" ") + 1)));
    assert.deepEqual(listing(packed), expected);
    for (const [folder, mode] of Object.entries(folderModes(packed))) assert.equal(mode, 0o755, `folder ${folder}`);
    assert.equal(statSync(join(packed, "usr/bin/fleetify-app")).mode & 0o777, 0o755);
    // In the original's place, executable, behind the original's runtime, with nothing left beside it.
    assert.equal(statSync(appimage).mode & 0o777, 0o755);
    assert.ok(readFileSync(appimage).subarray(0, RUNTIME_SIZE).equals(RUNTIME));
    assert.deepEqual(readdirSync(dir).sort(), ["Fleetify.AppDir", NAME]);
    assert.deepEqual(readdirSync(result.tmp), [], "a temporary folder was left behind");
  });

  test("the plugin runs as the bundler runs it, on the extracted AppDir, with the AppImage's own runtime, all in a temporary folder", () => {
    const { dir, appimage } = bundle();
    const runtime = readFileSync(appimage).subarray(0, RUNTIME_SIZE);
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    const inTmp = (path) => path.startsWith(`${result.tmp}/`);
    const [flag, appdir, ...rest] = readFileSync(join(result.log, "args"), "utf8").trim().split("\n");
    assert.deepEqual([flag, rest], ["--appdir", []]);
    assert.ok(inTmp(appdir) && appdir.endsWith("/squashfs-root"), appdir);
    const env = pluginEnv(result.log);
    assert.equal(env.APPIMAGE_EXTRACT_AND_RUN, "1");
    assert.equal(env.ARCH, "x86_64");
    // It writes elsewhere than the AppImage's folder, and extracts itself into the script's temporary folder.
    for (const name of ["OUTPUT", "LDAI_RUNTIME_FILE", "TMPDIR"]) assert.ok(inTmp(env[name]), `${name}=${env[name]}`);
    assert.ok(readFileSync(join(result.log, "runtime")).equals(runtime), "the runtime file isn't the AppImage's runtime");
    assert.deepEqual(readdirSync(result.tmp), []);
  });

  test("an AppImage that holds none of the excluded libraries is left as it was, and nothing is repacked", () => {
    const { dir, appimage } = bundle({ [NAME]: CLEAN_TREE });
    const before = snapshot(appimage);
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `appimage-exclude: ${NAME} holds none of libwayland-client.so.0; it is left as it was\n`);
    assert.equal(result.pluginRan, false, "the plugin ran");
    assertUnchanged(appimage, before);
    assert.deepEqual(readdirSync(result.tmp), []);
  });

  for (const { what, env, plugin = true, pluginRuns, message } of [
    { what: "the AppImage can't be extracted", env: { FAKE_EXTRACT_FAIL: "1" }, pluginRuns: false, message: /can't extract .*Fleetify_1\.2\.3_amd64\.AppImage \(exit 1\)[\s\S]*stand-in: can't extract/ },
    { what: "its runtime's size can't be read", env: { FAKE_OFFSET: "nope" }, pluginRuns: false, message: /--appimage-offset/ },
    { what: "the plugin isn't in the bundler's cache", plugin: false, pluginRuns: false, message: /no linuxdeploy-plugin-appimage at .*tauri\/linuxdeploy-plugin-appimage\.AppImage.*appimage-tools\.mjs/ },
    { what: "the plugin fails", env: { FAKE_PLUGIN_EXIT: "3" }, pluginRuns: true, message: /linuxdeploy-plugin-appimage failed \(exit 3\)[\s\S]*stand-in plugin: it failed/ },
    { what: "the plugin makes no AppImage", env: { FAKE_PLUGIN_NO_OUTPUT: "1" }, pluginRuns: true, message: /linuxdeploy-plugin-appimage made no AppImage/ },
    { what: "the repacked AppImage still holds the library", env: { FAKE_PLUGIN_KEEP: "1" }, pluginRuns: true, message: /the repacked AppImage still holds usr\/lib\/libwayland-client\.so\.0/ },
    { what: "the repacked AppImage lacks a file or holds one more", env: { FAKE_PLUGIN_SWAP: "1" }, pluginRuns: true, message: /lacks file usr\/bin\/fleetify-app[\s\S]*adds file usr\/bin\/surprise/ },
  ]) {
    test(`when ${what}, it fails and leaves the AppImage as it was`, () => {
      const { dir, appimage } = bundle();
      const before = snapshot(appimage);
      const result = run(dir, { env, plugin });
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, message);
      assert.match(result.stderr, /nothing in .* was changed/);
      assert.equal(result.stdout, "");
      assert.equal(result.pluginRan, pluginRuns, pluginRuns ? "the plugin didn't run" : "the plugin ran");
      assertUnchanged(appimage, before);
      assert.deepEqual(readdirSync(dir).sort(), ["Fleetify.AppDir", NAME]);
      assert.deepEqual(readdirSync(result.tmp), [], "a temporary folder was left behind");
    });
  }

  test("when the AppImage can't be replaced, it fails and leaves the AppImage as it was", { skip: process.getuid?.() === 0 && "root writes into a read-only folder" }, () => {
    const { dir, appimage } = bundle();
    const before = snapshot(appimage);
    chmodSync(dir, 0o555);
    let result;
    try {
      result = run(dir);
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /can't put the repacked AppImage in place/);
    assertUnchanged(appimage, before);
    assert.deepEqual(readdirSync(dir).sort(), ["Fleetify.AppDir", NAME]);
    assert.deepEqual(readdirSync(result.tmp), []);
  });

  test("a folder without an AppImage, with two, or that isn't there fails, and changes nothing", () => {
    const none = bundle({});
    const noneResult = run(none.dir);
    assert.equal(noneResult.status, 1, noneResult.stderr);
    assert.match(noneResult.stderr, /holds no \*\.AppImage/);

    const two = bundle({ [NAME]: TREE, "Fleetify_1.2.4_amd64.AppImage": TREE });
    const before = [snapshot(two.appimage), snapshot(join(two.dir, "Fleetify_1.2.4_amd64.AppImage"))];
    const twoResult = run(two.dir);
    assert.equal(twoResult.status, 1, twoResult.stderr);
    assert.match(twoResult.stderr, /holds 2 AppImages, expected one: Fleetify_1\.2\.3_amd64\.AppImage, Fleetify_1\.2\.4_amd64\.AppImage/);
    assertUnchanged(two.appimage, before[0]);
    assertUnchanged(join(two.dir, "Fleetify_1.2.4_amd64.AppImage"), before[1]);

    const missing = run(fresh("not-there"));
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /can't read/);

    for (const result of [noneResult, twoResult, missing]) {
      assert.equal(result.pluginRan, false);
      assert.deepEqual(readdirSync(result.tmp), []);
    }
  });

  test("usage errors exit 2", () => {
    for (const args of [[], ["--dir"], ["--dir", ""], ["--bogus", "x"], ["--dir", "a", "--dir", "b"]]) {
      const result = run(ROOT, { args });
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });

  test("excludeLibraries takes the plugin's path, the spawn function and the temporary root as seams, and runs nothing but the AppImages and the plugin", () => {
    const { dir, appimage } = bundle();
    const plugin = join(freshDir("plugin"), "plugin");
    writeFileSync(plugin, PLUGIN);
    chmodSync(plugin, 0o755);
    const log = freshDir("log");
    const tmpRoot = freshDir("tmp");
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args });
      return spawnSync(command, args, { ...options, env: { ...(options?.env ?? process.env), FAKE_LOG: log } });
    };
    const before = statSync(appimage).size;
    const result = excludeLibraries({ dir, plugin, spawn, tmpRoot });
    assert.deepEqual(result, { appimage, removed: TAKEN_OUT, before, after: statSync(appimage).size });
    assert.ok(calls.some(({ command, args }) => command === plugin && args[0] === "--appdir"), "the plugin didn't run");
    const others = calls.filter(({ command }) => command !== plugin && command !== appimage && !command.startsWith(`${tmpRoot}/`));
    assert.deepEqual(others, [], "it ran something else than the AppImage, the plugin and the repacked AppImage");
    assert.deepEqual(readdirSync(tmpRoot), []);
  });
});
