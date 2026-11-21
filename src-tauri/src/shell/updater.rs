//! In-app updates, run by the shell.
//!
//! A release build looks for a newer version [`FIRST_CHECK_DELAY`] after it
//! starts and then every [`CHECK_INTERVAL`], while automatic updates are on
//! (`updatesAuto` in `fleet.config.json`, see [`auto_updates_enabled`]). The
//! renderer can ask for a check at any time (`updater_check`). A newer
//! version downloads in the background, and the plugin checks its signature
//! against the release key (`plugins.updater.pubkey` in `tauri.conf.json`).
//! It installs only when the user picks Restart to update
//! (`updater_restart`). Debug builds never check.
//!
//! Every status change goes to the renderer as [`UPDATE_EVENT`], and
//! `updater_status` answers with the current one. `tauri-plugin-updater` makes
//! the requests, checks the signature and installs; the renderer can't call
//! its own commands, as no capability grants them.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The event every status change goes out as, with the [`UpdateStatus`].
pub const UPDATE_EVENT: &str = "fleet:updater-status";
/// How long after launch the first check runs.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
/// How long after one check the next one runs.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a request to an update endpoint may take. A request that hangs
/// then fails, and the check asks the next endpoint.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a download may go without receiving data before it fails. Each
/// read starts the wait again, so a slow download still finishes.
pub const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Download progress goes out at most this often: four times a second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// What the renderer shows when a check, a download or an install fails. The
/// details go to the log.
const CHECK_FAILED: &str = "Couldn't check for updates.";
const DOWNLOAD_FAILED: &str = "Couldn't download the update.";
const INSTALL_FAILED: &str = "Couldn't install the update.";
/// `updater_restart`'s error when no update has downloaded.
const NO_READY_UPDATE: &str = "no update is ready";

/// The target of the updater's log lines.
const LOG_TARGET: &str = "fleetify.updater";

/// Where the updater is, as the renderer gets it: `{"state":"ready",
/// "version":"0.2.1"}` and so on.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateStatus {
    /// A debug build, which never checks.
    Disabled,
    /// No check has run yet.
    Idle,
    /// A check is asking the update endpoints.
    Checking,
    /// The last check found no newer version.
    UpToDate,
    /// `version` is downloading: `downloaded` bytes so far, of `total` when
    /// the server gives a size.
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// `version` has downloaded and its signature checks out. It installs on
    /// Restart to update.
    Ready { version: String },
    /// `version` is installing, and the app restarts once it has.
    Installing { version: String },
    /// The last check, download or install failed; `message` says which.
    Failed { message: String },
}

/// Whether automatic updates are on in `cfg`, the saved `fleet.config.json`:
/// they are unless `updatesAuto` is `false`. Without a value, or with one
/// that isn't a bool, they are on, as Settings shows them.
pub fn auto_updates_enabled(cfg: &serde_json::Value) -> bool {
    cfg.get("updatesAuto")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// The updater's state, which the app manages: the status, and the update
/// that has downloaded, once one has.
pub struct UpdaterState {
    status: Mutex<UpdateStatus>,
    /// Kept once a download has verified, taken by `updater_restart`.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

impl UpdaterState {
    /// A release build starts [`UpdateStatus::Idle`]. Any other build stays
    /// [`UpdateStatus::Disabled`] for as long as it runs.
    pub fn new(release_build: bool) -> Self {
        let status = if release_build {
            UpdateStatus::Idle
        } else {
            UpdateStatus::Disabled
        };
        Self {
            status: Mutex::new(status),
            ready: Mutex::new(None),
        }
    }

    /// The current status.
    pub fn status(&self) -> UpdateStatus {
        lock(&self.status).clone()
    }

    /// Starts a check, and the status becomes [`UpdateStatus::Checking`].
    /// False when a check can't start: in a debug build, while one checks or
    /// downloads, and once an update is ready or installing. It tests and
    /// sets the status under one lock, so of callers racing, only one starts
    /// a check.
    pub(crate) fn try_begin_check(&self) -> bool {
        let mut status = lock(&self.status);
        let can_start = match *status {
            UpdateStatus::Idle | UpdateStatus::UpToDate | UpdateStatus::Failed { .. } => true,
            UpdateStatus::Disabled
            | UpdateStatus::Checking
            | UpdateStatus::Downloading { .. }
            | UpdateStatus::Ready { .. }
            | UpdateStatus::Installing { .. } => false,
        };
        if can_start {
            *status = UpdateStatus::Checking;
        }
        can_start
    }

    /// Makes `status` the current status, and returns the status as it now
    /// is: a disabled updater stays [`UpdateStatus::Disabled`].
    fn set(&self, status: UpdateStatus) -> UpdateStatus {
        let mut current = lock(&self.status);
        if *current != UpdateStatus::Disabled {
            *current = status;
        }
        current.clone()
    }

    /// Keeps `update`, downloaded and verified as `bytes`, for
    /// `updater_restart`.
    fn keep_ready(&self, update: Update, bytes: Vec<u8>) {
        *lock(&self.ready) = Some((update, bytes));
    }

    /// Takes the update that is ready to install, as [`ready_update`] does.
    pub(crate) fn take_ready(&self) -> Result<(Update, Vec<u8>), String> {
        ready_update(&mut lock(&self.ready))
    }
}

/// Takes the update that `ready` holds. With none, it's an error, and
/// nothing changes.
fn ready_update<T>(ready: &mut Option<T>) -> Result<T, String> {
    ready.take().ok_or_else(|| NO_READY_UPDATE.to_string())
}

/// Locks `mutex`. A thread that panicked while holding the lock left a whole
/// value behind: every holder either reads the value or replaces it whole.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts the automatic checks: the first [`FIRST_CHECK_DELAY`] after launch,
/// then one every [`CHECK_INTERVAL`], each only while automatic updates are
/// on in the saved config. A disabled updater (a debug build) starts
/// nothing. [`UpdaterState`] must be managed first.
pub fn spawn_auto_updates(app: AppHandle) {
    let enabled = app
        .try_state::<UpdaterState>()
        .is_some_and(|state| state.status() != UpdateStatus::Disabled);
    if !enabled {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if auto_updates_enabled(&saved_config(&app)) {
                check_and_download(&app, &app.state::<UpdaterState>()).await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// The saved `fleet.config.json`, or `{}` when the app data folder is
/// unknown.
fn saved_config(app: &AppHandle) -> serde_json::Value {
    app.path()
        .app_data_dir()
        .map(|dir| crate::shell::config::load_config_from(&dir))
        .unwrap_or_else(|_| serde_json::json!({}))
}

/// The updater's status, for the renderer as it loads.
#[tauri::command]
pub async fn updater_status(state: tauri::State<'_, UpdaterState>) -> Result<UpdateStatus, String> {
    Ok(state.status())
}

/// Checks for an update now (Check now in Settings), whether automatic
/// updates are on or not. Answers with the status the check ends on, which
/// is [`UpdateStatus::Ready`] once a newer version has downloaded. When a
/// check can't start, it answers with the status as it is.
#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: tauri::State<'_, UpdaterState>,
) -> Result<UpdateStatus, String> {
    Ok(check_and_download(&app, &state).await)
}

/// Installs the update that is ready, then restarts the app into it (Restart
/// to update). On Windows the plugin starts the installer and exits, and the
/// installer starts the new version. Without a ready update it's an error,
/// and the status stays as it is.
#[tauri::command]
pub async fn updater_restart(
    app: AppHandle,
    state: tauri::State<'_, UpdaterState>,
) -> Result<(), String> {
    let (update, bytes) = state.take_ready()?;
    publish(
        &app,
        &state,
        UpdateStatus::Installing {
            version: update.version.clone(),
        },
    );
    // Off the async runtime: the install writes files, and on Linux and
    // macOS it may wait for the user to authenticate.
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    let error = match installed {
        Ok(Ok(())) => {
            // Exits through the event loop, as quitting does, and starts the
            // new version. `restart()` would do the same here, then park
            // this runtime thread until the process ends.
            app.request_restart();
            return Ok(());
        }
        Ok(Err(error)) => error.to_string(),
        Err(error) => error.to_string(),
    };
    tracing::warn!(target: LOG_TARGET, error = %error, "update install failed");
    publish(
        &app,
        &state,
        UpdateStatus::Failed {
            message: INSTALL_FAILED.into(),
        },
    );
    Err(INSTALL_FAILED.into())
}

/// Runs one check: asks the update endpoints for a newer version and, when
/// there is one, downloads it and keeps it ready to install. Returns the
/// status it ends on. When a check can't start, it returns the status as it
/// is.
async fn check_and_download(app: &AppHandle, state: &UpdaterState) -> UpdateStatus {
    if !state.try_begin_check() {
        return state.status();
    }
    publish(app, state, UpdateStatus::Checking);
    let update = match find_update(app).await {
        Ok(Some(update)) => update,
        Ok(None) => return publish(app, state, UpdateStatus::UpToDate),
        Err(error) => {
            tracing::warn!(target: LOG_TARGET, error = %error, "update check failed");
            return publish(
                app,
                state,
                UpdateStatus::Failed {
                    message: CHECK_FAILED.into(),
                },
            );
        }
    };
    let version = update.version.clone();
    publish(
        app,
        state,
        UpdateStatus::Downloading {
            version: version.clone(),
            downloaded: 0,
            total: None,
        },
    );
    let mut throttle = Throttle::new(Instant::now());
    let mut downloaded: u64 = 0;
    // The plugin checks the signature before it returns the bytes.
    let download = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if throttle.ready(Instant::now()) {
                    publish(
                        app,
                        state,
                        UpdateStatus::Downloading {
                            version: version.clone(),
                            downloaded,
                            total,
                        },
                    );
                }
            },
            || {},
        )
        .await;
    match download {
        Ok(bytes) => {
            tracing::info!(target: LOG_TARGET, version = %version, "update ready");
            state.keep_ready(update, bytes);
            publish(app, state, UpdateStatus::Ready { version })
        }
        Err(error) => {
            tracing::warn!(target: LOG_TARGET, error = %error, "update download failed");
            publish(
                app,
                state,
                UpdateStatus::Failed {
                    message: DOWNLOAD_FAILED.into(),
                },
            )
        }
    }
}

/// Asks the update endpoints, in order, for a version newer than this one.
/// The update it returns downloads with the same client settings: no
/// overall time limit, but [`DOWNLOAD_IDLE_TIMEOUT`] between reads.
async fn find_update(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater_builder()
        .timeout(REQUEST_TIMEOUT)
        .configure_client(|client| client.read_timeout(DOWNLOAD_IDLE_TIMEOUT))
        .build()?
        .check()
        .await
}

/// Makes `status` the current status and sends it to the renderer. Returns
/// the status as it now is.
fn publish(app: &AppHandle, state: &UpdaterState, status: UpdateStatus) -> UpdateStatus {
    let status = state.set(status);
    let _ = app.emit(UPDATE_EVENT, &status);
    status
}

/// Spaces download progress updates at least [`PROGRESS_INTERVAL`] apart.
struct Throttle {
    last_sent: Instant,
}

impl Throttle {
    /// A throttle whose last update went out at `sent`.
    fn new(sent: Instant) -> Self {
        Self { last_sent: sent }
    }

    /// Whether an update may go out at `now`. If it may, it counts as sent.
    fn ready(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.last_sent) < PROGRESS_INTERVAL {
            return false;
        }
        self.last_sent = now;
        true
    }
}

/// CA certificate bundles, in the order they are looked for.
#[cfg(target_os = "linux")]
const CA_BUNDLES: &[&str] = &[
    "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Arch
    "/etc/pki/tls/certs/ca-bundle.crt",   // Fedora, RHEL
    "/etc/ssl/ca-bundle.pem",             // openSUSE
    "/etc/pki/tls/cacert.pem",            // OpenELEC
    "/etc/ssl/cert.pem",                  // Alpine and others
];

/// CA certificate directories, in the order they are looked for.
#[cfg(target_os = "linux")]
const CA_DIRS: &[&str] = &["/etc/ssl/certs", "/etc/pki/tls/certs"];

/// Points `SSL_CERT_FILE` and `SSL_CERT_DIR` at this system's CA
/// certificates, each only if it is unset ([`cert_env_to_set`]).
///
/// When the two are unset, the updater plugin sets them to Debian's paths on
/// each update check, and every process the app starts after that (agents,
/// git) inherits them. Fedora, RHEL and openSUSE keep their certificates
/// elsewhere, so TLS can fail in those processes. Once they hold this
/// system's paths, the plugin leaves them as they are.
///
/// Call it before the app starts any thread: setting a variable while
/// another thread reads the environment is a data race.
#[cfg(target_os = "linux")]
pub fn set_system_cert_env() {
    let to_set = cert_env_to_set(
        std::env::var_os("SSL_CERT_FILE").as_deref(),
        std::env::var_os("SSL_CERT_DIR").as_deref(),
        |path| std::path::Path::new(path).exists(),
    );
    for (name, value) in to_set {
        // Sound: run() calls this first, while its thread is the only one.
        std::env::set_var(name, value);
    }
}

/// The certificate variables to set, with their values: `SSL_CERT_FILE` to
/// the first of [`CA_BUNDLES`] that `exists`, and `SSL_CERT_DIR` to the first
/// of [`CA_DIRS`]. A variable that is set already (`current_file`,
/// `current_dir`), even to an empty value, stays as it is, and so does one
/// with no candidate on this system.
#[cfg(target_os = "linux")]
fn cert_env_to_set(
    current_file: Option<&std::ffi::OsStr>,
    current_dir: Option<&std::ffi::OsStr>,
    exists: impl Fn(&str) -> bool,
) -> Vec<(&'static str, &'static str)> {
    let mut to_set = Vec::new();
    if current_file.is_none() {
        if let Some(bundle) = first_existing(CA_BUNDLES, &exists) {
            to_set.push(("SSL_CERT_FILE", bundle));
        }
    }
    if current_dir.is_none() {
        if let Some(dir) = first_existing(CA_DIRS, &exists) {
            to_set.push(("SSL_CERT_DIR", dir));
        }
    }
    to_set
}

/// The first of `candidates` that `exists`.
#[cfg(target_os = "linux")]
fn first_existing<'a>(candidates: &[&'a str], exists: impl Fn(&str) -> bool) -> Option<&'a str> {
    candidates
        .iter()
        .copied()
        .find(|candidate| exists(candidate))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::{Duration, Instant};

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde_json::{json, Value};

    use super::*;

    /// `plugins.updater` in the app's `tauri.conf.json`: what a release
    /// build updates with.
    fn shipped_updater_config() -> Value {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        config["plugins"]["updater"].clone()
    }

    /// [`shipped_updater_config`], read the way the plugin reads it when the
    /// app starts.
    fn plugin_config() -> tauri_plugin_updater::Config {
        serde_json::from_value(shipped_updater_config())
            .expect("the updater plugin can read plugins.updater")
    }

    /// The versions of `package` that Cargo.lock (`lock`) holds.
    fn locked_versions<'a>(lock: &'a str, package: &str) -> Vec<&'a str> {
        let name = format!("name = \"{package}\"");
        lock.split("[[package]]")
            .filter(|block| block.lines().any(|line| line == name))
            .filter_map(|block| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
            })
            .collect()
    }

    fn downloading(downloaded: u64, total: Option<u64>) -> UpdateStatus {
        UpdateStatus::Downloading {
            version: "0.2.1".into(),
            downloaded,
            total,
        }
    }

    #[test]
    fn status_serialises_for_the_renderer() {
        let version = || "0.2.1".to_string();
        let cases = [
            (UpdateStatus::Disabled, r#"{"state":"disabled"}"#),
            (UpdateStatus::Idle, r#"{"state":"idle"}"#),
            (UpdateStatus::Checking, r#"{"state":"checking"}"#),
            (UpdateStatus::UpToDate, r#"{"state":"upToDate"}"#),
            (
                downloading(5, Some(10)),
                r#"{"state":"downloading","version":"0.2.1","downloaded":5,"total":10}"#,
            ),
            (
                downloading(5, None),
                r#"{"state":"downloading","version":"0.2.1","downloaded":5,"total":null}"#,
            ),
            (
                UpdateStatus::Ready { version: version() },
                r#"{"state":"ready","version":"0.2.1"}"#,
            ),
            (
                UpdateStatus::Installing { version: version() },
                r#"{"state":"installing","version":"0.2.1"}"#,
            ),
            (
                UpdateStatus::Failed {
                    message: "x".into(),
                },
                r#"{"state":"failed","message":"x"}"#,
            ),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
        }
    }

    #[test]
    fn auto_updates_default_on_and_respect_an_explicit_false() {
        assert!(auto_updates_enabled(&json!({})));
        assert!(auto_updates_enabled(&json!({ "updatesAuto": true })));
        assert!(!auto_updates_enabled(&json!({ "updatesAuto": false })));
        // Anything but a bool reads as the default.
        assert!(auto_updates_enabled(&json!({ "updatesAuto": "no" })));
        assert!(auto_updates_enabled(&json!({ "updatesAuto": null })));
    }

    #[test]
    fn only_one_check_runs_at_a_time() {
        let state = UpdaterState::new(true);
        assert_eq!(state.status(), UpdateStatus::Idle);
        assert!(state.try_begin_check(), "a check starts from idle");
        assert_eq!(state.status(), UpdateStatus::Checking);
        assert!(!state.try_begin_check(), "not while one checks");
        state.set(downloading(0, None));
        assert!(!state.try_begin_check(), "not while one downloads");
        state.set(UpdateStatus::UpToDate);
        assert!(state.try_begin_check(), "again once one found nothing");
        state.set(UpdateStatus::Failed {
            message: CHECK_FAILED.into(),
        });
        assert!(state.try_begin_check(), "again once one failed");
        state.set(UpdateStatus::Ready {
            version: "0.2.1".into(),
        });
        assert!(!state.try_begin_check(), "not once an update is ready");
        state.set(UpdateStatus::Installing {
            version: "0.2.1".into(),
        });
        assert!(!state.try_begin_check(), "not while one installs");

        // Callers racing from idle: exactly one of them starts a check.
        let state = UpdaterState::new(true);
        let start = std::sync::Barrier::new(8);
        let started = std::thread::scope(|scope| {
            let racers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        state.try_begin_check()
                    })
                })
                .collect();
            racers
                .into_iter()
                .map(|racer| racer.join().unwrap())
                .filter(|started| *started)
                .count()
        });
        assert_eq!(started, 1);
    }

    #[test]
    fn a_failed_check_allows_the_next_one() {
        assert_eq!(CHECK_FAILED, "Couldn't check for updates.");
        assert_eq!(DOWNLOAD_FAILED, "Couldn't download the update.");
        assert_eq!(INSTALL_FAILED, "Couldn't install the update.");
        let installing = UpdateStatus::Installing {
            version: "0.2.1".into(),
        };
        for (failed_while, message) in [
            (UpdateStatus::Checking, CHECK_FAILED),
            (downloading(5, Some(10)), DOWNLOAD_FAILED),
            (installing, INSTALL_FAILED),
        ] {
            let state = UpdaterState::new(true);
            state.set(failed_while);
            state.set(UpdateStatus::Failed {
                message: message.into(),
            });
            assert!(state.try_begin_check(), "no check after: {message}");
            assert_eq!(state.status(), UpdateStatus::Checking);
        }
    }

    #[test]
    fn debug_builds_never_check() {
        let state = UpdaterState::new(false);
        assert_eq!(state.status(), UpdateStatus::Disabled);
        assert!(!state.try_begin_check());
        // Off for good: no status change turns it on.
        for status in [
            UpdateStatus::Idle,
            UpdateStatus::UpToDate,
            UpdateStatus::Failed {
                message: "x".into(),
            },
        ] {
            assert_eq!(state.set(status), UpdateStatus::Disabled);
            assert!(!state.try_begin_check());
        }
        assert_eq!(state.status(), UpdateStatus::Disabled);
    }

    #[test]
    fn restart_needs_a_ready_update() {
        assert_eq!(
            ready_update::<()>(&mut None),
            Err("no update is ready".to_string())
        );
        // The update that is ready is taken once.
        let mut pending = Some(("0.2.1", vec![1u8, 2, 3]));
        assert_eq!(ready_update(&mut pending), Ok(("0.2.1", vec![1, 2, 3])));
        assert_eq!(
            ready_update(&mut pending),
            Err("no update is ready".to_string())
        );
        // The app's state with nothing downloaded: an error, and the status
        // stays as it was.
        let state = UpdaterState::new(true);
        assert_eq!(
            state.take_ready().err().as_deref(),
            Some("no update is ready")
        );
        assert_eq!(state.status(), UpdateStatus::Idle);
    }

    #[test]
    fn download_progress_goes_out_at_most_four_times_a_second() {
        let start = Instant::now();
        // The first progress update goes out as the download starts, then a
        // chunk arrives every millisecond for two seconds.
        let mut throttle = Throttle::new(start);
        let sent: Vec<u64> = (1..=2000u64)
            .filter(|ms| throttle.ready(start + Duration::from_millis(*ms)))
            .collect();
        assert_eq!(sent, [250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
    }

    #[test]
    fn the_updater_trusts_only_the_release_key() {
        // pubkey is a minisign public key file, base64-encoded. The file has
        // a comment line, then the key: "Ed", an 8-byte key id (little-endian)
        // and the 32-byte Ed25519 public key, base64-encoded.
        let config = shipped_updater_config();
        let pubkey = config["pubkey"]
            .as_str()
            .expect("tauri.conf.json sets plugins.updater.pubkey");
        let file = String::from_utf8(STANDARD.decode(pubkey).expect("pubkey is base64"))
            .expect("the key file is text");
        let lines: Vec<&str> = file.lines().collect();
        assert_eq!(lines.len(), 2, "{file}");
        let key = STANDARD.decode(lines[1]).expect("the key line is base64");
        assert_eq!(key.len(), 42);
        assert_eq!(&key[..2], b"Ed");
        let id = u64::from_le_bytes(key[2..10].try_into().unwrap());
        assert_eq!(format!("{id:016X}"), "44C694713A20D751");
        assert_eq!(
            lines[0],
            "untrusted comment: minisign public key: 44C694713A20D751"
        );
        assert_eq!(plugin_config().pubkey, pubkey);
    }

    #[test]
    fn the_updater_asks_fleetify_dev_then_github() {
        assert_eq!(
            shipped_updater_config()["endpoints"],
            json!([
                "https://fleetify.dev/api/desktop/update/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}",
                "https://github.com/fleetifydev/fleetify/releases/latest/download/latest.json",
            ])
        );
        assert_eq!(plugin_config().endpoints.len(), 2);
    }

    #[test]
    fn the_windows_update_installs_passively() {
        assert_eq!(
            shipped_updater_config()["windows"]["installMode"],
            json!("passive")
        );
        let windows = plugin_config()
            .windows
            .expect("plugins.updater has Windows settings");
        assert_eq!(windows.install_mode.to_string(), "passive");
    }

    #[test]
    fn the_shipped_config_never_allows_insecure_updates() {
        let config = shipped_updater_config();
        let settings = config
            .as_object()
            .expect("tauri.conf.json has plugins.updater");
        for key in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
        ] {
            assert_ne!(settings.get(key), Some(&json!(true)), "{key} is on");
        }
        // As the plugin reads them, which also covers their kebab-case names.
        let config = plugin_config();
        assert!(!config.dangerous_insecure_transport_protocol);
        assert!(!config.dangerous_accept_invalid_certs);
        assert!(!config.dangerous_accept_invalid_hostnames);
    }

    #[test]
    fn the_updater_plugin_matches_tauri_2_11() {
        // tauri-plugin-updater 2.13 and later need tauri 2.12. Cargo would
        // then leave out the vendored tauri-runtime-wry (2.11.2) with only a
        // warning.
        let lock =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.lock"))
                .expect("read the workspace's Cargo.lock");
        let versions = locked_versions(&lock, "tauri-plugin-updater");
        assert_eq!(versions.len(), 1, "{versions:?}");
        assert!(versions[0].starts_with("2.12."), "{}", versions[0]);
    }

    #[test]
    fn the_request_timeout_is_twenty_seconds() {
        // A request to fleetify.dev that hangs gives up after this, and the
        // check moves on to GitHub.
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(20));
    }

    #[test]
    fn a_stalled_download_gives_up_after_a_minute_of_silence() {
        // Each read may wait this long. The wait starts again after every
        // read, so a slow download still finishes.
        assert_eq!(DOWNLOAD_IDLE_TIMEOUT, Duration::from_secs(60));
        // find_update gives it to the plugin's client before the check, and
        // the update the check returns keeps it for the download. Read from
        // this file above its tests, with whitespace removed.
        let source = include_str!("updater.rs").replace("\r\n", "\n");
        let tests = source
            .find(&format!("#[cfg(test)]\nmod {} {{", "tests"))
            .expect("updater.rs has this test module");
        let code: String = source[..tests].split_whitespace().collect();
        let start = code
            .find(&format!("asyncfn{}(", "find_update"))
            .expect("updater.rs has find_update");
        let check = start + code[start..].find(".check()").expect("find_update checks");
        assert!(
            code[start..check].contains(&format!(
                ".configure_client(|client|client.read_timeout({}))",
                "DOWNLOAD_IDLE_TIMEOUT"
            )),
            "find_update must give the plugin's client the download idle timeout"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn certificate_paths_are_looked_for_in_order() {
        assert_eq!(
            CA_BUNDLES,
            [
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/ssl/ca-bundle.pem",
                "/etc/pki/tls/cacert.pem",
                "/etc/ssl/cert.pem",
            ]
        );
        assert_eq!(CA_DIRS, ["/etc/ssl/certs", "/etc/pki/tls/certs"]);
        let candidates = ["/a", "/b", "/c"];
        assert_eq!(first_existing(&candidates, |_| true), Some("/a"));
        assert_eq!(first_existing(&candidates, |path| path != "/a"), Some("/b"));
        assert_eq!(first_existing(&candidates, |path| path == "/c"), Some("/c"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fedora_system_gets_its_pki_certificate_paths() {
        // Fedora and RHEL have no /etc/ssl/certs/ca-certificates.crt, the
        // file the updater plugin would set.
        let fedora = ["/etc/pki/tls/certs/ca-bundle.crt", "/etc/pki/tls/certs"];
        assert_eq!(
            cert_env_to_set(None, None, |path| fedora.contains(&path)),
            [
                ("SSL_CERT_FILE", "/etc/pki/tls/certs/ca-bundle.crt"),
                ("SSL_CERT_DIR", "/etc/pki/tls/certs"),
            ]
        );
        let opensuse = ["/etc/ssl/ca-bundle.pem", "/etc/ssl/certs"];
        assert_eq!(
            cert_env_to_set(None, None, |path| opensuse.contains(&path)),
            [
                ("SSL_CERT_FILE", "/etc/ssl/ca-bundle.pem"),
                ("SSL_CERT_DIR", "/etc/ssl/certs"),
            ]
        );
        // Debian and Ubuntu get the paths the plugin would set.
        let debian = ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs"];
        assert_eq!(
            cert_env_to_set(None, None, |path| debian.contains(&path)),
            [
                ("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"),
                ("SSL_CERT_DIR", "/etc/ssl/certs"),
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn with_no_certificates_found_nothing_is_set() {
        assert_eq!(first_existing(CA_BUNDLES, |_| false), None);
        assert_eq!(first_existing(CA_DIRS, |_| false), None);
        let to_set = cert_env_to_set(None, None, |_| false);
        assert!(to_set.is_empty(), "{to_set:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_certificate_variable_already_set_is_never_overwritten() {
        let everything = |_: &str| true;
        let mine = std::ffi::OsStr::new("/home/me/company-ca.pem");
        assert_eq!(
            cert_env_to_set(Some(mine), None, everything),
            [("SSL_CERT_DIR", "/etc/ssl/certs")]
        );
        assert_eq!(
            cert_env_to_set(None, Some(mine), everything),
            [("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt")]
        );
        // An empty value counts as set, as it does for the plugin.
        let empty = std::ffi::OsStr::new("");
        let to_set = cert_env_to_set(Some(empty), Some(mine), everything);
        assert!(to_set.is_empty(), "{to_set:?}");
    }
}
