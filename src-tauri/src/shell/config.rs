//! Persisted app config — backs `window.electronAPI.getConfig` /
//! `setConfig`. Faithful in spirit to the Electron `electron-store`-style
//! JSON-on-disk used by the original.

use std::path::Path;

use serde_json::{json, Value};

const CONFIG_FILE: &str = "fleet.config.json";

/// Load JSON config; returns `{}` when the file doesn't exist or fails to
/// parse (parity with the Electron store's "no file = empty object").
pub fn load_config_from(path: &Path) -> Value {
    let file = path.join(CONFIG_FILE);
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

/// Save JSON config atomically (write `.tmp` then rename, so a crash
/// mid-write doesn't corrupt the existing config file).
pub fn save_config_to(path: &Path, cfg: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    let file = path.join(CONFIG_FILE);
    let tmp = path.join(format!("{CONFIG_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg).unwrap_or_default())?;
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_empty_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));
    }

    #[test]
    fn roundtrip_save_then_load() {
        let tmp = tempfile::tempdir().unwrap();
        let v = json!({"theme":"dark","apiKeys":{"openai":"sk-test"}});
        save_config_to(tmp.path(), &v).unwrap();
        assert_eq!(load_config_from(tmp.path()), v);
    }

    #[test]
    fn corrupt_file_falls_back_to_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(CONFIG_FILE), "{not valid json").unwrap();
        assert_eq!(load_config_from(tmp.path()), json!({}));
    }
}
