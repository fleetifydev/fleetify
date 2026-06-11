//! Library item store — JSON records under `~/.fleetify/library/items/<id>/`.
//! Each item dir holds `meta.json` (the `LibraryItem`) + its payload
//! (`skill/SKILL.md`, `command.md`, `prompt.md`, `hook.json`,
//! `template.json`). Resolved via the FLEETIFY_HOME-aware helper so a
//! `dev:tauri:wt` / `$FLEETIFY_HOME` instance gets its own isolated store.

use std::path::PathBuf;

use anyhow::Result;

use super::types::{LibraryItem, LibraryKind};

pub fn library_dir() -> PathBuf {
    fleetify_core::fleetify_home().join("library")
}

pub fn items_dir() -> PathBuf {
    library_dir().join("items")
}

pub fn item_dir(id: &str) -> PathBuf {
    items_dir().join(id)
}

/// Read one item's record, or `None` if it doesn't exist / fails to parse.
pub fn get(id: &str) -> Option<LibraryItem> {
    let txt = std::fs::read_to_string(item_dir(id).join("meta.json")).ok()?;
    serde_json::from_str(&txt).ok()
}

/// List all items, optionally filtered by kind. Best-effort: a record that
/// fails to parse is skipped rather than aborting the whole list.
pub fn list(kind: Option<LibraryKind>) -> Vec<LibraryItem> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(items_dir()) else {
        return out;
    };
    for ent in rd.flatten() {
        if !ent.path().is_dir() {
            continue;
        }
        if let Ok(txt) = std::fs::read_to_string(ent.path().join("meta.json")) {
            if let Ok(item) = serde_json::from_str::<LibraryItem>(&txt) {
                if kind.is_none_or(|k| k == item.kind) {
                    out.push(item);
                }
            }
        }
    }
    out
}

/// Write (create or overwrite) an item's `meta.json`.
pub fn save(item: &LibraryItem) -> Result<()> {
    let dir = item_dir(&item.id);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("meta.json"), serde_json::to_string_pretty(item)?)?;
    Ok(())
}

/// Remove an item's whole dir (record + payload). Materialized provider
/// artifacts are removed separately via `materialize::unmaterialize_item`.
pub fn delete_record(id: &str) -> Result<()> {
    let dir = item_dir(id);
    if dir.is_dir() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// True if another item of the same kind already uses `slug` (intra-store
/// uniqueness). `exclude_id` lets an edit keep its own slug.
pub fn slug_taken(kind: LibraryKind, slug: &str, exclude_id: Option<&str>) -> bool {
    list(Some(kind))
        .into_iter()
        .any(|i| i.slug == slug && Some(i.id.as_str()) != exclude_id)
}
