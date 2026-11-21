/**
 * Tests for appimage-host-libs.mjs, which lists the libraries an AppImage
 * leaves to the system that the system lacks.
 *
 *   node --test scripts/release/appimage-host-libs.test.mjs
 *
 * ldd is a stand-in on PATH that answers from the files' own text, so the
 * tests run anywhere with a POSIX shell; one test runs the real ldd, where
 * there is one, on a copy of a system program.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { elfFiles, missingLibraries, notFound } from "./appimage-host-libs.mjs";

const SCRIPT = fileURLToPath(new URL("./appimage-host-libs.mjs", import.meta.url));
const POSIX = process.platform !== "win32";

const ROOT = mkdtempSync(join(tmpdir(), "appimage-host-libs-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

/** ldd's answer for a binary that needs libEGL.so.1, which isn't there, besides libc. */
const LDD_OUTPUT = `\tlinux-vdso.so.1 (0x00007ffc8d1f2000)
\tlibEGL.so.1 => not found
\tlibgstreamer-1.0.so.0 => /tmp/squashfs-root/usr/lib/libgstreamer-1.0.so.0 (0x00007f1c2a400000)
\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f1c2a000000)
\t/lib64/ld-linux-x86-64.so.2 (0x00007f1c2a700000)
`;

/**
 * A stand-in ldd: it logs LD_LIBRARY_PATH, and reports as missing each name
 * on the file's "NEEDS" line, besides a libc it finds.
 */
const FAKE_LDD = `#!/bin/sh
printf '%s\\n' "$LD_LIBRARY_PATH" >> "$LDD_LOG"
for lib in $(sed -n 's/^NEEDS //p' "$1"); do
  printf '\\t%s => not found\\n' "$lib"
done
printf '\\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)\\n'
`;

/** A stand-in AppImage: given --appimage-extract, it writes squashfs-root here, as an AppImage does. */
const FAKE_APPIMAGE = `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 9
mkdir -p squashfs-root/usr/bin squashfs-root/usr/lib
printf '\\177ELF\\nNEEDS libEGL.so.1\\n' > squashfs-root/usr/bin/fleetify-app
printf '\\177ELF\\nNEEDS\\n' > squashfs-root/usr/lib/libbundled.so.1
pwd > "$EXTRACTED_IN"
`;

/** An extracted AppImage holding `files` (path → text). */
function tree(files) {
  const root = fresh("squashfs-root");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A folder holding the stand-in ldd, and its log. */
function fakeLdd() {
  const bin = fresh("bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ldd"), FAKE_LDD);
  chmodSync(join(bin, "ldd"), 0o755);
  const log = join(bin, "ldd.log");
  writeFileSync(log, "");
  return { bin, log };
}

/** Run the CLI with the stand-in ldd first on PATH. */
function cli(args, env = {}) {
  const { bin, log } = fakeLdd();
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LDD_LOG: log, ...env },
  });
  return { ...result, lddLog: readFileSync(log, "utf8") };
}

describe("notFound", () => {
  test("names each library ldd can't find, and nothing else", () => {
    assert.deepEqual(notFound(LDD_OUTPUT), ["libEGL.so.1"]);
    assert.deepEqual(notFound("\tstatically linked\n"), []);
    assert.deepEqual(notFound("\tnot a dynamic executable\n"), []);
  });
});

describe("elfFiles", () => {
  test("lists the ELF files, by their paths from the root, and skips symlinks and other files", { skip: !POSIX && "symlinks" }, () => {
    const root = tree({
      "usr/bin/fleetify-app": "\x7fELF app",
      "usr/lib/libfoo.so.1.2.3": "\x7fELF lib",
      "usr/share/applications/fleetify.desktop": "[Desktop Entry]",
      "AppRun.wrapped": "#!/bin/sh",
    });
    symlinkSync("libfoo.so.1.2.3", join(root, "usr/lib/libfoo.so.1"));
    assert.deepEqual(elfFiles(root), ["usr/bin/fleetify-app", "usr/lib/libfoo.so.1.2.3"]);
  });
});

describe("missingLibraries", () => {
  test("maps each missing library to the files that need it, with ldd looking in the AppImage's usr/lib first", () => {
    const root = tree({
      "usr/bin/fleetify-app": "\x7fELF app",
      "usr/lib/libgstgl-1.0.so.0": "\x7fELF gstgl",
      "usr/lib/libwebkit2gtk-4.1.so.0": "\x7fELF webkit",
    });
    const asked = [];
    const answers = {
      "usr/bin/fleetify-app": "\tlibasound.so.2 => not found\n",
      "usr/lib/libgstgl-1.0.so.0": "\tlibEGL.so.1 => not found\n\tlibGL.so.1 => not found\n",
      "usr/lib/libwebkit2gtk-4.1.so.0": "\tlibEGL.so.1 => not found\n\tlibgbm.so.1 => not found\n",
    };
    const ldd = (file, env) => {
      asked.push({ file, env });
      return answers[file.slice(root.length + 1)];
    };
    const missing = missingLibraries({ root, ldd });
    assert.deepEqual(Object.fromEntries(missing), {
      "libEGL.so.1": ["usr/lib/libgstgl-1.0.so.0", "usr/lib/libwebkit2gtk-4.1.so.0"],
      "libGL.so.1": ["usr/lib/libgstgl-1.0.so.0"],
      "libasound.so.2": ["usr/bin/fleetify-app"],
      "libgbm.so.1": ["usr/lib/libwebkit2gtk-4.1.so.0"],
    });
    assert.equal(asked.length, 3);
    for (const { env } of asked) assert.equal(env.LD_LIBRARY_PATH, join(root, "usr", "lib"));
  });
});

describe("the CLI", () => {
  test("exit 1 for an extracted AppImage that needs a library this system lacks, listing it with the files that need it", { skip: !POSIX && "a POSIX shell for the stand-in ldd" }, () => {
    const root = tree({ "usr/bin/fleetify-app": "\x7fELF\nNEEDS libEGL.so.1 libgbm.so.1\n", "usr/lib/libgstgl-1.0.so.0": "\x7fELF\nNEEDS libEGL.so.1\n" });
    const result = cli(["--root", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /libEGL\.so\.1, needed by usr\/bin\/fleetify-app, usr\/lib\/libgstgl-1\.0\.so\.0$/m);
    assert.match(result.stderr, /libgbm\.so\.1, needed by usr\/bin\/fleetify-app$/m);
    assert.deepEqual([...new Set(result.lddLog.trim().split("\n"))], [join(root, "usr", "lib")]);
  });

  test("exit 0 when every library is found", { skip: !POSIX && "a POSIX shell for the stand-in ldd" }, () => {
    const result = cli(["--root", tree({ "usr/bin/fleetify-app": "\x7fELF\nNEEDS\n" })]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /every library the AppImage's 1 ELF files need is here/);
  });

  test("exit 1 when there is no ELF file to check", { skip: !POSIX && "a POSIX shell for the stand-in ldd" }, () => {
    const result = cli(["--root", tree({ "usr/share/doc/README": "text" })]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no ELF file/);
  });

  test("--appimage extracts the AppImage in a folder of its own, checks it and removes it", { skip: !POSIX && "a POSIX shell for the stand-in AppImage" }, () => {
    const appimage = join(fresh("release"), "Fleetify_0.2.0_amd64.AppImage");
    mkdirSync(dirname(appimage));
    writeFileSync(appimage, FAKE_APPIMAGE);
    chmodSync(appimage, 0o755);
    const extractedIn = fresh("extracted-in");
    const before = readdirSync(ROOT).sort();
    const result = cli(["--appimage", appimage], { EXTRACTED_IN: extractedIn });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /libEGL\.so\.1, needed by usr\/bin\/fleetify-app$/m);
    const folder = readFileSync(extractedIn, "utf8").trim();
    assert.ok(!existsSync(folder), `${folder} is left behind`);
    assert.notEqual(folder, ROOT, "the AppImage was extracted in the working folder");
    // Nothing new in the working folder but the files the test made.
    assert.deepEqual(readdirSync(ROOT).filter((name) => !before.includes(name) && !name.startsWith("bin-") && !name.startsWith("extracted-in-")), []);
  });

  test("usage errors exit 2", () => {
    for (const args of [[], ["--root"], ["--appimage", "a", "--root", "b"], ["--bogus", "x"], ["--root", "a", "--root", "b"]]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });

  test("with the real ldd, a copy of a system program needs nothing this system lacks", { skip: (process.platform !== "linux" || !existsSync("/bin/true")) && "Linux's ldd and /bin/true" }, () => {
    const root = fresh("real");
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    copyFileSync("/bin/true", join(root, "usr", "bin", "true"));
    const result = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
});
