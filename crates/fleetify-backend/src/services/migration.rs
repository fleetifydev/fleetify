//! One-shot startup migration from `~/.fleet/` to `<fleetify_home>/`.
//! Faithful port of services/migration.py — idempotent, skips entries
//! whose destination already exists, removes the old root only when empty.
//!
//! The legacy `.fleet` directory only ever lived next to the user's
//! actual home (`USERPROFILE` / `HOME`); FLEETIFY_HOME isn't consulted
//! for the source side. The destination is `fleetify_home()`, so when
//! FLEETIFY_HOME is set this becomes a no-op (no legacy `.fleet` lives
//! under that override path).

use std::path::PathBuf;

/// Move `~/.fleet/*` contents into `<fleetify_home>/` (parity with
/// `migrate_fleet_to_fleetify`). Best-effort: failures are logged
/// and do not block startup.
pub fn migrate_fleet_to_fleetify() {
    let old = fleetify_core::user_home().join(".fleet");
    let new = fleetify_core::fleetify_home();
    migrate_at(Some(&old), Some(&new));
}

/// Test seam — full paths (not parent dirs) so tests can exercise
/// missing-old, normal-move, skip-on-existing, and partial-remove.
fn migrate_at(old: Option<&std::path::Path>, new: Option<&std::path::Path>) {
    let (Some(old), Some(new)) = (old, new) else {
        return;
    };
    if !old.is_dir() {
        return;
    }
    let new: PathBuf = new.to_path_buf();
    let _ = std::fs::create_dir_all(&new);

    let mut moved = 0;
    let mut skipped = 0;
    let entries = match std::fs::read_dir(old) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect::<Vec<_>>(),
        Err(_) => return,
    };
    for entry in entries {
        let target = new.join(entry.file_name());
        if target.exists() {
            skipped += 1;
            continue;
        }
        if std::fs::rename(entry.path(), &target).is_ok() {
            moved += 1;
        }
    }
    if moved > 0 || skipped > 0 {
        tracing::info!(moved, skipped, "fleet.migration_complete");
    }
    // Remove the old root if now empty (parity: leave it if anything remains).
    if std::fs::read_dir(old)
        .map(|mut rd| rd.next().is_none())
        .unwrap_or(false)
    {
        let _ = std::fs::remove_dir(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_old_dir_is_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".fleet");
        let new = tmp.path().join(".fleetify");
        // No ~/.fleet under tmp; migrate is a no-op.
        migrate_at(Some(&old), Some(&new));
        assert!(!old.exists());
    }

    #[test]
    fn moves_entries_and_removes_empty_old_root() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".fleet");
        let new = tmp.path().join(".fleetify");
        fs::create_dir_all(old.join("mcp_servers")).unwrap();
        fs::write(old.join("device.json"), b"{}").unwrap();

        migrate_at(Some(&old), Some(&new));

        assert!(new.join("mcp_servers").is_dir());
        assert!(new.join("device.json").is_file());
        assert!(!old.exists(), "old root should be gone when empty");
    }

    #[test]
    fn skips_when_target_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".fleet");
        let new = tmp.path().join(".fleetify");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("device.json"), b"OLD").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("device.json"), b"NEW").unwrap();

        migrate_at(Some(&old), Some(&new));

        // New file untouched; old left in place (since target existed).
        assert_eq!(fs::read(new.join("device.json")).unwrap(), b"NEW");
        assert!(old.join("device.json").is_file());
    }
}
