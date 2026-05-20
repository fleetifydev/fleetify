use serde::{Deserialize, Serialize};

/// `users` row. Mirrors `backend/app/models/user.py::User`.
/// `external_sub` is the OAuth `sub` claim (unique); `id` is a local UUID.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub external_sub: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}
