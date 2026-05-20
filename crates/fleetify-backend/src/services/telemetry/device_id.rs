//! Stable per-machine device identity. UUID generated once on first
//! launch, persisted to `<HOME>/.fleetify/device.json`. hostname is the
//! default name; user can rename via dashboard PATCH and the cloud row
//! becomes source of truth for display.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
    pub platform: String, // "darwin" | "win32" | "linux"
}

fn platform_short() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn hostname_or_default() -> String {
    // Try `whoami::fallible::hostname()` would add a dep; do it manually.
    // Windows: COMPUTERNAME env var. Unix: gethostname syscall via libc
    // would also add a dep — instead probe HOSTNAME env then fall back.
    if cfg!(windows) {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Fleetify desktop".into())
    } else {
        std::env::var("HOSTNAME")
            .or_else(|_| {
                // /etc/hostname is the cross-distro source on Linux; macOS
                // doesn't always populate HOSTNAME so fall back to
                // SC_NODENAME via `uname -n` would be ideal but adds a
                // subprocess. Conservative default for now.
                std::fs::read_to_string("/etc/hostname")
                    .map(|s| s.trim().to_string())
                    .map_err(|_| std::env::VarError::NotPresent)
            })
            .unwrap_or_else(|_| "Fleetify desktop".into())
    }
}

fn default_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".fleetify").join("device.json")
}

/// Return the persisted device identity, generating a UUID + writing
/// the file on first call. Corrupt JSON or a missing device_id key
/// triggers regeneration.
pub fn get_or_create() -> DeviceInfo {
    get_or_create_at(&default_path())
}

pub fn get_or_create_at(path: &std::path::Path) -> DeviceInfo {
    if path.exists() {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(id) = v.get("device_id").and_then(|x| x.as_str()) {
                    if !id.is_empty() {
                        return DeviceInfo {
                            device_id: id.to_string(),
                            name: v
                                .get("name")
                                .and_then(|x| x.as_str())
                                .map(String::from)
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(hostname_or_default),
                            platform: v
                                .get("platform")
                                .and_then(|x| x.as_str())
                                .map(String::from)
                                .unwrap_or_else(|| platform_short().to_string()),
                        };
                    }
                }
            }
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let info = DeviceInfo {
        device_id: uuid::Uuid::new_v4().to_string(),
        name: hostname_or_default(),
        platform: platform_short().to_string(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&info) {
        let _ = std::fs::write(path, json);
        // Best-effort 0o600 on Unix; no-op on Windows.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn first_call_generates_and_writes_device_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("device.json");
        let a = get_or_create_at(&path);
        assert_eq!(a.device_id.len(), 36); // UUID v4 string
        assert!(path.exists());
        // Same id on second call.
        let b = get_or_create_at(&path);
        assert_eq!(a.device_id, b.device_id);
        assert_eq!(a.name, b.name);
        assert_eq!(a.platform, b.platform);
    }

    #[test]
    fn corrupt_file_triggers_regeneration() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("device.json");
        std::fs::write(&path, b"not json at all").unwrap();
        let info = get_or_create_at(&path);
        assert_eq!(info.device_id.len(), 36);
    }

    #[test]
    fn platform_short_is_one_of_known_set() {
        let p = platform_short();
        assert!(matches!(p, "darwin" | "win32" | "linux" | "unknown"));
    }
}
