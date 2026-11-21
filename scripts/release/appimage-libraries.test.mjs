/**
 * Tests for appimage-libraries.mjs, which writes LINUX-APPIMAGE-LIBRARIES.txt
 * from the extracted AppImage in the Linux release build.
 *
 *   node --test scripts/release/appimage-libraries.test.mjs
 *
 * dpkg never runs here: its output comes from fixtures/notices/ and the
 * strings below, and every copyright text is made up.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseOwner,
  launchpadUrl,
  parseDpkgSearch,
  parseDpkgShow,
  renderLibraryList,
  sharedObjects,
} from "./appimage-libraries.mjs";

const SCRIPT = fileURLToPath(new URL("./appimage-libraries.mjs", import.meta.url));
const SEARCH = readFileSync(new URL("./fixtures/notices/dpkg-search.txt", import.meta.url), "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "appimage-libraries-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("parseDpkgSearch", () => {
  test("maps each path in the fixture to the package that owns it", () => {
    const owners = parseDpkgSearch(SEARCH);
    assert.equal(owners.size, 11);
    assert.equal(owners.get("/usr/lib/x86_64-linux-gnu/libgtk-3.so.0"), "libgtk-3-0t64:amd64");
    assert.equal(owners.get("/usr/lib/x86_64-linux-gnu/libgtk-3.so.0.2409.32"), "libgtk-3-0t64:amd64");
    assert.equal(
      owners.get("/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules/im-ibus.so"),
      "ibus-gtk3:amd64",
    );
    assert.equal(owners.get("/usr/lib/i386-linux-gnu/libpcre2-8.so.0"), "libpcre2-8-0:i386");
    assert.equal(owners.get("/usr/sbin/ldconfig"), "libc-bin");
  });

  test("skips diversions, and takes the first of several owners", () => {
    const owners = parseDpkgSearch(SEARCH);
    assert.ok(!owners.has("/bin/sh"));
    assert.ok(!owners.has("/bin/sh.distrib"));
    assert.equal(owners.get("/usr/share/doc/libjpeg-turbo8"), "libjpeg-turbo8:amd64");
  });

  test("finds nothing in empty output", () => {
    assert.equal(parseDpkgSearch("").size, 0);
  });
});

describe("chooseOwner", () => {
  const owners = parseDpkgSearch(SEARCH);

  test("matches the file name exactly, not as a prefix", () => {
    assert.equal(chooseOwner("usr/lib/libgtk-3.so.0", owners, "amd64"), "libgtk-3-0t64:amd64");
    // Ubuntu 22.04's dpkg still records many libraries under /lib, which sorts
    // before /usr/lib.
    const split = parseDpkgSearch(
      "libpcre2-8-0:amd64: /lib/x86_64-linux-gnu/libpcre2-8.so.0\n" +
        "libpcre2-dev:amd64: /usr/lib/x86_64-linux-gnu/libpcre2-8.so\n",
    );
    assert.equal(chooseOwner("usr/lib/libpcre2-8.so", split, "amd64"), "libpcre2-dev:amd64");
    assert.equal(chooseOwner("usr/lib/libpcre2-8.so.0", split, "amd64"), "libpcre2-8-0:amd64");
  });

  test("prefers the owner whose path ends like the AppImage's", () => {
    // ibus-gtk owns an im-ibus.so for GTK 2 as well.
    assert.equal(
      chooseOwner("usr/lib/gtk-3.0/3.0.0/immodules/im-ibus.so", owners, "amd64"),
      "ibus-gtk3:amd64",
    );
  });

  test("prefers the system's own architecture", () => {
    assert.equal(chooseOwner("usr/lib/libpcre2-8.so.0", owners, "amd64"), "libpcre2-8-0:amd64");
  });

  test("returns null for a file that no package owns", () => {
    assert.equal(chooseOwner("usr/lib/libmystery.so.1", owners, "amd64"), null);
  });
});

describe("parseDpkgShow", () => {
  test("reads each package's version, source package and source version", () => {
    const info = parseDpkgShow(
      "libgudev-1.0-0:amd64\t1:238-7build1\tlibgudev\t238-7build1\n" +
        "libtdb1:amd64\t2:1.4.14+samba4.23.6+dfsg-1ubuntu2.2\tsamba\t2:4.23.6+dfsg-1ubuntu2.2\n",
    );
    assert.deepEqual(Object.fromEntries(info), {
      "libgudev-1.0-0:amd64": { version: "1:238-7build1", source: "libgudev", sourceVersion: "238-7build1" },
      "libtdb1:amd64": {
        version: "2:1.4.14+samba4.23.6+dfsg-1ubuntu2.2",
        source: "samba",
        sourceVersion: "2:4.23.6+dfsg-1ubuntu2.2",
      },
    });
  });
});

describe("launchpadUrl", () => {
  test("links the source package at its full version, epoch included", () => {
    assert.equal(launchpadUrl("orc", "1:0.4.42-2"), "https://launchpad.net/ubuntu/+source/orc/1:0.4.42-2");
    assert.equal(
      launchpadUrl("gtk+3.0", "3.24.41-4ubuntu1"),
      "https://launchpad.net/ubuntu/+source/gtk+3.0/3.24.41-4ubuntu1",
    );
  });
});

describe("renderLibraryList", () => {
  const GTK_COPYRIGHT =
    "Format: fixture copyright file for gtk+3.0\nFiles: *\nCopyright: 2026 The Fixture GTK Team\nLicense: LGPL-2.1+  \n";
  const GUDEV_COPYRIGHT = "Fixture copyright file for libgudev.\r\nLicense: LGPL-2.1+\r\n";
  const gtk = { version: "3.24.41-4ubuntu1", source: "gtk+3.0", sourceVersion: "3.24.41-4ubuntu1", copyright: GTK_COPYRIGHT };
  const ENTRIES = [
    { file: "usr/lib/libgtk-3.so.0", pkg: "libgtk-3-0t64:amd64", ...gtk },
    { file: "usr/lib/gtk-3.0/3.0.0/immodules/im-am-et.so", pkg: "libgtk-3-0t64:amd64", ...gtk },
    { file: "usr/lib/libgailutil-3.so.0", pkg: "libgail-3-0t64:amd64", ...gtk },
    {
      file: "usr/lib/libgudev-1.0.so.0",
      pkg: "libgudev-1.0-0:amd64",
      version: "1:238-7build1",
      source: "libgudev",
      sourceVersion: "238-7build1",
      copyright: GUDEV_COPYRIGHT,
    },
    { file: "usr/lib/libmystery.so.1", pkg: null },
  ];
  const lines = (text) => text.split("\n");

  test("lists a .so that no package owns under \"Not from an Ubuntu package\"", () => {
    const all = lines(renderLibraryList(ENTRIES));
    const heading = all.indexOf("Not from an Ubuntu package");
    assert.ok(heading > 0, "no heading");
    const at = all.findIndex((l) => l.trim() === "usr/lib/libmystery.so.1");
    assert.ok(at > heading, `listed at line ${at}, the heading is at ${heading}`);
    assert.equal(all.filter((l) => l.includes("libmystery")).length, 1);
  });

  test("says so when every library comes from a package", () => {
    const all = lines(renderLibraryList(ENTRIES.filter((e) => e.pkg)));
    const heading = all.indexOf("Not from an Ubuntu package");
    assert.ok(heading > 0, "no heading");
    assert.ok(all.slice(heading).some((l) => l.trim() === "None."));
  });

  test("groups the libraries by source package, linked at the source version", () => {
    const out = renderLibraryList(ENTRIES);
    assert.ok(out.includes("https://launchpad.net/ubuntu/+source/gtk+3.0/3.24.41-4ubuntu1"));
    assert.ok(out.includes("https://launchpad.net/ubuntu/+source/libgudev/238-7build1"));
    // libgudev's binary version has an epoch that its source version lacks.
    assert.ok(!out.includes("+source/libgudev/1:238-7build1"));
    const all = lines(out).map((l) => l.trim());
    for (const e of ENTRIES) assert.ok(all.includes(e.file), e.file);
    assert.ok(all.indexOf("usr/lib/libgailutil-3.so.0") < all.indexOf("usr/lib/libgudev-1.0.so.0"));
  });

  test("gives each copyright file verbatim, once even when packages share it", () => {
    const out = renderLibraryList(ENTRIES);
    assert.equal(out.split(GTK_COPYRIGHT).length - 1, 1);
    assert.equal(out.split(GUDEV_COPYRIGHT).length - 1, 1);
  });

  test("the output is deterministic", () => {
    const first = renderLibraryList(ENTRIES);
    assert.equal(renderLibraryList([...ENTRIES].reverse()), first);
    assert.equal(renderLibraryList([ENTRIES[2], ENTRIES[4], ENTRIES[0], ENTRIES[3], ENTRIES[1]]), first);
  });
});

describe("sharedObjects", () => {
  test("lists the shared libraries under usr/lib, and nothing else", () => {
    const root = join(ROOT, "squashfs-root");
    const files = {
      "usr/lib/libgtk-3.so.0": "elf",
      "usr/lib/libicudata.so.78": "elf",
      "usr/lib/libgio-2.0.so": "elf",
      "usr/lib/gtk-3.0/3.0.0/immodules/im-ibus.so": "elf",
      "usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so": "elf",
      "usr/lib/notes.sound.xml": "<xml/>",
      "usr/share/glib-2.0/schemas/com.ubuntu.sound.gschema.xml": "<xml/>",
      "usr/share/libdemo.so.1": "elf",
      "usr/bin/fleetify-app": "elf",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    // A link to a library already listed adds no file of its own.
    symlinkSync("gtk-3.0/3.0.0/immodules/im-ibus.so", join(root, "usr/lib/im-ibus.so"));

    assert.deepEqual(sharedObjects(root), [
      "usr/lib/gtk-3.0/3.0.0/immodules/im-ibus.so",
      "usr/lib/libgio-2.0.so",
      "usr/lib/libgtk-3.so.0",
      "usr/lib/libicudata.so.78",
      "usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so",
    ]);
  });

  test("a root without usr/lib throws", () => {
    assert.throws(() => sharedObjects(join(ROOT, "nowhere")), /usr\/lib/);
  });
});

describe("the CLI", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("without --root and --out it prints the usage and exits 2", () => {
    const r = run("--out", join(ROOT, "list.txt"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node scripts\/release\/appimage-libraries\.mjs --root <squashfs-root> --out <file>/);
  });

  test("a root with no libraries in it fails before dpkg runs", () => {
    const r = run("--root", join(ROOT, "nowhere"), "--out", join(ROOT, "list.txt"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usr\/lib/);
  });
});
