//! The UI files a release build serves, and the one place they come from.
//!
//! Release builds load the app from the embedded backend, which serves the
//! built UI (`npm run build` → `dist/`) on `http://127.0.0.1:<port>`. That
//! origin holds every app command (see
//! `startup_window::runtime_capability`). The bundle ships the UI as a
//! resource: `bundle.resources` in `tauri.conf.json` maps `../dist` to
//! [`UI_DIR`] in the install's resource folder, and that is the only place
//! it is served from ([`ui_dir`]).
//!
//! It used to be served from `dist` beside the executable, or else from
//! `dist` in the working directory. No bundle had either, so an installed
//! copy showed a blank window, and a `dist` folder in whatever directory
//! Fleetify was launched from (a cloned repository, say) was served as the
//! app, with all of its IPC. Missing UI files now end the start like a
//! backend that can't start: an error dialog, then the app quits (see
//! `startup_window`).
//!
//! Debug builds load the UI from the Vite dev server and serve none.

use std::fmt;
use std::path::{Path, PathBuf};

/// The UI's folder in the install's resource folder: where
/// `bundle.resources` puts the built `../dist`.
pub const UI_DIR: &str = "dist";

/// Why a release build has no UI files to serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiDirError {
    /// The install's resource folder is unknown: Tauri couldn't work it out
    /// (its error), or it is not an absolute path, which every file system
    /// call would resolve against the working directory.
    NoResourceDir(String),
    /// The UI folder ([`UI_DIR`] in the resource folder) has no
    /// `index.html`: the folder is missing, or it is there without the file.
    NoIndexHtml(PathBuf),
}

impl fmt::Display for UiDirError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoResourceDir(error) => {
                write!(f, "the install's resource folder is unknown: {error}")
            }
            Self::NoIndexHtml(dir) => write!(f, "{} has no index.html", dir.display()),
        }
    }
}

impl std::error::Error for UiDirError {}

/// The UI folder in `resource_dir`, the install's resource folder
/// (`app.path().resource_dir()`): [`UI_DIR`] there, when it holds
/// `index.html`. Nowhere else: not beside the executable, and never the
/// working directory. A relative `resource_dir` is refused, since it would
/// be resolved against the working directory.
pub fn ui_dir(resource_dir: &Path) -> Result<PathBuf, UiDirError> {
    if !resource_dir.is_absolute() {
        return Err(UiDirError::NoResourceDir(format!(
            "{resource_dir:?} is not an absolute path"
        )));
    }
    let dir = resource_dir.join(UI_DIR);
    if dir.join("index.html").is_file() {
        Ok(dir)
    } else {
        Err(UiDirError::NoIndexHtml(dir))
    }
}

/// The UI folder the embedded backend serves: none in a debug build, which
/// loads the UI from Vite and never asks for `resource_dir`; in release, the
/// one [`ui_dir`] finds in the install's resource folder. An error is a
/// release build with no UI to serve, which is a start failure.
pub fn served_ui_dir(
    release: bool,
    resource_dir: impl FnOnce() -> tauri::Result<PathBuf>,
) -> Result<Option<PathBuf>, UiDirError> {
    if !release {
        return Ok(None);
    }
    let resource_dir = resource_dir().map_err(|e| UiDirError::NoResourceDir(e.to_string()))?;
    ui_dir(&resource_dir).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A folder holding `files` (paths relative to it), each with a line of
    /// content.
    fn folder_with(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in files {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, format!("<!-- {file} -->")).unwrap();
        }
        dir
    }

    #[test]
    fn the_ui_is_dist_in_the_resource_folder_when_it_has_index_html() {
        let resources = folder_with(&["dist/index.html", "dist/assets/index.js"]);
        assert_eq!(ui_dir(resources.path()), Ok(resources.path().join("dist")));
    }

    #[test]
    fn no_dist_folder_means_no_ui() {
        let resources = folder_with(&[]);
        assert_eq!(
            ui_dir(resources.path()),
            Err(UiDirError::NoIndexHtml(resources.path().join("dist")))
        );
    }

    #[test]
    fn a_dist_folder_without_index_html_means_no_ui() {
        let resources = folder_with(&["dist/assets/index.js"]);
        let dist = resources.path().join("dist");
        assert_eq!(
            ui_dir(resources.path()),
            Err(UiDirError::NoIndexHtml(dist.clone()))
        );
        // A folder named index.html isn't the page.
        fs::create_dir(dist.join("index.html")).unwrap();
        assert_eq!(ui_dir(resources.path()), Err(UiDirError::NoIndexHtml(dist)));
    }

    #[test]
    fn an_index_html_outside_dist_does_not_count() {
        // At the root of the resource folder, or in a dist folder one level
        // down: only <resource folder>/dist/index.html is the UI.
        let resources = folder_with(&["index.html", "lib/dist/index.html"]);
        assert_eq!(
            ui_dir(resources.path()),
            Err(UiDirError::NoIndexHtml(resources.path().join("dist")))
        );
    }

    #[test]
    fn a_relative_resource_folder_is_refused() {
        // It would be resolved against the working directory.
        for relative in ["", ".", "resources", "../lib/Fleetify"] {
            assert!(
                matches!(
                    ui_dir(Path::new(relative)),
                    Err(UiDirError::NoResourceDir(_))
                ),
                "{relative:?}: {:?}",
                ui_dir(Path::new(relative))
            );
        }
    }

    /// Set in the child process [`the_working_directory_is_never_consulted`]
    /// starts: the resource folder the child checks.
    const PROBE_RESOURCE_DIR: &str = "FLEETIFY_TEST_UI_FILES_RESOURCE_DIR";

    #[test]
    fn the_working_directory_is_never_consulted() {
        // The working directory is the whole process's, and tests run on
        // parallel threads: the check runs in a child process of this test
        // binary, started in that directory and running this test alone.
        if let Some(resources) = std::env::var_os(PROBE_RESOURCE_DIR) {
            // The child. Its working directory has dist/index.html; the
            // resource folder doesn't.
            assert!(
                Path::new("dist/index.html").is_file(),
                "the launch directory has the UI files"
            );
            let resources = Path::new(&resources);
            assert_eq!(
                ui_dir(resources),
                Err(UiDirError::NoIndexHtml(resources.join("dist")))
            );
            return;
        }
        // Launched from a directory with a dist folder (a cloned repository,
        // say), from an install without its UI files.
        let launch_dir = folder_with(&["dist/index.html", "dist/assets/evil.js"]);
        let resources = folder_with(&[]);
        let (_crate, module) = module_path!().split_once("::").unwrap();
        let this_test = format!("{module}::the_working_directory_is_never_consulted");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([this_test.as_str(), "--exact", "--test-threads=1"])
            .env(PROBE_RESOURCE_DIR, resources.path())
            .current_dir(launch_dir.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("1 passed"), "the child ran it: {stdout}");
    }

    #[test]
    fn a_debug_build_serves_no_ui_and_never_asks_for_the_resource_folder() {
        assert_eq!(
            served_ui_dir(false, || panic!("a debug build loads the UI from Vite")),
            Ok(None)
        );
    }

    #[test]
    fn a_release_build_serves_the_ui_from_the_resource_folder() {
        let resources = folder_with(&["dist/index.html"]);
        let dir = resources.path().to_path_buf();
        assert_eq!(
            served_ui_dir(true, || Ok(dir)),
            Ok(Some(resources.path().join("dist")))
        );
    }

    #[test]
    fn a_release_build_without_its_ui_files_has_nothing_to_serve() {
        let resources = folder_with(&[]);
        let dir = resources.path().to_path_buf();
        assert_eq!(
            served_ui_dir(true, || Ok(dir)),
            Err(UiDirError::NoIndexHtml(resources.path().join("dist")))
        );
        assert!(matches!(
            served_ui_dir(true, || Err(tauri::Error::UnknownPath)),
            Err(UiDirError::NoResourceDir(_))
        ));
    }

    #[test]
    fn the_error_says_which_folder_or_why_there_is_none() {
        let dir = Path::new("/usr/lib/Fleetify/dist");
        assert_eq!(
            UiDirError::NoIndexHtml(dir.to_path_buf()).to_string(),
            format!("{} has no index.html", dir.display())
        );
        assert_eq!(
            UiDirError::NoResourceDir("unknown path".into()).to_string(),
            "the install's resource folder is unknown: unknown path"
        );
    }

    // ── The bundle ──

    /// The app's `tauri.conf.json`.
    fn tauri_conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap()
    }

    #[test]
    fn the_bundle_ships_the_built_ui_as_dist() {
        // The map form, source → target: a directory source keeps its
        // structure under the target, so the frontend build's dist/index.html
        // lands at <resource folder>/dist/index.html. The list form would
        // put `../dist` under `_up_/dist` instead.
        let config = tauri_conf();
        let resources = &config["bundle"]["resources"];
        assert!(
            resources.is_object(),
            "bundle.resources must be a source → target map: {resources}"
        );
        assert_eq!(
            resources["../dist"], UI_DIR,
            "bundle.resources must map ../dist to {UI_DIR}: {resources}"
        );
    }

    #[test]
    fn the_bundled_folder_is_the_one_the_frontend_build_fills() {
        // `tauri build` runs beforeBuildCommand, the frontend build among
        // it, before it compiles and bundles; Vite writes dist/ at the repo
        // root, `../dist` from src-tauri, which frontendDist names too.
        let config = tauri_conf();
        assert_eq!(
            config["build"]["frontendDist"], "../dist",
            "bundle.resources ships ../dist: the frontend build's output, \
             which frontendDist names"
        );
        let before_build = config["build"]["beforeBuildCommand"].as_str().unwrap();
        assert!(
            before_build
                .split("&&")
                .any(|command| command.trim() == "npm run build"),
            "beforeBuildCommand must run the frontend build: {before_build}"
        );
    }
}
