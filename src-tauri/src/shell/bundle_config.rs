//! The bundle settings `tauri build` reads: `tauri.conf.json`, which every
//! build uses, and `tauri.release.conf.json`, which only the release
//! workflow adds (`tauri build --config`). Updater artefacts need the
//! signing key and THIRD-PARTY-NOTICES is generated in CI, so both live in
//! the overlay alone: a contributor's plain `tauri build` needs neither.
//!
//! Tests only. The files are read when the tests run, from `src-tauri/`,
//! which the configs' relative paths start from.

use std::path::PathBuf;

use serde_json::{json, Value};

/// `src-tauri/`.
fn tauri_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The text of `name`, a path relative to `src-tauri/`.
fn read(name: &str) -> String {
    let path = tauri_dir().join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// `name` (relative to `src-tauri/`) as JSON.
fn json_file(name: &str) -> Value {
    serde_json::from_str(&read(name)).unwrap_or_else(|e| panic!("{name} is not JSON: {e}"))
}

/// The config every build uses.
fn base() -> Value {
    json_file("tauri.conf.json")
}

#[test]
fn the_bundle_ships_the_licence_and_notice() {
    // Apache-2.0 asks a redistribution to carry the licence and the NOTICE
    // file, so every bundle does, in a `legal` folder of its resources.
    let resources = &base()["bundle"]["resources"];
    assert_eq!(
        resources,
        &json!({ "../LICENSE": "legal/LICENSE", "../NOTICE": "legal/NOTICE" }),
        "bundle.resources"
    );
    for source in resources.as_object().unwrap().keys() {
        let path = tauri_dir().join(source);
        assert!(path.is_file(), "{} isn't a file", path.display());
    }
}

#[test]
fn a_build_without_release_secrets_still_works() {
    // Updater artefacts are signed with TAURI_SIGNING_PRIVATE_KEY, and
    // THIRD-PARTY-NOTICES only exists in a release run. A build that asked
    // for either would fail without them.
    let bundle = &base()["bundle"];
    let updater_artifacts = bundle.get("createUpdaterArtifacts");
    assert!(
        matches!(
            updater_artifacts,
            None | Some(Value::Null) | Some(Value::Bool(false))
        ),
        "bundle.createUpdaterArtifacts: {updater_artifacts:?}"
    );
    let resources = bundle["resources"].to_string();
    assert!(
        !resources.contains("THIRD-PARTY-NOTICES"),
        "bundle.resources: {resources}"
    );
}

#[test]
fn the_release_overlay_adds_updater_artifacts_and_notices() {
    // The whole overlay, so nothing else rides along: plugins.updater, for
    // one, stays as the base config sets it. `resources` is a map, as in the
    // base config: `--config` merges objects key by key (JSON Merge Patch),
    // so the licence and NOTICE stay; a list would replace them. The release
    // workflow stages the release sidecars itself, so the build command
    // builds only the UI.
    assert_eq!(
        json_file("tauri.release.conf.json"),
        json!({
            "bundle": {
                "createUpdaterArtifacts": true,
                "resources": { "../THIRD-PARTY-NOTICES": "legal/THIRD-PARTY-NOTICES" }
            },
            "build": { "beforeBuildCommand": "npm run build" }
        })
    );
}

#[test]
fn the_deb_requires_webkitgtk_2_40() {
    assert_eq!(
        base()["bundle"]["linux"]["deb"]["depends"],
        json!(["libwebkit2gtk-4.1-0 (>= 2.40)"])
    );
}

#[test]
fn the_descriptions_match_the_readme_and_name_no_removed_agent() {
    let config = base();
    let bundle = &config["bundle"];
    let short = bundle["shortDescription"]
        .as_str()
        .expect("bundle.shortDescription is a string");
    assert_eq!(short, "A command center for AI agents.");
    // The README's tagline.
    let readme = read("../README.md");
    assert!(readme.contains(short), "README.md doesn't say {short:?}");
    let long = bundle["longDescription"]
        .as_str()
        .expect("bundle.longDescription is a string");
    for description in [short, long] {
        assert!(
            !description.to_lowercase().contains("gemini"),
            "names the removed Gemini agent: {description}"
        );
    }
}

#[test]
fn the_macos_build_has_hardened_runtime_and_the_microphone_entitlement() {
    let config = base();
    let macos = &config["bundle"]["macOS"];
    assert_eq!(
        macos["hardenedRuntime"],
        json!(true),
        "bundle.macOS: {macos}"
    );
    assert_eq!(
        macos["entitlements"],
        json!("Entitlements.plist"),
        "bundle.macOS: {macos}"
    );
    // Voice dictation records from the microphone, which a hardened app may
    // do only with this entitlement (Info.plist holds the prompt's text).
    let plist = read("Entitlements.plist");
    let key = "<key>com.apple.security.device.audio-input</key>";
    let (_, after) = plist
        .split_once(key)
        .unwrap_or_else(|| panic!("Entitlements.plist has no {key}: {plist}"));
    assert!(
        after.trim_start().starts_with("<true/>"),
        "{key} isn't followed by <true/>: {plist}"
    );
    // Nothing else: another entitlement comes with the run that needed it.
    assert_eq!(plist.matches("<key>").count(), 1, "{plist}");
}
