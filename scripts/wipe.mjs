#!/usr/bin/env node
/**
 * wipe.mjs — Fleetify-side "factory reset". Removes every persisted
 * piece of state so the next launch behaves like a fresh install:
 *
 *   1. `~/.fleetify/`              — backend SQLite, telemetry outbox,
 *                                    device.json, plugin_state.json,
 *                                    installed plugins.
 *   2. Tauri config dir            — `<appdata>/com.fleetify.app/`
 *                                    holds `fleet.config.json`.
 *   3. WebView2 user data          — `<localappdata>/com.fleetify.app/`
 *                                    holds the WebView's localStorage,
 *                                    IndexedDB, cookies, cache.
 *   4. OS keychain entries         — every entry whose service name
 *                                    starts with `Fleetify` — covers
 *                                    `Fleetify` (OIDC refresh token),
 *                                    `Fleetify-GitHub` (PAT/OAuth),
 *                                    and `Fleetify-Provider-<id>`
 *                                    (each API provider's saved key).
 *
 * Idempotent: missing paths are skipped silently. Logs every action so
 * you can audit what was touched.
 *
 * Pass `--keep-keychain` to skip step 4 (useful when you want to reset
 * onboarding state without re-running OAuth).
 */

import { rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  isFleetifyKeychainTarget,
  parseMacKeychainDump,
  parseSecretToolDump,
} from "./wipe/keychain-filter.mjs";

const ARGS = new Set(process.argv.slice(2));
const KEEP_KEYCHAIN = ARGS.has("--keep-keychain");

const home = homedir();
const plat = platform(); // "win32" | "darwin" | "linux"

// ── Targets ────────────────────────────────────────────────────────
const targets = [
  {
    label: "backend state",
    path: path.join(home, ".fleetify"),
  },
];

if (plat === "win32") {
  const APPDATA = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  targets.push(
    {
      label: "Tauri config",
      path: path.join(APPDATA, "com.fleetify.app"),
    },
    {
      label: "WebView2 user data",
      path: path.join(LOCALAPPDATA, "com.fleetify.app"),
    },
  );
} else if (plat === "darwin") {
  targets.push(
    {
      label: "Tauri config",
      path: path.join(home, "Library", "Application Support", "com.fleetify.app"),
    },
    {
      label: "WebView (WebKit) cache",
      path: path.join(home, "Library", "Caches", "com.fleetify.app"),
    },
  );
} else {
  targets.push(
    {
      label: "Tauri config",
      path: path.join(home, ".config", "com.fleetify.app"),
    },
    {
      label: "WebView cache",
      path: path.join(home, ".cache", "com.fleetify.app"),
    },
  );
}

// ── Helpers ────────────────────────────────────────────────────────
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function wipeDir(label, dir) {
  if (!(await exists(dir))) {
    console.log(`  · ${label.padEnd(22)} skip       ${dir} (not found)`);
    return;
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    console.log(`  ✓ ${label.padEnd(22)} removed    ${dir}`);
  } catch (err) {
    console.log(`  ✗ ${label.padEnd(22)} FAILED     ${dir}`);
    console.log(`    ${err.message}`);
  }
}

// ── OS keychain ────────────────────────────────────────────────────
// Implementations vary by OS. The `keyring` crate (used by the Rust
// shell) writes Generic Credentials with target = `<service>/<user>`.
// We list and prune every entry whose target starts with `Fleetify`
// or `Fleetify-GitHub`.
function wipeKeychainWindows() {
  // `cmdkey /list` prints "Target: <name>" lines. Filter via the
  // shared predicate so the same rule governs every OS — keeps
  // Fleetify-Provider-* + future Fleetify-* namespaces consistent.
  const list = spawnSync("cmdkey", ["/list"], { encoding: "utf8" });
  if (list.status !== 0) {
    console.log("  ✗ keychain               FAILED     cmdkey /list returned", list.status);
    if (list.stderr) console.log(`    ${list.stderr.trim()}`);
    return;
  }
  const targets = [];
  for (const line of list.stdout.split(/\r?\n/)) {
    const m = line.match(/Target:\s*(.+?)\s*$/i);
    if (!m) continue;
    const target = m[1];
    if (isFleetifyKeychainTarget(target)) targets.push(target);
  }
  if (targets.length === 0) {
    console.log("  · keychain               skip       no Fleetify* entries found");
    return;
  }
  for (const t of targets) {
    const del = spawnSync("cmdkey", [`/delete:${t}`], { encoding: "utf8" });
    if (del.status === 0) {
      console.log(`  ✓ keychain               removed    ${t}`);
    } else {
      console.log(`  ✗ keychain               FAILED     ${t}`);
      if (del.stderr) console.log(`    ${del.stderr.trim()}`);
    }
  }
}

function wipeKeychainMac() {
  // Discover services first via `security dump-keychain` (attributes
  // only, no secret reveals; doesn't prompt for the keychain pw on
  // current macOS). Filter through the shared predicate, then delete.
  const dump = spawnSync("security", ["dump-keychain"], { encoding: "utf8" });
  if (dump.status !== 0) {
    console.log("  ✗ keychain               FAILED     security dump-keychain returned", dump.status);
    if (dump.stderr) console.log(`    ${dump.stderr.trim()}`);
    return;
  }
  const services = parseMacKeychainDump(dump.stdout);
  if (services.length === 0) {
    console.log("  · keychain               skip       no Fleetify* services found");
    return;
  }
  for (const service of services) {
    const r = spawnSync("security", ["delete-generic-password", "-s", service], { encoding: "utf8" });
    if (r.status === 0) {
      console.log(`  ✓ keychain               removed    service=${service}`);
    } else {
      console.log(`  ✗ keychain               FAILED     service=${service}`);
      if (r.stderr) console.log(`    ${r.stderr.trim()}`);
    }
  }
}

function wipeKeychainLinux() {
  // `secret-tool search --all` lists every secret with attributes;
  // we never look at the secret value, only `attribute.service`.
  const dump = spawnSync("secret-tool", ["search", "--all"], { encoding: "utf8" });
  if (dump.status !== 0) {
    // Missing secret-tool is the common fresh-install case — log,
    // don't error.
    console.log("  · keychain               skip       secret-tool unavailable (status", dump.status, ")");
    return;
  }
  const services = parseSecretToolDump(dump.stdout);
  if (services.length === 0) {
    console.log("  · keychain               skip       no Fleetify* services found");
    return;
  }
  for (const service of services) {
    const r = spawnSync("secret-tool", ["clear", "service", service], { encoding: "utf8" });
    if (r.status === 0) {
      console.log(`  ✓ keychain               cleared    service=${service}`);
    } else {
      console.log(`  ✗ keychain               FAILED     service=${service}`);
      if (r.stderr) console.log(`    ${r.stderr.trim()}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────
console.log("Fleetify wipe — clearing every persisted piece of state.\n");

for (const t of targets) {
  await wipeDir(t.label, t.path);
}

if (KEEP_KEYCHAIN) {
  console.log("  · keychain               skip       --keep-keychain passed");
} else {
  if (plat === "win32") wipeKeychainWindows();
  else if (plat === "darwin") wipeKeychainMac();
  else wipeKeychainLinux();
}

console.log("\nDone. Launch the app again to start from scratch.");
