//! `/api/library/*` — CRUD for user-authored library items. Items live under
//! `~/.fleetify/library/` (NOT a plugin) and materialize to the selected
//! providers' on-disk locations via the shared `services::plugins::materializers`
//! writers. Cleanup on delete reverses the recorded paths.

use std::path::{Path, PathBuf};

use axum::extract::{Path as AxPath, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::routers::{ApiError, AppState};
use crate::services::library::types::{is_valid_slug, LibraryItem, LibraryKind};
use crate::services::library::{enumerate, materialize, store};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/library/items", get(list_items).post(create_item))
        .route(
            "/library/items/{id}",
            get(get_item).put(update_item).delete(delete_item),
        )
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    kind: Option<String>,
}

/// A list row: the item plus its origin (`"user"` or a plugin name) and whether
/// the renderer may edit/delete it (plugin-contributed items are read-only).
#[derive(serde::Serialize)]
struct ItemRow {
    #[serde(flatten)]
    item: LibraryItem,
    source: String,
    editable: bool,
}

async fn list_items(Query(q): Query<ListQuery>) -> Result<Json<Value>, ApiError> {
    let kind = match q.kind.as_deref() {
        Some(s) => Some(
            LibraryKind::parse(s)
                .ok_or_else(|| ApiError::BadRequest(format!("unknown kind: {s}")))?,
        ),
        None => None,
    };
    let mut rows: Vec<ItemRow> = store::list(kind)
        .into_iter()
        .map(|item| ItemRow {
            item,
            source: "user".to_string(),
            editable: true,
        })
        .collect();
    // Plugin-contributed items (read-only): the requested kind, or all
    // enumerable kinds when unfiltered.
    let kinds = match kind {
        Some(k) => vec![k],
        None => vec![LibraryKind::Skill, LibraryKind::Template],
    };
    for k in kinds {
        for (plugin, item) in enumerate::plugin_items(k) {
            rows.push(ItemRow {
                item,
                source: plugin,
                editable: false,
            });
        }
    }
    Ok(Json(serde_json::to_value(rows)?))
}

async fn get_item(AxPath(id): AxPath<String>) -> Result<Json<Value>, ApiError> {
    let item = store::get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("library item {id} not found")))?;
    Ok(Json(serde_json::to_value(item)?))
}

#[derive(Deserialize)]
struct CreateBody {
    kind: String,
    name: String,
    slug: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    providers: Vec<String>,
    /// The authored payload body: SKILL.md / command md / prompt md / hook json
    /// / template json, depending on `kind`.
    #[serde(default)]
    body: String,
}

async fn create_item(
    State(_st): State<AppState>,
    Json(b): Json<CreateBody>,
) -> Result<Json<Value>, ApiError> {
    let kind = LibraryKind::parse(&b.kind)
        .ok_or_else(|| ApiError::BadRequest(format!("unknown kind: {}", b.kind)))?;
    if !is_valid_slug(&b.slug) {
        return Err(ApiError::BadRequest(
            "slug must match ^[a-z0-9][a-z0-9-]*$".into(),
        ));
    }
    if kind.is_provider_scoped() && b.providers.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "{} items need at least one provider",
            b.kind
        )));
    }
    if store::slug_taken(kind, &b.slug, None) {
        return Err(ApiError::Conflict(
            json!({ "error": format!("a {} named '{}' already exists", b.kind, b.slug) }),
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let dir = store::item_dir(&id);
    let payload =
        write_payload(&dir, kind, &b.body).map_err(|e| ApiError::Internal(e.to_string()))?;

    let mut item = LibraryItem {
        id,
        kind,
        name: b.name,
        slug: b.slug,
        description: b.description,
        providers: b.providers,
        materialized: vec![],
        hook_merge: vec![],
        created_at: now.clone(),
        updated_at: now,
    };
    let out = materialize::materialize_item(&item, &payload)?;
    item.materialized = out.materialized;
    item.hook_merge = out.hook_merge;
    store::save(&item)?;
    Ok(Json(serde_json::to_value(item)?))
}

async fn delete_item(AxPath(id): AxPath<String>) -> Result<Json<Value>, ApiError> {
    let item = store::get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("library item {id} not found")))?;
    materialize::unmaterialize_item(&item.materialized, &item.hook_merge);
    store::delete_record(&id)?;
    Ok(Json(json!({ "ok": true })))
}

/// Edit an item: kind + slug are immutable; name/description/providers update,
/// and the body is rewritten only when a non-empty one is supplied (so a
/// providers-only edit keeps the existing payload). Re-materializes from
/// scratch so dropped providers are cleaned up.
async fn update_item(
    State(_st): State<AppState>,
    AxPath(id): AxPath<String>,
    Json(b): Json<CreateBody>,
) -> Result<Json<Value>, ApiError> {
    let mut item = store::get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("library item {id} not found")))?;
    if item.kind.is_provider_scoped() && b.providers.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "{} items need at least one provider",
            b.kind
        )));
    }
    materialize::unmaterialize_item(&item.materialized, &item.hook_merge);

    item.name = b.name;
    item.description = b.description;
    item.providers = b.providers;
    item.updated_at = chrono::Utc::now().to_rfc3339();

    let dir = store::item_dir(&id);
    let payload = if b.body.is_empty() {
        existing_payload(&dir, item.kind)
    } else {
        write_payload(&dir, item.kind, &b.body).map_err(|e| ApiError::Internal(e.to_string()))?
    };
    let out = materialize::materialize_item(&item, &payload)?;
    item.materialized = out.materialized;
    item.hook_merge = out.hook_merge;
    store::save(&item)?;
    Ok(Json(serde_json::to_value(item)?))
}

/// The on-disk payload path for an existing item (no write) — used when an edit
/// changes only metadata/providers and keeps the current body.
fn existing_payload(dir: &Path, kind: LibraryKind) -> PathBuf {
    match kind {
        LibraryKind::Skill => dir.join("skill"),
        LibraryKind::Prompt => dir.join("prompt.md"),
        LibraryKind::Hook => dir.join("hook.json"),
        LibraryKind::Template => dir.join("system_prompt.md"),
    }
}

/// Write the authored body into the item dir, returning the payload path the
/// materializer reads (a dir for skills, the file for everything else).
fn write_payload(dir: &Path, kind: LibraryKind, body: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let payload = match kind {
        LibraryKind::Skill => {
            let sdir = dir.join("skill");
            std::fs::create_dir_all(&sdir)?;
            std::fs::write(sdir.join("SKILL.md"), body)?;
            sdir
        }
        LibraryKind::Prompt => {
            let p = dir.join("prompt.md");
            std::fs::write(&p, body)?;
            p
        }
        LibraryKind::Hook => {
            let p = dir.join("hook.json");
            std::fs::write(&p, body)?;
            p
        }
        LibraryKind::Template => {
            // The authored body is the agent preset's system prompt; the rest
            // of the spec derives from item metadata (see services::templates).
            let p = dir.join("system_prompt.md");
            std::fs::write(&p, body)?;
            p
        }
    };
    Ok(payload)
}
