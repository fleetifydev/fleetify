//! Electron main-process equivalents. Phase 1b lands auth and auth IPC; the
//! remaining ~51 IPC commands (fs/git/pty/github/…) follow in Phase 1c+.

pub mod ai_git;
pub mod auth;
pub mod backend_ready;
pub mod config;
pub mod feedback;
pub mod git;
pub mod git_host;
pub mod github_link;
pub mod github_pr;
pub mod head_watcher;
pub mod integrations_cache;
pub mod ipc;
pub mod logging;
pub mod migration;
pub mod providers_link;
pub mod providers_setup;
pub mod pty;
pub mod routers_link;
pub mod routing_setup;
pub mod startup_window;
pub mod ui_files;
pub mod voice;

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Every file under `dir`, however deep.
    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).expect("read a source directory") {
                let path = entry.expect("read a directory entry").path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    files.push(path);
                }
            }
        }
        files
    }

    // The renderer gets the access token over IPC and the telemetry client
    // gets it in-process, so the app serves it on no port of its own. The
    // needles are put together at run time: the walk reads this file too,
    // and must not find them in it.
    #[test]
    fn no_local_token_server() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let needles = [["87", "70"].concat(), ["bearer", "::"].concat()];
        let files = files_under(&src);
        assert!(
            files.iter().any(|f| f.ends_with(file!())),
            "the walk of {} never reached {}",
            src.display(),
            file!()
        );
        let mut hits = Vec::new();
        for file in &files {
            let bytes = std::fs::read(file).expect("read a source file");
            let text = String::from_utf8_lossy(&bytes);
            for needle in &needles {
                if text.contains(needle.as_str()) {
                    hits.push(format!("{} contains {needle:?}", file.display()));
                }
            }
        }
        assert!(hits.is_empty(), "{hits:#?}");
    }

    // get_webview_window finds a window only while every webview in it has
    // the window's label. The main window has none of that kind while the
    // Browser panel's child webview is attached, so the app looks a window
    // up with get_window and a webview with get_webview. The needle is put
    // together at run time, so the walk doesn't find it in this file.
    #[test]
    fn no_lookup_needs_a_window_with_a_single_webview() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let needle = format!("{}(", ["get", "webview", "window"].join("_"));
        let files = files_under(&src);
        assert!(
            files.iter().any(|f| f.ends_with(file!())),
            "the walk of {} never reached {}",
            src.display(),
            file!()
        );
        let hits: Vec<String> = files
            .iter()
            .filter(|file| file.is_file())
            .filter(|file| {
                let bytes = std::fs::read(file).expect("read a source file");
                String::from_utf8_lossy(&bytes).contains(&needle)
            })
            .map(|file| file.display().to_string())
            .collect();
        assert!(hits.is_empty(), "{hits:#?} call {needle}");
    }
}
