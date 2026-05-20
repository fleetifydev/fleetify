use serde::{Deserialize, Serialize};

/// Canonical memory kinds — keep stable, the UI groups by kind (mirrors
/// `MEMORY_KINDS` in `backend/app/models/memory.py`).
pub const MEMORY_KINDS: [&str; 5] = ["decision", "learning", "gotcha", "plan", "note"];

/// `session_memory` row — curated, hand-picked knowledge for cross-session
/// per-project recall.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SessionMemory {
    pub id: String,
    pub session_id: String,
    pub project_path: Option<String>,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub created_at: String,
    pub created_by: String,
}
