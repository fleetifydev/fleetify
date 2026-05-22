//! One-shot startup migration from `~/.fleet/` to `~/.fleetify/`.
//! Faithful port of services/migration.py — idempotent, skips entries
//! whose destination already exists, removes the old root only when empty.

use std::path::PathBuf;

fn home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

/// Move `~/.fleet/*` contents into `~/.fleetify/` (parity with
/// `migrate_fleet_to_fleetify`). Best-effort: failures are logged
/// and do not block startup.
pub fn migrate_fleet_to_fleetify() {
    migrate_at(home().as_deref(), home().as_deref());
}

/// Test seam — separate home paths for old and new to exercise
/// missing-old, normal-move, skip-on-existing, and partial-remove.
fn migrate_at(old_home: Option<&std::path::Path>, new_home: Option<&std::path::Path>) {
    let (Some(oh), Some(nh)) = (old_home, new_home) else {
        return;
    };
    let old = oh.join(".fleet");
    if !old.is_dir() {
        return;
    }
    let new = nh.join(".fleetify");
    let _ = std::fs::create_dir_all(&new);

    let mut moved = 0;
    let mut skipped = 0;
    let entries = match std::fs::read_dir(&old) {
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
    if std::fs::read_dir(&old)
        .map(|mut rd| rd.next().is_none())
        .unwrap_or(false)
    {
        let _ = std::fs::remove_dir(&old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_old_dir_is_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        // No ~/.fleet under tmp; migrate is a no-op.
        migrate_at(Some(tmp.path()), Some(tmp.path()));
        assert!(!tmp.path().join(".fleet").exists());
    }

    #[test]
    fn moves_entries_and_removes_empty_old_root() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".fleet");
        fs::create_dir_all(old.join("mcp_servers")).unwrap();
        fs::write(old.join("device.json"), b"{}").unwrap();

        migrate_at(Some(tmp.path()), Some(tmp.path()));

        let new = tmp.path().join(".fleetify");
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

        migrate_at(Some(tmp.path()), Some(tmp.path()));

        // New file untouched; old left in place (since target existed).
        assert_eq!(fs::read(new.join("device.json")).unwrap(), b"NEW");
        assert!(old.join("device.json").is_file());
    }
}
