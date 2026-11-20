#!/usr/bin/env node
/**
 * wipe.mjs — Fleetify-side "factory reset". Removes every persisted
 * piece of state so the next launch behaves like a fresh install:
 *
 *   1. `~/.fleetify/`              — backend SQLite, telemetry outbox,
 *                                    device.json, plugin_state.json,
 *                                    installed plugins.
 *   2. App config + webview data   — `fleet.config.json` PLUS the webview's
 *                                    localStorage / IndexedDB / cookies. These
 *                                    sit in different dirs per OS:
 *                                      win:   %APPDATA%/com.fleetify.app +
 *                                             %LOCALAPPDATA%/com.fleetify.app
 *                                      mac:   ~/Library/Application Support +
 *                                             ~/Library/WebKit +
 *                                             ~/Library/HTTP Storages (+ caches)
 *                                      linux: ~/.local/share/com.fleetify.app
 *                                             (the WebKitGTK *data* dir — NOT
 *                                             ~/.cache, which is just cache).
 *   3. OS credential store         — every entry whose service is `Fleetify`
 *                                    or `Fleetify-*` (OIDC refresh token,
 *                                    `Fleetify-GitHub`, `Fleetify-Voice`,
 *                                    `Fleetify-Provider-<id>`,
 *                                    `Fleetify-Router-<id>`). Backend differs by
 *                                    OS: macOS Keychain (`security`), Windows
 *                                    Credential Manager (`cmdkey`), and on Linux
 *                                    the Secret Service (GNOME Keyring, KWallet,
 *                                    ...) cleared via the `fleet-wipe` helper,
 *                                    which also sweeps the kernel keyring that
 *                                    builds before the Secret Service used.
 *
 * Idempotent: missing paths are skipped silently. Logs every action so
 * you can audit what was touched.
 *
 * Pass `--keep-keychain` to skip step 3 (useful when you want to reset
 * onboarding state without re-running OAuth).
 */

import { rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  isFleetifyKeychainTarget,
  parseMacKeychainDump,
} from "./wipe/keychain-filter.mjs";

const ARGS = new Set(process.argv.slice(2));
const KEEP_KEYCHAIN = ARGS.has("--keep-keychain");

const home = homedir();
const plat = platform(); // "win32" | "darwin" | "linux"
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  // macOS (WKWebView). Application Support holds fleet.config.json, but the
  // webview's cookies / localStorage / IndexedDB live under ~/Library/WebKit
  // and ~/Library/HTTP Storages — NOT in ~/Library/Caches. Clearing only the
  // cache left the session (and cookies) intact, so the app stayed signed in.
  targets.push(
    {
      label: "Tauri config + data",
      path: path.join(home, "Library", "Application Support", "com.fleetify.app"),
    },
    {
      label: "WebKit website data",
      path: path.join(home, "Library", "WebKit", "com.fleetify.app"),
    },
    {
      label: "HTTP storages (cookies)",
      path: path.join(home, "Library", "HTTP Storages", "com.fleetify.app"),
    },
    {
      label: "WebView (WebKit) cache",
      path: path.join(home, "Library", "Caches", "com.fleetify.app"),
    },
    {
      label: "Saved app state",
      path: path.join(home, "Library", "Saved Application State", "com.fleetify.app.savedState"),
    },
    {
      label: "Preferences plist",
      path: path.join(home, "Library", "Preferences", "com.fleetify.app.plist"),
    },
  );
} else {
  // Linux (WebKitGTK). The webview's PERSISTENT state — localStorage, cookies,
  // IndexedDB, HSTS — AND the app's own fleet.config.json live in the XDG
  // *data* dir (~/.local/share/<id>), NOT the cache dir. The old script only
  // cleared ~/.config + ~/.cache (usually absent), so the real data survived
  // and the app reopened on the previous account. Clear the data dir first.
  targets.push(
    {
      label: "WebView + app data",
      path: path.join(home, ".local", "share", "com.fleetify.app"),
    },
    {
      label: "Tauri config (legacy)",
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

// ── Session SQL wipe ───────────────────────────────────────────────
// Clears all session data from a fleet.db without deleting the file,
// so the schema and migrations table survive and the next launch skips
// re-migration. Deletes child tables before parent to satisfy FKs even
// when foreign_keys pragma is off.
const SESSION_TABLES = [
  "session_memory",
  "session_activity",
  "cost_events",
  "messages",
  "routing_decisions",
  "sessions",
  "groups",
];

function wipeSessionsInDb(label, dbPath) {
  if (!existsSync(dbPath)) {
    console.log(`  · ${label.padEnd(22)} skip       ${dbPath} (not found)`);
    return;
  }
  try {
    const db = new DatabaseSync(dbPath);
    for (const table of SESSION_TABLES) {
      try {
        db.exec(`DELETE FROM ${table}`);
      } catch {
        // Table may not exist in older DBs — skip silently.
      }
    }
    db.close();
    console.log(`  ✓ ${label.padEnd(22)} cleared    ${dbPath}`);
  } catch (err) {
    console.log(`  ✗ ${label.padEnd(22)} FAILED     ${dbPath}`);
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

// Linux — the app's `keyring` crate keeps credentials in the Secret Service
// (GNOME Keyring, KWallet, ...). We shell out to the `fleet-wipe` Rust helper:
// it deletes every Secret Service item keyring created whose service is
// `Fleetify` / `Fleetify-*` (the OIDC refresh token plus GitHub / voice /
// provider / router keys), and invalidates the `keyring-rs:*@Fleetify*` keys
// that builds before the Secret Service store left in the kernel keyring. No
// secret-tool needed. It deletes only when passed `--yes`; without it, it
// prints its usage and exits 2, changing nothing. It exits 1 when its Secret
// Service sweep fails (unreachable, left locked, or an item can't be deleted).
function wipeKeychainLinux() {
  const run = spawnSync("cargo", ["run", "-q", "-p", "fleet-wipe", "--", "--yes"], { encoding: "utf8" });
  if (run.error) {
    console.log("  ✗ keychain               FAILED     could not run fleet-wipe via cargo");
    console.log(`    ${run.error.message}`);
    console.log("    The OIDC refresh token may persist — install Rust/cargo, then re-run `npm run wipe`.");
    return;
  }
  for (const line of (run.stdout || "").split(/\r?\n/)) {
    if (line.trim()) console.log(`    ${line.trimEnd()}`);
  }
  if (run.status === 0) {
    console.log("  ✓ keychain               cleared    via fleet-wipe (Secret Service + kernel keyring)");
  } else {
    console.log("  ✗ keychain               FAILED     fleet-wipe exited", run.status);
    if (run.stderr) console.log(`    ${run.stderr.trim()}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────
console.log("Fleetify wipe — clearing every persisted piece of state.\n");

for (const t of targets) {
  await wipeDir(t.label, t.path);
}

// Clear sessions from the dev/prod DB (src-tauri/fleet.db). Preserves the
// schema so the next launch skips migrations. The ~/.fleetify/ DB is already
// gone via the backend-state wipe above.
wipeSessionsInDb("sessions DB", path.join(projectRoot, "src-tauri", "fleet.db"));

if (KEEP_KEYCHAIN) {
  console.log("  · keychain               skip       --keep-keychain passed");
} else if (plat === "win32") {
  wipeKeychainWindows();
} else if (plat === "darwin") {
  wipeKeychainMac();
} else {
  // Linux: fleet-wipe clears the Secret Service (the app's keyring store) and
  // the kernel keyring older builds used.
  wipeKeychainLinux();
}

console.log("\nDone. Launch the app again to start from scratch.");
