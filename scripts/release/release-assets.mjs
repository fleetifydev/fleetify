/**
 * release-assets.mjs — what a Fleetify release is made of: the targets CI
 * builds, the files each build produces and the names they are published
 * under, the updater manifest (latest.json), how an update endpoint picks an
 * entry from it, and SHA256SUMS.
 *
 * The release scripts and workflows import these, so each name is defined in
 * one place.
 *
 * Asset names are the Tauri CLI's own (tauri-cli 2.11.2), with one exception:
 * both macOS builds write macos/Fleetify.app.tar.gz, so the updater archive is
 * published with the version and arch added.
 */
import { posix } from "node:path";

export const REPO = "fleetifydev/fleetify";

/**
 * The id of the key that signs updates. Its public half is
 * plugins.updater.pubkey in src-tauri/tauri.conf.json, which every build
 * embeds, so an update signed with any other key is refused.
 */
export const UPDATER_KEY_ID = "44C694713A20D751";

/** The release assets that don't come out of a Tauri bundle. */
export const MANIFEST = "latest.json";
export const CHECKSUMS = "SHA256SUMS";
export const NOTICES = "THIRD-PARTY-NOTICES";
export const LIBRARY_LIST = "LINUX-APPIMAGE-LIBRARIES.txt";

/**
 * The release targets: the Rust target triple, the GitHub runner that builds
 * it, and the Tauri bundles it ships (`tauri build --bundles`).
 */
export const TARGETS = Object.freeze(
  [
    { triple: "x86_64-unknown-linux-gnu", runner: "ubuntu-22.04", bundles: ["appimage", "deb", "rpm"] },
    { triple: "x86_64-pc-windows-msvc", runner: "windows-2025", bundles: ["nsis"] },
    { triple: "aarch64-apple-darwin", runner: "macos-15", bundles: ["app", "dmg"] },
    { triple: "x86_64-apple-darwin", runner: "macos-15-intel", bundles: ["app", "dmg"] },
  ].map(({ bundles, ...target }) => Object.freeze({ ...target, bundles: Object.freeze(bundles) })),
);

/**
 * What each target's bundles produce, for version `v`:
 *   from  the file Tauri writes, under target/<triple>/release/bundle/;
 *   to    its release asset name, when it isn't the file's own name;
 *   keys  the latest.json entries that point at it.
 *
 * A bundle with keys is an updater artifact, which Tauri signs into
 * <file>.sig. Its keys are {os}-{arch}-{installer}, the entry the updater
 * plugin looks up first, and, for each platform's fallback bundle, also
 * {os}-{arch}, which the plugin uses when it can't tell how it was installed.
 * The dmg has none: an app installed from it reports itself as "app" and
 * updates through the app archive.
 */
const BUNDLES = {
  "x86_64-unknown-linux-gnu": {
    appimage: (v) => ({ from: `appimage/Fleetify_${v}_amd64.AppImage`, keys: ["linux-x86_64-appimage", "linux-x86_64"] }),
    deb: (v) => ({ from: `deb/Fleetify_${v}_amd64.deb`, keys: ["linux-x86_64-deb"] }),
    rpm: (v) => ({ from: `rpm/Fleetify-${v}-1.x86_64.rpm`, keys: ["linux-x86_64-rpm"] }),
  },
  "x86_64-pc-windows-msvc": {
    nsis: (v) => ({ from: `nsis/Fleetify_${v}_x64-setup.exe`, keys: ["windows-x86_64-nsis", "windows-x86_64"] }),
  },
  "aarch64-apple-darwin": {
    app: (v) => ({
      from: "macos/Fleetify.app.tar.gz",
      to: `Fleetify_${v}_aarch64.app.tar.gz`,
      keys: ["darwin-aarch64-app", "darwin-aarch64"],
    }),
    dmg: (v) => ({ from: `dmg/Fleetify_${v}_aarch64.dmg`, keys: [] }),
  },
  "x86_64-apple-darwin": {
    app: (v) => ({
      from: "macos/Fleetify.app.tar.gz",
      to: `Fleetify_${v}_x64.app.tar.gz`,
      keys: ["darwin-x86_64-app", "darwin-x86_64"],
    }),
    dmg: (v) => ({ from: `dmg/Fleetify_${v}_x64.dmg`, keys: [] }),
  },
};

/** Code-point order, the same on every machine and locale. */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** MAJOR.MINOR.PATCH, without a leading "v", a pre-release or build part, or leading zeros. */
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** The three parts of a version, as BigInts. Throws on anything but MAJOR.MINOR.PATCH. */
function versionParts(version) {
  const match = typeof version === "string" ? VERSION.exec(version) : null;
  if (!match) throw new Error(`invalid version ${JSON.stringify(version)}: expected MAJOR.MINOR.PATCH`);
  return match.slice(1).map(BigInt);
}

/** One entry per bundle of a target, in TARGETS order: { from, to, keys }. */
function targetBundles(triple, version) {
  versionParts(version);
  const target = TARGETS.find((t) => t.triple === triple);
  if (!target || !Object.hasOwn(BUNDLES, triple)) throw new Error(`unknown target triple: ${triple}`);
  return target.bundles.map((bundle) => {
    if (!Object.hasOwn(BUNDLES[triple], bundle)) throw new Error(`no file names known for the ${bundle} bundle of ${triple}`);
    const { from, to = posix.basename(from), keys } = BUNDLES[triple][bundle](version);
    return { from, to, keys };
  });
}

/**
 * The files a target's build publishes: where Tauri writes each one, under
 * target/<triple>/release/bundle/, and its release asset name. Each updater
 * artifact is followed by its signature.
 *
 * @param {string} triple
 * @param {string} version
 * @returns {{ from: string, to: string }[]}
 */
export function bundleFiles(triple, version) {
  return targetBundles(triple, version).flatMap(({ from, to, keys }) =>
    keys.length > 0
      ? [
          { from, to },
          { from: `${from}.sig`, to: `${to}.sig` },
        ]
      : [{ from, to }],
  );
}

/**
 * Every asset of a release, sorted: each target's bundle files, the AppImage
 * library list, the notices, latest.json and SHA256SUMS.
 *
 * @param {string} version
 * @returns {string[]}
 */
export function expectedAssets(version) {
  versionParts(version);
  const names = [
    ...TARGETS.flatMap(({ triple }) => bundleFiles(triple, version).map(({ to }) => to)),
    LIBRARY_LIST,
    NOTICES,
    MANIFEST,
    CHECKSUMS,
  ];
  if (new Set(names).size !== names.length) throw new Error("two release assets have the same name");
  return names.sort(compare);
}

/**
 * The updater artifacts, each with the latest.json keys that point at it.
 * Each is published with its signature, `${asset}.sig`.
 *
 * @param {string} version
 * @returns {{ asset: string, keys: string[] }[]}
 */
export function updaterArtifacts(version) {
  return TARGETS.flatMap(({ triple }) =>
    targetBundles(triple, version)
      .filter(({ keys }) => keys.length > 0)
      .map(({ to, keys }) => ({ asset: to, keys: [...keys] })),
  );
}

/** Where a release's assets download from: its tag's folder on GitHub. */
export function downloadBase(version) {
  versionParts(version);
  return `https://github.com/${REPO}/releases/download/v${version}`;
}

/**
 * RFC 3339 in UTC, as the updater plugin parses pub_date. A pub_date it can't
 * parse makes the whole manifest unreadable to it.
 */
const PUB_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;

/**
 * latest.json, the updater manifest that GitHub serves for the latest
 * release: an entry under `platforms` for each key of each updater artifact,
 * in sorted key order.
 *
 * @param {{ version: string, pubDate: string, signatures: Record<string, string>, base: string }} options
 *   signatures maps each updater artifact to its signature: its .sig file's
 *   text, trimmed. base is where the assets download from (downloadBase).
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }}
 */
export function latestJson({ version, pubDate, signatures, base }) {
  versionParts(version);
  if (typeof pubDate !== "string" || !PUB_DATE.test(pubDate) || Number.isNaN(Date.parse(pubDate))) {
    throw new Error(`invalid pub_date ${JSON.stringify(pubDate)}: expected RFC 3339 in UTC, like 2026-11-21T10:00:00Z`);
  }
  if (typeof base !== "string" || base === "" || base.endsWith("/")) {
    throw new Error(`invalid download base ${JSON.stringify(base)}`);
  }
  const artifacts = updaterArtifacts(version);
  const known = new Set(artifacts.map(({ asset }) => asset));
  for (const asset of Object.keys(signatures)) {
    if (!known.has(asset)) throw new Error(`${asset} is not an updater artifact`);
  }
  const platforms = new Map();
  for (const { asset, keys } of artifacts) {
    const signature = Object.hasOwn(signatures, asset) ? signatures[asset] : undefined;
    if (typeof signature !== "string" || signature === "") throw new Error(`no signature for ${asset}`);
    for (const key of keys) {
      if (platforms.has(key)) throw new Error(`two updater artifacts claim ${key}`);
      platforms.set(key, { signature, url: `${base}/${encodeURIComponent(asset)}` });
    }
  }
  return {
    version,
    notes: `See https://github.com/${REPO}/releases/tag/v${version}`,
    pub_date: pubDate,
    platforms: Object.fromEntries([...platforms].sort(([a], [b]) => compare(a, b))),
  };
}

/**
 * The update to offer an installed copy, or null when there is none. This
 * is the updater plugin's own choice from a latest.json: the entry for
 * `${target}-${arch}-${bundleType}`, else the one for `${target}-${arch}`,
 * and only when the manifest's version is newer than `currentVersion`. The
 * answer has the shape of the plugin's dynamic update response.
 *
 * This function is the contract for the fleetify.dev update endpoint, the
 * first of plugins.updater.endpoints in src-tauri/tauri.conf.json:
 *
 *   GET /api/desktop/update/{target}/{arch}/{current_version}?bundle_type={bundle_type}
 *
 * The endpoint ports this logic exactly. It answers 200 with the result as
 * JSON, and 204 when the result is null; docs/RELEASE.md describes the
 * endpoint. Package managers depend on the bundle type: a .deb or .rpm
 * install handed the AppImage can't install it.
 *
 * Throws on a version that isn't MAJOR.MINOR.PATCH, and when the chosen
 * entry has no url or signature, so that the endpoint answers with an error
 * (and the updater tries its next endpoint) instead of a wrong package.
 *
 * @param {{ version: string, notes?: string, pub_date?: string, platforms: Record<string, { url: string, signature: string }> }} manifest
 * @param {{ target: string, arch: string, bundleType: string, currentVersion: string }} query
 *   target is the plugin's os (linux, windows, darwin); bundleType is
 *   appimage, deb, rpm, nsis, msi, app or unknown.
 * @returns {null | { version: string, url: string, signature: string, notes?: string, pub_date?: string }}
 */
export function resolveUpdate(manifest, { target, arch, bundleType, currentVersion }) {
  const newer = compareVersions(manifest.version, currentVersion) > 0;
  const platforms = manifest.platforms ?? {};
  const key = [`${target}-${arch}-${bundleType}`, `${target}-${arch}`].find((k) => Object.hasOwn(platforms, k));
  if (key === undefined || !newer) return null;
  const { url, signature } = platforms[key] ?? {};
  if (typeof url !== "string" || url === "" || typeof signature !== "string" || signature === "") {
    throw new Error(`latest.json entry ${key} has no url or signature`);
  }
  return { version: manifest.version, url, signature, notes: manifest.notes, pub_date: manifest.pub_date };
}

/**
 * -1, 0 or 1 as version `a` is older than, the same as, or newer than `b`.
 * Throws on anything but MAJOR.MINOR.PATCH.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** A file name SHA256SUMS can carry: no path, no spaces, no line breaks. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * SHA256SUMS: a "<hash>  <name>" line per file, sorted by name, which
 * `sha256sum -c` and `shasum -a 256 -c` read.
 *
 * @param {{ name: string, sha256: string }[]} entries
 * @returns {string}
 */
export function sha256sums(entries) {
  const seen = new Set();
  for (const { name, sha256 } of entries) {
    if (typeof name !== "string" || !ASSET_NAME.test(name)) throw new Error(`can't list ${JSON.stringify(name)} in SHA256SUMS`);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`${name}: ${JSON.stringify(sha256)} is not a SHA-256 in lowercase hex`);
    }
    if (seen.has(name)) throw new Error(`${name} is listed twice`);
    seen.add(name);
  }
  return [...entries]
    .sort((a, b) => compare(a.name, b.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join("");
}
