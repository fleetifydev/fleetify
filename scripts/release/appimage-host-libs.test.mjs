/**
 * Tests for appimage-host-libs.mjs, which lists what an AppImage needs from
 * the system and doesn't get: libraries missing, libraries too old, files
 * ldd fails on.
 *
 *   node --test scripts/release/appimage-host-libs.test.mjs
 *
 * The ELF files here are headers alone, with directives after them that a
 * stand-in ldd on PATH answers from, so the tests run anywhere with a POSIX
 * shell; one test runs the real ldd, where there is one, on a copy of a
 * system program.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { elfFiles, hostLibraryProblems, isDynamicElf, notFound, versionsNotFound } from "./appimage-host-libs.mjs";

const SCRIPT = fileURLToPath(new URL("./appimage-host-libs.mjs", import.meta.url));
const POSIX = process.platform !== "win32";

const ROOT = mkdtempSync(join(tmpdir(), "appimage-host-libs-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

/**
 * An ELF file's header and one program header, dynamic (PT_DYNAMIC) or not
 * (PT_LOAD), followed by `lines` for the stand-in ldd.
 */
function elf(lines = [], { dynamic = true, wide = true, little = true } = {}) {
  const ehsize = wide ? 64 : 52;
  const phentsize = wide ? 56 : 32;
  const head = Buffer.alloc(ehsize + phentsize);
  head.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1]);
  const u16 = (value, at) => (little ? head.writeUInt16LE(value, at) : head.writeUInt16BE(value, at));
  const u32 = (value, at) => (little ? head.writeUInt32LE(value, at) : head.writeUInt32BE(value, at));
  u16(3, 0x10);
  if (wide) {
    little ? head.writeBigUInt64LE(64n, 0x20) : head.writeBigUInt64BE(64n, 0x20);
    u16(phentsize, 0x36);
    u16(1, 0x38);
  } else {
    u32(52, 0x1c);
    u16(phentsize, 0x2a);
    u16(1, 0x2c);
  }
  u32(dynamic ? 2 : 1, ehsize);
  return Buffer.concat([head, Buffer.from(`\n${lines.join("\n")}\n`)]);
}

/** ldd's answer for a binary that needs libEGL.so.1, which isn't there, besides libc. */
const LDD_OUTPUT = `\tlinux-vdso.so.1 (0x00007ffc8d1f2000)
\tlibEGL.so.1 => not found
\tlibgstreamer-1.0.so.0 => /tmp/squashfs-root/usr/lib/libgstreamer-1.0.so.0 (0x00007f1c2a400000)
\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f1c2a000000)
\t/lib64/ld-linux-x86-64.so.2 (0x00007f1c2a700000)
`;

/**
 * A stand-in ldd: it logs LD_LIBRARY_PATH; it reports each name on the
 * file's "NEEDS" line as missing, and each "OLD <library> <version>" line as
 * a version the loader can't find; it exits with the "EXIT" line's code.
 */
const FAKE_LDD = `#!/bin/sh
printf '%s\\n' "$LD_LIBRARY_PATH" >> "$LDD_LOG"
for lib in $(sed -n 's/^NEEDS //p' "$1"); do
  printf '\\t%s => not found\\n' "$lib"
done
sed -n 's/^OLD //p' "$1" | while read -r lib version; do
  printf "%s: /lib/x86_64-linux-gnu/%s: version \\\`%s' not found (required by %s)\\n" "$1" "$lib" "$version" "$1"
done
printf '\\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)\\n'
exit "$(sed -n 's/^EXIT //p' "$1" | head -n 1 | grep . || echo 0)"
`;

/** A stand-in AppImage: given --appimage-extract, it copies $FAKE_TREE to squashfs-root here, as an AppImage extracts itself. */
const FAKE_APPIMAGE = `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 9
cp -R "$FAKE_TREE" squashfs-root
pwd > "$EXTRACTED_IN"
`;

/** An extracted AppImage holding `files` (path → contents). */
function tree(files) {
  const root = fresh("squashfs-root");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

/** Run the CLI with the stand-in ldd first on PATH. */
function cli(args, env = {}) {
  const bin = fresh("bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ldd"), FAKE_LDD);
  chmodSync(join(bin, "ldd"), 0o755);
  const log = join(bin, "ldd.log");
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LDD_LOG: log, ...env },
  });
  return { ...result, lddLog: readFileSync(log, "utf8") };
}

describe("reading ldd", () => {
  test("notFound names each library ldd can't find, and nothing else", () => {
    assert.deepEqual(notFound(LDD_OUTPUT), ["libEGL.so.1"]);
    assert.deepEqual(notFound("\tstatically linked\n"), []);
    assert.deepEqual(notFound("\tnot a dynamic executable\n"), []);
  });

  test("versionsNotFound reads the loader's missing-version lines, in either quoting, and not the weak ones", () => {
    const output = [
      "/r/usr/bin/app: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.40' not found (required by /r/usr/bin/app)",
      "/r/usr/bin/app: /lib/x86_64-linux-gnu/libstdc++.so.6: version 'GLIBCXX_3.4.33' not found (required by /r/usr/lib/libfoo.so.1)",
      "/r/usr/bin/app: /lib/x86_64-linux-gnu/libm.so.6: weak version `GLIBC_2.99' not found (required by /r/usr/bin/app)",
      "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)",
    ].join("\n");
    assert.deepEqual(versionsNotFound(output), [
      { library: "libc.so.6", version: "GLIBC_2.40", requiredBy: "/r/usr/bin/app" },
      { library: "libstdc++.so.6", version: "GLIBCXX_3.4.33", requiredBy: "/r/usr/lib/libfoo.so.1" },
    ]);
  });
});

describe("finding the files", () => {
  test("elfFiles lists the ELF files, by their paths from the root, and skips symlinks and other files", { skip: !POSIX && "symlinks" }, () => {
    const root = tree({
      "usr/bin/fleetify-app": elf(),
      "usr/lib/libfoo.so.1.2.3": elf(),
      "usr/share/applications/fleetify.desktop": "[Desktop Entry]",
      "AppRun.wrapped": "#!/bin/sh",
    });
    symlinkSync("libfoo.so.1.2.3", join(root, "usr/lib/libfoo.so.1"));
    assert.deepEqual(elfFiles(root), ["usr/bin/fleetify-app", "usr/lib/libfoo.so.1.2.3"]);
  });

  test("isDynamicElf tells a dynamically linked file by its program headers, in 32 and 64 bits and either byte order", () => {
    const root = tree({
      dynamic: elf(),
      static: elf([], { dynamic: false }),
      "dynamic-32-big": elf([], { wide: false, little: false }),
      "static-32-big": elf([], { wide: false, little: false, dynamic: false }),
      "magic-only": "\x7fELF",
    });
    const dynamic = ["dynamic", "static", "dynamic-32-big", "static-32-big", "magic-only"].filter((name) => isDynamicElf(join(root, name)));
    assert.deepEqual(dynamic, ["dynamic", "dynamic-32-big"]);
  });
});

describe("hostLibraryProblems", () => {
  test("gathers missing libraries, missing versions and ldd's failures, with the files concerned, ldd looking in usr/lib first", () => {
    const root = tree({
      "usr/bin/fleetify-app": elf(),
      "usr/lib/libgstgl-1.0.so.0": elf(),
      "usr/lib/libwebkit2gtk-4.1.so.0": elf(),
      "usr/lib/libbroken.so.1": elf(),
      "usr/bin/static-helper": elf([], { dynamic: false }),
    });
    const answers = {
      "usr/bin/fleetify-app": {
        status: 1,
        output: `\tlibasound.so.2 => not found\n${root}/usr/bin/fleetify-app: /lib/libc.so.6: version \`GLIBC_2.40' not found (required by ${root}/usr/lib/libgstgl-1.0.so.0)\n`,
      },
      "usr/lib/libgstgl-1.0.so.0": { status: 0, output: "\tlibEGL.so.1 => not found\n\tlibGL.so.1 => not found\n" },
      "usr/lib/libwebkit2gtk-4.1.so.0": { status: 0, output: "\tlibEGL.so.1 => not found\n" },
      "usr/lib/libbroken.so.1": { status: 1, output: "ldd: exited unexpectedly\nmore\n" },
    };
    const asked = [];
    const ldd = (file, env) => {
      asked.push(file.slice(root.length + 1));
      assert.equal(env.LD_LIBRARY_PATH, join(root, "usr", "lib"));
      return answers[file.slice(root.length + 1)];
    };
    const { missing, older, failures } = hostLibraryProblems({ root, ldd });
    assert.deepEqual(Object.fromEntries(missing), {
      "libEGL.so.1": ["usr/lib/libgstgl-1.0.so.0", "usr/lib/libwebkit2gtk-4.1.so.0"],
      "libGL.so.1": ["usr/lib/libgstgl-1.0.so.0"],
      "libasound.so.2": ["usr/bin/fleetify-app"],
    });
    assert.deepEqual(Object.fromEntries(older), { "libc.so.6 GLIBC_2.40": ["usr/lib/libgstgl-1.0.so.0"] });
    // A failure the lines above explain isn't listed again.
    assert.deepEqual(failures, [{ file: "usr/lib/libbroken.so.1", status: 1, output: "ldd: exited unexpectedly" }]);
    assert.ok(!asked.includes("usr/bin/static-helper"), "ldd ran on a statically linked file");
  });
});

describe("the CLI", () => {
  const posix = { skip: !POSIX && "a POSIX shell for the stand-ins" };

  test("exit 1 for a library this system lacks, listing it with the files that need it", posix, () => {
    const root = tree({ "usr/bin/fleetify-app": elf(["NEEDS libEGL.so.1 libgbm.so.1"]), "usr/lib/libgstgl-1.0.so.0": elf(["NEEDS libEGL.so.1"]) });
    const result = cli(["--root", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^ {2}libEGL\.so\.1, needed by usr\/bin\/fleetify-app, usr\/lib\/libgstgl-1\.0\.so\.0$/m);
    assert.match(result.stderr, /^ {2}libgbm\.so\.1, needed by usr\/bin\/fleetify-app$/m);
    assert.deepEqual([...new Set(result.lddLog.trim().split("\n"))], [join(root, "usr", "lib")]);
  });

  test("exit 1 for a library older than the AppImage needs, even when ldd exits 0", posix, () => {
    const root = tree({ "usr/bin/fleetify-app": elf(["OLD libc.so.6 GLIBC_2.40"]) });
    const result = cli(["--root", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /older than the AppImage needs:\n {2}libc\.so\.6 GLIBC_2\.40, needed by usr\/bin\/fleetify-app$/m);
  });

  test("exit 1 when ldd fails on a dynamically linked file, though it reports no library missing", posix, () => {
    const root = tree({ "usr/bin/fleetify-app": elf(["EXIT 1"]), "usr/bin/helper": elf(["EXIT 1"], { dynamic: false }) });
    const result = cli(["--root", root]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ldd failed on:\n {2}usr\/bin\/fleetify-app \(exit 1\): /);
    assert.doesNotMatch(result.stderr, /helper/);
  });

  test("exit 0 when every library is found, in a version new enough", posix, () => {
    const result = cli(["--root", tree({ "usr/bin/fleetify-app": elf(), "usr/bin/static-helper": elf(["EXIT 1"], { dynamic: false }) })]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /every library the AppImage's 1 dynamically linked files need is here/);
  });

  test("exit 1 when there is no dynamically linked file to check", posix, () => {
    for (const files of [{ "usr/share/doc/README": "text" }, { "usr/bin/static": elf([], { dynamic: false }) }]) {
      const result = cli(["--root", tree(files)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no dynamically linked ELF file/);
    }
  });

  test("--appimage extracts the AppImage in a folder of its own, checks it and removes it", posix, () => {
    const appimage = join(fresh("release"), "Fleetify_0.2.0_amd64.AppImage");
    mkdirSync(dirname(appimage));
    writeFileSync(appimage, FAKE_APPIMAGE);
    chmodSync(appimage, 0o755);
    const template = tree({ "usr/bin/fleetify-app": elf(["NEEDS libEGL.so.1"]), "usr/lib/libbundled.so.1": elf() });
    const extractedIn = fresh("extracted-in");
    const before = readdirSync(ROOT).sort();
    const result = cli(["--appimage", appimage], { EXTRACTED_IN: extractedIn, FAKE_TREE: template });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^ {2}libEGL\.so\.1, needed by usr\/bin\/fleetify-app$/m);
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
    assert.match(result.stdout, /1 dynamically linked files/);
  });
});
