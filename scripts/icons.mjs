#!/usr/bin/env node
// Regenerates the app icons in src-tauri/icons from the two sources in
// src-tauri/icons/source: app-icon.svg makes every size Windows and Linux use
// (a rounded tile that fills most of the canvas, so it reads at 16-32 px on a
// dark or a light taskbar), and app-icon-macos.svg makes icon.icns, on Apple's
// icon grid (an 824 px body on the 1024 px canvas). The tray glyphs,
// logo-mark-light.png and logo-mark-dark.png, aren't generated here.
//
//   npm run icons
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const icons = join(root, "src-tauri", "icons");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function tauriIcon(source, output) {
  const result = spawnSync(npx, ["--no", "tauri", "icon", source, "-o", output], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`icons: tauri icon ${source} failed`);
    process.exit(result.status ?? 1);
  }
}

tauriIcon(join(icons, "source", "app-icon.svg"), icons);
const macos = mkdtempSync(join(tmpdir(), "fleetify-icons-"));
try {
  tauriIcon(join(icons, "source", "app-icon-macos.svg"), macos);
  copyFileSync(join(macos, "icon.icns"), join(icons, "icon.icns"));
} finally {
  rmSync(macos, { recursive: true, force: true });
}
console.log("icons: regenerated src-tauri/icons from src-tauri/icons/source");
