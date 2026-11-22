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
 * A download that fails in a way that can pass is tried again, three tries in
 * all, 2 s and then 5 s apart: a network error or a timeout, while fetching
 * or while reading the body, or HTTP 429 or 5xx. Each retry is reported on
 * stderr with the tool, the try and the reason. Any other HTTP status fails at
 * once, and so does a SHA-256 that doesn't match: upstream replaced the file,
 * which another try wouldn't change (appimage-tools.json's note says what to
 * do then).
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
/** The waits before a download's second and third tries, after a failure that can pass. */
const RETRY_DELAYS_MS = [2_000, 5_000];

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

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

/** An Error with `message`, whose `retry` says whether another try could succeed. */
const failure = (message, retry) => Object.assign(new Error(message), { retry });

/** Why fetch failed: its message, and its cause's code or message, as its own message says only "fetch failed". */
function reason(err) {
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? err);
}

/**
 * Download one tool, once; resolves with its bytes, or rejects with a
 * failure() that says whether another try could succeed. Any error while
 * fetching it or reading its body can pass, the timeout's included, and so
 * can HTTP 429 and 5xx; any other HTTP status can't.
 */
async function download(url, fetch) {
  let response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw failure(reason(err), true);
  }
  if (!response.ok) {
    // Dropped unread, which frees the connection for the next try.
    await response.body?.cancel().catch(() => {});
    throw failure(`HTTP ${response.status} from ${url}`, response.status === 429 || response.status >= 500);
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw failure(reason(err), true);
  }
}

/**
 * Download one tool, trying again after each of RETRY_DELAYS_MS while the
 * failure is one that can pass, and reporting each retry to `warn`. Resolves
 * with its bytes, or rejects with the last failure, whose `attempts` says
 * how many tries were made.
 */
async function downloadTool({ file, url }, { fetch, sleep, warn }) {
  const attempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await download(url, fetch);
    } catch (err) {
      if (!err.retry || attempt === attempts) throw Object.assign(err, { attempts: attempt });
      const wait = RETRY_DELAYS_MS[attempt - 1];
      warn(`${file}: attempt ${attempt} of ${attempts} failed: ${err.message}; trying again in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

/**
 * Download and check every tool, then install them all, or none. `fetch` and
 * `sleep` stand in for the global fetch and a real wait in the tests; `warn`
 * gets a line for each retry.
 *
 * @param {{ tools: { file: string, url: string, sha256: string }[], cacheDir: string, log?: (line: string) => void, warn?: (line: string) => void, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<string[]>} the problems; empty when every tool was installed
 */
export async function installTools({ tools, cacheDir, log = () => {}, warn = () => {}, fetch = globalThis.fetch, sleep = pause }) {
  const problems = [];
  const checked = [];
  for (const { file, url, sha256 } of tools) {
    let bytes;
    try {
      bytes = await downloadTool({ file, url }, { fetch, sleep, warn });
    } catch (err) {
      const tries = err.attempts > 1 ? ` after ${err.attempts} attempts` : "";
      problems.push(`${file}: download failed${tries}: ${err.message}`);
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
  const problems = await installTools({
    tools,
    cacheDir: args.cacheDir,
    log: (line) => process.stdout.write(`appimage-tools: ${line}\n`),
    warn: (line) => process.stderr.write(`appimage-tools: ${line}\n`),
  });
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
