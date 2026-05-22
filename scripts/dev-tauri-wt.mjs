#!/usr/bin/env node
//! Boot `tauri dev` with worktree-aware ports + an isolated FLEETIFY_HOME,
//! so multiple worktrees of this repo can run the app side-by-side
//! without colliding on:
//!
//!   - the embedded backend port (FLEETIFY_BACKEND_PORT, default 8765)
//!   - the Vite dev server port (VITE_PORT, default 3000)
//!   - `~/.fleetify/` shared user data (telemetry-outbox.sqlite,
//!     mcp_servers.json, plugins/, plugin_state.json, clones/, device.json)
//!
//! Slot resolution order (lowest → highest priority):
//!
//!   1. Main checkout (NOT a linked worktree): slot = 0 (default ports).
//!   2. Linked worktree: slot derived from the worktree's `.git/worktrees/<name>`
//!      basename via sha256 → 1..=99. Deterministic, so the same worktree
//!      always gets the same slot (and thus the same data dir on next boot).
//!   3. CLI argv override: `npm run dev:tauri:wt -- 17` forces slot 17.
//!
//! Per-slot env:
//!   VITE_PORT             = 3000 + slot
//!   FLEETIFY_BACKEND_PORT = 8765 + slot
//!   FLEETIFY_HOME         = ~/.fleetify-wt-<slot, 2-digit>  (slot 0 → ~/.fleetify-wt-00)
//!   FLEETIFY_RESOURCE     = http://127.0.0.1:<backend port>
//!   FLEETIFY_AUDIENCE     = http://127.0.0.1:<backend port>
//!
//! NOTE: slot 0 still gets its own FLEETIFY_HOME — running this from main
//! does NOT touch your stock `~/.fleetify`. If you want the historical
//! single-data-dir behaviour, run `npm run dev:tauri` instead.

import { spawn, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

/** Return the linked-worktree name, or null when in a main checkout. */
function detectWorktreeName() {
  let gitDir, gitCommonDir;
  try {
    gitDir = execSync('git rev-parse --absolute-git-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    gitCommonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git repo at all — treat as main checkout.
    return null;
  }
  if (gitDir === gitCommonDir) return null; // main checkout
  // Linked worktree: gitDir is `<repo>/.git/worktrees/<name>`. The
  // basename is the worktree directory name as known to git, which
  // is stable across reboots and across `git worktree move`.
  return basename(gitDir);
}

/** Deterministic 1..=99 slot from an arbitrary string. */
function slotFromName(name) {
  const hex = createHash('sha256').update(name).digest('hex').slice(0, 8);
  // 32-bit unsigned → mod 99 + 1 keeps slot in [1, 99]. Slot 0 is
  // reserved for "main checkout" so worktree-derived slots never
  // collide with that.
  return (parseInt(hex, 16) % 99) + 1;
}

function resolveSlot() {
  // Explicit argv override wins. Accept 0..=99; reject anything else
  // with a usage message so a typo doesn't silently fall through to
  // worktree auto-detection.
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    const n = Number(argv[0]);
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      console.error(`[dev:tauri:wt] usage: npm run dev:tauri:wt -- <slot 0-99>`);
      process.exit(2);
    }
    return { slot: n, source: `explicit (${n})` };
  }
  const wt = detectWorktreeName();
  if (wt) {
    return { slot: slotFromName(wt), source: `worktree "${wt}"` };
  }
  return { slot: 0, source: 'main checkout' };
}

function main() {
  const { slot, source } = resolveSlot();
  const padded = slot.toString().padStart(2, '0');
  const vitePort = 3000 + slot;
  const backendPort = 8765 + slot;
  const fleetifyHome = join(homedir(), `.fleetify-wt-${padded}`);
  const backendUrl = `http://127.0.0.1:${backendPort}`;

  const env = {
    ...process.env,
    VITE_PORT: String(vitePort),
    FLEETIFY_BACKEND_PORT: String(backendPort),
    FLEETIFY_HOME: fleetifyHome,
    // No-auth mode by default — worktree dev sessions shouldn't lock
    // the user out of their primary ~/.fleetify cloud session, and
    // signing into the real OIDC issuer from N parallel processes
    // burns tokens. Override with `FLEETIFY_NOAUTH=0 npm run
    // dev:tauri:wt` if you actually need the real auth flow from a
    // worktree.
    FLEETIFY_NOAUTH: process.env.FLEETIFY_NOAUTH ?? '1',
    // Mirror dev:tauri's OIDC env. The auth issuer / dashboard URL
    // don't shift per-slot (they're shared dev endpoints); only the
    // RESOURCE / AUDIENCE follow the backend port.
    FLEETIFY_ISSUER: process.env.FLEETIFY_ISSUER ?? 'http://localhost:3001',
    FLEETIFY_DASHBOARD_URL:
      process.env.FLEETIFY_DASHBOARD_URL ?? 'http://localhost:3000',
    FLEETIFY_RESOURCE: backendUrl,
    FLEETIFY_AUDIENCE: backendUrl,
  };

  console.log(`[dev:tauri:wt] booting (source: ${source}, slot: ${slot})`);
  console.log(`  VITE_PORT=${vitePort}`);
  console.log(`  FLEETIFY_BACKEND_PORT=${backendPort}`);
  console.log(`  FLEETIFY_HOME=${fleetifyHome}`);
  console.log(`  FLEETIFY_NOAUTH=${env.FLEETIFY_NOAUTH}`);

  // `npx tauri dev` so the user's local @tauri-apps/cli is honoured
  // (matches the other dev scripts in package.json). `shell: true` is
  // needed on Windows so `.cmd` shims resolve.
  const proc = spawn('npx', ['tauri', 'dev'], {
    env,
    stdio: 'inherit',
    shell: true,
  });
  proc.on('exit', (code) => process.exit(code ?? 0));
}

main();
