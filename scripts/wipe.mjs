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
 *   4. OS keychain entries         — `Fleetify` (OIDC refresh token) +
 *                                    `Fleetify-GitHub` (PAT/OAuth payload).
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
  // `cmdkey /list` prints "Target: <name>" lines. Filter and delete.
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
    // The `keyring` crate sometimes prefixes targets with
    // "LegacyGeneric:target=" on Windows. Strip that so the literal
    // service name we wrote (Fleetify, Fleetify-GitHub) shows up.
    const bare = target.replace(/^LegacyGeneric:target=/i, "");
    if (bare.startsWith("Fleetify-GitHub") || bare.startsWith("Fleetify/") || bare === "Fleetify" || bare.startsWith("Fleetify ")) {
      targets.push(target);
    }
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
  // `security delete-generic-password -s <service>` removes by
  // service name. Run for each known service; errors when the entry
  // doesn't exist are expected and silent.
  for (const service of ["Fleetify", "Fleetify-GitHub"]) {
    const r = spawnSync("security", ["delete-generic-password", "-s", service], { encoding: "utf8" });
    if (r.status === 0) {
      console.log(`  ✓ keychain               removed    service=${service}`);
    } else {
      console.log(`  · keychain               skip       service=${service} (not found)`);
    }
  }
}

function wipeKeychainLinux() {
  // libsecret-tool: `secret-tool clear service <name>`. Schema-less
  // attribute match works for entries the `keyring` crate writes.
  for (const service of ["Fleetify", "Fleetify-GitHub"]) {
    const r = spawnSync("secret-tool", ["clear", "service", service], { encoding: "utf8" });
    if (r.status === 0) {
      console.log(`  ✓ keychain               cleared    service=${service}`);
    } else {
      console.log(`  · keychain               skip       service=${service} (not found or secret-tool missing)`);
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
