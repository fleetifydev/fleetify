use serde::{Deserialize, Serialize};

/// `messages` row. Mirrors `backend/app/models/message.py::Message`.
/// `content` is a JSON-encoded array of content blocks (stored as TEXT).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub usage_json: Option<String>,
    pub cost_usd: f64,
    pub timestamp: String,
}
