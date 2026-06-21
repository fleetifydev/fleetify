//! USER-scoped personal memory — the durable, cross-project things Fleet knows
//! about the user (preferences, stack, goals, working style, interests, life
//! context, ongoing threads). Backs the `/api/user/memory` routes, the staff
//! prompt injection (`top_for_prompt`), and the auto-extractor's dedupe
//! (`find_similar`). Distinct from `session_memory` (per-project, dev notes).

use crate::models::user_memory::{normalize_kind, UserMemory};
use anyhow::Result;
use sqlx::SqlitePool;

/// Char-truncate on a code-point boundary (mirrors `sessions.rs::trunc`).
fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

fn clamp_importance(v: i64) -> i64 {
    v.clamp(1, 5)
}

/// Most-relevant memories first (importance, then recency).
pub async fn list(pool: &SqlitePool, user_id: &str, limit: i64) -> Result<Vec<UserMemory>> {
    let rows = sqlx::query_as::<_, UserMemory>(
        "SELECT id,user_id,kind,title,content,importance,source,created_at,updated_at \
         FROM user_memory WHERE user_id = ? \
         ORDER BY importance DESC, created_at DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Insert a memory. `source` is "explicit" (user-told) or "auto" (extracted).
pub async fn create(
    pool: &SqlitePool,
    user_id: &str,
    kind: &str,
    title: &str,
    content: &str,
    importance: i64,
    source: &str,
) -> Result<UserMemory> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    let kind = normalize_kind(kind);
    let title = trunc(title.trim(), 300);
    let content = trunc(content.trim(), 4000);
    let importance = clamp_importance(importance);
    let source = if source == "auto" { "auto" } else { "explicit" };
    sqlx::query(
        "INSERT INTO user_memory (id,user_id,kind,title,content,importance,source,created_at) \
         VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(kind)
    .bind(&title)
    .bind(&content)
    .bind(importance)
    .bind(source)
    .bind(&created_at)
    .execute(pool)
    .await?;
    Ok(UserMemory {
        id,
        user_id: user_id.to_string(),
        kind: kind.to_string(),
        title,
        content,
        importance,
        source: source.to_string(),
        created_at,
        updated_at: None,
    })
}

/// Patch a memory's fields. Scoped by user_id so one user can't touch another's
/// rows. Returns the updated row, or None if it doesn't exist for this user.
pub async fn update(
    pool: &SqlitePool,
    user_id: &str,
    id: &str,
    kind: Option<&str>,
    title: Option<&str>,
    content: Option<&str>,
    importance: Option<i64>,
) -> Result<Option<UserMemory>> {
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM user_memory WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Ok(None);
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(k) = kind {
        sqlx::query("UPDATE user_memory SET kind = ? WHERE id = ?")
            .bind(normalize_kind(k))
            .bind(id)
            .execute(pool)
            .await?;
    }
    if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE user_memory SET title = ? WHERE id = ?")
            .bind(trunc(t, 300))
            .bind(id)
            .execute(pool)
            .await?;
    }
    if let Some(c) = content.map(str::trim).filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE user_memory SET content = ? WHERE id = ?")
            .bind(trunc(c, 4000))
            .bind(id)
            .execute(pool)
            .await?;
    }
    if let Some(imp) = importance {
        sqlx::query("UPDATE user_memory SET importance = ? WHERE id = ?")
            .bind(clamp_importance(imp))
            .bind(id)
            .execute(pool)
            .await?;
    }
    sqlx::query("UPDATE user_memory SET updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    let row = sqlx::query_as::<_, UserMemory>(
        "SELECT id,user_id,kind,title,content,importance,source,created_at,updated_at \
         FROM user_memory WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Delete a memory (scoped by user_id). Returns true if a row was removed.
pub async fn delete(pool: &SqlitePool, user_id: &str, id: &str) -> Result<bool> {
    let res = sqlx::query("DELETE FROM user_memory WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Compact, prompt-ready block of what Fleet knows about the user. Empty string
/// when there's nothing yet (caller skips the section).
pub async fn top_for_prompt(pool: &SqlitePool, user_id: &str, limit: i64) -> String {
    let rows = match list(pool, user_id, limit).await {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for m in &rows {
        out.push_str(&format!("- [{}] {}: {}\n", m.kind, m.title, m.content));
    }
    out
}

/// Crude dedupe helper for the auto-extractor: existing rows whose title matches
/// (case-insensitive) the candidate. Semantic matching can replace this later.
pub async fn find_similar(
    pool: &SqlitePool,
    user_id: &str,
    title: &str,
) -> Result<Vec<UserMemory>> {
    let rows = sqlx::query_as::<_, UserMemory>(
        "SELECT id,user_id,kind,title,content,importance,source,created_at,updated_at \
         FROM user_memory WHERE user_id = ? AND lower(title) = lower(?)",
    )
    .bind(user_id)
    .bind(title.trim())
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
