/**
 * Tests for glibc-floor.mjs, which checks that the ELF files of the Linux
 * build are x86-64 and need no glibc newer than Ubuntu 22.04's.
 *
 *   node --test scripts/release/glibc-floor.test.mjs
 *
 * fixtures/readelf/ holds readelf's own output, with LC_ALL=C and
 * --file-header --version-info --wide, for ELF files of an x86-64 system with
 * glibc 2.43:
 * - cxx-needs-2.34.txt: a small C++ program. It needs GLIBC_2.4, 2.34, 2.7,
 *   2.2.5 and 2.3.4, in that order, so only a comparison number by number
 *   finds 2.34, and GLIBCXX_3.4 from libstdc++, which isn't glibc's.
 * - needs-2.38.txt: a small C program that needs GLIBC_2.38.
 * - static.txt: a statically linked program, with no version information.
 * - glibc-library.txt: one of glibc's own libraries. It defines versions up to
 *   GLIBC_2.43 and needs GLIBC_2.34 at most, besides GLIBC_PRIVATE and the
 *   loader features GLIBC_ABI_DT_RELR and GLIBC_ABI_DT_X86_64_PLT.
 * - aarch64.txt: the C++ program again, with the machine in its ELF header
 *   set to AArch64.
 *
 * The CLI tests put a stand-in readelf first on PATH, which prints the
 * fixture a stand-in ELF file names, so they need no real binary.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GLIBC_FLOOR, checkFiles, compareVersions, elfFiles, glibcNeeds, machineOf, newestVersion } from "./glibc-floor.mjs";

const SCRIPT = fileURLToPath(new URL("./glibc-floor.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/readelf/", import.meta.url));
const POSIX = process.platform !== "win32";
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "glibc-floor-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

/** A stand-in ELF file: the ELF magic, then the fixture the stand-in readelf prints for it. */
function elf(path, fixtureName) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(`\nREADELF ${fixtureName}\n`)]));
  return path;
}

/** A file that isn't ELF. */
function text(path, body = "#!/bin/sh\necho hi\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/**
 * A stand-in readelf: it logs LC_ALL and its arguments, then prints the
 * fixture its last argument names on a "READELF <fixture>" line, or fails
 * as readelf does on a file it can't read.
 */
const FAKE_READELF = `#!/bin/sh
printf '%s|%s\\n' "$LC_ALL" "$*" >> "$READELF_LOG"
for file; do :; done
name=$(sed -n 's/^READELF //p' "$file")
if [ -z "$name" ]; then
  echo "readelf: Error: $file: Failed to read file header" >&2
  exit 1
fi
cat "$FIXTURES/$name"
`;

/** Run the script with the stand-in readelf first on PATH; resolves with its exit code, output and readelf's calls. */
function run(args) {
  const bin = fresh("bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "readelf"), FAKE_READELF, { mode: 0o755 });
  const log = join(bin, "readelf.log");
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, READELF_LOG: log, FIXTURES, LC_ALL: "tr_TR.UTF-8" },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

/** The ::error:: lines of an output. */
const errors = (output) => output.split("\n").filter((line) => line.startsWith("::error::"));

describe("the floor", () => {
  test("is glibc 2.35, Ubuntu 22.04's, the oldest Linux INSTALL.md promises", () => {
    // A change to the promise is a change to the floor, and to this check.
    assert.equal(GLIBC_FLOOR, "2.35");
    assert.match(
      readFileSync(new URL("../../docs/INSTALL.md", import.meta.url), "utf8"),
      /64-bit x86 Linux with WebKitGTK 4\.1, which Ubuntu 22\.04, Debian 12 and newer releases provide/,
    );
  });
});

describe("parsing readelf's output", () => {
  test("machineOf names the machine in the ELF header", () => {
    for (const name of ["cxx-needs-2.34.txt", "needs-2.38.txt", "static.txt", "glibc-library.txt"]) {
      assert.equal(machineOf(fixture(name)), "Advanced Micro Devices X86-64", name);
    }
    assert.equal(machineOf(fixture("aarch64.txt")), "AArch64");
    assert.equal(machineOf("No version information found in this file.\n"), undefined);
  });

  test("glibcNeeds lists the glibc versions in the version needs section, and no other library's", () => {
    // GLIBCXX_3.4 is libstdc++'s, not glibc 3.4.
    assert.deepEqual(glibcNeeds(fixture("cxx-needs-2.34.txt")), { versions: ["2.4", "2.34", "2.7", "2.2.5", "2.3.4"], features: [], glibcPrivate: false });
    assert.deepEqual(glibcNeeds(fixture("needs-2.38.txt")), { versions: ["2.38", "2.34", "2.3.4", "2.2.5", "2.11"], features: [], glibcPrivate: false });
    assert.deepEqual(glibcNeeds(fixture("static.txt")), { versions: [], features: [], glibcPrivate: false });
  });

  test("glibcNeeds leaves out the versions a library defines, lists the loader features it needs, and notes that it needs GLIBC_PRIVATE", () => {
    // The definitions go up to GLIBC_2.43, which the library provides, not
    // needs. Its symbol table names GLIBC_PRIVATE too, which isn't a need.
    assert.deepEqual(glibcNeeds(fixture("glibc-library.txt")), {
      versions: ["2.3.4", "2.14", "2.30", "2.34", "2.4", "2.17", "2.2.5"],
      features: ["GLIBC_ABI_DT_X86_64_PLT", "GLIBC_ABI_DT_RELR"],
      glibcPrivate: true,
    });
    const symbolsOnly = fixture("glibc-library.txt").replace(/^.*Name: GLIBC_PRIVATE .*\n/gm, "");
    assert.ok(symbolsOnly.includes("(GLIBC_PRIVATE)"), "the edited output lost the symbol table's GLIBC_PRIVATE");
    assert.equal(glibcNeeds(symbolsOnly).glibcPrivate, false);
  });

  test("compareVersions compares number by number, and newestVersion finds the newest", () => {
    for (const [a, b, expected] of [
      ["2.34", "2.4", 1],
      ["2.4", "2.34", -1],
      ["2.3.4", "2.3", 1],
      ["2.3.4", "2.34", -1],
      ["2.35", "2.35", 0],
      ["2.35", "2.35.0", 0],
      ["2.36", "2.35", 1],
      ["3.0", "2.99", 1],
    ]) {
      assert.equal(compareVersions(a, b), expected, `${a} vs ${b}`);
    }
    assert.equal(newestVersion(["2.4", "2.34", "2.7", "2.2.5", "2.3.4"]), "2.34");
    assert.equal(newestVersion([]), undefined);
  });
});

describe("checkFiles", () => {
  const readelfFor = (fixtures) => (file) => fixture(fixtures[file]);

  test("files that are x86-64 and need glibc 2.35 at most pass, and the newest version is named with its file", () => {
    const result = checkFiles(["a", "b"], { readelf: readelfFor({ a: "cxx-needs-2.34.txt", b: "static.txt" }) });
    assert.deepEqual(result, { checked: 2, newest: { version: "2.34", file: "a" }, failures: [] });
  });

  test("a file that needs a glibc newer than the floor fails, named with the version", () => {
    const result = checkFiles(["a", "new"], { readelf: readelfFor({ a: "cxx-needs-2.34.txt", new: "needs-2.38.txt" }) });
    assert.deepEqual(result.newest, { version: "2.38", file: "new" });
    assert.deepEqual(result.failures, [{ file: "new", reasons: ["needs GLIBC_2.38, newer than the floor, glibc 2.35"] }]);
  });

  /** One of glibc's own libraries, without the needs that `drop` matches. */
  const glibcLibraryWithout = (drop) => fixture("glibc-library.txt").replace(new RegExp(`^.*Name: ${drop}.*\n`, "gm"), "");

  test("a file that needs a loader feature fails, though no number it needs is newer than the floor", () => {
    const result = checkFiles(["lib"], { readelf: () => glibcLibraryWithout("GLIBC_PRIVATE ") });
    assert.deepEqual(result.newest, { version: "2.34", file: "lib" });
    assert.deepEqual(result.failures, [{ file: "lib", reasons: ["needs GLIBC_ABI_DT_X86_64_PLT and GLIBC_ABI_DT_RELR, which glibc 2.35 lacks"] }]);
  });

  test("a file that needs GLIBC_PRIVATE fails, though no number it needs is newer than the floor: it is a part of glibc", () => {
    // A newer glibc's own libraries in the AppImage would meet the system's
    // glibc, whose private interface differs.
    const result = checkFiles(["lib"], { readelf: () => glibcLibraryWithout("GLIBC_ABI_") });
    assert.deepEqual(result.newest, { version: "2.34", file: "lib" });
    assert.deepEqual(result.failures, [
      { file: "lib", reasons: ["needs GLIBC_PRIVATE, the interface between glibc's own libraries, so it loads only beside the glibc it came from"] },
    ]);
  });

  test("a file for another machine fails, whatever it needs", () => {
    const result = checkFiles(["arm"], { readelf: readelfFor({ arm: "aarch64.txt" }) });
    assert.deepEqual(result.failures, [{ file: "arm", reasons: ["is built for AArch64, not x86-64"] }]);
  });

  test("a file with several problems is one failure with each reason", () => {
    // The AArch64 output, edited to need GLIBC_2.40 where it needs GLIBC_2.34.
    const both = fixture("aarch64.txt").replace(/Name: GLIBC_2\.34 /, "Name: GLIBC_2.40 ");
    const result = checkFiles(["x", "lib"], { readelf: (file) => (file === "x" ? both : fixture("glibc-library.txt")) });
    assert.deepEqual(result.failures, [
      { file: "x", reasons: ["is built for AArch64, not x86-64", "needs GLIBC_2.40, newer than the floor, glibc 2.35"] },
      {
        file: "lib",
        reasons: [
          "needs GLIBC_ABI_DT_X86_64_PLT and GLIBC_ABI_DT_RELR, which glibc 2.35 lacks",
          "needs GLIBC_PRIVATE, the interface between glibc's own libraries, so it loads only beside the glibc it came from",
        ],
      },
    ]);
  });

  test("no file needing glibc leaves no newest version", () => {
    assert.deepEqual(checkFiles(["s"], { readelf: () => fixture("static.txt") }), { checked: 1, newest: undefined, failures: [] });
  });
});

describe("elfFiles", () => {
  test("it finds the ELF files given and those in the folders given, by their magic, and skips symlinks", { skip: !POSIX && "symlinks" }, () => {
    const tree = fresh("tree");
    elf(join(tree, "usr/bin/app"), "cxx-needs-2.34.txt");
    elf(join(tree, "usr/lib/libz.so.1.3"), "static.txt");
    symlinkSync("libz.so.1.3", join(tree, "usr/lib/libz.so.1"));
    symlinkSync("usr/bin/app", join(tree, "AppRun"));
    symlinkSync("/usr/bin", join(tree, "usr/host-bin"));
    text(join(tree, "usr/share/app/readme.txt"), "\x7fEL");
    text(join(tree, "apprun-hooks/hook.sh"));
    const single = elf(join(fresh("single"), "sidecar"), "static.txt");
    assert.deepEqual(elfFiles([single, tree]), [single, join(tree, "usr/bin/app"), join(tree, "usr/lib/libz.so.1.3")]);
  });

  test("a file found twice, given and in a folder given, is listed once", () => {
    const tree = fresh("tree");
    const app = elf(join(tree, "app"), "static.txt");
    assert.deepEqual(elfFiles([app, tree, `${tree}/`]), [app]);
  });

  test("a symlink given by name is followed", { skip: !POSIX && "symlinks" }, () => {
    const dir = fresh("link");
    const app = elf(join(dir, "app"), "static.txt");
    symlinkSync("app", join(dir, "current"));
    assert.deepEqual(elfFiles([join(dir, "current")]), [join(dir, "current")]);
    assert.deepEqual(elfFiles([app, join(dir, "current")]), [app]);
  });

  test("a path that doesn't exist, or a file given that isn't ELF, is refused", () => {
    const dir = fresh("refused");
    assert.throws(() => elfFiles([join(dir, "missing")]), /missing: no such file or folder/);
    const script = text(join(dir, "script.sh"));
    assert.throws(() => elfFiles([script]), /script\.sh isn't an ELF file/);
  });
});

describe("glibc-floor.mjs", { skip: !POSIX && "the stand-in readelf is a shell script" }, () => {
  test("the build passes: one summary line names the files checked, the newest version and its file; exit 0", () => {
    const tree = fresh("squashfs-root");
    const app = elf(join(tree, "usr/bin/fleetify-app"), "cxx-needs-2.34.txt");
    elf(join(tree, "usr/lib/libz.so.1"), "static.txt");
    const sidecar = elf(join(fresh("release"), "fleet-memory-mcp"), "static.txt");
    const result = run([sidecar, tree]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(errors(result.stdout), []);
    assert.deepEqual(result.stdout.trim().split("\n"), [`glibc-floor: 3 ELF files checked; the newest glibc they need is 2.34, by ${app}; the floor is 2.35`]);
  });

  test("readelf runs on each file once, in the C locale, with --file-header --version-info --wide", () => {
    const tree = fresh("tree");
    const app = elf(join(tree, "app"), "cxx-needs-2.34.txt");
    symlinkSync("app", join(tree, "link"));
    const result = run([tree, app]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(result.calls, [`C|--file-header --version-info --wide ${app}`]);
  });

  test("a file that needs a newer glibc, or isn't x86-64, gets an ::error:: line of its own, and the check exits 1", () => {
    const tree = fresh("squashfs-root");
    elf(join(tree, "usr/bin/fleetify-app"), "cxx-needs-2.34.txt");
    const newer = elf(join(tree, "usr/lib/libnew.so.1"), "needs-2.38.txt");
    symlinkSync("libnew.so.1", join(tree, "usr/lib/libnew.so"));
    const arm = elf(join(tree, "usr/lib/libarm.so"), "aarch64.txt");
    const result = run([tree]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.deepEqual(errors(result.stdout), [
      `::error::${arm}: is built for AArch64, not x86-64`,
      `::error::${newer}: needs GLIBC_2.38, newer than the floor, glibc 2.35`,
    ]);
    assert.ok(result.stdout.includes(`glibc-floor: 3 ELF files checked; the newest glibc they need is 2.38, by ${newer}; the floor is 2.35\n`), result.stdout);
  });

  test("files that need no glibc version at all pass, and the summary says so", () => {
    const sidecar = elf(join(fresh("release"), "fleet-memory-mcp"), "static.txt");
    const result = run([sidecar]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "glibc-floor: 1 ELF file checked; none needs a glibc version; the floor is 2.35\n");
  });

  test("a missing path, a file given that isn't ELF, or no ELF file at all fails, and says why", () => {
    const dir = fresh("bad");
    // An unmatched glob reaches the script as it was written.
    const missing = run([join(dir, "fleet-*-mcp")]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /fleet-\*-mcp: no such file or folder/);
    const notElf = run([text(join(dir, "script.sh"))]);
    assert.equal(notElf.status, 1);
    assert.match(notElf.stderr, /script\.sh isn't an ELF file/);
    const empty = join(dir, "empty");
    text(join(empty, "readme.txt"));
    const none = run([empty]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no ELF file in/);
  });

  test("a file readelf can't read fails the check, naming the file", () => {
    const broken = join(fresh("broken"), "lib.so");
    text(broken, "\x7fELF, then nothing readelf can read");
    const result = run([broken]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`readelf failed on ${broken.replaceAll(".", "\\.")} \\(exit 1\\): readelf: Error: .*Failed to read file header`));
  });

  test("usage errors exit 2", () => {
    for (const args of [[], ["--floor", "2.39"], ["-h"]]) {
      const result = run(args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });
});
