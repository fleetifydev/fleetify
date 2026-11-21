/**
 * Tests for compiled-tar.mjs, which names the files a macOS compile job hands
 * the bundle job, and unpacks that hand-off archive only after checking each
 * of its members.
 *
 *   node --test scripts/release/compiled-tar.test.mjs
 *
 * The archives are written here, header by header, so each kind of member
 * the check must refuse can be tried; one test also reads an archive the
 * system's tar wrote.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_BINARY, compiledFiles, unpack } from "./compiled-tar.mjs";

const SCRIPT = fileURLToPath(new URL("./compiled-tar.mjs", import.meta.url));
const ARM_MAC = "aarch64-apple-darwin";
const FILES = compiledFiles(ARM_MAC);

const ROOT = mkdtempSync(join(tmpdir(), "compiled-tar-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(ROOT, `${name}-${(count += 1)}`);

/** A ustar header block. */
function header({ name, type = "0", size = 0, mode = 0o755, linkname = "", prefix = "", magic = "ustar\0", checksum }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.fill(0x20, 148, 156);
  if (type !== "\0") block.write(type, 156, 1, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write(magic, 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, 155, "utf8");
  const sum = checksum ?? block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** A ustar archive of `entries` ({ name, data?, type?, ... }), with its end-of-archive blocks unless `end` is false. */
function archive(entries, { end = true } = {}) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    parts.push(header({ ...entry, size: entry.size ?? data.length }));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The hand-off's own members: each listed file, with text naming it. */
const good = () => FILES.map((name) => ({ name, data: `binary ${name}\n` }));

/** Write `bytes` as an archive file and unpack it into a fresh folder: { problems, out }. */
function tryUnpack(bytes) {
  const tar = `${fresh("compiled")}.tar`;
  writeFileSync(tar, bytes);
  const out = fresh("out");
  return { ...unpack({ tar, out, files: FILES }), out };
}

/** Every file under `dir`, as paths from it. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter((path) => statSync(join(dir, path)).isFile()).sort();
}

describe("compiledFiles", () => {
  test("the app binary and each sidecar Tauri bundles, as tauri.conf.json names them", () => {
    assert.deepEqual(FILES, [
      "target/aarch64-apple-darwin/release/fleetify-app",
      "src-tauri/binaries/fleet-memory-mcp-aarch64-apple-darwin",
      "src-tauri/binaries/fleet-dispatch-mcp-aarch64-apple-darwin",
      "src-tauri/binaries/fleet-reveng-mcp-aarch64-apple-darwin",
      "src-tauri/binaries/fleet-browser-mcp-aarch64-apple-darwin",
    ]);
  });

  test("the app binary is the app crate's own", () => {
    const cargo = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
    assert.match(cargo, new RegExp(`^\\[package\\]\\s*\\nname = "${APP_BINARY}"$`, "m"));
  });
});

describe("unpack", () => {
  test("the listed files, and folders above them, unpack executable, and nothing else", () => {
    const members = [{ name: "target/", type: "5" }, { name: "target/aarch64-apple-darwin/", type: "5" }, ...good()];
    const { problems, out } = tryUnpack(archive(members));
    assert.deepEqual(problems, []);
    assert.deepEqual(filesUnder(out), [...FILES].sort());
    for (const name of FILES) {
      assert.equal(readFileSync(join(out, name), "utf8"), `binary ${name}\n`);
      assert.equal(statSync(join(out, name)).mode & 0o7777, 0o755, name);
    }
  });

  test("a member's mode never carries over: a setuid file still unpacks as 0755", () => {
    const members = good().map((member, i) => (i === 0 ? { ...member, mode: 0o4777 } : member));
    const { problems, out } = tryUnpack(archive(members));
    assert.deepEqual(problems, []);
    assert.equal(statSync(join(out, FILES[0])).mode & 0o7777, 0o755);
  });

  test("an old-style regular file (type NUL) and a path split into prefix and name are read", () => {
    const [first, ...rest] = good();
    const slash = first.name.lastIndexOf("/");
    const members = [{ ...first, name: first.name.slice(slash + 1), prefix: first.name.slice(0, slash), type: "\0" }, ...rest];
    assert.deepEqual(tryUnpack(archive(members)).problems, []);
  });

  for (const [type, what] of [
    ["1", "a hard link"],
    ["2", "a symbolic link"],
    ["3", "a character device"],
    ["4", "a block device"],
    ["6", "a FIFO"],
    ["x", "a pax extended header"],
    ["g", "a pax global header"],
    ["L", "a GNU long name"],
  ]) {
    test(`${what} is refused, and nothing is unpacked`, () => {
      const members = [...good(), { name: "src-tauri/tauri.macos.conf.json", type, linkname: "/etc/passwd" }];
      const { problems, out } = tryUnpack(archive(members));
      assert.ok(problems.some((problem) => problem.includes("src-tauri/tauri.macos.conf.json") && problem.includes(what)), problems.join("\n"));
      assert.deepEqual(filesUnder(out), []);
    });
  }

  for (const [name, why] of [
    ["../outside", "a .. component"],
    ["target/../../outside", "a .. component"],
    ["/etc/outside", "an absolute path"],
    ["./target/x", "a . component"],
    ["target//x", "an empty component"],
  ]) {
    test(`${JSON.stringify(name)} is refused for ${why}`, () => {
      const { problems, out } = tryUnpack(archive([...good(), { name, data: "x" }]));
      assert.ok(problems.includes(`${JSON.stringify(name)} has ${why}`), problems.join("\n"));
      assert.deepEqual(filesUnder(out), []);
    });
  }

  test("the files are executable whatever the umask", () => {
    const umask = process.umask(0o077);
    try {
      const { problems, out } = tryUnpack(archive(good()));
      assert.deepEqual(problems, []);
      for (const name of FILES) assert.equal(statSync(join(out, name)).mode & 0o7777, 0o755, name);
    } finally {
      process.umask(umask);
    }
  });

  test("a file off the list, a missing listed file and a member given twice are each a problem", () => {
    const [first, ...rest] = good();
    const { problems } = tryUnpack(archive([...rest, { name: "src-tauri/tauri.macos.conf.json", data: "{}" }, rest[0]]));
    assert.ok(problems.includes(`unexpected file "src-tauri/tauri.macos.conf.json"`), problems.join("\n"));
    assert.ok(problems.includes(`missing "${first.name}"`), problems.join("\n"));
    assert.ok(problems.includes(`"${rest[0].name}" appears twice`), problems.join("\n"));
  });

  test("a folder that isn't above a listed file is a problem", () => {
    const { problems } = tryUnpack(archive([...good(), { name: "node_modules/", type: "5" }]));
    assert.deepEqual(problems, [`unexpected folder "node_modules"`]);
  });

  test("a damaged archive is refused: a bad checksum, another format, cut short, or no end", () => {
    const bad = good();
    const checksum = archive([{ ...bad[0], checksum: 1 }, ...bad.slice(1)]);
    assert.match(tryUnpack(checksum).problems.join("\n"), /checksum/);
    const gnu = archive(good().map((member) => ({ ...member, magic: "xxxxx\0" })));
    assert.match(tryUnpack(gnu).problems.join("\n"), /not a ustar/);
    const whole = archive(good());
    assert.match(tryUnpack(whole.subarray(0, 512 + 10)).problems.join("\n"), /cut short/);
    assert.match(tryUnpack(archive(good(), { end: false })).problems.join("\n"), /end-of-archive/);
  });

  test("the out folder must be empty", () => {
    const tar = `${fresh("compiled")}.tar`;
    writeFileSync(tar, archive(good()));
    const out = fresh("out");
    mkdirSync(out);
    writeFileSync(join(out, "left-over"), "x");
    assert.match(unpack({ tar, out, files: FILES }).problems.join("\n"), /not empty/);
  });

  test("an archive the system's tar writes in ustar format unpacks", { skip: spawnSync("tar", ["--version"]).status !== 0 && "no tar here" }, () => {
    const src = fresh("src");
    for (const name of FILES) {
      mkdirSync(dirname(join(src, name)), { recursive: true });
      writeFileSync(join(src, name), `binary ${name}\n`, { mode: 0o755 });
    }
    const tar = `${fresh("compiled")}.tar`;
    const made = spawnSync("tar", ["--format", "ustar", "-cf", tar, ...FILES], { cwd: src, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const out = fresh("out");
    assert.deepEqual(unpack({ tar, out, files: FILES }).problems, []);
    assert.deepEqual(filesUnder(out), [...FILES].sort());
  });
});

describe("the CLI", () => {
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("list prints the files, one a line", () => {
    const result = cli("list", "--target", ARM_MAC);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${FILES.join("\n")}\n`);
  });

  test("unpack: exit 0 for a good archive, 1 for a bad one, 2 for usage", () => {
    const tar = `${fresh("compiled")}.tar`;
    writeFileSync(tar, archive(good()));
    const ok = cli("unpack", "--target", ARM_MAC, "--tar", tar, "--out", fresh("out"));
    assert.equal(ok.status, 0, ok.stderr);
    const badTar = `${fresh("compiled")}.tar`;
    writeFileSync(badTar, archive([...good(), { name: "x", type: "2", linkname: "/" }]));
    const bad = cli("unpack", "--target", ARM_MAC, "--tar", badTar, "--out", fresh("out"));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /a symbolic link/);
    for (const args of [[], ["list"], ["unpack", "--target", ARM_MAC], ["pack", "--target", ARM_MAC]]) {
      assert.equal(cli(...args).status, 2, args.join(" "));
    }
  });
});
