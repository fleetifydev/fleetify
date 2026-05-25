//! One-shot startup migration that rewrites `sessions.model_name` rows
//! whose pinned id no longer exists in the provider catalog.
//!
//! Why: Tasks 7+8 (commits 3d14ed3 and 698567d) refreshed every HTTP
//! provider's `default_models` list against the live vendor docs and
//! dropped several stale ids (e.g. `gemini-3-flash`, `gpt-5.5-pro`,
//! `deepseek-r1`, ...). Sessions persisted with one of those ids would
//! 404 on the very next chat turn — `routers::chat` looks the model up
//! in CATALOG to pick the right base URL / auth header, and a miss is
//! fatal.
//!
//! Walk every row once at boot. For each session whose `tool` matches
//! a known provider AND whose `model_name` is set AND whose `model_name`
//! is NOT in that provider's `default_models`, replace the value with
//! the provider's first canonical default (`default_models[0].id`).
//!
//! Idempotent by construction:
//!   - Rows with `model_name IS NULL` (most CLI agents) are skipped.
//!   - Rows whose tool isn't in the catalog (custom/legacy agents) are
//!     skipped — we can't safely guess a replacement for those.
//!   - Rows whose tool's provider has an empty `default_models` list
//!     (Ollama dynamic, CLI agents) are skipped for the same reason.
//!   - A second boot sees only valid ids and walks through doing
//!     nothing.
//!
//! Best-effort: a malformed row, a SQL error on a single UPDATE, or a
//! provider whose catalog entry has no curated models all log + skip
//! rather than crashing startup.

use sqlx::SqlitePool;

use crate::providers::find_provider;

/// Outcome from a single migration pass. Returned so callers can log a
/// summary and tests can assert on the exact count touched.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ModelNameMigrationOutcome {
    /// Number of rows whose `model_name` was rewritten this pass.
    pub migrated: usize,
    /// Number of rows we looked at but couldn't safely migrate
    /// (unknown tool id, empty `default_models`, ...). Surfaced only
    /// for tracing — these rows are left alone.
    pub skipped: usize,
}

/// Walk every row in `sessions` and replace orphaned `model_name`
/// values with the first canonical model id for that provider.
///
/// Logs `migrated=N skipped=M` and returns the outcome. Errors on
/// individual rows are logged + ignored so startup stays robust.
pub async fn migrate_orphaned_model_names(pool: &SqlitePool) -> ModelNameMigrationOutcome {
    let mut out = ModelNameMigrationOutcome::default();

    // Pull only the columns we need so a wide row schema change
    // doesn't break this migration via sqlx::FromRow strictness.
    let rows: Vec<(String, String, String)> = match sqlx::query_as(
        "SELECT id, tool, model_name FROM sessions \
         WHERE model_name IS NOT NULL AND model_name != ''",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                target: "fleet-backend",
                error = %e,
                "session_migrations: failed to enumerate sessions; skipping"
            );
            return out;
        }
    };

    for (id, tool, model_name) in rows {
        let Some(spec) = find_provider(&tool) else {
            // Custom agent / unknown tool — no catalog entry to consult.
            out.skipped += 1;
            continue;
        };
        if spec.default_models.is_empty() {
            // Ollama (dynamic models) or a CLI agent without a curated
            // list. We have no canonical replacement to offer.
            out.skipped += 1;
            continue;
        }
        let still_valid = spec.default_models.iter().any(|m| m.id == model_name);
        if still_valid {
            // Already pointing at a live id — leave it alone (this is
            // the steady-state branch on subsequent boots).
            continue;
        }
        // Orphaned id — rewrite to the provider's first default.
        let replacement = spec.default_models[0].id;
        match sqlx::query("UPDATE sessions SET model_name = ? WHERE id = ?")
            .bind(replacement)
            .bind(&id)
            .execute(pool)
            .await
        {
            Ok(_) => {
                tracing::info!(
                    target: "fleet-backend",
                    session_id = %id,
                    tool = %tool,
                    from = %model_name,
                    to = %replacement,
                    "session_migrations: rewrote orphaned model_name"
                );
                out.migrated += 1;
            }
            Err(e) => {
                tracing::warn!(
                    target: "fleet-backend",
                    session_id = %id,
                    error = %e,
                    "session_migrations: UPDATE failed; leaving row alone"
                );
            }
        }
    }

    if out.migrated > 0 || out.skipped > 0 {
        tracing::info!(
            target: "fleet-backend",
            migrated = out.migrated,
            skipped = out.skipped,
            "session_migrations: model_name pass complete"
        );
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;

    /// Helper: insert a minimal sessions row with the supplied tool +
    /// model_name. Fills required non-null columns with sensible
    /// placeholders — anything we don't touch in the migration is
    /// allowed to be junk.
    async fn insert_session(pool: &SqlitePool, id: &str, tool: &str, model_name: Option<&str>) {
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,use_worktree,\
              model_name,permission_mode,session_mode,pinned,order_idx,created_at,budget_used) \
             VALUES (?,'t','','',?,?,'idle',0,?,'default','new',0,0,'2026-01-01T00:00:00Z',0.0)",
        )
        .bind(id)
        .bind(tool)
        .bind(tool)
        .bind(model_name)
        .execute(pool)
        .await
        .expect("insert sessions row");
    }

    async fn fetch_model_name(pool: &SqlitePool, id: &str) -> Option<String> {
        let row: (Option<String>,) = sqlx::query_as("SELECT model_name FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("fetch row");
        row.0
    }

    #[tokio::test]
    async fn rewrites_orphaned_gemini_id_to_first_canonical_default() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        // `gemini-3-flash` was dropped in the Task 7 refresh — it's not
        // in the current GEMINI_API_MODELS list. The first canonical
        // default for `gemini-api` is `gemini-3.5-flash`.
        insert_session(&pool, "s1", "gemini-api", Some("gemini-3-flash")).await;

        let out = migrate_orphaned_model_names(&pool).await;
        assert_eq!(out.migrated, 1, "should have migrated exactly one row");
        assert_eq!(out.skipped, 0);

        let after = fetch_model_name(&pool, "s1").await;
        assert_eq!(after.as_deref(), Some("gemini-3.5-flash"));
    }

    #[tokio::test]
    async fn rewrite_is_idempotent_across_two_passes() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        insert_session(&pool, "s1", "gemini-api", Some("gemini-3-flash")).await;

        // First pass rewrites the row.
        let first = migrate_orphaned_model_names(&pool).await;
        assert_eq!(first.migrated, 1);

        // Second pass sees only valid ids and walks through doing nothing.
        let second = migrate_orphaned_model_names(&pool).await;
        assert_eq!(second.migrated, 0);
        assert_eq!(second.skipped, 0);

        // Value is still the migrated one (not flipped back).
        let after = fetch_model_name(&pool, "s1").await;
        assert_eq!(after.as_deref(), Some("gemini-3.5-flash"));
    }

    #[tokio::test]
    async fn leaves_already_valid_models_alone() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        // `gpt-5.5` is a live id in the OpenAI catalog — must not be
        // touched.
        insert_session(&pool, "s1", "openai", Some("gpt-5.5")).await;

        let out = migrate_orphaned_model_names(&pool).await;
        assert_eq!(out.migrated, 0);
        assert_eq!(out.skipped, 0);

        let after = fetch_model_name(&pool, "s1").await;
        assert_eq!(after.as_deref(), Some("gpt-5.5"));
    }

    #[tokio::test]
    async fn null_model_name_rows_are_ignored() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        // CLI-agent shaped session — no pinned model.
        insert_session(&pool, "s1", "claude", None).await;

        let out = migrate_orphaned_model_names(&pool).await;
        assert_eq!(out.migrated, 0);
        assert_eq!(out.skipped, 0);

        let after = fetch_model_name(&pool, "s1").await;
        assert!(after.is_none());
    }

    #[tokio::test]
    async fn unknown_tool_id_is_skipped_not_crashed() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        // A custom agent the user wired up — `find_provider` returns
        // None, so we leave the row alone instead of guessing.
        insert_session(&pool, "s1", "my-custom-agent", Some("some-stale-model")).await;

        let out = migrate_orphaned_model_names(&pool).await;
        assert_eq!(out.migrated, 0);
        assert_eq!(out.skipped, 1);

        let after = fetch_model_name(&pool, "s1").await;
        assert_eq!(after.as_deref(), Some("some-stale-model"));
    }

    #[tokio::test]
    async fn provider_with_empty_default_models_is_skipped() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        // Ollama has `default_models: &[]` (dynamic) — even if the
        // user pinned a model name, we can't pick a canonical
        // replacement, so the row is skipped.
        insert_session(&pool, "s1", "ollama", Some("some-old-tag")).await;

        let out = migrate_orphaned_model_names(&pool).await;
        assert_eq!(out.migrated, 0);
        assert_eq!(out.skipped, 1);

        let after = fetch_model_name(&pool, "s1").await;
        assert_eq!(after.as_deref(), Some("some-old-tag"));
    }

    #[tokio::test]
    async fn mixed_rows_are_partitioned_correctly() {
        let pool = init_pool("sqlite::memory:").await.expect("pool");
        // Orphaned (Gemini) — should rewrite.
        insert_session(&pool, "s_orphan", "gemini-api", Some("gemini-3-flash")).await;
        // Valid (OpenAI) — should be left.
        insert_session(&pool, "s_valid", "openai", Some("gpt-5.5")).await;
        // Null model_name (CLI) — should be ignored entirely.
        insert_session(&pool, "s_null", "claude", None).await;
        // Unknown tool — should bump skipped.
        insert_session(&pool, "s_unknown", "custom-x", Some("foo")).await;

        let out = migrate_orphaned_model_names(&pool).await;
        assert_eq!(out.migrated, 1);
        assert_eq!(out.skipped, 1);

        assert_eq!(
            fetch_model_name(&pool, "s_orphan").await.as_deref(),
            Some("gemini-3.5-flash")
        );
        assert_eq!(
            fetch_model_name(&pool, "s_valid").await.as_deref(),
            Some("gpt-5.5")
        );
        assert!(fetch_model_name(&pool, "s_null").await.is_none());
        assert_eq!(
            fetch_model_name(&pool, "s_unknown").await.as_deref(),
            Some("foo")
        );
    }
}
