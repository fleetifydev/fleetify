//! Compile every Fleet MCP sidecar crate AND stage each binary where Tauri can
//! bundle it, so the `fleet-*-mcp` servers are present in EVERY run mode:
//!
//!   * dev  — built into `target/{debug}/`, right next to the `fleetify-app`
//!            dev exe that the backend resolves them against
//!            (`current_exe().parent()`, see
//!            `crates/fleetify-backend/src/services/mcp_registry.rs`).
//!   * packaged release — also copied to `src-tauri/binaries/<bin>-<triple>`
//!            so `tauri.conf.json::bundle.externalBin` ships them next to the
//!            installed exe (Tauri strips the triple, so the installed name
//!            stays `fleet-*-mcp` and resolve_builtin_path() still finds it).
//!
//! WHY THIS EXISTS: nothing else builds these crates. They are standalone
//! workspace binaries, NOT dependencies of `src-tauri`, so `tauri dev` /
//! `tauri build` only ever compile the app. When a sidecar is missing,
//! `builtin_resolves()` returns false and that MCP silently disappears from
//! the agent (no memory/recall, no dispatch, no reveng). This step is wired
//! into `tauri.conf.json::build.beforeDevCommand` / `beforeBuildCommand`.
//! (The Claude permission gate used to be a sidecar too; it now runs
//! in-process over HTTP - see routers::internal::mcp_permission_*.)
//!
//! Usage:
//!   node scripts/build-sidecars.mjs                    # debug   (for `tauri dev`)
//!   node scripts/build-sidecars.mjs --release          # release (for `tauri build`)
//!   node scripts/build-sidecars.mjs --release --target <triple>
//!                                                      # release, for that target (CI)
//!   node scripts/build-sidecars.mjs --check            # drift guard; builds nothing
//!
//! The target triple is `--target`, else TAURI_ENV_TARGET_TRIPLE, which the
//! Tauri CLI sets for its before-commands (`tauri build --target <triple>`
//! included), else the host's. Cargo gets `--target` when it was given or
//! when the triple isn't the host's, and then writes to
//! `target/<triple>/<profile>/` instead of `target/<profile>/`.
//! CARGO_TARGET_DIR moves `target/`, as it does for cargo.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// One source of truth for the sidecar list. `pkg` is the cargo PACKAGE name
// (the `-p` arg); `bin` is the produced binary. Add new `fleet-*-mcp` crates
// here AND to `bundle.externalBin` in src-tauri/tauri.conf.json.
const SIDECARS = [
  { pkg: 'memory-mcp', bin: 'fleet-memory-mcp' },
  { pkg: 'dispatch-mcp', bin: 'fleet-dispatch-mcp' },
  { pkg: 'reveng-mcp', bin: 'fleet-reveng-mcp' },
  { pkg: 'browser-mcp', bin: 'fleet-browser-mcp' },
];

// What a target triple may contain. Cargo runs through a shell (see
// buildAndStage), so a triple must not carry shell syntax, and it ends up
// in the staged file names.
const TRIPLE = /^[A-Za-z0-9_.-]+$/;

/**
 * What a run builds, and where cargo puts it. Pure: `argv` (the arguments
 * after the script), `env` and `hostTriple` (from `rustc -vV`) are all it
 * reads.
 *
 * - `triple`: `--target <triple>`, else `env.TAURI_ENV_TARGET_TRIPLE`, else
 *   `hostTriple`.
 * - `cargoTarget`: what cargo gets as `--target`: the triple when `--target`
 *   was given or the triple isn't the host's, otherwise null.
 * - `outDir`: the folder cargo writes the binaries to,
 *   `<CARGO_TARGET_DIR or target>[/<cargoTarget>]/<profile>`, relative to
 *   the repo root unless CARGO_TARGET_DIR is absolute.
 * - `exe`: ".exe" for a Windows triple.
 *
 * Throws when `--target` has no triple after it, or the triple has anything
 * but letters, digits, '_', '.' and '-' in it.
 *
 * @param {{ argv: string[], env: Record<string, string | undefined>, hostTriple: string }} input
 * @returns {{ check: boolean, release: boolean, profile: "debug"|"release", triple: string, cargoTarget: string|null, outDir: string, exe: ""|".exe" }}
 */
export function planBuild({ argv, env, hostTriple }) {
  let check = false;
  let release = false;
  let target = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') {
      check = true;
    } else if (argv[i] === '--release') {
      release = true;
    } else if (argv[i] === '--target') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--target needs a target triple');
      target = value;
      i += 1;
    }
  }
  const profile = release ? 'release' : 'debug';
  const triple = target ?? (env.TAURI_ENV_TARGET_TRIPLE || hostTriple);
  if (typeof triple !== 'string' || !TRIPLE.test(triple)) {
    throw new Error(`not a target triple: ${JSON.stringify(triple)}`);
  }
  const cargoTarget = target !== null || triple !== hostTriple ? triple : null;
  const targetDir = env.CARGO_TARGET_DIR || 'target';
  const outDir = cargoTarget
    ? posix.join(targetDir, cargoTarget, profile)
    : posix.join(targetDir, profile);
  const exe = triple.includes('windows') ? '.exe' : '';
  return { check, release, profile, triple, cargoTarget, outDir, exe };
}

/** Run the script with `argv` (the arguments after it). Returns the exit code. */
function main(argv, env) {
  // `--check` is the drift guard: SIDECARS above and bundle.externalBin in
  // tauri.conf.json have to list the same binaries, and nothing enforced that
  // until now — the comment above simply asked contributors to remember. A
  // sidecar added here but not there is bundled-but-missing at runtime; added
  // there but not here fails the Tauri build with "resource path … doesn't
  // exist". Compares only; never compiles, so CI can run it in milliseconds.
  // It starts no rustc either: where a toolchain is pinned, rustup would
  // install that toolchain first.
  if (argv.includes('--check')) return checkExternalBinDrift();

  const hostTriple = rustcHostTriple();
  if (!hostTriple) {
    console.error('[build-sidecars] could not determine host triple from `rustc -vV`');
    return 1;
  }
  let plan;
  try {
    plan = planBuild({ argv, env, hostTriple });
  } catch (err) {
    console.error(`[build-sidecars] ${err.message}`);
    return 2;
  }
  return buildAndStage(plan);
}

/** Compile the sidecars as `plan` says, then stage them. Returns the exit code. */
function buildAndStage(plan) {
  // 1) Compile every sidecar crate into plan.outDir.
  const cargoArgs = ['build', ...SIDECARS.flatMap((s) => ['-p', s.pkg])];
  if (plan.release) cargoArgs.push('--release');
  if (plan.cargoTarget) cargoArgs.push('--target', plan.cargoTarget);
  console.log(`[build-sidecars] ${plan.profile} for ${plan.triple}: cargo ${cargoArgs.join(' ')}`);

  // `shell: true` so the OS resolves `cargo` via PATH (+ PATHEXT on Windows),
  // mirroring scripts/dev-tauri-wt.mjs. From the repo root, so that a
  // relative CARGO_TARGET_DIR means the same folder to cargo as to outDir.
  const built = spawnSync('cargo', cargoArgs, { stdio: 'inherit', shell: true, cwd: ROOT });
  if (built.error) {
    console.error(`[build-sidecars] failed to spawn cargo: ${built.error.message}`);
    return 1;
  }
  if (built.status !== 0) {
    console.error(`[build-sidecars] cargo exited with code ${built.status}`);
    return built.status ?? 1;
  }

  // 2) Stage each binary as src-tauri/binaries/<bin>-<target-triple>[.exe] so
  //    bundle.externalBin can pick it up. Done in every mode so a plain
  //    `tauri dev` (which resolves externalBin too) never fails on a missing
  //    sidecar.
  const fromDir = resolve(ROOT, plan.outDir);
  const stageDir = join(ROOT, 'src-tauri', 'binaries');
  mkdirSync(stageDir, { recursive: true });
  for (const s of SIDECARS) {
    const from = join(fromDir, `${s.bin}${plan.exe}`);
    const name = `${s.bin}-${plan.triple}${plan.exe}`;
    if (!existsSync(from)) {
      console.error(`[build-sidecars] expected build output missing: ${from}`);
      return 1;
    }
    copyFileSync(from, join(stageDir, name));
    console.log(`[build-sidecars] staged -> binaries/${name}`);
  }
  return 0;
}

/**
 * Compare SIDECARS against `bundle.externalBin`. Returns a process exit code:
 * 0 when they agree, 1 on any drift (or an unreadable/!malformed config).
 * Tauri strips the host triple at bundle time, so externalBin entries are the
 * bare `binaries/<bin>` form — that is what we compare against.
 */
function checkExternalBinDrift() {
  const confPath = join(ROOT, 'src-tauri', 'tauri.conf.json');
  let conf;
  try {
    conf = JSON.parse(readFileSync(confPath, 'utf8'));
  } catch (e) {
    console.error(`[build-sidecars] --check: cannot read ${confPath}: ${e.message}`);
    return 1;
  }
  const declared = conf?.bundle?.externalBin;
  if (!Array.isArray(declared)) {
    console.error('[build-sidecars] --check: bundle.externalBin is missing or not an array');
    return 1;
  }
  const inConf = new Set(declared.map((p) => p.split('/').pop()));
  const inScript = new Set(SIDECARS.map((s) => s.bin));

  const missingFromConf = [...inScript].filter((b) => !inConf.has(b)).sort();
  const missingFromScript = [...inConf].filter((b) => !inScript.has(b)).sort();

  if (missingFromConf.length === 0 && missingFromScript.length === 0) {
    console.log(`[build-sidecars] --check: ok, ${inScript.size} sidecars in sync`);
    return 0;
  }
  for (const b of missingFromConf) {
    console.error(`[build-sidecars] --check: '${b}' is built here but absent from bundle.externalBin`);
  }
  for (const b of missingFromScript) {
    console.error(`[build-sidecars] --check: '${b}' is in bundle.externalBin but not built here`);
  }
  console.error('[build-sidecars] --check: sidecar list drift — fix scripts/build-sidecars.mjs or src-tauri/tauri.conf.json');
  return 1;
}

/** Host target triple from `rustc -vV` (the `host:` line), or null. */
function rustcHostTriple() {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8', shell: true, cwd: ROOT });
  const m = (r.stdout || '').match(/^host:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Last, so SIDECARS and TRIPLE are initialised. Only when run as a script:
// the tests import planBuild without building anything.
if (invokedDirectly()) process.exitCode = main(process.argv.slice(2), process.env);
