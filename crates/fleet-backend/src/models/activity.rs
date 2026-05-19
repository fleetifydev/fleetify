use serde::{Deserialize, Serialize};

/// Canonical activity kinds — keep stable, the UI's kind filter relies on
/// it (mirrors `ACTIVITY_KINDS` in `backend/app/models/activity.py`).
pub const ACTIVITY_KINDS: [&str; 9] = [
    "file_edit", "file_read", "command", "web_fetch", "todo", "plan", "error", "tool", "note",
];

/// `session_activity` row — the auto-captured audit trail.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SessionActivity {
    pub id: String,
    pub session_id: String,
    pub project_path: Option<String>,
    pub kind: String,
    pub summary: String,
    pub payload_json: Option<String>,
    pub ts: String,
}
