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
//!   node scripts/build-sidecars.mjs            # debug   (for `tauri dev`)
//!   node scripts/build-sidecars.mjs --release  # release (for `tauri build`)

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// `--check` is the drift guard: SIDECARS above and bundle.externalBin in
// tauri.conf.json have to list the same binaries, and nothing enforced that
// until now — the comment above simply asked contributors to remember. A
// sidecar added here but not there is bundled-but-missing at runtime; added
// there but not here fails the Tauri build with "resource path … doesn't
// exist". Compares only; never compiles, so CI can run it in milliseconds.
if (process.argv.includes('--check')) {
  process.exit(checkExternalBinDrift());
}

const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const exe = process.platform === 'win32' ? '.exe' : '';

// 1) Compile every sidecar crate into target/<profile>/.
const cargoArgs = ['build', ...SIDECARS.flatMap((s) => ['-p', s.pkg])];
if (release) cargoArgs.push('--release');
console.log(`[build-sidecars] ${profile}: cargo ${cargoArgs.join(' ')}`);

// `shell: true` so the OS resolves `cargo` via PATH (+ PATHEXT on Windows),
// mirroring scripts/dev-tauri-wt.mjs.
const built = spawnSync('cargo', cargoArgs, { stdio: 'inherit', shell: true });
if (built.error) {
  console.error(`[build-sidecars] failed to spawn cargo: ${built.error.message}`);
  process.exit(1);
}
if (built.status !== 0) {
  console.error(`[build-sidecars] cargo exited with code ${built.status}`);
  process.exit(built.status ?? 1);
}

// 2) Stage each binary as src-tauri/binaries/<bin>-<target-triple>[.exe] so
//    bundle.externalBin can pick it up. Done in every mode so a plain
//    `tauri dev` (which resolves externalBin too) never fails on a missing
//    sidecar.
const triple = hostTriple();
const outDir = join(ROOT, 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
for (const s of SIDECARS) {
  const from = join(ROOT, 'target', profile, `${s.bin}${exe}`);
  const to = join(outDir, `${s.bin}-${triple}${exe}`);
  if (!existsSync(from)) {
    console.error(`[build-sidecars] expected build output missing: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
  console.log(`[build-sidecars] staged -> binaries/${s.bin}-${triple}${exe}`);
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

/** Host target triple from `rustc -vV` (the `host:` line). */
function hostTriple() {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8', shell: true });
  const m = (r.stdout || '').match(/^host:\s*(.+)$/m);
  if (!m) {
    console.error('[build-sidecars] could not determine host triple from `rustc -vV`');
    process.exit(1);
  }
  return m[1].trim();
}
