//! Persisted app config — backs `window.electronAPI.getConfig` /
//! `setConfig`. Faithful in spirit to the Electron `electron-store`-style
//! JSON-on-disk used by the original.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CONFIG_FILE: &str = "fleet.config.json";

/// What [`load_config_with_status`] found at `fleet.config.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigLoad {
    /// There is no file: a fresh install, or a reset one.
    Missing,
    /// The file parsed to a JSON object.
    Ok,
    /// The file was read but isn't a JSON object; a copy was kept.
    Corrupt,
    /// The file is there but couldn't be read.
    Unreadable,
}

/// Load JSON config; `{}` when the file doesn't exist (parity with the
/// Electron store's "no file = empty object") or can't be read. One leading
/// UTF-8 BOM, which some Windows editors write, is ignored.
///
/// A file that reads but isn't a JSON object (a hand edit with a stray
/// comma, say) also gives `{}`, after a copy of the bytes read is kept as
/// `fleet.config.json.corrupt-<content hash>`. Every setter reads, merges
/// and writes the whole file, so the next save replaces it and would
/// otherwise silently drop every other setting. The file itself is never
/// touched here: by now it may hold something other than what was read.
///
/// [`load_config_with_status`] also says which of these it found.
pub fn load_config_from(path: &Path) -> Value {
    load_config_with_status(path).0
}

/// [`load_config_from`], plus what it found. Both a missing file and a
/// broken one load as `{}`; a caller for which they must differ reads the
/// status.
pub fn load_config_with_status(path: &Path) -> (Value, ConfigLoad) {
    let file = path.join(CONFIG_FILE);
    // Bytes, not a String: a file that isn't UTF-8 isn't JSON either, and
    // must be kept like any other corrupt config.
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (json!({}), ConfigLoad::Missing)
        }
        Err(e) => {
            tracing::warn!(error = %e, "couldn't read {CONFIG_FILE}; using defaults");
            return (json!({}), ConfigLoad::Unreadable);
        }
    };
    let content = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let problem = match serde_json::from_slice::<Value>(content) {
        Ok(cfg @ Value::Object(_)) => return (cfg, ConfigLoad::Ok),
        Ok(_) => "not a JSON object".to_string(),
        // A position and a fixed message, never the file's text.
        Err(e) => e.to_string(),
    };
    back_up_corrupt_config(path, &bytes, &problem);
    (json!({}), ConfigLoad::Corrupt)
}

/// Keep `bytes`, read from a corrupt config, in `dir` as
/// `fleet.config.json.corrupt-<first 16 hex characters of their SHA-256>`.
/// Named by content, so loading the same bytes again finds the copy already
/// kept and stays quiet, and no other copy is ever overwritten. Logs the
/// backup's file name only: not the folder (its path usually holds the
/// user's name), and never the content.
fn back_up_corrupt_config(dir: &Path, bytes: &[u8], problem: &str) {
    let hash: String = Sha256::digest(bytes)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let name = format!("{CONFIG_FILE}.corrupt-{hash}");
    let backup = dir.join(&name);
    let written = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
    {
        Ok(mut out) => {
            let wrote = out.write_all(bytes);
            drop(out);
            if wrote.is_err() {
                // A partial copy would pass for a kept one at the next load.
                let _ = std::fs::remove_file(&backup);
            }
            wrote
        }
        // These exact bytes are already kept.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return,
        Err(e) => Err(e),
    };
    match written {
        Ok(()) => tracing::warn!(
            problem = %problem,
            backup = %name,
            "{CONFIG_FILE} isn't a JSON object; kept a copy and used defaults"
        ),
        Err(error) => tracing::warn!(
            problem = %problem,
            error = %error,
            "{CONFIG_FILE} isn't a JSON object and no copy could be kept; used defaults"
        ),
    }
}

/// Milliseconds since the Unix epoch, or 0 when the clock is set before it.
fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Numbers this process's config temp files. With the pid in the name too,
/// no two saves share a temp file, even across processes sharing the folder.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Held around each save's write and rename. The privacy setters and the
/// renderer's `config_set` can save at the same time; one at a time, the
/// last rename wins whole.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Save JSON config atomically: fill a temp file of this save's own
/// (`fleet.config.json.<pid>.<n>.tmp`), flush it to disk, then rename it over
/// the live file. A crash mid-save leaves the old file whole, and a save
/// never renames a temp file another save is still filling. A failed save
/// removes its temp file.
pub fn save_config_to(path: &Path, cfg: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    let file = path.join(CONFIG_FILE);
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.join(format!("{CONFIG_FILE}.{}.{n}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(cfg).unwrap_or_default();
    // A save that panicked while holding the lock left nothing half-done
    // that the next one depends on.
    let _guard = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let saved = write_synced(&tmp, body.as_bytes()).and_then(|()| std::fs::rename(&tmp, &file));
    if saved.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    saved
}

/// Write `bytes` to a new file at `path` and flush it to disk, so the rename
/// that follows can never publish an empty or partial file after a crash.
fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut out = std::fs::File::create(path)?;
    out.write_all(bytes)?;
    out.sync_all()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoutingConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_decision_router")]
    pub active_decision_router: String,
    #[serde(default = "default_proxy_gateway")]
    pub active_proxy_gateway: String,
    #[serde(default)]
    pub connected_routers: HashMap<String, ConnectedRouter>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConnectedRouter {
    pub connected: bool,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

fn default_decision_router() -> String {
    "builtin".into()
}
fn default_proxy_gateway() -> String {
    "none-proxy".into()
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_decision_router: default_decision_router(),
            active_proxy_gateway: default_proxy_gateway(),
            connected_routers: HashMap::new(),
        }
    }
}

/// Read the `"routing"` section from a config Value, defaulting when absent or invalid.
pub fn routing_from(cfg: &Value) -> RoutingConfig {
    cfg.get("routing")
        .and_then(|v| serde_json::from_value::<RoutingConfig>(v.clone()).ok())
        .unwrap_or_default()
}

/// Replace the `"routing"` section in a config Value.
pub fn routing_set(cfg: &mut Value, routing: &RoutingConfig) {
    let val = serde_json::to_value(routing).unwrap_or_else(|_| json!({}));
    match cfg {
        Value::Object(map) => {
            map.insert("routing".into(), val);
        }
        _ => {
            *cfg = json!({ "routing": val });
        }
    }
}

/// Per-user provider state — which API providers the user has connected,
/// which models from each provider are enabled in the picker, plus the
/// Ollama base URL and the active CLI-agent shortlist.
///
/// Secrets do NOT live here — they're in the OS keychain under
/// `Fleetify-Provider-<id>`. This struct only carries non-secret state
/// (booleans, model id lists, the Ollama URL, the enabled-agents list)
/// so it can be JSON-serialized into `fleet.config.json` without
/// surfacing a credential on disk.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProvidersConfig {
    /// provider_id → connected. `true` means a keychain entry exists and
    /// the renderer should show a green pill. Disconnect clears the entry
    /// here AND in the keychain so the two stay in sync.
    #[serde(default)]
    pub connected: HashMap<String, bool>,
    /// provider_id → list of model ids enabled in the chat composer's
    /// picker. Empty list ⇒ provider's `default_models` are all enabled.
    /// Phase 2 wires the Settings UI; Phase 3's picker reads from here.
    #[serde(default)]
    pub enabled_models: HashMap<String, Vec<String>>,
    /// Ollama base URL. `None` ⇒ falls back to `http://localhost:11434`.
    /// User can point this at a LAN box (`http://192.168.1.50:11434`) so
    /// the desktop client uses a beefier remote rig for inference.
    #[serde(default)]
    pub ollama_base_url: Option<String>,
    /// Active CLI agents — the shortlist shown in Settings → Agents'
    /// "Active" section + the New Agent dialog. Onboarding writes the
    /// user's first picks here; Settings reads + edits.
    #[serde(default)]
    pub enabled_agents: Vec<String>,
    /// Cloudflare account id for the `cloudflare-workers-ai` provider.
    /// Substituted into the account-scoped Workers AI base URL at dispatch
    /// (backend `cloudflare_base_url_from_cfg`). `None` ⇒ not connected; the
    /// renderer shows the "Connect" card. Not a secret (the token lives in
    /// the OS keychain), so it round-trips in `fleet.config.json`.
    #[serde(default)]
    pub cloudflare_account_id: Option<String>,
    /// Ollama Cloud base URL. `None` ⇒ falls back to `https://ollama.com`.
    /// Editable for forward-compat / self-hosted gateways. Not a secret (the
    /// key lives in the OS keychain), so it round-trips in fleet.config.json.
    #[serde(default)]
    pub ollama_cloud_base_url: Option<String>,
}

/// Read the `"providers"` section from a config Value. Defaults when
/// absent OR when the existing section is malformed (parity with
/// `routing_from`'s defensive parse).
pub fn providers_from(cfg: &Value) -> ProvidersConfig {
    cfg.get("providers")
        .and_then(|v| serde_json::from_value::<ProvidersConfig>(v.clone()).ok())
        .unwrap_or_default()
}

/// Replace the `"providers"` section in a config Value.
pub fn providers_set(cfg: &mut Value, providers: &ProvidersConfig) {
    let val = serde_json::to_value(providers).unwrap_or_else(|_| json!({}));
    match cfg {
        Value::Object(map) => {
            map.insert("providers".into(), val);
        }
        _ => {
            *cfg = json!({ "providers": val });
        }
    }
}

/// Whether the commits and pull requests the app makes credit Fleetify (a
/// `Co-Authored-By` trailer and a PR footer). Settings → General →
/// Attribution writes the flat `gitAttribution` key; absent or non-boolean
/// means on, the default.
pub fn git_attribution_from(cfg: &Value) -> bool {
    cfg.get("gitAttribution")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// The two telemetry switches, at `fleet.config.json::telemetry` (parallel
/// to `routing` / `providers`).
///
/// PostHog product analytics: default `posthog_enabled` is `false` —
/// flipped only by explicit user consent in the onboarding step or in
/// Settings → Privacy. `posthog_enabled_at` records the first opt-in
/// timestamp (Unix ms) so funnels can distinguish fresh consenters from
/// users who've been enabled for ages.
///
/// Fleetify cloud sync (the fleetify.dev dashboard): `cloud_sync_enabled`
/// is the saved switch — `None` until the user flips it; read it through
/// [`cloud_sync_from`], which also covers the legacy flag and the default
/// (on). `cloud_sync_enabled_at` records the first opt-in (Unix ms): the
/// first time sync is turned on from off.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct TelemetryConfig {
    #[serde(default)]
    pub posthog_enabled: bool,
    #[serde(default)]
    pub posthog_enabled_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_sync_enabled: Option<bool>,
    #[serde(default)]
    pub cloud_sync_enabled_at: Option<i64>,
}

/// Whether Fleetify cloud sync is on for a user who never flipped the
/// switch: on, disclosed at onboarding, and turned off in Settings →
/// Privacy. The owner's decision; nothing else may hard-code it.
pub const CLOUD_SYNC_DEFAULT: bool = true;

/// Whether Fleetify cloud sync is on. In order:
/// 1. `telemetry.cloud_sync_enabled`, when it is a bool;
/// 2. `false` when the legacy top-level `telemetryEnabled` is exactly
///    `false` — an explicit opt-out from the old switch still counts (its
///    `true` does not: that switch was never read and defaulted to on);
/// 3. [`CLOUD_SYNC_DEFAULT`].
pub fn cloud_sync_from(cfg: &Value) -> bool {
    if let Some(on) = cfg
        .get("telemetry")
        .and_then(|t| t.get("cloud_sync_enabled"))
        .and_then(Value::as_bool)
    {
        return on;
    }
    if cfg.get("telemetryEnabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    CLOUD_SYNC_DEFAULT
}

pub fn telemetry_from(cfg: &Value) -> TelemetryConfig {
    cfg.get("telemetry")
        .and_then(|v| serde_json::from_value::<TelemetryConfig>(v.clone()).ok())
        .unwrap_or_default()
}

/// Write `telem` into the `"telemetry"` section field by field, so keys the
/// struct doesn't know, or couldn't parse, survive: a malformed sibling
/// (which sends [`telemetry_from`] to its defaults) must not cost the user
/// their saved cloud sync choice. `None` fields are skipped; they neither
/// write `null` nor remove a saved value.
pub fn telemetry_set(cfg: &mut Value, telem: &TelemetryConfig) {
    let Ok(Value::Object(fields)) = serde_json::to_value(telem) else {
        return;
    };
    if !cfg.is_object() {
        *cfg = json!({});
    }
    let section = &mut cfg["telemetry"];
    if !section.is_object() {
        *section = json!({});
    }
    if let Some(section) = section.as_object_mut() {
        for (key, value) in fields {
            if !value.is_null() {
                section.insert(key, value);
            }
        }
    }
}

/// Save the Fleetify cloud sync switch in `dir`'s `fleet.config.json`:
/// read-merge-write `telemetry.cloud_sync_enabled`, stamping
/// `cloud_sync_enabled_at` on the first opt-in only (turning it off, or on
/// again later, keeps that time). Keeping sync on while it is on by default
/// saves the choice but is no opt-in, so it stamps nothing. `Err` carries a
/// message fit for the user.
pub fn persist_cloud_choice(dir: &Path, enabled: bool) -> Result<(), String> {
    let mut cfg = load_config_from(dir);
    let was_enabled = cloud_sync_from(&cfg);
    let mut telem = telemetry_from(&cfg);
    telem.cloud_sync_enabled = Some(enabled);
    if enabled && !was_enabled && telem.cloud_sync_enabled_at.is_none() {
        telem.cloud_sync_enabled_at = Some(unix_ms());
    }
    telemetry_set(&mut cfg, &telem);
    save_config_to(dir, &cfg).map_err(|e| format!("Couldn't save the cloud sync setting: {e}"))
}

/// Whether this launch may open the cloud sync gate, decided once at
/// startup from `dir`'s `fleet.config.json`: the saved choice
/// ([`cloud_sync_from`]) when the file loads, the default when there is no
/// file yet.
///
/// A file that is there but can't be read or parsed fails closed, since an
/// earlier opt-out may be what it no longer shows: sync stays off for this
/// launch, and an explicit opt-out is saved ([`persist_cloud_choice`]) so
/// later launches stay off too, until the user turns sync back on. If that
/// save fails, sync still stays off for this launch.
pub fn startup_cloud_decision(dir: &Path) -> bool {
    let (cfg, status) = load_config_with_status(dir);
    let condition = match status {
        ConfigLoad::Missing | ConfigLoad::Ok => return cloud_sync_from(&cfg),
        ConfigLoad::Corrupt => "corrupt",
        ConfigLoad::Unreadable => "unreadable",
    };
    // The condition only: never the file's content, nor its folder (whose
    // path usually holds the user's name).
    match persist_cloud_choice(dir, false) {
        Ok(()) => tracing::warn!(
            condition,
            "{CONFIG_FILE} is {condition}; cloud sync is off until it is turned back on"
        ),
        Err(error) => tracing::warn!(
            condition,
            error = %error,
            "{CONFIG_FILE} is {condition}; cloud sync stays off for this launch, \
             but turning it off couldn't be saved"
        ),
    }
    false
}

/// What `dir`'s `fleet.config.json` says about cloud sync now, for the end
/// of the startup restore: the saved choice when the file loads or isn't
/// there, and off when it is there but can't be read or parsed. Saves
/// nothing.
pub fn saved_cloud_choice(dir: &Path) -> bool {
    let (cfg, status) = load_config_with_status(dir);
    matches!(status, ConfigLoad::Missing | ConfigLoad::Ok) && cloud_sync_from(&cfg)
}

/// Save the PostHog product analytics switch in `dir`'s `fleet.config.json`:
/// read-merge-write `telemetry.posthog_enabled`, stamping
/// `posthog_enabled_at` on the first opt-in only (turning it off, or on
/// again later, keeps that time). `Err` carries a message fit for the user.
pub fn persist_posthog_choice(dir: &Path, enabled: bool) -> Result<(), String> {
    let mut cfg = load_config_from(dir);
    let mut telem = telemetry_from(&cfg);
    let was_enabled = telem.posthog_enabled;
    telem.posthog_enabled = enabled;
    if enabled && !was_enabled && telem.posthog_enabled_at.is_none() {
        telem.posthog_enabled_at = Some(unix_ms());
    }
    telemetry_set(&mut cfg, &telem);
    save_config_to(dir, &cfg)
        .map_err(|e| format!("Couldn't save the product analytics setting: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `fleet.config.json.corrupt-*` backups in `dir`. Each must be
    /// named by 16 lowercase hex characters (its content hash).
    fn corrupt_backups(dir: &Path) -> Vec<std::path::PathBuf> {
        let prefix = format!("{CONFIG_FILE}.corrupt-");
        let backups: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_str().unwrap();
                name.starts_with(&prefix)
            })
            .collect();
        for path in &backups {
            let name = path.file_name().unwrap().to_str().unwrap();
            let hash = &name[prefix.len()..];
            assert!(
                hash.len() == 16 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                "backup not named by 16 lowercase hex characters: {name}"
            );
        }
        backups
    }

    /// What `fleet.config.json` in `dir` holds now; `None` once it's gone.
    fn live_bytes(dir: &Path) -> Option<Vec<u8>> {
        std::fs::read(dir.join(CONFIG_FILE)).ok()
    }

    #[test]
    fn a_missing_file_loads_as_empty_without_a_backup() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert!(corrupt_backups(tmp.path()).is_empty());
    }

    #[test]
    fn roundtrip_save_then_load() {
        let tmp = tempfile::tempdir().unwrap();
        let v = json!({"theme":"dark","apiKeys":{"openai":"sk-test"}});
        save_config_to(tmp.path(), &v).unwrap();
        assert_eq!(load_config_from(tmp.path()), v);
    }

    /// Temp files left in `dir`.
    fn temp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    /// Reads `dir`'s live config over and over until stopped, as the app
    /// does on every load, and lists each read that found it torn. Unix
    /// only: there a rename replaces the file atomically even while a reader
    /// has it open. On Windows an open reader can make the rename itself
    /// fail, which is not what the test below asks.
    #[cfg(unix)]
    struct TornReader {
        done: std::sync::Arc<std::sync::atomic::AtomicBool>,
        reads: std::thread::JoinHandle<Vec<String>>,
    }

    #[cfg(unix)]
    impl TornReader {
        fn start(dir: std::sync::Arc<std::path::PathBuf>, filler_len: usize) -> Self {
            let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop = std::sync::Arc::clone(&done);
            let reads = std::thread::spawn(move || {
                let mut torn = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    let Ok(bytes) = std::fs::read(dir.join(CONFIG_FILE)) else {
                        torn.push("missing".to_string());
                        continue;
                    };
                    match serde_json::from_slice::<Value>(&bytes) {
                        Ok(cfg) if cfg["filler"].as_str().map(str::len) == Some(filler_len) => {}
                        _ => torn.push(format!("{} bytes", bytes.len())),
                    }
                }
                torn
            });
            Self { done, reads }
        }

        fn stop(self) -> Vec<String> {
            self.done.store(true, Ordering::Relaxed);
            self.reads.join().unwrap()
        }
    }

    #[test]
    fn concurrent_saves_all_succeed_and_the_live_file_always_parses() {
        use std::sync::Arc;

        // The privacy setters and the renderer's config_set can save at the
        // same time. Large enough that one write takes a while, so they
        // overlap.
        const FILLER: usize = 256 * 1024;
        let tmp = tempfile::tempdir().unwrap();
        let dir = Arc::new(tmp.path().to_path_buf());
        let filler = Arc::new("x".repeat(FILLER));
        save_config_to(&dir, &json!({ "writer": -1, "filler": *filler })).unwrap();

        #[cfg(unix)]
        let reader = TornReader::start(Arc::clone(&dir), FILLER);

        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let (dir, filler) = (Arc::clone(&dir), Arc::clone(&filler));
                std::thread::spawn(move || {
                    (0..12)
                        .map(|i| {
                            save_config_to(
                                &dir,
                                &json!({ "writer": writer, "i": i, "filler": *filler }),
                            )
                            .map_err(|e| e.to_string())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let failed: Vec<String> = writers
            .into_iter()
            .flat_map(|w| w.join().unwrap())
            .filter_map(Result::err)
            .collect();
        #[cfg(unix)]
        let torn = reader.stop();

        assert!(failed.is_empty(), "saves that failed: {failed:?}");
        #[cfg(unix)]
        assert!(torn.is_empty(), "reads of a torn live file: {torn:?}");
        let cfg = load_config_from(&dir);
        assert_eq!(cfg["filler"].as_str().map(str::len), Some(FILLER));
        assert!(temp_files(&dir).is_empty(), "{:?}", temp_files(&dir));
        assert!(corrupt_backups(&dir).is_empty());
    }

    #[test]
    fn a_failed_save_leaves_no_temp_file_and_the_old_file_whole() {
        let tmp = tempfile::tempdir().unwrap();
        // A folder where the live file should be: the write works, the rename
        // over it fails.
        let live = tmp.path().join(CONFIG_FILE);
        std::fs::create_dir(&live).unwrap();
        std::fs::write(live.join("keep"), "x").unwrap();

        assert!(save_config_to(tmp.path(), &json!({ "theme": "dark" })).is_err());

        assert!(
            temp_files(tmp.path()).is_empty(),
            "{:?}",
            temp_files(tmp.path())
        );
        assert_eq!(std::fs::read(live.join("keep")).unwrap(), b"x");
    }

    #[test]
    fn a_save_never_writes_through_another_saves_temp_file() {
        // The old fixed temp name, as a save from another writer would be
        // filling it. Each save now has a temp file of its own.
        let tmp = tempfile::tempdir().unwrap();
        let other = tmp.path().join(format!("{CONFIG_FILE}.tmp"));
        std::fs::write(&other, "half-written").unwrap();

        save_config_to(tmp.path(), &json!({ "theme": "dark" })).unwrap();

        assert_eq!(std::fs::read(&other).unwrap(), b"half-written");
        assert_eq!(load_config_from(tmp.path()), json!({ "theme": "dark" }));
    }

    #[test]
    fn a_valid_file_loads_unchanged_without_a_backup() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(CONFIG_FILE),
            r#"{"theme": "dark", "providers": {"a": 1}}"#,
        )
        .unwrap();
        assert_eq!(
            load_config_from(tmp.path()),
            json!({"theme": "dark", "providers": {"a": 1}})
        );
        assert!(corrupt_backups(tmp.path()).is_empty());
        assert!(tmp.path().join(CONFIG_FILE).exists());
    }

    #[test]
    fn a_corrupt_file_is_backed_up_and_loads_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let original = br#"{"providers": {"a": 1},"#;
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&original[..]),
            "live file untouched"
        );
        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
        // Named by the first 16 hex characters of the bytes' SHA-256
        // (`printf '%s' '{"providers": {"a": 1},' | sha256sum`).
        assert_eq!(
            backups[0].file_name().unwrap(),
            "fleet.config.json.corrupt-16e4fbebb8eabfec"
        );
    }

    #[test]
    fn a_file_that_is_not_an_object_is_backed_up_too() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(CONFIG_FILE), "[1,2]").unwrap();

        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&b"[1,2]"[..]),
            "live file untouched"
        );
        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), b"[1,2]");
    }

    #[test]
    fn a_file_that_is_not_utf8_is_backed_up_too() {
        // JSON must be UTF-8, so these bytes are a corrupt config like any
        // other, not an unreadable file to leave for the next save.
        let tmp = tempfile::tempdir().unwrap();
        let original = b"{\"theme\": \"\xff\xfe\"}";
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&original[..]),
            "live file untouched"
        );
        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
    }

    #[test]
    fn loading_the_same_corrupt_file_twice_keeps_one_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let original = br#"{"providers": {"a": 1},"#;
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&original[..]),
            "live file untouched"
        );
        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
    }

    #[test]
    fn a_changed_corrupt_file_gets_a_second_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let first = br#"{"providers": {"a": 1},"#;
        let second = br#"{"providers": {"a": 2},"#;
        std::fs::write(tmp.path().join(CONFIG_FILE), first).unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));

        std::fs::write(tmp.path().join(CONFIG_FILE), second).unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&second[..]),
            "live file untouched"
        );
        let mut kept: Vec<Vec<u8>> = corrupt_backups(tmp.path())
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect();
        kept.sort();
        assert_eq!(kept, [first.to_vec(), second.to_vec()]);
    }

    #[test]
    fn a_valid_file_with_a_bom_loads_without_a_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let original = b"\xEF\xBB\xBF{\"theme\": \"dark\", \"providers\": {\"a\": 1}}";
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        assert_eq!(
            load_config_from(tmp.path()),
            json!({"theme": "dark", "providers": {"a": 1}})
        );
        assert!(corrupt_backups(tmp.path()).is_empty());
        assert_eq!(live_bytes(tmp.path()).as_deref(), Some(&original[..]));
    }

    #[test]
    fn a_corrupt_file_with_a_bom_is_backed_up_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let original = b"\xEF\xBB\xBF{\"providers\": {\"a\": 1},";
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        assert_eq!(load_config_from(tmp.path()), json!({}));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&original[..]),
            "live file untouched"
        );
        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), original, "BOM kept");
        // Named by the hash of the raw bytes, BOM included.
        assert_eq!(
            backups[0].file_name().unwrap(),
            "fleet.config.json.corrupt-421aca0a03c1d36a"
        );
    }

    #[test]
    fn a_save_after_a_corrupt_load_leaves_the_backup_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let original = br#"{"providers": {"a": 1},"#;
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        persist_cloud_choice(tmp.path(), true).unwrap();

        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
        // The live file now holds only what the setter wrote.
        let cfg: Value = serde_json::from_slice(&live_bytes(tmp.path()).unwrap()).unwrap();
        assert_eq!(
            cfg.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["telemetry"],
            "{cfg}"
        );
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
    }

    #[test]
    fn the_load_status_says_what_was_found() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(CONFIG_FILE);
        assert_eq!(
            load_config_with_status(tmp.path()),
            (json!({}), ConfigLoad::Missing)
        );

        std::fs::write(&file, b"\xEF\xBB\xBF{\"theme\": \"dark\"}").unwrap();
        assert_eq!(
            load_config_with_status(tmp.path()),
            (json!({"theme": "dark"}), ConfigLoad::Ok)
        );

        std::fs::write(&file, "{\"theme\": ").unwrap();
        assert_eq!(
            load_config_with_status(tmp.path()),
            (json!({}), ConfigLoad::Corrupt)
        );
        std::fs::write(&file, "[1,2]").unwrap();
        assert_eq!(
            load_config_with_status(tmp.path()),
            (json!({}), ConfigLoad::Corrupt)
        );

        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        assert_eq!(
            load_config_with_status(tmp.path()),
            (json!({}), ConfigLoad::Unreadable)
        );
    }

    #[test]
    fn a_corrupt_config_keeps_sync_off_and_saves_the_opt_out() {
        let tmp = tempfile::tempdir().unwrap();
        // An opt-out cut short: the saved choice can't be read back.
        let original = br#"{"telemetry": {"cloud_sync_enabled": false"#;
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();

        assert!(
            !startup_cloud_decision(tmp.path()),
            "a corrupt config keeps sync off"
        );

        // The opt-out is saved, so later launches stay off as well...
        let cfg: Value = serde_json::from_slice(&live_bytes(tmp.path()).unwrap()).unwrap();
        assert_eq!(
            cfg["telemetry"]["cloud_sync_enabled"],
            json!(false),
            "{cfg}"
        );
        assert!(
            !startup_cloud_decision(tmp.path()),
            "the next launch stays off"
        );
        // ...and the corrupt bytes are still kept.
        let backups = corrupt_backups(tmp.path());
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read(&backups[0]).unwrap(), original);
    }

    #[test]
    fn an_unreadable_config_keeps_sync_off() {
        let tmp = tempfile::tempdir().unwrap();
        // A folder where the file belongs: it is there but can't be read,
        // and nothing can replace it, so the opt-out can't be saved either.
        std::fs::create_dir(tmp.path().join(CONFIG_FILE)).unwrap();

        assert!(!startup_cloud_decision(tmp.path()));
        assert!(
            tmp.path().join(CONFIG_FILE).is_dir(),
            "the save failed, and sync still stays off"
        );
        assert!(corrupt_backups(tmp.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_config_that_can_be_replaced_gets_the_opt_out() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(CONFIG_FILE);
        std::fs::write(&file, r#"{"telemetry": {"cloud_sync_enabled": false}}"#).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&file).is_ok() {
            eprintln!("skipped: permissions don't stop this user's reads (root?)");
            return;
        }

        assert!(!startup_cloud_decision(tmp.path()));
        let cfg = load_config_from(tmp.path());
        assert_eq!(
            cfg["telemetry"]["cloud_sync_enabled"],
            json!(false),
            "{cfg}"
        );
    }

    #[test]
    fn a_missing_config_opens_sync_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(startup_cloud_decision(tmp.path()), "a fresh install is on");
        assert!(
            !tmp.path().join(CONFIG_FILE).exists(),
            "a fresh install saves no choice"
        );
    }

    #[test]
    fn a_readable_config_decides_by_its_saved_choice() {
        for (saved, open) in [
            (json!({"telemetry": {"cloud_sync_enabled": true}}), true),
            (json!({"telemetry": {"cloud_sync_enabled": false}}), false),
            (json!({"telemetryEnabled": false}), false),
            (json!({"theme": "dark"}), CLOUD_SYNC_DEFAULT),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            save_config_to(tmp.path(), &saved).unwrap();
            assert_eq!(startup_cloud_decision(tmp.path()), open, "{saved}");
            assert_eq!(load_config_from(tmp.path()), saved, "left as it was");
        }
    }

    #[test]
    fn the_restore_reads_a_broken_config_as_off_and_saves_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let original = br#"{"telemetry": {"cloud_sync_enabled": true}"#;
        std::fs::write(tmp.path().join(CONFIG_FILE), original).unwrap();
        assert!(!saved_cloud_choice(tmp.path()));
        assert_eq!(
            live_bytes(tmp.path()).as_deref(),
            Some(&original[..]),
            "nothing saved"
        );

        let unreadable = tempfile::tempdir().unwrap();
        std::fs::create_dir(unreadable.path().join(CONFIG_FILE)).unwrap();
        assert!(!saved_cloud_choice(unreadable.path()));
    }

    #[test]
    fn the_restore_reads_a_missing_or_readable_config_as_saved() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(saved_cloud_choice(tmp.path()), CLOUD_SYNC_DEFAULT);
        assert!(!tmp.path().join(CONFIG_FILE).exists(), "nothing saved");

        save_config_to(
            tmp.path(),
            &json!({"telemetry": {"cloud_sync_enabled": true}}),
        )
        .unwrap();
        assert!(saved_cloud_choice(tmp.path()));
        save_config_to(
            tmp.path(),
            &json!({"telemetry": {"cloud_sync_enabled": false}}),
        )
        .unwrap();
        assert!(!saved_cloud_choice(tmp.path()));
    }

    #[test]
    fn routing_section_round_trip() {
        let mut cfg = json!({});
        let mut r = RoutingConfig {
            enabled: true,
            active_decision_router: "notdiamond".into(),
            active_proxy_gateway: "weave".into(),
            ..Default::default()
        };
        r.connected_routers.insert(
            "notdiamond".into(),
            ConnectedRouter {
                connected: true,
                metadata: json!({ "workspace_id": "ws_1" }),
            },
        );
        routing_set(&mut cfg, &r);

        let back = routing_from(&cfg);
        assert!(back.enabled);
        assert_eq!(back.active_decision_router, "notdiamond");
        assert_eq!(back.active_proxy_gateway, "weave");
        assert!(back.connected_routers.contains_key("notdiamond"));
        assert_eq!(
            back.connected_routers["notdiamond"].metadata,
            json!({ "workspace_id": "ws_1" })
        );
    }

    #[test]
    fn routing_section_defaults_when_missing() {
        let cfg = json!({ "theme": "dark" });
        let r = routing_from(&cfg);
        assert!(!r.enabled);
        assert_eq!(r.active_decision_router, "builtin");
        assert_eq!(r.active_proxy_gateway, "none-proxy");
        assert!(r.connected_routers.is_empty());
    }

    #[test]
    fn routing_section_defaults_when_corrupt() {
        let cfg = json!({ "routing": "not an object" });
        let r = routing_from(&cfg);
        assert!(!r.enabled);
        assert_eq!(r.active_decision_router, "builtin");
    }

    #[test]
    fn providers_section_round_trip() {
        let mut cfg = json!({});
        let mut p = ProvidersConfig {
            ollama_base_url: Some("http://192.168.1.50:11434".into()),
            enabled_agents: vec!["claude-code".into(), "kimi-code".into()],
            ..Default::default()
        };
        p.connected.insert("openai".into(), true);
        p.connected.insert("perplexity".into(), true);
        p.enabled_models
            .insert("openai".into(), vec!["o3".into(), "gpt-4o".into()]);

        providers_set(&mut cfg, &p);
        let back = providers_from(&cfg);
        assert_eq!(
            back.ollama_base_url.as_deref(),
            Some("http://192.168.1.50:11434")
        );
        assert_eq!(back.enabled_agents, vec!["claude-code", "kimi-code"]);
        assert_eq!(back.connected.get("openai"), Some(&true));
        assert_eq!(back.connected.get("perplexity"), Some(&true));
        assert_eq!(
            back.enabled_models.get("openai").map(Vec::as_slice),
            Some(["o3".to_string(), "gpt-4o".to_string()].as_slice())
        );
    }

    #[test]
    fn providers_section_defaults_when_missing() {
        let cfg = json!({ "theme": "dark" });
        let p = providers_from(&cfg);
        assert!(p.connected.is_empty());
        assert!(p.enabled_models.is_empty());
        assert!(p.ollama_base_url.is_none());
        assert!(p.enabled_agents.is_empty());
    }

    #[test]
    fn providers_config_round_trips_cloud_base_url() {
        let json =
            serde_json::json!({ "providers": { "ollama_cloud_base_url": "https://ollama.com" } });
        let p = providers_from(&json);
        assert_eq!(
            p.ollama_cloud_base_url.as_deref(),
            Some("https://ollama.com")
        );
        let def = ProvidersConfig::default();
        assert!(def.ollama_cloud_base_url.is_none());
    }

    #[test]
    fn providers_section_defaults_when_corrupt() {
        let cfg = json!({ "providers": "not an object" });
        let p = providers_from(&cfg);
        assert!(p.connected.is_empty());
        assert!(p.enabled_models.is_empty());
    }

    #[test]
    fn telemetry_section_round_trip() {
        let mut cfg = json!({});
        let t = TelemetryConfig {
            posthog_enabled: true,
            posthog_enabled_at: Some(1_700_000_000_000),
            ..Default::default()
        };
        telemetry_set(&mut cfg, &t);
        let back = telemetry_from(&cfg);
        assert!(back.posthog_enabled);
        assert_eq!(back.posthog_enabled_at, Some(1_700_000_000_000));
    }

    #[test]
    fn telemetry_section_defaults_when_missing() {
        let cfg = json!({ "theme": "dark" });
        let t = telemetry_from(&cfg);
        assert!(!t.posthog_enabled);
        assert!(t.posthog_enabled_at.is_none());
    }

    #[test]
    fn telemetry_section_defaults_when_corrupt() {
        let cfg = json!({ "telemetry": "not an object" });
        let t = telemetry_from(&cfg);
        assert!(!t.posthog_enabled);
    }

    #[test]
    fn telemetry_and_other_sections_coexist() {
        // The three top-level sections (routing, providers, telemetry)
        // must round-trip independently from the same Value.
        let mut cfg = json!({});
        let r = RoutingConfig {
            enabled: true,
            ..Default::default()
        };
        routing_set(&mut cfg, &r);
        let p = ProvidersConfig {
            enabled_agents: vec!["claude-code".into()],
            ..Default::default()
        };
        providers_set(&mut cfg, &p);
        let t = TelemetryConfig {
            posthog_enabled: true,
            posthog_enabled_at: Some(42),
            ..Default::default()
        };
        telemetry_set(&mut cfg, &t);

        assert!(routing_from(&cfg).enabled);
        assert_eq!(
            providers_from(&cfg).enabled_agents,
            vec!["claude-code".to_string()]
        );
        assert!(telemetry_from(&cfg).posthog_enabled);
        assert_eq!(telemetry_from(&cfg).posthog_enabled_at, Some(42));
    }

    #[test]
    fn cloud_sync_falls_back_to_the_default_when_unset_or_not_a_bool() {
        assert_eq!(cloud_sync_from(&json!({})), CLOUD_SYNC_DEFAULT);
        assert_eq!(cloud_sync_from(&Value::Null), CLOUD_SYNC_DEFAULT);
        assert_eq!(cloud_sync_from(&json!("on")), CLOUD_SYNC_DEFAULT);
        assert_eq!(
            cloud_sync_from(&json!({"telemetry": {"cloud_sync_enabled": null}})),
            CLOUD_SYNC_DEFAULT
        );
        assert_eq!(
            cloud_sync_from(&json!({"telemetry": {"cloud_sync_enabled": "true"}})),
            CLOUD_SYNC_DEFAULT
        );
    }

    #[test]
    fn sync_is_on_unless_the_user_turned_it_off() {
        assert!(cloud_sync_from(&json!({})), "on for a user who never chose");
        assert!(
            !cloud_sync_from(&json!({"telemetry": {"cloud_sync_enabled": false}})),
            "an explicit opt-out"
        );
        assert!(
            !cloud_sync_from(&json!({"telemetryEnabled": false})),
            "an opt-out from the old switch"
        );
    }

    #[test]
    fn cloud_sync_honours_the_saved_choice() {
        assert!(cloud_sync_from(
            &json!({"telemetry": {"cloud_sync_enabled": true}})
        ));
        assert!(!cloud_sync_from(
            &json!({"telemetry": {"cloud_sync_enabled": false}})
        ));
    }

    #[test]
    fn cloud_sync_honours_an_old_explicit_opt_out() {
        assert!(!cloud_sync_from(&json!({"telemetryEnabled": false})));
        // The old switch was never read and defaulted to on, so `true`
        // there is not a choice the user made.
        assert_eq!(
            cloud_sync_from(&json!({"telemetryEnabled": true})),
            CLOUD_SYNC_DEFAULT
        );
    }

    #[test]
    fn saved_cloud_sync_choice_wins_over_the_old_flag() {
        assert!(cloud_sync_from(&json!({
            "telemetry": {"cloud_sync_enabled": true},
            "telemetryEnabled": false
        })));
    }

    #[test]
    fn telemetry_set_merges_into_the_saved_section() {
        let mut cfg = json!({
            "theme": "dark",
            "telemetry": {"future_flag": 1, "posthog_enabled_at": 42}
        });
        let t = TelemetryConfig {
            posthog_enabled: true,
            ..Default::default()
        };
        telemetry_set(&mut cfg, &t);
        // Unknown keys stay; `None` fields neither write `null` nor remove
        // a saved value.
        assert_eq!(
            cfg,
            json!({
                "theme": "dark",
                "telemetry": {"future_flag": 1, "posthog_enabled_at": 42, "posthog_enabled": true}
            })
        );
    }

    #[test]
    fn posthog_toggle_keeps_the_cloud_sync_choice() {
        // persist_posthog_choice reads the telemetry section into
        // TelemetryConfig and merges the struct back.
        let mut cfg = json!({
            "telemetry": {"cloud_sync_enabled": true, "cloud_sync_enabled_at": 42}
        });
        let mut t = telemetry_from(&cfg);
        t.posthog_enabled = true;
        telemetry_set(&mut cfg, &t);
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled_at"], json!(42));
    }

    #[test]
    fn persisting_the_cloud_choice_writes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        // Sync is on by default, so an opt-in needs an earlier opt-out.
        save_config_to(
            tmp.path(),
            &json!({"theme": "dark", "telemetry": {"cloud_sync_enabled": false}}),
        )
        .unwrap();

        persist_cloud_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert!(
            cfg["telemetry"]["cloud_sync_enabled_at"].is_i64(),
            "first opt-in stamped: {cfg}"
        );
        assert_eq!(cfg["theme"], json!("dark"), "other settings kept");
        let first_opt_in = cfg["telemetry"]["cloud_sync_enabled_at"].clone();

        persist_cloud_choice(tmp.path(), false).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(false));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled_at"], first_opt_in);

        // Opting in again keeps the first opt-in time.
        persist_cloud_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled_at"], first_opt_in);
    }

    #[test]
    fn keeping_sync_on_saves_the_choice_without_an_opt_in_time() {
        // Onboarding's "Keep it on" saves an explicit choice. Sync was
        // already on by default, so it isn't an opt-in: only turning sync on
        // from off is stamped.
        let tmp = tempfile::tempdir().unwrap();
        save_config_to(tmp.path(), &json!({"theme": "dark"})).unwrap();

        persist_cloud_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(true));
        assert_eq!(cfg["telemetry"].get("cloud_sync_enabled_at"), None, "{cfg}");
        assert_eq!(cfg["theme"], json!("dark"), "other settings kept");
    }

    #[test]
    fn persisting_the_cloud_choice_reports_a_failed_save() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a-file");
        std::fs::write(&file, "not a folder").unwrap();
        // The settings folder would have to live under a regular file.
        let err = persist_cloud_choice(&file.join("settings"), false).unwrap_err();
        assert!(
            err.starts_with("Couldn't save the cloud sync setting: "),
            "{err}"
        );
    }

    #[test]
    fn persisting_the_posthog_choice_writes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        save_config_to(
            tmp.path(),
            &json!({"theme": "dark", "telemetry": {"cloud_sync_enabled": false}}),
        )
        .unwrap();

        persist_posthog_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["posthog_enabled"], json!(true));
        assert!(
            cfg["telemetry"]["posthog_enabled_at"].is_i64(),
            "first opt-in stamped: {cfg}"
        );
        assert_eq!(
            cfg["telemetry"]["cloud_sync_enabled"],
            json!(false),
            "cloud choice kept"
        );
        assert_eq!(cfg["theme"], json!("dark"), "other settings kept");
        let first_opt_in = cfg["telemetry"]["posthog_enabled_at"].clone();

        persist_posthog_choice(tmp.path(), false).unwrap();
        let mut cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["posthog_enabled"], json!(false));
        assert_eq!(cfg["telemetry"]["posthog_enabled_at"], first_opt_in);
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(false));

        // Opting in again keeps the first opt-in time. A stamp no clock
        // would write shows a fresh one even within the same millisecond.
        cfg["telemetry"]["posthog_enabled_at"] = json!(42);
        save_config_to(tmp.path(), &cfg).unwrap();
        persist_posthog_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(cfg["telemetry"]["posthog_enabled"], json!(true));
        assert_eq!(cfg["telemetry"]["posthog_enabled_at"], json!(42));
        assert_eq!(cfg["telemetry"]["cloud_sync_enabled"], json!(false));
    }

    #[test]
    fn a_malformed_telemetry_field_does_not_cost_the_cloud_choice() {
        let tmp = tempfile::tempdir().unwrap();
        save_config_to(
            tmp.path(),
            &json!({"telemetry": {"posthog_enabled": "yes", "cloud_sync_enabled": false}}),
        )
        .unwrap();

        persist_posthog_choice(tmp.path(), true).unwrap();
        let cfg = load_config_from(tmp.path());
        assert_eq!(
            cfg["telemetry"]["cloud_sync_enabled"],
            json!(false),
            "{cfg}"
        );
        assert_eq!(cfg["telemetry"]["posthog_enabled"], json!(true), "{cfg}");
    }

    #[test]
    fn persisting_the_posthog_choice_reports_a_failed_save() {
        let tmp = tempfile::tempdir().unwrap();
        // A folder where the config file belongs can't be replaced by one.
        std::fs::create_dir(tmp.path().join(CONFIG_FILE)).unwrap();
        let err = persist_posthog_choice(tmp.path(), false).unwrap_err();
        assert!(
            err.starts_with("Couldn't save the product analytics setting: "),
            "{err}"
        );
    }

    #[test]
    fn providers_round_trip_cloudflare_account_id() {
        let mut cfg = json!({});
        let p = ProvidersConfig {
            cloudflare_account_id: Some("acc_123".into()),
            ..ProvidersConfig::default()
        };
        providers_set(&mut cfg, &p);
        let back = providers_from(&cfg);
        assert_eq!(back.cloudflare_account_id.as_deref(), Some("acc_123"));
    }

    #[test]
    fn providers_default_cloudflare_account_id_is_none() {
        assert!(ProvidersConfig::default().cloudflare_account_id.is_none());
    }

    #[test]
    fn attribution_defaults_on() {
        assert!(git_attribution_from(&json!({})));
    }

    #[test]
    fn attribution_respects_false() {
        assert!(!git_attribution_from(&json!({"gitAttribution": false})));
    }

    #[test]
    fn attribution_ignores_non_boolean_values() {
        assert!(git_attribution_from(&json!({"gitAttribution": "false"})));
        assert!(git_attribution_from(&json!({"gitAttribution": 0})));
        assert!(git_attribution_from(&json!({"gitAttribution": null})));
    }

    #[test]
    fn attribution_opt_out_survives_save_and_reload() {
        let tmp = tempfile::tempdir().unwrap();
        save_config_to(
            tmp.path(),
            &json!({"theme": "dark", "gitAttribution": false}),
        )
        .unwrap();
        assert!(!git_attribution_from(&load_config_from(tmp.path())));
    }

    #[test]
    fn providers_and_routing_coexist_in_same_config() {
        // Sanity check that the two sections don't clobber each other —
        // both round-trip cleanly out of the same Value.
        let mut cfg = json!({});
        let mut r = RoutingConfig {
            enabled: true,
            ..Default::default()
        };
        r.connected_routers.insert(
            "weave".into(),
            ConnectedRouter {
                connected: true,
                metadata: json!({}),
            },
        );
        routing_set(&mut cfg, &r);
        let mut p = ProvidersConfig::default();
        p.connected.insert("openai".into(), true);
        providers_set(&mut cfg, &p);

        let r_back = routing_from(&cfg);
        let p_back = providers_from(&cfg);
        assert!(r_back.enabled);
        assert_eq!(
            r_back.connected_routers.get("weave").map(|c| c.connected),
            Some(true)
        );
        assert_eq!(p_back.connected.get("openai"), Some(&true));
    }
}
