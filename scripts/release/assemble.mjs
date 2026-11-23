#!/usr/bin/env node
/**
 * assemble.mjs — turn the build jobs' artifacts into a release, checking
 * every file before anything is published.
 *
 *   node scripts/release/assemble.mjs --in <dir> --out <dir> --version <v>
 *        (--pubkey-config src-tauri/tauri.conf.json --expect-key-id 44C694713A20D751 | --per-target-pubkeys --rehearsal-out <dir>)
 *        [--extra <file>]...
 *
 * --in holds the downloaded artifacts:
 *
 *   bundles-<triple>/       one per release target, holding that target's
 *                           files under their release names (bundleFiles).
 *                           The Linux one also holds LINUX-APPIMAGE-LIBRARIES.txt;
 *                           in a dry run, each also holds updater-pubkey.txt.
 *   rehearsal-<triple>/     in a dry run only, one per release target: the
 *                           rehearsal's signature of each of the target's
 *                           updater artifacts, <asset>.sig, which the run's
 *                           key made for REHEARSAL_VERSION. The smoke's
 *                           update server offers that version, and the
 *                           updater refuses a signature made for another.
 *   third-party-notices/THIRD-PARTY-NOTICES
 *
 * --extra adds a file from elsewhere under its own name. It must be a release
 * asset that no artifact provides.
 *
 * Problems, all listed before anything is written:
 *   - a missing file, and an unexpected one: --in holds exactly those files,
 *     each a non-empty regular file (symlinks aren't followed);
 *   - a signature that doesn't verify: each updater artifact's .sig is checked
 *     (minisign.mjs) against the updater public key, and the version: field
 *     of its trusted comment must name the release version, which latest.json
 *     announces: the updater refuses a signature made for another version,
 *     and with requireSignedVersion one that names none. With
 *     --pubkey-config, that is the key in the config, which every build
 *     embeds, and its key id must be --expect-key-id; `tauri build` only
 *     warns when it signs with another key. With --per-target-pubkeys (dry
 *     runs, where each build signs with a throwaway key), it is each bundle
 *     folder's own updater-pubkey.txt, which isn't published;
 *   - in a dry run, a rehearsal signature that doesn't verify against its
 *     target's key, over its artifact's bytes, for REHEARSAL_VERSION. A
 *     release run takes none: a rehearsal-<triple> folder is unexpected;
 *   - an out folder that isn't empty, and a --rehearsal-out that isn't, or
 *     that is --out, lies inside it or holds it.
 *
 * With none, it copies the files, writes latest.json (latestJson: download
 * URLs under the version's tag; each signature is the .sig text, trimmed;
 * pub_date is now, as toISOString() writes it) and SHA256SUMS (every other
 * asset), and checks that the out folder holds exactly
 * expectedAssets(version). A dry run then copies the rehearsal's signatures
 * into --rehearsal-out, each as <asset>.sig, for the smoke: they never join
 * the release. Each file is hashed from the same read that was checked (a
 * .sig's verified text and its hash come from one read), and each copy must
 * hash the same, so the hashes, the signatures and latest.json all vouch for
 * the bytes in the out folders. After a problem, both out folders are left
 * as they were found.
 *
 * Exit codes: 0 assembled; 1 problems, listed on stderr; 2 usage.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePublicKey, verifySignature } from "./minisign.mjs";
import {
  CHECKSUMS,
  LIBRARY_LIST,
  MANIFEST,
  NOTICES,
  REHEARSAL_VERSION,
  TARGETS,
  bundleFiles,
  downloadBase,
  expectedAssets,
  latestJson,
  sha256sums,
  updaterArtifacts,
  updaterAssets,
} from "./release-assets.mjs";

const USAGE = [
  "usage: node scripts/release/assemble.mjs --in <dir> --out <dir> --version <v>",
  "         (--pubkey-config <tauri.conf.json> --expect-key-id <16 hex digits> | --per-target-pubkeys --rehearsal-out <dir>)",
  "         [--extra <file>]...",
].join("\n");

/** In a dry run, each bundle folder's copy of the updater public key its build signed with. */
const PUBKEY_FILE = "updater-pubkey.txt";
/** In a dry run, the folder of a target's rehearsal signatures. */
const rehearsalFolder = (triple) => `rehearsal-${triple}`;
const NOTICES_FOLDER = "third-party-notices";
/** The target whose folder also holds the AppImage's library list. */
const LIBRARY_TRIPLE = TARGETS.find(({ bundles }) => bundles.includes("appimage")).triple;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** fs.stat or fs.lstat, with null for a path that isn't there. */
function statOrNull(path, { follow }) {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/** Whether `child` is the folder `parent`, or lies inside it. */
function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Check the artifacts in `inDir` and assemble the release into `outDir`.
 *
 * @param {object} options
 * @param {string} options.inDir
 * @param {string} options.outDir   created when absent; must be empty
 * @param {string} options.version
 * @param {{ config: string, expectKeyId: string } | { perTarget: true }} options.pubkeys
 * @param {string} [options.rehearsalOut]   a dry run's, with per-target keys and only
 *   with them: where the rehearsal's signatures go; created when absent, must be empty
 * @param {string[]} [options.extras]
 * @param {Date} [options.now]      the time latest.json gives as pub_date
 * @param {typeof verifySignature} [options.verify]
 * @param {(line: string) => void} [options.log]   progress lines
 * @returns {{ assets: string[], rehearsal: string[], problems: string[] }}
 *   the assets and the rehearsal signatures written (none after a problem)
 */
export function assemble({
  inDir,
  outDir,
  version,
  pubkeys,
  rehearsalOut,
  extras = [],
  now = new Date(),
  verify = verifySignature,
  log = () => {},
}) {
  const perTarget = pubkeys?.perTarget === true;
  if (perTarget === (typeof pubkeys?.config === "string") || (!perTarget && typeof pubkeys.expectKeyId !== "string")) {
    throw new TypeError("pubkeys must be { config, expectKeyId } or { perTarget: true }");
  }
  if (perTarget !== (typeof rehearsalOut === "string")) {
    throw new TypeError("rehearsalOut goes with pubkeys { perTarget: true }, and only with them: a dry run's builds sign the rehearsal's signatures");
  }
  const problems = [];
  const failed = () => ({ assets: [], rehearsal: [], problems });

  let expected;
  try {
    expected = expectedAssets(version);
  } catch (err) {
    problems.push(err.message);
    return failed();
  }
  if (!statOrNull(inDir, { follow: true })?.isDirectory()) {
    problems.push(`--in ${inDir} does not exist or is not a folder`);
    return failed();
  }

  // What each folder of --in must hold, and where each asset comes from.
  const folders = new Map();
  for (const { triple } of TARGETS) {
    const files = bundleFiles(triple, version).map(({ to }) => to);
    if (triple === LIBRARY_TRIPLE) files.push(LIBRARY_LIST);
    folders.set(`bundles-${triple}`, { triple, files, keyFile: perTarget, rehearsal: false });
  }
  folders.set(NOTICES_FOLDER, { triple: null, files: [NOTICES], keyFile: false, rehearsal: false });
  const provided = new Set([...[...folders.values()].flatMap(({ files }) => files), MANIFEST, CHECKSUMS]);
  /** The rehearsal's signatures, each named for its updater artifact: what --rehearsal-out holds. */
  const rehearsalNames = [];
  if (perTarget) {
    for (const { triple } of TARGETS) {
      const files = updaterAssets(triple, version).map((asset) => `${asset}.sig`);
      rehearsalNames.push(...files);
      folders.set(rehearsalFolder(triple), { triple, files, keyFile: false, rehearsal: true });
    }
    rehearsalNames.sort(compare);
  }

  /** asset name → { path, label }: the file each asset is copied from. */
  const sources = new Map();
  /** updater artifact → { path, label }: its rehearsal signature, in a dry run. */
  const rehearsalSources = new Map();
  /** triple → path of its updater-pubkey.txt */
  const keyFiles = new Map();

  for (const [folder, { triple, files, keyFile, rehearsal }] of folders) {
    const dir = join(inDir, folder);
    const stats = statOrNull(dir, { follow: false });
    if (stats === null) {
      problems.push(`missing ${folder}/`);
      continue;
    }
    if (!stats.isDirectory()) {
      problems.push(`${folder} is not a folder`);
      continue;
    }
    const wanted = keyFile ? [...files, PUBKEY_FILE] : files;
    const present = new Set(readdirSync(dir));
    for (const name of wanted) {
      const label = `${folder}/${name}`;
      const path = join(dir, name);
      if (!present.has(name)) {
        problems.push(`missing ${label}`);
        continue;
      }
      const file = lstatSync(path);
      if (!file.isFile()) problems.push(`${label} is not a regular file`);
      else if (file.size === 0) problems.push(`${label} is empty`);
      else if (name === PUBKEY_FILE) keyFiles.set(triple, path);
      else if (rehearsal) rehearsalSources.set(name.slice(0, -".sig".length), { path, label });
      else sources.set(name, { path, label });
    }
    for (const name of [...present].sort(compare)) {
      if (wanted.includes(name)) continue;
      const isFolder = lstatSync(join(dir, name)).isDirectory();
      problems.push(isFolder ? `unexpected folder ${folder}/${name}/` : `unexpected file ${folder}/${name}`);
    }
  }
  for (const name of readdirSync(inDir).sort(compare)) {
    if (folders.has(name)) continue;
    const isFolder = lstatSync(join(inDir, name)).isDirectory();
    problems.push(isFolder ? `unexpected folder ${name}/` : `unexpected file ${name}`);
  }

  // The updater public key each target's signatures must verify against.
  const keys = new Map();
  if (perTarget) {
    for (const [triple, path] of keyFiles) {
      try {
        const key = parsePublicKey(readFileSync(path, "utf8").trim());
        keys.set(triple, key);
        log(`updater public key for ${triple}: key id ${key.keyId}`);
      } catch (err) {
        problems.push(`bundles-${triple}/${PUBKEY_FILE}: ${err.message}`);
      }
    }
  } else {
    const key = configuredKey(pubkeys.config, problems);
    if (key !== null) {
      log(`updater public key from ${pubkeys.config}: key id ${key.keyId}`);
      if (key.keyId !== pubkeys.expectKeyId.toUpperCase()) {
        problems.push(`the updater public key in ${pubkeys.config} has key id ${key.keyId}, expected ${pubkeys.expectKeyId}`);
      }
      for (const { triple } of TARGETS) keys.set(triple, key);
    }
  }

  for (const path of extras) {
    const name = basename(path);
    const label = `--extra ${path}`;
    const stats = statOrNull(path, { follow: true });
    if (stats === null) problems.push(`${label}: missing`);
    else if (!stats.isFile()) problems.push(`${label}: not a regular file`);
    else if (stats.size === 0) problems.push(`${label}: empty`);
    else if (provided.has(name)) problems.push(`${label}: ${name} is already provided by the build`);
    else if (sources.has(name)) problems.push(`${label}: ${name} is already given by another --extra`);
    else if (!expected.includes(name)) problems.push(`${label}: ${name} is not a release asset`);
    else sources.set(name, { path, label });
  }
  for (const name of expected) {
    if (!provided.has(name) && !sources.has(name)) problems.push(`missing ${name}: give it with --extra`);
  }

  const outStats = statOrNull(outDir, { follow: true });
  if (outStats !== null && !outStats.isDirectory()) problems.push(`--out ${outDir} is not a folder`);
  else if (outStats !== null && readdirSync(outDir).length > 0) problems.push(`--out ${outDir} is not empty`);
  let rehearsalStats = null;
  if (perTarget) {
    if (within(outDir, rehearsalOut) || within(rehearsalOut, outDir)) {
      problems.push(`--rehearsal-out ${rehearsalOut} must be a folder of its own, apart from --out ${outDir}`);
    } else {
      rehearsalStats = statOrNull(rehearsalOut, { follow: true });
      if (rehearsalStats !== null && !rehearsalStats.isDirectory()) problems.push(`--rehearsal-out ${rehearsalOut} is not a folder`);
      else if (rehearsalStats !== null && readdirSync(rehearsalOut).length > 0) problems.push(`--rehearsal-out ${rehearsalOut} is not empty`);
    }
  }

  // Each updater artifact's signature, and in a dry run the rehearsal's,
  // against its target's key.
  const tripleOf = new Map(
    TARGETS.flatMap(({ triple }) => bundleFiles(triple, version).map(({ to }) => [to, triple])),
  );
  const hashes = new Map();
  /** updater artifact → the SHA-256 of its rehearsal signature, as checked. */
  const rehearsalHashes = new Map();
  const signatures = {};
  /**
   * A signature's text, trimmed, from one read: the text checked here, and
   * later carried by latest.json, and the hash the copy must match come from
   * the same bytes. Null, with a problem, when the text is empty.
   */
  const readSignature = ({ path, label }, name, into) => {
    const bytes = readFileSync(path);
    into.set(name, sha256(bytes));
    const text = bytes.toString("utf8").trim();
    if (text === "") problems.push(`${label} is empty`);
    return text === "" ? null : text;
  };
  for (const { asset, keys: platformKeys } of updaterArtifacts(version)) {
    const artifact = sources.get(asset);
    const sig = sources.get(`${asset}.sig`);
    const rehearsalSig = rehearsalSources.get(asset);
    const key = keys.get(tripleOf.get(asset));
    if (artifact === undefined) continue;
    const signature = sig === undefined ? null : readSignature(sig, `${asset}.sig`, hashes);
    const rehearsal = rehearsalSig === undefined ? null : readSignature(rehearsalSig, asset, rehearsalHashes);
    if (key === undefined || (signature === null && rehearsal === null)) continue;
    const data = readFileSync(artifact.path);
    hashes.set(asset, sha256(data));
    if (signature !== null) {
      const result = verify({ data, tauriSignature: signature, publicKey: key, version });
      if (result?.ok === true) {
        signatures[asset] = signature;
        log(`signature ok, key ${key.keyId}, version ${version}: ${asset} (${platformKeys.join(", ")})`);
      } else {
        problems.push(`bad signature for ${asset}: ${result?.reason ?? "no reason given"}`);
      }
    }
    if (rehearsal !== null) {
      const result = verify({ data, tauriSignature: rehearsal, publicKey: key, version: REHEARSAL_VERSION });
      if (result?.ok === true) log(`rehearsal signature ok, key ${key.keyId}, version ${REHEARSAL_VERSION}: ${asset}`);
      else problems.push(`bad rehearsal signature for ${asset}: ${result?.reason ?? "no reason given"}`);
    }
  }
  if (problems.length > 0) return failed();

  for (const [name, { path }] of sources) if (!hashes.has(name)) hashes.set(name, sha256(readFileSync(path)));
  const pubDate = new Date(now).toISOString();
  const manifest = Buffer.from(
    `${JSON.stringify(latestJson({ version, pubDate, signatures, base: downloadBase(version) }), null, 2)}\n`,
  );
  hashes.set(MANIFEST, sha256(manifest));
  const checksums = Buffer.from(sha256sums([...hashes].map(([name, hash]) => ({ name, sha256: hash }))));

  // Write, then check that each folder holds exactly what it should: the
  // release, then in a dry run the rehearsal's signatures.
  const written = [];
  const created = [];
  /** Where the files go now, for the message when one can't be written. */
  let writing = outDir;
  /** A problem when `dir` doesn't hold exactly `names`, naming the difference. */
  const holdsExactly = (dir, names, sentence) => {
    const listed = readdirSync(dir).sort(compare);
    const missing = names.filter((name) => !listed.includes(name));
    const unexpected = listed.filter((name) => !names.includes(name));
    if (missing.length > 0 || unexpected.length > 0) {
      problems.push(`${sentence}: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`);
    }
  };
  try {
    if (outStats === null) {
      mkdirSync(outDir, { recursive: true });
      created.push(outDir);
    }
    const write = (dir, name, bytes) => {
      const target = join(dir, name);
      writeFileSync(target, bytes, { flag: "wx" });
      written.push(target);
    };
    for (const [name, { path, label }] of [...sources].sort(([a], [b]) => compare(a, b))) {
      const bytes = readFileSync(path);
      if (sha256(bytes) !== hashes.get(name)) {
        problems.push(`${label} changed while the release was being assembled`);
        break;
      }
      write(outDir, name, bytes);
    }
    if (problems.length === 0) {
      write(outDir, MANIFEST, manifest);
      write(outDir, CHECKSUMS, checksums);
      holdsExactly(outDir, expected, "the out folder doesn't hold exactly the release's assets");
    }
    if (problems.length === 0 && perTarget) {
      writing = rehearsalOut;
      if (rehearsalStats === null) {
        mkdirSync(rehearsalOut, { recursive: true });
        created.push(rehearsalOut);
      }
      for (const [asset, { path, label }] of [...rehearsalSources].sort(([a], [b]) => compare(a, b))) {
        const bytes = readFileSync(path);
        if (sha256(bytes) !== rehearsalHashes.get(asset)) {
          problems.push(`${label} changed while the release was being assembled`);
          break;
        }
        write(rehearsalOut, `${asset}.sig`, bytes);
      }
      if (problems.length === 0) holdsExactly(rehearsalOut, rehearsalNames, "--rehearsal-out doesn't hold exactly the rehearsal's signatures");
    }
  } catch (err) {
    problems.push(`could not write ${writing}: ${err.message}`);
  }
  if (problems.length > 0) {
    for (const target of written.reverse()) {
      try {
        unlinkSync(target);
      } catch {
        // Best effort: the problem is already reported.
      }
    }
    for (const dir of created.reverse()) {
      try {
        rmdirSync(dir);
      } catch {
        // Best effort, as above.
      }
    }
    return failed();
  }
  return { assets: expected, rehearsal: rehearsalNames, problems };
}

/**
 * The updater public key in a Tauri config (plugins.updater.pubkey), parsed.
 * Appends a problem and returns null when it can't be read.
 */
function configuredKey(configPath, problems) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    problems.push(`--pubkey-config ${configPath}: ${err.message}`);
    return null;
  }
  const pubkey = config?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string") {
    problems.push(`--pubkey-config ${configPath}: no plugins.updater.pubkey`);
    return null;
  }
  try {
    return parsePublicKey(pubkey);
  } catch (err) {
    problems.push(`--pubkey-config ${configPath}: ${err.message}`);
    return null;
  }
}

/** The command line, as assemble()'s options. Throws a usage error. */
function parseArgs(argv) {
  const values = new Map();
  const extras = [];
  let perTarget = false;
  const takesValue = ["--in", "--out", "--version", "--pubkey-config", "--expect-key-id", "--rehearsal-out", "--extra"];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--per-target-pubkeys") {
      if (perTarget) throw new Error(`${flag} is given twice`);
      perTarget = true;
      continue;
    }
    if (!takesValue.includes(flag)) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--extra") extras.push(value);
    else if (values.has(flag)) throw new Error(`${flag} is given twice`);
    else values.set(flag, value);
  }
  for (const flag of ["--in", "--out", "--version"]) {
    if (!values.has(flag)) throw new Error(`${flag} is required`);
  }
  const config = values.get("--pubkey-config");
  const expectKeyId = values.get("--expect-key-id");
  const rehearsalOut = values.get("--rehearsal-out");
  if (perTarget && (config !== undefined || expectKeyId !== undefined)) {
    throw new Error("--per-target-pubkeys can't be combined with --pubkey-config or --expect-key-id");
  }
  if (!perTarget && (config === undefined || expectKeyId === undefined)) {
    throw new Error("give --pubkey-config with --expect-key-id, or --per-target-pubkeys");
  }
  if (perTarget !== (rehearsalOut !== undefined)) {
    throw new Error("--rehearsal-out goes with --per-target-pubkeys, and only with it: a dry run's builds sign the rehearsal's signatures");
  }
  if (expectKeyId !== undefined && !/^[0-9A-Fa-f]{16}$/.test(expectKeyId)) {
    throw new Error(`--expect-key-id must be a key id of 16 hex digits, not ${expectKeyId}`);
  }
  return {
    inDir: values.get("--in"),
    outDir: values.get("--out"),
    version: values.get("--version"),
    pubkeys: perTarget ? { perTarget: true } : { config, expectKeyId },
    ...(perTarget ? { rehearsalOut } : {}),
    extras,
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`assemble: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = assemble({ ...options, log: (line) => process.stdout.write(`assemble: ${line}\n`) });
  } catch (err) {
    process.stderr.write(`assemble: ${err.message}\n`);
    return 1;
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) process.stderr.write(`assemble: ${problem}\n`);
    process.stderr.write(`assemble: ${result.problems.length} problem(s); nothing was assembled in ${options.outDir}\n`);
    return 1;
  }
  process.stdout.write(`assemble: ${result.assets.length} assets in ${options.outDir}:\n`);
  for (const asset of result.assets) process.stdout.write(`  ${asset}\n`);
  if (options.rehearsalOut !== undefined) {
    process.stdout.write(`assemble: ${result.rehearsal.length} rehearsal signatures in ${options.rehearsalOut}:\n`);
    for (const name of result.rehearsal) process.stdout.write(`  ${name}\n`);
  }
  return 0;
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
