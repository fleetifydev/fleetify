#!/usr/bin/env node
/**
 * appimage-libraries.mjs — write LINUX-APPIMAGE-LIBRARIES.txt: the system
 * libraries inside the Linux AppImage, each with the Ubuntu package it comes
 * from, that package's copyright file and a link to its source on Launchpad.
 *
 *   node scripts/release/appimage-libraries.mjs --root <squashfs-root> --out LINUX-APPIMAGE-LIBRARIES.txt
 *
 * <squashfs-root> is the AppImage extracted with --appimage-extract. Run this
 * on the system that built the AppImage: the AppImage bundler copies the
 * libraries from it, and its dpkg knows which package each one came from.
 * Each release carries the list, and THIRD-PARTY-NOTICES points to it.
 *
 * For each shared library (*.so, *.so.N...) under usr/lib:
 *   - `dpkg-query -S <file name>` finds the packages that own a file of that
 *     name. The owner whose path ends most like the AppImage's wins, then one
 *     of the system's own architecture;
 *   - `dpkg-query -W` gives that package's version, source package and
 *     source version;
 *   - /usr/share/doc/<package>/copyright is its copyright file;
 *   - its source is https://launchpad.net/ubuntu/+source/<source>/<source version>.
 * A library that no package owns is listed under "Not from an Ubuntu package".
 *
 * Exit codes: 0 written; 1 no libraries found, dpkg failed or a copyright
 * file is missing; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release/appimage-libraries.mjs --root <squashfs-root> --out <file>";

/** A shared library, by name: libx.so, libx.so.1, libx.so.1.2.3, but not x.sound.xml. */
const SHARED_OBJECT = /\.so(\.[0-9][^/]*)?$/;

/** The fields `dpkg-query -W` prints for each package, as parseDpkgShow reads them. */
const SHOW_FORMAT = "${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n";

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** A package name without its architecture: libgtk-3-0t64:amd64 → libgtk-3-0t64. */
const bare = (pkg) => pkg.split(":")[0];

/**
 * The shared libraries under `<root>/usr/lib`, as paths from `root` with "/"
 * separators, sorted. Regular files only: a symlink adds no library of its
 * own. Throws when usr/lib isn't there.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function sharedObjects(root) {
  const lib = join(root, "usr", "lib");
  if (!existsSync(lib)) throw new Error(`no usr/lib in ${root}: is it an extracted AppImage (squashfs-root)?`);
  const found = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const stats = lstatSync(join(dir, name));
      if (stats.isDirectory()) walk(join(dir, name), `${rel}/${name}`);
      else if (stats.isFile() && SHARED_OBJECT.test(name)) found.push(`${rel}/${name}`);
    }
  };
  walk(lib, "usr/lib");
  return found.sort(compare);
}

/**
 * `dpkg-query -S` output as a map from each path to the package that owns it.
 * Lines read "pkg[:arch][, pkg2[:arch]...]: /path"; of several owners, the
 * first counts. Diversion lines are skipped.
 *
 * @param {string} output
 * @returns {Map<string, string>}
 */
export function parseDpkgSearch(output) {
  const owners = new Map();
  for (const line of output.split("\n")) {
    if (/^(local )?diversion /.test(line)) continue;
    const at = line.indexOf(": /");
    if (at <= 0) continue;
    const [pkg] = line.slice(0, at).split(", ");
    owners.set(line.slice(at + 2).trimEnd(), pkg.trim());
  }
  return owners;
}

/**
 * The package that `file`, a path in the AppImage such as
 * usr/lib/gtk-3.0/3.0.0/immodules/im-ibus.so, came from: one that owns a
 * file of the same name, or null when none does. Of several, the one whose
 * path shares the most trailing folders with `file` wins, then one of the
 * system's architecture `arch` (or of none), then the first by path.
 *
 * @param {string} file
 * @param {Map<string, string>} owners  from parseDpkgSearch
 * @param {string} arch  from `dpkg --print-architecture`
 * @returns {string | null}
 */
export function chooseOwner(file, owners, arch) {
  const want = file.split("/").reverse();
  const candidates = [];
  for (const [path, pkg] of owners) {
    const have = path.split("/").reverse();
    if (have[0] !== want[0]) continue;
    let shared = 1;
    while (shared < want.length && shared < have.length && have[shared] === want[shared]) shared += 1;
    const pkgArch = pkg.includes(":") ? pkg.slice(pkg.indexOf(":") + 1) : null;
    const native = pkgArch === null || pkgArch === arch || pkgArch === "all";
    candidates.push({ path, pkg, shared, native });
  }
  candidates.sort(
    (a, b) => b.shared - a.shared || Number(b.native) - Number(a.native) || compare(a.path, b.path),
  );
  return candidates.length > 0 ? candidates[0].pkg : null;
}

/**
 * `dpkg-query -W` output in SHOW_FORMAT, as a map from each package to its
 * version, source package and source version.
 *
 * @param {string} output
 * @returns {Map<string, { version: string, source: string, sourceVersion: string }>}
 */
export function parseDpkgShow(output) {
  const info = new Map();
  for (const line of output.split("\n")) {
    const [pkg, version, source, sourceVersion] = line.trimEnd().split("\t");
    if (pkg && version && source && sourceVersion) info.set(pkg, { version, source, sourceVersion });
  }
  return info;
}

/**
 * The Launchpad page of an Ubuntu source package at a version. The version
 * keeps its epoch ("1:0.4.42-2"), as Launchpad's own links do.
 *
 * @param {string} source
 * @param {string} version
 */
export function launchpadUrl(source, version) {
  return `https://launchpad.net/ubuntu/+source/${source}/${version}`;
}

const RULE = "=".repeat(80);

const INTRO = [
  "The Linux AppImage carries these shared libraries from the Ubuntu system it",
  "was built on. They are grouped by the Ubuntu source package they were built",
  "from, with a link to that source on Launchpad. Under it come the binary",
  "packages with the AppImage files they provided, then the packages' copyright",
  "files as published.",
];

/** A text that comes out verbatim once the lines are joined with "\n", which puts its final newline back. */
const verbatim = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

/**
 * LINUX-APPIMAGE-LIBRARIES.txt as text. `entries` has one item per library:
 * `{ file, pkg, version, source, sourceVersion, copyright }`, with
 * `pkg: null` for a library no package owns. Libraries are grouped by source
 * package, linked at its source version (which can differ from the binary
 * package's), then by binary package. Each copyright text appears once per
 * source package, verbatim. Deterministic: the order of `entries` doesn't
 * matter.
 *
 * @param {Array<{ file: string, pkg: string | null, version?: string, source?: string,
 *                 sourceVersion?: string, copyright?: string }>} entries
 * @returns {string}
 */
export function renderLibraryList(entries) {
  const sources = new Map();
  const loose = [];
  for (const entry of entries) {
    if (!entry.pkg) {
      loose.push(entry.file);
      continue;
    }
    const sourceVersion = entry.sourceVersion ?? entry.version;
    const key = `${entry.source}\0${sourceVersion}`;
    if (!sources.has(key)) sources.set(key, { source: entry.source, sourceVersion, packages: new Map() });
    const { packages } = sources.get(key);
    if (!packages.has(entry.pkg)) {
      packages.set(entry.pkg, { pkg: entry.pkg, version: entry.version, copyright: entry.copyright, files: [] });
    }
    packages.get(entry.pkg).files.push(entry.file);
  }
  const groups = [...sources.values()].sort(
    (a, b) => compare(a.source, b.source) || compare(a.sourceVersion, b.sourceVersion),
  );
  const packageCount = groups.reduce((n, group) => n + group.packages.size, 0);

  const title = "System libraries in the Fleetify Linux AppImage";
  const out = [title, "=".repeat(title.length), "", ...INTRO, ""];
  out.push(
    `Libraries: ${entries.length}`,
    `  from Ubuntu packages: ${entries.length - loose.length} (${packageCount} binary packages, ` +
      `${groups.length} source packages)`,
    `  not from an Ubuntu package: ${loose.length}`,
  );

  for (const group of groups) {
    out.push("", "", RULE, `${group.source} ${group.sourceVersion}`);
    out.push(launchpadUrl(group.source, group.sourceVersion), RULE);
    const packages = [...group.packages.values()].sort((a, b) => compare(a.pkg, b.pkg));
    for (const p of packages) {
      out.push("", `${bare(p.pkg)} ${p.version}`, ...[...p.files].sort(compare).map((f) => `    ${f}`));
    }
    const texts = new Map();
    for (const p of packages) {
      if (!texts.has(p.copyright)) texts.set(p.copyright, []);
      texts.get(p.copyright).push(bare(p.pkg));
    }
    for (const [text, names] of texts) {
      out.push("", `Copyright file of ${names.join(", ")}:`, "", verbatim(text));
    }
  }

  out.push("", "", RULE, "Not from an Ubuntu package", RULE, "");
  out.push(...(loose.length > 0 ? [...loose].sort(compare).map((f) => `    ${f}`) : ["None."]));
  return `${out.join("\n")}\n`;
}

/** `--root <dir> --out <file>`, and nothing else. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if ((argv[i] === "--root" || argv[i] === "--out") && value && !value.startsWith("-")) {
      args[argv[i].slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
  }
  if (!args.root || !args.out) throw new Error("--root and --out are both required");
  return args;
}

/** `command args` without a shell; returns its stdout. `ok` lists the exit codes that count as success. */
function run(command, args, ok = [0]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  if (!ok.includes(result.status)) {
    throw new Error(`${command} ${args[0]} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** The copyright file of a package, as Debian policy places it. Throws when it is missing. */
function readCopyright(pkg) {
  const path = `/usr/share/doc/${bare(pkg)}/copyright`;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`${pkg} has no copyright file at ${path} (${err.code ?? err.message})`);
  }
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`appimage-libraries: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const files = sharedObjects(args.root);
    if (files.length === 0) throw new Error(`no shared libraries in ${join(args.root, "usr", "lib")}`);
    const names = [...new Set(files.map((file) => posix.basename(file)))].sort(compare);
    // Exit code 1: some name has no owner. Those files are "Not from an Ubuntu package".
    const owners = parseDpkgSearch(run("dpkg-query", ["-S", ...names], [0, 1]));
    const arch = run("dpkg", ["--print-architecture"]).trim();
    const owned = files.map((file) => ({ file, pkg: chooseOwner(file, owners, arch) }));

    const pkgs = [...new Set(owned.map(({ pkg }) => pkg).filter(Boolean))].sort(compare);
    const info = pkgs.length > 0 ? parseDpkgShow(run("dpkg-query", ["-W", `-f=${SHOW_FORMAT}`, ...pkgs])) : new Map();
    const copyrights = new Map();
    const entries = owned.map(({ file, pkg }) => {
      if (!pkg) return { file, pkg: null };
      const meta = info.get(pkg) ?? info.get(bare(pkg));
      if (!meta) throw new Error(`dpkg-query -W printed nothing for ${pkg}`);
      if (!copyrights.has(pkg)) copyrights.set(pkg, readCopyright(pkg));
      return { file, pkg, ...meta, copyright: copyrights.get(pkg) };
    });
    writeFileSync(args.out, renderLibraryList(entries));

    const loose = entries.filter(({ pkg }) => !pkg).length;
    const sources = new Set(entries.filter(({ pkg }) => pkg).map((e) => `${e.source} ${e.sourceVersion}`));
    process.stderr.write(
      `appimage-libraries: wrote ${args.out}: ${files.length} libraries, ${files.length - loose} from ` +
        `${pkgs.length} Ubuntu packages (${sources.size} source packages), ${loose} not from a package\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`appimage-libraries: ${err.message}\n`);
    return 1;
  }
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// exitCode instead of process.exit(), so buffered output is written first.
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
