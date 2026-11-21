/**
 * Tests for appimage-tools.mjs and its manifest, appimage-tools.json: the
 * tools tauri-bundler downloads to make an AppImage, pinned by SHA-256.
 *
 *   node --test scripts/release/appimage-tools.test.mjs
 *
 * The installs run against a server on 127.0.0.1; nothing here touches the
 * network.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./appimage-tools.mjs", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("./appimage-tools.json", import.meta.url), "utf8"));

/**
 * The files tauri-bundler 2.9.2 caches for an x86_64 AppImage, and the
 * upstream file each comes from (bundle/linux/appimage/linuxdeploy.rs,
 * prepare_tools). It downloads one only when the cache lacks it, unchecked.
 */
const PREPARE_TOOLS = {
  "AppRun-x86_64": "github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64",
  "linuxdeploy-x86_64.AppImage": "github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage",
  "linuxdeploy-plugin-gtk.sh": "raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/<commit>/linuxdeploy-plugin-gtk.sh",
  "linuxdeploy-plugin-gstreamer.sh": "raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/<commit>/linuxdeploy-plugin-gstreamer.sh",
  "linuxdeploy-plugin-appimage.AppImage":
    "github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage",
};

const ROOT = mkdtempSync(join(tmpdir(), "appimage-tools-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A server on 127.0.0.1 serving `files` (path → bytes); everything else is 404. */
async function serve(files) {
  const server = createServer((req, res) => {
    const body = files[req.url];
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

/** Run the script, with `env` added to the environment; resolves with its exit code and output. */
function run(args, env = {}) {
  return new Promise((done) => {
    // In the temporary folder, so a relative path can't land in the repository.
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** A manifest file listing `tools`. */
function manifestFile(tools) {
  const path = `${fresh("manifest")}.json`;
  writeFileSync(path, JSON.stringify({ note: "test", tools }));
  return path;
}

describe("appimage-tools.json", () => {
  test("it pins each file tauri-bundler 2.9.2's prepare_tools downloads, and only those", () => {
    assert.deepEqual(MANIFEST.tools.map(({ file }) => file).sort(), Object.keys(PREPARE_TOOLS).sort());
  });

  test("each pin is an https URL to the bundler's own source, and a SHA-256", () => {
    for (const { file, url, sha256: hash } of MANIFEST.tools) {
      assert.match(hash, /^[0-9a-f]{64}$/, file);
      assert.ok(url.startsWith("https://"), `${file}: ${url}`);
      const expected = PREPARE_TOOLS[file].replace("<commit>", "[0-9a-f]{40}").replaceAll(".", "\\.");
      assert.match(url.slice("https://".length), new RegExp(`^${expected}$`), `${file}: ${url}`);
    }
  });

  test("the plugin scripts are pinned to a commit, not to a branch", () => {
    for (const { file, url } of MANIFEST.tools.filter(({ file }) => file.endsWith(".sh"))) {
      assert.match(url, /\/[0-9a-f]{40}\/[^/]+\.sh$/, file);
      assert.doesNotMatch(url, /\/master\//, file);
    }
  });

  test("its note says a mismatch means upstream changed the asset", () => {
    assert.match(MANIFEST.note, /mismatch/);
    assert.match(MANIFEST.note, /deliberately/);
  });
});

describe("appimage-tools.mjs", () => {
  const one = Buffer.from("#!/bin/sh\necho one\n");
  const two = Buffer.from("\x7fELF two");

  test("each download whose SHA-256 matches goes into the cache, executable", async () => {
    const server = await serve({ "/one.sh": one, "/two": two });
    try {
      const cache = fresh("cache");
      const manifest = manifestFile([
        { file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one) },
        { file: "two.AppImage", url: `${server.base}/two`, sha256: sha256(two) },
      ]);
      const result = await run(["--manifest", manifest, "--cache-dir", cache]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readdirSync(cache).sort(), ["one.sh", "two.AppImage"]);
      assert.ok(readFileSync(join(cache, "one.sh")).equals(one));
      assert.ok(readFileSync(join(cache, "two.AppImage")).equals(two));
      for (const name of ["one.sh", "two.AppImage"]) assert.equal(statSync(join(cache, name)).mode & 0o777, 0o755, name);
    } finally {
      await server.close();
    }
  });

  test("a SHA-256 that doesn't match fails, and nothing is installed, not even the files that matched", async () => {
    const server = await serve({ "/one.sh": one, "/two": two });
    try {
      const cache = fresh("cache");
      const manifest = manifestFile([
        { file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one) },
        { file: "two.AppImage", url: `${server.base}/two`, sha256: sha256(Buffer.from("something else")) },
      ]);
      const result = await run(["--manifest", manifest, "--cache-dir", cache]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /two\.AppImage: SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}/);
      assert.ok(!existsSync(cache) || readdirSync(cache).length === 0, "something was installed");
    } finally {
      await server.close();
    }
  });

  test("a failed download fails, and nothing is installed", async () => {
    const server = await serve({ "/one.sh": one });
    try {
      const cache = fresh("cache");
      const manifest = manifestFile([
        { file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one) },
        { file: "gone.sh", url: `${server.base}/gone.sh`, sha256: sha256(one) },
      ]);
      const result = await run(["--manifest", manifest, "--cache-dir", cache]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /gone\.sh: .*404/);
      assert.ok(!existsSync(cache) || readdirSync(cache).length === 0, "something was installed");
    } finally {
      await server.close();
    }
  });

  test("the tools are executable whatever the umask", { skip: process.platform === "win32" && "POSIX modes only" }, async () => {
    const server = await serve({ "/one.sh": one });
    try {
      const cache = fresh("cache");
      const manifest = manifestFile([{ file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one) }]);
      // The child takes the umask it is started with.
      const umask = process.umask(0o077);
      let pending;
      try {
        pending = run(["--manifest", manifest, "--cache-dir", cache]);
      } finally {
        process.umask(umask);
      }
      const result = await pending;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(statSync(join(cache, "one.sh")).mode & 0o777, 0o755);
    } finally {
      await server.close();
    }
  });

  test("a file already in the cache is replaced by the checked download", async () => {
    const server = await serve({ "/one.sh": one });
    try {
      const cache = fresh("cache");
      mkdirSync(cache);
      writeFileSync(join(cache, "one.sh"), "a stale copy");
      const result = await run(["--manifest", manifestFile([{ file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one) }]), "--cache-dir", cache]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(join(cache, "one.sh")).equals(one));
    } finally {
      await server.close();
    }
  });

  test("without --cache-dir, it installs where the bundler looks: $XDG_CACHE_HOME/tauri when absolute, else ~/.cache/tauri", async () => {
    const server = await serve({ "/one.sh": one });
    try {
      const manifest = manifestFile([{ file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one) }]);
      const xdg = fresh("xdg");
      const home = fresh("home");
      const absolute = await run(["--manifest", manifest], { XDG_CACHE_HOME: xdg, HOME: home });
      assert.equal(absolute.status, 0, absolute.stderr);
      assert.deepEqual(readdirSync(join(xdg, "tauri")), ["one.sh"]);
      assert.ok(!existsSync(join(home, ".cache")));
      const relative = await run(["--manifest", manifest], { XDG_CACHE_HOME: "relative/cache", HOME: home });
      assert.equal(relative.status, 0, relative.stderr);
      assert.deepEqual(readdirSync(join(home, ".cache", "tauri")), ["one.sh"]);
    } finally {
      await server.close();
    }
  });

  for (const [what, entry] of [
    ["a file name that is a path", { file: "../one.sh" }],
    ["a URL over plain http to another host", { url: "http://example.com/one.sh" }],
    ["a SHA-256 that isn't 64 hex digits", { sha256: "abc" }],
  ]) {
    test(`a manifest entry with ${what} is refused, and nothing is installed`, async () => {
      const server = await serve({ "/one.sh": one });
      try {
        const cache = fresh("cache");
        const manifest = manifestFile([{ file: "one.sh", url: `${server.base}/one.sh`, sha256: sha256(one), ...entry }]);
        const result = await run(["--manifest", manifest, "--cache-dir", cache]);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /manifest/);
        assert.ok(!existsSync(cache), "something was installed");
      } finally {
        await server.close();
      }
    });
  }

  test("usage errors exit 2", async () => {
    for (const args of [["--manifest"], ["--cache-dir", ""], ["--bogus"], ["--manifest", "a", "--manifest", "b"]]) {
      const result = await run(args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
  });
});
