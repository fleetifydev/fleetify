//! The UI files a release build serves, and the one place they come from:
//! the binary itself.
//!
//! Release builds load the app from the embedded backend, which serves the
//! UI on `http://127.0.0.1:<port>`. That origin holds every app command
//! (see `startup_window::runtime_capability`). `tauri build` runs the
//! frontend build (`npm run build` → `dist/`, `frontendDist` in
//! `tauri.conf.json`) and embeds its output in the executable; [`served_ui`]
//! hands exactly those files to the backend, read through Tauri's
//! `AssetResolver`, and the backend serves them with a Content-Security-
//! Policy of its own (`fleetify_backend::ui`). Nothing is read from disk.
//!
//! The UI used to be a `dist` folder: first beside the executable or in the
//! working directory, so a `dist` folder wherever Fleetify was launched from
//! was served as the app; then one the bundle shipped as a resource. A
//! release build without the embedded files now ends the start like a
//! backend that can't start: an error dialog, then the app quits (see
//! `startup_window`).
//!
//! Debug builds load the UI from the Vite dev server and serve none.

use std::collections::HashSet;
use std::fmt;

use fleetify_backend::ui::{UiAsset, UiAssets};

/// The key of the page `/` stands for. Tauri's asset keys start with a
/// slash (tauri-utils `AssetKey`).
pub const INDEX_KEY: &str = "/index.html";

/// Why a release build has no UI files to serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiFilesMissing {
    /// The binary has none embedded: a release build compiled without
    /// `tauri build` (a plain `cargo build --release`), which embeds
    /// nothing and expects Vite.
    NotEmbedded,
    /// The embedded files have no `index.html`.
    NoIndexHtml,
}

impl fmt::Display for UiFilesMissing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotEmbedded => f.write_str(
                "this build has no UI files embedded (a release binary needs `tauri build`)",
            ),
            Self::NoIndexHtml => {
                f.write_str("the UI files embedded in this build have no index.html")
            }
        }
    }
}

impl std::error::Error for UiFilesMissing {}

/// What the embedded backend serves as the UI, by build ([`ui_decision`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiDecision {
    /// Nothing: Vite serves the UI.
    None,
    /// Nothing, though it should: a start failure.
    Missing,
    /// The files embedded in the binary.
    Embedded,
}

/// What a build serves: a debug build (`release` false) nothing, as Vite
/// serves its UI. A release build serves the embedded files, unless Tauri
/// was compiled in dev mode (`tauri_dev`, `tauri::is_dev()`), which embeds
/// none.
pub fn ui_decision(release: bool, tauri_dev: bool) -> UiDecision {
    match (release, tauri_dev) {
        (false, _) => UiDecision::None,
        (true, true) => UiDecision::Missing,
        (true, false) => UiDecision::Embedded,
    }
}

/// The asset key a request path names: `/` is [`INDEX_KEY`]; any other path
/// is its own key, percent-decoded, as the browser encodes what it asks
/// for. `None` when the decoded path isn't UTF-8, which no key is.
pub fn asset_key(request_path: &str) -> Option<String> {
    if request_path == "/" {
        return Some(INDEX_KEY.to_string());
    }
    percent_encoding::percent_decode_str(request_path)
        .decode_utf8()
        .ok()
        .map(|key| key.into_owned())
}

/// What `AssetResolver::get_for_scheme` is asked for to get `key`: it
/// percent-decodes its argument, so a literal `%` in a file name goes to it
/// as `%25`.
fn resolver_path(key: &str) -> String {
    key.replace('%', "%25")
}

/// The UI over the embedded files `keys`, which `get` reads by key. A
/// request path is answered only when its key ([`asset_key`]) is one of
/// `keys`: Tauri's resolver answers a key it doesn't have with index.html,
/// and a missing file must stay missing. Files without index.html are no UI.
fn embedded_ui(
    keys: HashSet<String>,
    get: impl Fn(&str) -> Option<UiAsset> + Send + Sync + 'static,
) -> Result<UiAssets, UiFilesMissing> {
    if !keys.contains(INDEX_KEY) {
        return Err(UiFilesMissing::NoIndexHtml);
    }
    Ok(UiAssets::new(move |request_path| {
        let key = asset_key(request_path)?;
        if keys.contains(&key) {
            get(&key)
        } else {
            None
        }
    }))
}

/// The UI files the embedded backend serves, by [`ui_decision`]: none in a
/// debug build, which loads the UI from Vite; in release, the files embedded
/// in the binary, read through `resolver` (`app.asset_resolver()`).
/// `tauri_dev` is `tauri::is_dev()`. An error is a release build with no UI
/// to serve, which is a start failure.
pub fn served_ui<R: tauri::Runtime>(
    release: bool,
    tauri_dev: bool,
    resolver: tauri::AssetResolver<R>,
) -> Result<Option<UiAssets>, UiFilesMissing> {
    match ui_decision(release, tauri_dev) {
        UiDecision::None => Ok(None),
        UiDecision::Missing => Err(UiFilesMissing::NotEmbedded),
        UiDecision::Embedded => {
            let keys: HashSet<String> = resolver.iter().map(|(key, _)| key.into_owned()).collect();
            tracing::info!(
                files = keys.len(),
                "serving the UI files embedded in the binary"
            );
            embedded_ui(keys, move |key| {
                resolver
                    .get_for_scheme(resolver_path(key), false)
                    .map(|asset| UiAsset {
                        bytes: asset.bytes,
                        mime_type: asset.mime_type,
                    })
            })
            .map(Some)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn what_the_backend_serves_depends_on_the_build() {
        // (release, tauri_dev) → what the backend serves
        for (release, tauri_dev, want) in [
            // `tauri dev`, `cargo build`, CI: Vite serves the UI.
            (false, true, UiDecision::None),
            // A debug build made by `tauri build --debug`.
            (false, false, UiDecision::None),
            // `cargo build --release`: a release binary with nothing embedded.
            (true, true, UiDecision::Missing),
            // `tauri build`.
            (true, false, UiDecision::Embedded),
        ] {
            assert_eq!(
                ui_decision(release, tauri_dev),
                want,
                "release={release} tauri_dev={tauri_dev}"
            );
        }
    }

    #[test]
    fn a_request_path_names_its_asset_key() {
        // Tauri's keys have a leading slash (tauri-utils `AssetKey`).
        assert_eq!(asset_key("/").as_deref(), Some(INDEX_KEY));
        assert_eq!(asset_key("/assets/a.js").as_deref(), Some("/assets/a.js"));
        assert_eq!(asset_key("/index.html").as_deref(), Some(INDEX_KEY));
        assert_eq!(asset_key("/favicon.svg").as_deref(), Some("/favicon.svg"));
        // Percent-decoded, as the path a browser asks for is encoded.
        assert_eq!(
            asset_key("/assets/a%20b.js").as_deref(),
            Some("/assets/a b.js")
        );
        // Not UTF-8 once decoded: no file has that name.
        assert_eq!(asset_key("/assets/%FF.js"), None);
    }

    #[test]
    fn a_key_reaches_the_resolver_escaped_for_its_own_decoding() {
        // Tauri percent-decodes what it is asked for, so a literal % in a
        // file name has to reach it as %25.
        assert_eq!(resolver_path("/assets/a.js"), "/assets/a.js");
        assert_eq!(resolver_path("/100%.png"), "/100%25.png");
        assert_eq!(resolver_path("/a%20b.js"), "/a%2520b.js");
    }

    /// The embedded files in `files`, read through a getter that answers as
    /// Tauri's resolver does: index.html for any key it doesn't have.
    fn embedded(files: &[(&'static str, &'static str)]) -> Result<UiAssets, UiFilesMissing> {
        let files: HashMap<&str, &str> = files.iter().copied().collect();
        let keys = files.keys().map(|key| key.to_string()).collect();
        embedded_ui(keys, move |key| {
            let body = files.get(key).or_else(|| files.get(INDEX_KEY))?;
            Some(UiAsset {
                bytes: body.as_bytes().to_vec(),
                mime_type: "text/plain".into(),
            })
        })
    }

    fn body(ui: &UiAssets, path: &str) -> Option<String> {
        ui.get(path)
            .map(|asset| String::from_utf8(asset.bytes).unwrap())
    }

    #[test]
    fn only_the_embedded_files_are_served() {
        let ui = embedded(&[
            (INDEX_KEY, "<!doctype html>"),
            ("/assets/a.js", "export {}"),
        ])
        .unwrap();
        assert_eq!(body(&ui, "/").as_deref(), Some("<!doctype html>"));
        assert_eq!(body(&ui, "/index.html").as_deref(), Some("<!doctype html>"));
        assert_eq!(body(&ui, "/assets/a.js").as_deref(), Some("export {}"));
        // The resolver would answer index.html for each of these.
        for path in [
            "/assets/missing.js",
            "/api/nope",
            "/index",
            "/assets/",
            "/assets",
        ] {
            assert_eq!(body(&ui, path), None, "{path}");
        }
    }

    #[test]
    fn embedded_files_without_index_html_are_missing() {
        assert_eq!(
            embedded(&[("/assets/a.js", "export {}")]).err(),
            Some(UiFilesMissing::NoIndexHtml)
        );
        // index.html elsewhere isn't the page.
        assert_eq!(
            embedded(&[("/app/index.html", "<!doctype html>")]).err(),
            Some(UiFilesMissing::NoIndexHtml)
        );
        assert_eq!(embedded(&[]).err(), Some(UiFilesMissing::NoIndexHtml));
    }

    #[test]
    fn the_error_says_what_is_missing() {
        assert!(
            UiFilesMissing::NotEmbedded
                .to_string()
                .contains("tauri build"),
            "{}",
            UiFilesMissing::NotEmbedded
        );
        assert!(
            UiFilesMissing::NoIndexHtml
                .to_string()
                .contains("index.html"),
            "{}",
            UiFilesMissing::NoIndexHtml
        );
    }

    // ── The build ──

    /// The app's `tauri.conf.json`.
    fn tauri_conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap()
    }

    #[test]
    fn the_bundle_ships_no_ui_folder() {
        // The UI is in the binary. A copy beside it would be a second
        // source that nothing reads.
        let config = tauri_conf();
        let resources = &config["bundle"]["resources"];
        let ships_dist = match resources {
            serde_json::Value::Null => false,
            serde_json::Value::Object(map) => {
                map.contains_key("../dist") || map.values().any(|target| target == "dist")
            }
            serde_json::Value::Array(list) => list
                .iter()
                .any(|source| source.as_str().is_some_and(|s| s.contains("dist"))),
            other => panic!("bundle.resources is neither a map nor a list: {other}"),
        };
        assert!(
            !ships_dist,
            "bundle.resources ships the UI folder: {resources}"
        );
    }

    #[test]
    fn the_bundle_declares_apache_without_a_click_through() {
        // The bundler puts `license` in the rpm License header.
        let config = tauri_conf();
        let bundle = &config["bundle"];
        assert_eq!(bundle["license"], "Apache-2.0", "bundle: {bundle}");
        // No licenseFile: Apache-2.0 needs no click-through (NSIS "I Agree" page, DMG prompt).
        for key in ["licenseFile", "license-file"] {
            assert!(bundle.get(key).is_none(), "bundle.{key}: {bundle}");
        }
    }

    #[test]
    fn tauri_adds_no_csp_of_its_own() {
        // The backend sends the policy with every UI file. Tauri's would
        // only rewrite the embedded index.html (nonces, hashes) for a
        // protocol the app doesn't load.
        let config = tauri_conf();
        assert_eq!(
            config["app"]["security"].get("csp"),
            Some(&serde_json::Value::Null),
            "app.security.csp must be null: {}",
            config["app"]["security"]
        );
    }

    #[test]
    fn the_embedded_folder_is_the_one_the_frontend_build_fills() {
        // `tauri build` runs beforeBuildCommand, the frontend build among
        // it, before it compiles and embeds frontendDist: Vite writes dist/
        // at the repo root, `../dist` from src-tauri.
        let config = tauri_conf();
        assert_eq!(config["build"]["frontendDist"], "../dist");
        let before_build = config["build"]["beforeBuildCommand"].as_str().unwrap();
        assert!(
            before_build
                .split("&&")
                .any(|command| command.trim() == "npm run build"),
            "beforeBuildCommand must run the frontend build: {before_build}"
        );
    }

    #[test]
    fn a_tauri_build_without_the_built_ui_fails() {
        // A release binary without index.html would only show the error
        // dialog, so the build stops instead.
        let build_rs = include_str!("../../build.rs");
        assert!(build_rs.contains("tauri_build::is_dev()"), "{build_rs}");
        assert!(build_rs.contains(r#""../dist/index.html""#), "{build_rs}");
        assert!(
            build_rs.contains("the UI isn't built: run npm run build before tauri build"),
            "{build_rs}"
        );
        // The empty-folder workaround for the resource copy is gone.
        assert!(!build_rs.contains("create_dir_all"), "{build_rs}");
    }
}
