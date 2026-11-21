/**
 * Tests for release-assets.mjs: the release's targets and asset names, the
 * updater manifest (latest.json), how an update endpoint picks an entry from
 * it, and SHA256SUMS.
 *
 *   node --test scripts/release/release-assets.test.mjs
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REPO,
  TARGETS,
  UPDATER_KEY_ID,
  bundleFiles,
  compareVersions,
  downloadBase,
  expectedAssets,
  latestJson,
  resolveUpdate,
  sha256sums,
  unsignedAssets,
  unsignedBundleFiles,
  updaterArtifacts,
  updaterAssets,
} from "./release-assets.mjs";

const SCRIPT = fileURLToPath(new URL("./release-assets.mjs", import.meta.url));

const V = "0.2.0";
const LINUX = "x86_64-unknown-linux-gnu";
const WINDOWS = "x86_64-pc-windows-msvc";
const ARM_MAC = "aarch64-apple-darwin";
const INTEL_MAC = "x86_64-apple-darwin";

const BASE = "https://github.com/fleetifydev/fleetify/releases/download/v0.2.0";
const PUB_DATE = "2026-11-21T10:00:00.000Z";

/** A fake signature per updater artifact, as the trimmed text of its .sig file. */
const SIGNATURES = Object.fromEntries(updaterArtifacts(V).map(({ asset }) => [asset, `sig of ${asset}`]));

const manifest = () => latestJson({ version: V, pubDate: PUB_DATE, signatures: SIGNATURES, base: downloadBase(V) });

const APPIMAGE = "Fleetify_0.2.0_amd64.AppImage";
const DEB = "Fleetify_0.2.0_amd64.deb";
const RPM = "Fleetify-0.2.0-1.x86_64.rpm";
const NSIS = "Fleetify_0.2.0_x64-setup.exe";
const ARM_APP = "Fleetify_0.2.0_aarch64.app.tar.gz";
const INTEL_APP = "Fleetify_0.2.0_x64.app.tar.gz";

/** The latest.json entry for an asset. */
const entry = (asset) => ({ signature: `sig of ${asset}`, url: `${BASE}/${asset}` });
/** What resolveUpdate answers when it offers an asset. */
const offer = (asset) => ({
  version: "0.2.0",
  url: `${BASE}/${asset}`,
  signature: `sig of ${asset}`,
  notes: "See https://github.com/fleetifydev/fleetify/releases/tag/v0.2.0",
  pub_date: PUB_DATE,
});

describe("the release's constants", () => {
  test("the repository and the updater key id", () => {
    assert.equal(REPO, "fleetifydev/fleetify");
    assert.equal(UPDATER_KEY_ID, "44C694713A20D751");
  });

  test("TARGETS: the four release targets, each with its runner, its bundles and its label", () => {
    assert.deepEqual(TARGETS, [
      { triple: LINUX, runner: "ubuntu-22.04", bundles: ["appimage", "deb", "rpm"], label: "Linux x64" },
      { triple: WINDOWS, runner: "windows-2025", bundles: ["nsis"], label: "Windows x64" },
      { triple: ARM_MAC, runner: "macos-15", bundles: ["app", "dmg"], label: "macOS Apple Silicon" },
      { triple: INTEL_MAC, runner: "macos-15-intel", bundles: ["app", "dmg"], label: "macOS Intel" },
    ]);
  });

  test("TARGETS can't be changed by the scripts that import it", () => {
    assert.ok(Object.isFrozen(TARGETS));
    for (const target of TARGETS) {
      assert.ok(Object.isFrozen(target), target.triple);
      assert.ok(Object.isFrozen(target.bundles), target.triple);
    }
  });

  test("downloadBase: GitHub's download folder for the release's tag", () => {
    assert.equal(downloadBase(V), BASE);
  });
});

describe("bundleFiles", () => {
  test("Linux: the AppImage, .deb and .rpm, each with its signature, under Tauri's own names", () => {
    assert.deepEqual(bundleFiles(LINUX, V), [
      { from: "appimage/Fleetify_0.2.0_amd64.AppImage", to: "Fleetify_0.2.0_amd64.AppImage" },
      { from: "appimage/Fleetify_0.2.0_amd64.AppImage.sig", to: "Fleetify_0.2.0_amd64.AppImage.sig" },
      { from: "deb/Fleetify_0.2.0_amd64.deb", to: "Fleetify_0.2.0_amd64.deb" },
      { from: "deb/Fleetify_0.2.0_amd64.deb.sig", to: "Fleetify_0.2.0_amd64.deb.sig" },
      { from: "rpm/Fleetify-0.2.0-1.x86_64.rpm", to: "Fleetify-0.2.0-1.x86_64.rpm" },
      { from: "rpm/Fleetify-0.2.0-1.x86_64.rpm.sig", to: "Fleetify-0.2.0-1.x86_64.rpm.sig" },
    ]);
  });

  test("Windows: the NSIS installer and its signature", () => {
    assert.deepEqual(bundleFiles(WINDOWS, V), [
      { from: "nsis/Fleetify_0.2.0_x64-setup.exe", to: "Fleetify_0.2.0_x64-setup.exe" },
      { from: "nsis/Fleetify_0.2.0_x64-setup.exe.sig", to: "Fleetify_0.2.0_x64-setup.exe.sig" },
    ]);
  });

  test("macOS arm64: the updater archive is renamed with the version and arch; the dmg keeps Tauri's name", () => {
    assert.deepEqual(bundleFiles(ARM_MAC, V), [
      { from: "macos/Fleetify.app.tar.gz", to: "Fleetify_0.2.0_aarch64.app.tar.gz" },
      { from: "macos/Fleetify.app.tar.gz.sig", to: "Fleetify_0.2.0_aarch64.app.tar.gz.sig" },
      { from: "dmg/Fleetify_0.2.0_aarch64.dmg", to: "Fleetify_0.2.0_aarch64.dmg" },
    ]);
  });

  test("macOS x64: the same, with x64", () => {
    assert.deepEqual(bundleFiles(INTEL_MAC, V), [
      { from: "macos/Fleetify.app.tar.gz", to: "Fleetify_0.2.0_x64.app.tar.gz" },
      { from: "macos/Fleetify.app.tar.gz.sig", to: "Fleetify_0.2.0_x64.app.tar.gz.sig" },
      { from: "dmg/Fleetify_0.2.0_x64.dmg", to: "Fleetify_0.2.0_x64.dmg" },
    ]);
  });

  test("an unknown triple throws, naming it", () => {
    assert.throws(() => bundleFiles("riscv64gc-unknown-linux-gnu", V), /unknown target triple: riscv64gc-unknown-linux-gnu/);
  });

  test("a version that isn't MAJOR.MINOR.PATCH throws, so no asset name carries a bad version", () => {
    for (const bad of [undefined, "", "0.2", "v0.2.0", "0.2.0-rc.1", "01.2.0", "0.2.0\n"]) {
      assert.throws(() => bundleFiles(LINUX, bad), /invalid version/, JSON.stringify(bad));
      assert.throws(() => expectedAssets(bad), /invalid version/, JSON.stringify(bad));
      assert.throws(() => updaterArtifacts(bad), /invalid version/, JSON.stringify(bad));
      assert.throws(() => downloadBase(bad), /invalid version/, JSON.stringify(bad));
    }
  });
});

describe("expectedAssets", () => {
  test("the 18 assets of a release, sorted", () => {
    const assets = expectedAssets(V);
    assert.equal(assets.length, 18);
    assert.deepEqual(assets, [
      "Fleetify-0.2.0-1.x86_64.rpm",
      "Fleetify-0.2.0-1.x86_64.rpm.sig",
      "Fleetify_0.2.0_aarch64.app.tar.gz",
      "Fleetify_0.2.0_aarch64.app.tar.gz.sig",
      "Fleetify_0.2.0_aarch64.dmg",
      "Fleetify_0.2.0_amd64.AppImage",
      "Fleetify_0.2.0_amd64.AppImage.sig",
      "Fleetify_0.2.0_amd64.deb",
      "Fleetify_0.2.0_amd64.deb.sig",
      "Fleetify_0.2.0_x64-setup.exe",
      "Fleetify_0.2.0_x64-setup.exe.sig",
      "Fleetify_0.2.0_x64.app.tar.gz",
      "Fleetify_0.2.0_x64.app.tar.gz.sig",
      "Fleetify_0.2.0_x64.dmg",
      "LINUX-APPIMAGE-LIBRARIES.txt",
      "SHA256SUMS",
      "THIRD-PARTY-NOTICES",
      "latest.json",
    ]);
  });

  test("each call returns a new list", () => {
    expectedAssets(V).push("stray");
    assert.equal(expectedAssets(V).length, 18);
  });

  test("every bundle file of every target is a release asset", () => {
    const assets = new Set(expectedAssets(V));
    for (const { triple } of TARGETS) {
      for (const { to } of bundleFiles(triple, V)) assert.ok(assets.has(to), `${triple}: ${to}`);
    }
  });
});

describe("updaterArtifacts", () => {
  test("each updater artifact with its exact latest.json keys", () => {
    assert.deepEqual(updaterArtifacts(V), [
      { asset: APPIMAGE, keys: ["linux-x86_64-appimage", "linux-x86_64"] },
      { asset: DEB, keys: ["linux-x86_64-deb"] },
      { asset: RPM, keys: ["linux-x86_64-rpm"] },
      { asset: NSIS, keys: ["windows-x86_64-nsis", "windows-x86_64"] },
      { asset: ARM_APP, keys: ["darwin-aarch64-app", "darwin-aarch64"] },
      { asset: INTEL_APP, keys: ["darwin-x86_64-app", "darwin-x86_64"] },
    ]);
  });

  test("each updater artifact is published with its .sig; the dmgs are not updater artifacts", () => {
    const assets = new Set(expectedAssets(V));
    for (const { asset } of updaterArtifacts(V)) {
      assert.ok(assets.has(asset), asset);
      assert.ok(assets.has(`${asset}.sig`), `${asset}.sig`);
      assert.doesNotMatch(asset, /\.dmg$/);
    }
  });
});

// The updater plugin (tauri-plugin-updater 2.12.0, updater.rs:581-582) looks up
// its own platform's entry *before* it compares versions. A latest.json that
// lacks that entry fails the check, even when no newer version exists. So
// every platform a shipped bundle can report must have its entry.
//
// The expected keys are worked out here from TARGETS alone, independently of
// release-assets.mjs's own table: the plugin's os and arch for each triple,
// and the installer it reports for each bundle.
describe("latest.json has an entry for every platform a shipped bundle can ask for", () => {
  /** The plugin's os for a target triple. */
  const osOf = (triple) => {
    if (triple.includes("-linux-")) return "linux";
    if (triple.includes("-apple-darwin")) return "darwin";
    if (triple.includes("-windows-")) return "windows";
    return assert.fail(`no updater os known for ${triple}`);
  };
  /** The plugin's arch for a target triple: the triple's first part (x86_64, aarch64). */
  const archOf = (triple) => triple.split("-")[0];
  /**
   * The installer the plugin reports for each Tauri bundle
   * (installer_for_bundle_type). A dmg installs the .app, which reports
   * "app", so it has no entry of its own.
   */
  const INSTALLER = { appimage: "appimage", deb: "deb", rpm: "rpm", msi: "msi", nsis: "nsis", app: "app", dmg: null };
  /** Where Tauri writes each bundle, under target/<triple>/release/bundle/. */
  const FOLDER = { appimage: "appimage/", deb: "deb/", rpm: "rpm/", msi: "msi/", nsis: "nsis/", app: "macos/", dmg: "dmg/" };
  /**
   * The bundle behind each platform's generic {os}-{arch} entry, which the
   * plugin falls back to when its bundle type is unknown. This is the
   * asset-name table: the AppImage, the NSIS installer and the .app.
   */
  const FALLBACK = { linux: "appimage", windows: "nsis", darwin: "app" };

  /** The release file that a target's bundle produces (its updater artifact, not the .sig). */
  const fileOf = (triple, bundle) => {
    const files = bundleFiles(triple, V).filter(({ from }) => from.startsWith(FOLDER[bundle]) && !from.endsWith(".sig"));
    assert.equal(files.length, 1, `${triple} ${bundle}: ${JSON.stringify(files)}`);
    return files[0].to;
  };
  const assertEntry = (m, key, asset) => {
    assert.ok(Object.hasOwn(m.platforms, key), `latest.json has no "${key}"`);
    assert.deepEqual(m.platforms[key], { signature: SIGNATURES[asset], url: `${BASE}/${encodeURIComponent(asset)}` }, key);
  };

  /** Every key the targets need, mapped to the asset it must point at. */
  const required = () => {
    const keys = new Map();
    for (const { triple, bundles } of TARGETS) {
      const platform = `${osOf(triple)}-${archOf(triple)}`;
      for (const bundle of bundles) {
        assert.ok(Object.hasOwn(INSTALLER, bundle), `no installer known for the ${bundle} bundle`);
        if (INSTALLER[bundle] !== null) keys.set(`${platform}-${INSTALLER[bundle]}`, fileOf(triple, bundle));
      }
      const fallback = FALLBACK[osOf(triple)];
      assert.ok(bundles.includes(fallback), `${triple} ships no ${fallback} for its ${platform} entry`);
      keys.set(platform, fileOf(triple, fallback));
    }
    return keys;
  };

  test("each shipped updater bundle has its {os}-{arch}-{installer} entry, pointing at that bundle's own file", () => {
    const m = manifest();
    for (const [key, asset] of required()) if (key.split("-").length === 3) assertEntry(m, key, asset);
  });

  test("each platform has its generic {os}-{arch} entry, pointing at the platform's fallback bundle", () => {
    const m = manifest();
    for (const [key, asset] of required()) if (key.split("-").length === 2) assertEntry(m, key, asset);
  });

  test("and no other entry", () => {
    assert.deepEqual(Object.keys(manifest().platforms).sort(), [...required().keys()].sort());
  });

  test("the same holds for the keys updaterArtifacts lists", () => {
    const listed = new Map(updaterArtifacts(V).flatMap(({ asset, keys }) => keys.map((key) => [key, asset])));
    assert.deepEqual(new Map([...listed].sort()), new Map([...required()].sort()));
  });
});

describe("latestJson", () => {
  test("the version, the notes, pub_date and every key under platforms", () => {
    const m = manifest();
    assert.deepEqual(Object.keys(m), ["version", "notes", "pub_date", "platforms"]);
    assert.equal(m.version, "0.2.0");
    assert.equal(m.notes, "See https://github.com/fleetifydev/fleetify/releases/tag/v0.2.0");
    assert.equal(m.pub_date, PUB_DATE);
    for (const { asset, keys } of updaterArtifacts(V)) {
      for (const key of keys) {
        assert.deepEqual(m.platforms[key], { signature: `sig of ${asset}`, url: `${BASE}/${encodeURIComponent(asset)}` }, key);
      }
    }
  });

  test("the exact platforms, in sorted key order", () => {
    const m = manifest();
    assert.deepEqual(m.platforms, {
      "darwin-aarch64": entry(ARM_APP),
      "darwin-aarch64-app": entry(ARM_APP),
      "darwin-x86_64": entry(INTEL_APP),
      "darwin-x86_64-app": entry(INTEL_APP),
      "linux-x86_64": entry(APPIMAGE),
      "linux-x86_64-appimage": entry(APPIMAGE),
      "linux-x86_64-deb": entry(DEB),
      "linux-x86_64-rpm": entry(RPM),
      "windows-x86_64": entry(NSIS),
      "windows-x86_64-nsis": entry(NSIS),
    });
    assert.deepEqual(Object.keys(m.platforms), Object.keys(m.platforms).sort());
  });

  test("a missing or empty signature throws, naming the asset", () => {
    const { [DEB]: _dropped, ...withoutDeb } = SIGNATURES;
    assert.throws(
      () => latestJson({ version: V, pubDate: PUB_DATE, signatures: withoutDeb, base: BASE }),
      /no signature for Fleetify_0\.2\.0_amd64\.deb/,
    );
    assert.throws(
      () => latestJson({ version: V, pubDate: PUB_DATE, signatures: { ...SIGNATURES, [DEB]: "" }, base: BASE }),
      /no signature for Fleetify_0\.2\.0_amd64\.deb/,
    );
  });

  test("a signature for a file that isn't an updater artifact throws", () => {
    assert.throws(
      () =>
        latestJson({
          version: V,
          pubDate: PUB_DATE,
          signatures: { ...SIGNATURES, "Fleetify_0.2.0_x64.dmg": "sig" },
          base: BASE,
        }),
      /Fleetify_0\.2\.0_x64\.dmg is not an updater artifact/,
    );
  });

  test("pub_date must be a date that toISOString() writes back exactly; anything else throws", () => {
    for (const bad of [
      "",
      "2026-11-21",
      "2026-11-21 10:00:00.000Z",
      "yesterday",
      "2026-11-21T10:00:00.000",
      // Dates that don't exist, which the plugin's RFC 3339 parser refuses.
      "2026-02-30T10:00:00.000Z",
      "2026-02-29T10:00:00.000Z",
      "2026-11-21T24:00:00.000Z",
      "2026-11-21T10:60:00.000Z",
      "2026-11-21T10:00:60.000Z",
      // Valid RFC 3339, but not as toISOString() writes it.
      "2026-11-21T10:00:00Z",
      "2026-11-21T10:00:00.5Z",
      "2026-11-21T10:00:00.000+00:00",
      "+010000-01-01T00:00:00.000Z",
      undefined,
    ]) {
      assert.throws(
        () => latestJson({ version: V, pubDate: bad, signatures: SIGNATURES, base: BASE }),
        /pub_date/,
        JSON.stringify(bad),
      );
    }
  });

  test("pub_date may be any real date and time that toISOString() writes", () => {
    for (const good of ["2026-11-21T10:00:00.250Z", "2028-02-29T23:59:59.999Z", new Date(0).toISOString()]) {
      assert.equal(latestJson({ version: V, pubDate: good, signatures: SIGNATURES, base: BASE }).pub_date, good);
    }
  });

  test("a version that isn't MAJOR.MINOR.PATCH throws", () => {
    assert.throws(
      () => latestJson({ version: "v0.2.0", pubDate: PUB_DATE, signatures: SIGNATURES, base: BASE }),
      /invalid version/,
    );
  });
});

describe("resolveUpdate", () => {
  /** A Linux .deb install of 0.1.0 asks, unless told otherwise. */
  const ask = (query) =>
    resolveUpdate(manifest(), { target: "linux", arch: "x86_64", bundleType: "deb", currentVersion: "0.1.0", ...query });

  test("a .deb install gets the .deb", () => {
    assert.deepEqual(ask({}), offer(DEB));
  });

  test("an .rpm install gets the .rpm, and an AppImage the AppImage", () => {
    assert.deepEqual(ask({ bundleType: "rpm" }), offer(RPM));
    assert.deepEqual(ask({ bundleType: "appimage" }), offer(APPIMAGE));
  });

  test("an unknown bundle type falls back to the platform's generic entry", () => {
    assert.deepEqual(ask({ bundleType: "unknown" }), offer(APPIMAGE));
    assert.deepEqual(ask({ target: "windows", bundleType: "unknown" }), offer(NSIS));
    assert.deepEqual(ask({ target: "darwin", arch: "aarch64", bundleType: "unknown" }), offer(ARM_APP));
  });

  test("Windows and both macOS arches get their own installer", () => {
    assert.deepEqual(ask({ target: "windows", bundleType: "nsis" }), offer(NSIS));
    assert.deepEqual(ask({ target: "darwin", arch: "aarch64", bundleType: "app" }), offer(ARM_APP));
    assert.deepEqual(ask({ target: "darwin", arch: "x86_64", bundleType: "app" }), offer(INTEL_APP));
  });

  test("no update for the same version or a newer one", () => {
    assert.equal(ask({ currentVersion: "0.2.0" }), null);
    assert.equal(ask({ currentVersion: "0.2.1" }), null);
    assert.equal(ask({ currentVersion: "0.10.0" }), null);
    assert.equal(ask({ currentVersion: "1.0.0" }), null);
  });

  test("an older version by any part gets the update", () => {
    assert.deepEqual(ask({ currentVersion: "0.1.9" }), offer(DEB));
    assert.deepEqual(ask({ currentVersion: "0.0.99" }), offer(DEB));
  });

  test("no update for a platform the release doesn't ship", () => {
    assert.equal(ask({ target: "freebsd" }), null);
    assert.equal(ask({ arch: "i686" }), null);
    assert.equal(ask({ target: "linux", arch: "aarch64", bundleType: "unknown" }), null);
  });

  test("only the manifest's own entries count, never inherited properties", () => {
    const inherited = { ...manifest(), platforms: Object.create({ "linux-x86_64-deb": entry(DEB), "linux-x86_64": entry(APPIMAGE) }) };
    assert.equal(resolveUpdate(inherited, { target: "linux", arch: "x86_64", bundleType: "deb", currentVersion: "0.1.0" }), null);
  });

  test("a malformed version throws rather than offering anything", () => {
    assert.throws(() => ask({ currentVersion: "latest" }), /invalid version/);
    assert.throws(
      () => resolveUpdate({ ...manifest(), version: "0.2" }, { target: "linux", arch: "x86_64", bundleType: "deb", currentVersion: "0.1.0" }),
      /invalid version/,
    );
  });

  test("a chosen entry without a url or signature throws rather than falling back to another package", () => {
    const broken = { ...manifest(), platforms: { ...manifest().platforms, "linux-x86_64-deb": { url: `${BASE}/${DEB}` } } };
    assert.throws(
      () => resolveUpdate(broken, { target: "linux", arch: "x86_64", bundleType: "deb", currentVersion: "0.1.0" }),
      /linux-x86_64-deb/,
    );
  });
});

describe("compareVersions", () => {
  test("compares MAJOR, MINOR and PATCH as numbers, in that order", () => {
    assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
    assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
    assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
    assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
    assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
    assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
    assert.equal(compareVersions("123456789012345678901.0.0", "123456789012345678900.0.0"), 1);
  });

  test("anything but MAJOR.MINOR.PATCH throws", () => {
    for (const bad of [undefined, null, 1, "", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc.1", "1.2.3+build", "01.2.3", " 1.2.3", "1.2.x"]) {
      assert.throws(() => compareVersions(bad, "1.0.0"), /invalid version/, JSON.stringify(bad));
      assert.throws(() => compareVersions("1.0.0", bad), /invalid version/, JSON.stringify(bad));
    }
  });
});

describe("sha256sums", () => {
  const A = "a".repeat(64);
  const B = "0123456789abcdef".repeat(4);
  const C = "f".repeat(64);

  test("one '<hash>  <name>' line per file, two spaces between, sorted by name", () => {
    const text = sha256sums([
      { name: "latest.json", sha256: A },
      { name: "Fleetify_0.2.0_amd64.deb", sha256: B },
      { name: "Fleetify-0.2.0-1.x86_64.rpm", sha256: C },
    ]);
    assert.equal(text, `${C}  Fleetify-0.2.0-1.x86_64.rpm\n${B}  Fleetify_0.2.0_amd64.deb\n${A}  latest.json\n`);
  });

  test("the sort is by code point, not by locale", () => {
    const text = sha256sums([
      { name: "b", sha256: A },
      { name: "B", sha256: A },
      { name: "a", sha256: A },
    ]);
    assert.deepEqual(text.trimEnd().split("\n").map((line) => line.slice(66)), ["B", "a", "b"]);
  });

  test("a name or hash that would break the file throws", () => {
    for (const bad of [
      [{ name: "a\nb", sha256: A }],
      [{ name: "dir/file", sha256: A }],
      [{ name: "dir\\file", sha256: A }],
      [{ name: "", sha256: A }],
      [{ name: "a", sha256: A.toUpperCase() }],
      [{ name: "a", sha256: "abc" }],
      [{ name: "a", sha256: A }, { name: "a", sha256: C }],
    ]) {
      assert.throws(() => sha256sums(bad), Error, JSON.stringify(bad));
    }
  });
});

describe("before signing", () => {
  test("unsignedBundleFiles: each target's bundles under their release names, without signatures", () => {
    assert.deepEqual(unsignedBundleFiles(LINUX, V), [
      { from: "appimage/Fleetify_0.2.0_amd64.AppImage", to: "Fleetify_0.2.0_amd64.AppImage" },
      { from: "deb/Fleetify_0.2.0_amd64.deb", to: "Fleetify_0.2.0_amd64.deb" },
      { from: "rpm/Fleetify-0.2.0-1.x86_64.rpm", to: "Fleetify-0.2.0-1.x86_64.rpm" },
    ]);
    assert.deepEqual(unsignedBundleFiles(ARM_MAC, V), [
      { from: "macos/Fleetify.app.tar.gz", to: "Fleetify_0.2.0_aarch64.app.tar.gz" },
      { from: "dmg/Fleetify_0.2.0_aarch64.dmg", to: "Fleetify_0.2.0_aarch64.dmg" },
    ]);
    for (const { triple } of TARGETS) {
      const signed = bundleFiles(triple, V).filter(({ to }) => !to.endsWith(".sig"));
      assert.deepEqual(unsignedBundleFiles(triple, V), signed, triple);
    }
  });

  test("unsignedAssets: the unsigned artifact's files, sorted, with the AppImage's library list on Linux", () => {
    assert.deepEqual(unsignedAssets(LINUX, V), [
      "Fleetify-0.2.0-1.x86_64.rpm",
      "Fleetify_0.2.0_amd64.AppImage",
      "Fleetify_0.2.0_amd64.deb",
      "LINUX-APPIMAGE-LIBRARIES.txt",
    ]);
    assert.deepEqual(unsignedAssets(WINDOWS, V), ["Fleetify_0.2.0_x64-setup.exe"]);
    assert.deepEqual(unsignedAssets(INTEL_MAC, V), ["Fleetify_0.2.0_x64.app.tar.gz", "Fleetify_0.2.0_x64.dmg"]);
  });

  test("updaterAssets: a target's updater artifacts, the files that get a signature", () => {
    assert.deepEqual(updaterAssets(LINUX, V), ["Fleetify_0.2.0_amd64.AppImage", "Fleetify_0.2.0_amd64.deb", "Fleetify-0.2.0-1.x86_64.rpm"]);
    assert.deepEqual(updaterAssets(WINDOWS, V), ["Fleetify_0.2.0_x64-setup.exe"]);
    assert.deepEqual(updaterAssets(ARM_MAC, V), ["Fleetify_0.2.0_aarch64.app.tar.gz"]);
    const all = TARGETS.flatMap(({ triple }) => updaterAssets(triple, V));
    assert.deepEqual(all, updaterArtifacts(V).map(({ asset }) => asset));
  });

  test("an unknown triple or a bad version throws", () => {
    assert.throws(() => unsignedAssets("riscv64-unknown-linux-gnu", V), /unknown target triple/);
    assert.throws(() => updaterAssets(LINUX, "v0.2.0"), /invalid version/);
  });

  test("the CLI prints either list, one name a line", () => {
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    const unsigned = cli("unsigned", LINUX, V);
    assert.equal(unsigned.status, 0, unsigned.stderr);
    assert.equal(unsigned.stdout, `${unsignedAssets(LINUX, V).join("\n")}\n`);
    const updaters = cli("updaters", WINDOWS, V);
    assert.equal(updaters.status, 0, updaters.stderr);
    assert.equal(updaters.stdout, "Fleetify_0.2.0_x64-setup.exe\n");
    for (const args of [[], ["unsigned"], ["unsigned", LINUX], ["signed", LINUX, V], ["unsigned", LINUX, V, "extra"]]) {
      const result = cli(...args);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage:/);
    }
    const unknown = cli("updaters", "riscv64-unknown-linux-gnu", V);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown target triple/);
    assert.equal(unknown.stdout, "");
  });
});
