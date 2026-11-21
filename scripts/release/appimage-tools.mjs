#!/usr/bin/env node
/**
 * appimage-tools.mjs — install the tools tauri-bundler runs to make the Linux
 * AppImage into its cache, each checked against a pinned SHA-256, before the
 * bundler would download them unchecked.
 *
 *   node scripts/release/appimage-tools.mjs [--manifest <file>] [--cache-dir <dir>]
 *
 * The manifest (appimage-tools.json next to this script by default) lists
 * each tool: the name the bundler's cache gives it, the URL to download it
 * from, and its SHA-256. The bundler only downloads a tool when its cache
 * lacks the file, so once these are in place it uses them as they are. Its
 * cache is dirs::cache_dir()/tauri: $XDG_CACHE_HOME/tauri when that is an
 * absolute path, else ~/.cache/tauri (the default for --cache-dir).
 *
 * Every tool is downloaded and checked before any is installed; a failed
 * download or a SHA-256 that doesn't match installs nothing. Each is then
 * written next to its place and renamed into it, with mode 0755. The bundler
 * later changes three bytes of the cached linuxdeploy in place, so it is the
 * download that is checked, not the cache afterwards.
 *
 * URLs must be https; plain http is accepted from the loopback address
 * only, which the tests use.
 *
 * Exit codes: 0 installed; 1 a bad manifest, a failed download or a
 * mismatch, each named on stderr; 2 usage.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release/appimage-tools.mjs [--manifest <file>] [--cache-dir <dir>]";
const DEFAULT_MANIFEST = fileURLToPath(new URL("./appimage-tools.json", import.meta.url));
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Where tauri-bundler caches its AppImage tools: dirs::cache_dir()/tauri. */
export function defaultCacheDir(env = process.env) {
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "tauri");
}

/**
 * The manifest's tools, or an Error naming what is wrong with it.
 *
 * @param {unknown} manifest
 * @returns {{ file: string, url: string, sha256: string }[]}
 */
export function parseManifest(manifest) {
  const tools = manifest?.tools;
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("the manifest lists no tools");
  const seen = new Set();
  for (const [i, tool] of tools.entries()) {
    const where = `the manifest's tool ${i + 1}`;
    const { file, url, sha256 } = tool ?? {};
    if (typeof file !== "string" || file === "" || file === "." || file === ".." || /[/\\]/.test(file)) {
      throw new Error(`${where} has no plain file name: ${JSON.stringify(file)}`);
    }
    if (seen.has(file)) throw new Error(`the manifest lists ${file} twice`);
    seen.add(file);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where} (${file}) has no valid URL`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) {
      throw new Error(`${where} (${file}) has a URL that isn't https: ${url}`);
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${where} (${file}) has no SHA-256 of 64 hex digits`);
  }
  return tools.map(({ file, url, sha256 }) => ({ file, url, sha256 }));
}

/** Download one tool; resolves with its bytes, or rejects with an Error naming the HTTP status. */
async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download and check every tool, then install them all, or none.
 *
 * @param {{ tools: { file: string, url: string, sha256: string }[], cacheDir: string, log?: (line: string) => void }} options
 * @returns {Promise<string[]>} the problems; empty when every tool was installed
 */
export async function installTools({ tools, cacheDir, log = () => {} }) {
  const problems = [];
  const checked = [];
  for (const { file, url, sha256 } of tools) {
    let bytes;
    try {
      bytes = await download(url);
    } catch (err) {
      problems.push(`${file}: download failed: ${err.message}`);
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) {
      problems.push(`${file}: SHA-256 ${actual}, expected ${sha256} (from ${url})`);
      continue;
    }
    checked.push({ file, bytes, sha256 });
  }
  if (problems.length > 0) return problems;

  mkdirSync(cacheDir, { recursive: true });
  for (const { file, bytes, sha256 } of checked) {
    const target = join(cacheDir, file);
    const temporary = join(cacheDir, `.${file}.${process.pid}.download`);
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o755 });
      chmodSync(temporary, 0o755);
      renameSync(temporary, target);
    } catch (err) {
      rmSync(temporary, { force: true });
      return [`${file}: can't install into ${cacheDir}: ${err.message}`];
    }
    log(`installed ${file} (SHA-256 ${sha256}) into ${cacheDir}`);
  }
  return [];
}

/** --manifest and --cache-dir, each at most once and with a value. Throws a usage error. */
function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag !== "--manifest" && flag !== "--cache-dir") throw new Error(`unexpected argument: ${flag}`);
    if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} is given twice`);
    values.set(flag, value);
  }
  return { manifest: values.get("--manifest") ?? DEFAULT_MANIFEST, cacheDir: values.get("--cache-dir") ?? defaultCacheDir() };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`appimage-tools: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let tools;
  try {
    tools = parseManifest(JSON.parse(readFileSync(args.manifest, "utf8")));
  } catch (err) {
    process.stderr.write(`appimage-tools: bad manifest ${args.manifest}: ${err.message}\n`);
    return 1;
  }
  const problems = await installTools({ tools, cacheDir: args.cacheDir, log: (line) => process.stdout.write(`appimage-tools: ${line}\n`) });
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`appimage-tools: ${problem}\n`);
    process.stderr.write(`appimage-tools: nothing was installed into ${args.cacheDir}\n`);
    return 1;
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
if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
