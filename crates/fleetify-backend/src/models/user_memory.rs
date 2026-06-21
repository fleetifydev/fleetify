use serde::{Deserialize, Serialize};

/// Personal-memory kinds — what Fleet knows about the USER (not a project).
/// Distinct vocabulary from `MEMORY_KINDS` (which is dev/project-oriented).
pub const USER_MEMORY_KINDS: [&str; 8] = [
    "preference",
    "stack",
    "goal",
    "working_style",
    "interest",
    "life_context",
    "thread",
    "fact",
];

/// `user_memory` row — USER-scoped, cross-project personal knowledge Fleet
/// draws on to act as a personal assistant. `importance` (1..5) orders
/// retrieval; `source` is `explicit` (the user told Fleet) or `auto` (Fleet
/// extracted it from conversation).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserMemory {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub importance: i64,
    pub source: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

/// Coerce an arbitrary string to a known kind (fallback `fact`).
pub fn normalize_kind(raw: &str) -> &'static str {
    let lc = raw.trim().to_ascii_lowercase();
    USER_MEMORY_KINDS
        .into_iter()
        .find(|k| *k == lc)
        .unwrap_or("fact")
}
